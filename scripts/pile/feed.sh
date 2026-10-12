#!/bin/bash
# Feeds the pile into the inbox: hardlinks the .txt files of PILE_DIR into ./inbox smallest-first and keeps at most IN_FLIGHT of them in flight.
# The originals are never touched (a hardlink is a second NAME for the same data; the app only renames and unlinks names).
# Stops feeding (never kills anything) on: a new file in inbox/failed, free space < FLOOR_GIB (pauses, resumes at FLOOR_GIB+5), partition >= PHASE_STOP_GIB.
# Queue = the pile's .txt names that are NOT in ulp.sources and not anywhere in the inbox tree, ascending size.
#
# Env: PILE_DIR ("$HOME/Downloads/AyuGram Desktop"), PILE_WORK_DIR (<repo>/.pile-work), IN_FLIGHT (2), FLOOR_GIB (60), PHASE_STOP_GIB (0 = none),
#      MAX_FILES, PARTITION (202610: the partition the run fills), CH_CONTAINER (ulpsuite_clickhouse), DRY_RUN=1 (print the queue and stop),
#      ULP_REPO (the checkout whose ./inbox and ./data are used; default: the checkout this script is in).
#      POLL_SECS (10: seconds between two looks at the inbox; the tests use a fraction).
# Log lines: START / FEED / PROGRESS / JOBS / STOP / LOW DISK / DISK OK / PHASE LIMIT / COMPLETE.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=${ULP_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}; cd "$REPO" || exit 1
PILE_DIR=${PILE_DIR:-"$HOME/Downloads/AyuGram Desktop"}
WORK=${PILE_WORK_DIR:-"$REPO/.pile-work"}; mkdir -p "$WORK"
CH_CONTAINER=${CH_CONTAINER:-ulpsuite_clickhouse}
PARTITION=${PARTITION:-202610}
IN_FLIGHT=${IN_FLIGHT:-2}
FLOOR_GIB=${FLOOR_GIB:-60}
PHASE_STOP_GIB=${PHASE_STOP_GIB:-0}
MAX_FILES=${MAX_FILES:-100000}
START_TS=$(date -u '+%Y-%m-%d %H:%M:%S')

ch()    { docker exec "$CH_CONTAINER" clickhouse-client -q "$1" 2>/dev/null; }
count() { ls -A "$1" 2>/dev/null | wc -l; }
now()   { date -u +%T; }

# ── queue ──
find "$PILE_DIR" -maxdepth 1 -type f -iname '*.txt' -printf '%f\n' | LC_ALL=C sort > "$WORK/candidates.txt"
ch "SELECT filename FROM ulp.sources" | LC_ALL=C sort > "$WORK/sources.txt"
LC_ALL=C comm -23 "$WORK/candidates.txt" "$WORK/sources.txt" > "$WORK/todo.txt"
: > "$WORK/queue.tsv"
while IFS= read -r f; do
  [ -e "$PILE_DIR/$f" ] || continue
  { [ -e "inbox/$f" ] || [ -e "inbox/done/$f" ] || [ -e "inbox/processing/$f" ] || [ -e "inbox/failed/$f" ]; } && continue
  printf '%s\t%s\n' "$(stat -c %s "$PILE_DIR/$f")" "$f" >> "$WORK/queue.tsv"
done < "$WORK/todo.txt"
sort -n -o "$WORK/queue.tsv" "$WORK/queue.tsv"
total=$(wc -l < "$WORK/queue.tsv"); [ "$total" -gt "$MAX_FILES" ] && total=$MAX_FILES
bytes=$(awk -F'\t' -v n="$total" 'NR<=n {s+=$1} END {printf "%.1f", s/1073741824}' "$WORK/queue.tsv")
echo "$(now) START queue=$total files ($bytes GiB) in_flight=$IN_FLIGHT floor=${FLOOR_GIB}GiB phase_stop=${PHASE_STOP_GIB}GiB since='$START_TS'"

if [ "${DRY_RUN:-0}" = 1 ]; then
  echo "first:"; head -3 "$WORK/queue.tsv" | awk -F'\t' '{printf "  %.1f MB %s\n", $1/1048576, $2}'
  echo "last:";  tail -3 "$WORK/queue.tsv" | awk -F'\t' '{printf "  %.1f MB %s\n", $1/1048576, $2}'
  exit 0
fi

