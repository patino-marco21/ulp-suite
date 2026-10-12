#!/bin/bash
# Reset before (re-)importing the pile: nothing in flight, then DROP the partition the run fills, delete the pile's ulp.sources rows (everything imported at or after
# CUT, plus -- with ALL_PILE_NAMES=1 -- the rows whose name is a pile file, so that files imported long ago pass the same-name guard) and unlink the inbox/done names
# that are hardlinks of pile originals (inode and link-count guard: the originals are never touched).
#
# usage: CUT='2026-10-11 14:43:00' scripts/pile/reset.sh check      (read-only: prints what it would do)
#        CUT='...' [ALL_PILE_NAMES=1] scripts/pile/reset.sh apply
# Env: CUT (required), PILE_DIR, PILE_WORK_DIR, PARTITION (202610), CH_CONTAINER (ulpsuite_clickhouse),
#      ULP_REPO (the checkout whose ./inbox and ./data are used; default: the checkout this script is in).
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=${ULP_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}; cd "$REPO" || exit 1
PILE_DIR=${PILE_DIR:-"$HOME/Downloads/AyuGram Desktop"}
WORK=${PILE_WORK_DIR:-"$REPO/.pile-work"}; mkdir -p "$WORK"
CH_CONTAINER=${CH_CONTAINER:-ulpsuite_clickhouse}
PARTITION=${PARTITION:-202610}
CUT=${CUT:?set CUT to the first import time of the run, for example CUT=\'2026-10-11 14:43:00\'}
ch() { docker exec "$CH_CONTAINER" clickhouse-client --max_execution_time=300 -q "$1"; }
mode=${1:-check}

top=$(ls -A inbox | grep -v -E '^(done|failed|processing|held)$' | wc -l); proc=$(ls -A inbox/processing | wc -l); nfail=$(ls -A inbox/failed | wc -l)
echo "inbox: top-level=$top processing=$proc failed=$nfail"
[ "$top" = 0 ] && [ "$proc" = 0 ] || { echo "ABORT: files are in flight"; exit 1; }
echo "mutations open: $(ch "SELECT count() FROM system.mutations WHERE database='ulp' AND NOT is_done")  merges running: $(ch "SELECT count() FROM system.merges")"
echo "partition $PARTITION: $(ch "SELECT concat(toString(count()), ' rows, ', toString(uniqExact(source_file)), ' files, before the cut: ', toString(countIf(imported_at < '$CUT'))) FROM ulp.credentials WHERE _partition_id='$PARTITION'")"
echo "other partitions: $(ch "SELECT arrayStringConcat(groupArray(concat(partition,'=',toString(r))), ' ') FROM (SELECT partition, sum(rows) r FROM system.parts WHERE database='ulp' AND table='credentials' AND active GROUP BY partition ORDER BY partition)")"
echo "sources rows since the cut: $(ch "SELECT count() FROM ulp.sources WHERE imported_at >= '$CUT'")  before: $(ch "SELECT count() FROM ulp.sources WHERE imported_at < '$CUT'")"
before=$(ch "SELECT count() FROM ulp.credentials WHERE _partition_id='$PARTITION' AND imported_at < '$CUT'")
[ "$before" = 0 ] || { echo "ABORT: partition $PARTITION holds $before rows from before the cut; it is not a pile-only partition"; exit 1; }

# the sources rows to delete: since the cut, and optionally every pile name
SQL_NAMES=""
if [ "${ALL_PILE_NAMES:-0}" = 1 ]; then
  SQL_NAMES=$(find "$PILE_DIR" -maxdepth 1 -type f -iname '*.txt' -printf '%f\n' | node -e '
    const names = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean)
    console.log(names.map(n => "\x27" + n.replace(/\\/g, "\\\\").replace(/\x27/g, "\\\x27") + "\x27").join(","))')
  echo "pile names that would also be removed from ulp.sources: $(ch "SELECT count() FROM ulp.sources WHERE imported_at < '$CUT' AND filename IN ($SQL_NAMES)") (imported before the cut)"
fi

# inbox/done names that are hardlinks of the originals
n_ok=0; n_skip=0
: > "$WORK/reset-unlink.txt"
for f in inbox/done/*; do
  [ -e "$f" ] || continue
  name=${f#inbox/done/}
  if [ -e "$PILE_DIR/$name" ] && [ "$(stat -c %i "$f")" = "$(stat -c %i "$PILE_DIR/$name")" ] && [ "$(stat -c %h "$f")" -ge 2 ]; then
    n_ok=$((n_ok+1)); printf '%s\n' "$f" >> "$WORK/reset-unlink.txt"
  else
    n_skip=$((n_skip+1)); echo "  not a hardlink of a pile original (left alone): $name"
  fi
done
echo "inbox/done: $n_ok names are hardlinks of pile originals (would be unlinked; this frees no space while the originals exist), $n_skip left alone"

if [ "$mode" != apply ]; then echo "(check only: nothing changed)"; exit 0; fi

echo "== DROP PARTITION $PARTITION"
# A refused drop (for instance a partition above the server's 50 GB limit that the setting did not lift) stops everything here: nothing after it may run
# while the rows are still in the table, or the sources rows and the done names would no longer describe what is in it.
ch "ALTER TABLE ulp.credentials DROP PARTITION '$PARTITION' SETTINGS max_partition_size_to_drop = 0" || { echo "ABORT: the DROP of partition $PARTITION failed; nothing after it was run"; exit 1; }
echo dropped
echo "== DELETE the pile's sources rows"
if [ -n "$SQL_NAMES" ]; then
  ch "ALTER TABLE ulp.sources DELETE WHERE imported_at >= '$CUT' OR filename IN ($SQL_NAMES) SETTINGS mutations_sync = 2" || { echo "ABORT: deleting the sources rows failed; the partition is already dropped, no inbox/done name was unlinked"; exit 1; }
else
  ch "ALTER TABLE ulp.sources DELETE WHERE imported_at >= '$CUT' SETTINGS mutations_sync = 2" || { echo "ABORT: deleting the sources rows failed; the partition is already dropped, no inbox/done name was unlinked"; exit 1; }
fi
echo deleted
echo "== unlink inbox/done names"
while IFS= read -r f; do rm -f -- "$f"; done < "$WORK/reset-unlink.txt"
echo "inbox/done left: $(ls -A inbox/done | wc -l)"
echo "== after"
echo "partition $PARTITION rows: $(ch "SELECT count() FROM ulp.credentials WHERE _partition_id='$PARTITION'")  sources since the cut: $(ch "SELECT count() FROM ulp.sources WHERE imported_at >= '$CUT'")"