fail0=$(count inbox/failed); done0=$(count inbox/done)
fed=0; idx=0; paused_disk=0; last_progress=0; last_jobs=0
while true; do
  # 1. a failure stops the feeding (in-flight files keep going; look at processing_jobs.error_message before retrying)
  nfail=$(( $(count inbox/failed) - fail0 ))
  if [ "$nfail" -gt 0 ]; then echo "$(now) STOP new file(s) in inbox/failed: $(ls -A inbox/failed | head -4 | tr '\n' ';')"; exit 2; fi

  top=$(ls -A inbox | grep -v -E '^(done|failed|processing)$' | wc -l); proc=$(count inbox/processing)
  inflight=$((top + proc))
  free=$(df -BG --output=avail / | tail -1 | tr -d ' G')
  pgib=$(ch "SELECT round(sumIf(bytes_on_disk, partition='$PARTITION')/1073741824, 1) FROM system.parts WHERE database='ulp' AND table='credentials' AND active"); pgib=${pgib:-0}

  # 2. limits
  phase_hit=0
  if [ "$PHASE_STOP_GIB" != 0 ] && awk -v a="$pgib" -v b="$PHASE_STOP_GIB" 'BEGIN{exit !(a>=b)}'; then phase_hit=1; fi
  if [ "$free" -lt "$FLOOR_GIB" ] && [ "$paused_disk" = 0 ]; then paused_disk=1; echo "$(now) LOW DISK free=${free}GiB < ${FLOOR_GIB}: feeding paused"; fi
  if [ "$paused_disk" = 1 ] && [ "$free" -ge $((FLOOR_GIB + 5)) ]; then paused_disk=0; echo "$(now) DISK OK free=${free}GiB: feeding resumes"; fi

  # 3. feed
  while [ "$inflight" -lt "$IN_FLIGHT" ] && [ "$fed" -lt "$total" ] && [ "$paused_disk" = 0 ] && [ "$phase_hit" = 0 ]; do
    idx=$((idx + 1)); line=$(sed -n "${idx}p" "$WORK/queue.tsv"); [ -z "$line" ] && break
    size=${line%%$'\t'*}; name=${line#*$'\t'}
    if ln "$PILE_DIR/$name" "inbox/$name" 2>/dev/null; then
      fed=$((fed + 1)); inflight=$((inflight + 1))
      echo "$(now) FEED $fed/$total $(awk -v s="$size" 'BEGIN{printf "%.1f MB", s/1048576}') $name"
    else
      echo "$(now) STOP could not link: $name"; exit 3
    fi
  done

  # 4. progress / jobs summary every 5 minutes
  t=$(date +%s)
  if [ $((t - last_progress)) -ge 300 ]; then
    last_progress=$t
    echo "$(now) PROGRESS fed=$fed/$total inflight=$inflight done=+$(( $(count inbox/done) - done0 )) free=${free}GiB p${PARTITION}=${pgib}GiB"
  fi
  if [ $((t - last_jobs)) -ge 300 ]; then
    last_jobs=$t
    rm -rf "$WORK/dbcopy"; mkdir -p "$WORK/dbcopy"; cp data/ulp.db data/ulp.db-wal data/ulp.db-shm "$WORK/dbcopy/" 2>/dev/null
    node "$SCRIPT_DIR/jobs-summary.cjs" "$WORK/dbcopy" "$START_TS" 2>&1 | head -1 | sed "s/^/$(now) /"
  fi

  # 5. end conditions
  if [ "$inflight" = 0 ] && { [ "$fed" -ge "$total" ] || [ "$phase_hit" = 1 ]; }; then
    if [ "$phase_hit" = 1 ]; then echo "$(now) PHASE LIMIT reached p${PARTITION}=${pgib}GiB, nothing in flight: feeding stopped after $fed files"; else echo "$(now) COMPLETE all $fed files processed"; fi
    rm -rf "$WORK/dbcopy"; mkdir -p "$WORK/dbcopy"; cp data/ulp.db data/ulp.db-wal data/ulp.db-shm "$WORK/dbcopy/" 2>/dev/null
    node "$SCRIPT_DIR/jobs-summary.cjs" "$WORK/dbcopy" "$START_TS" 2>&1 | head -1 | sed "s/^/$(now) /"
    exit 0
  fi
  sleep "${POLL_SECS:-10}"
done
