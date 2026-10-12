#!/bin/bash
# Global checks of the partition a pile run filled (read-only). One line per check. Env: PARTITION (202610), CUT (required, the first import time of the run),
# CH_CONTAINER (ulpsuite_clickhouse). QUICK=1 skips the four hash-bucket probes against the older partitions (each reads a column of ~1.4B rows).
PARTITION=${PARTITION:-202610}
CUT=${CUT:?set CUT to the first import time of the run}
CH_CONTAINER=${CH_CONTAINER:-ulpsuite_clickhouse}
ch() { docker exec "$CH_CONTAINER" clickhouse-client --max_execution_time=600 --max_memory_usage=8000000000 -q "$1"; }
P="_partition_id='$PARTITION'"
echo "rows / distinct hashes / duplicates: $(ch "SELECT concat(toString(count()), ' / ', toString(uniqExact(content_key_hash)), ' / ', toString(count() - uniqExact(content_key_hash))) FROM ulp.credentials WHERE $P")"
echo "junk signature rows (colon in the login, or :// in both url and login): $(ch "SELECT countIf(position(email,':')>0 OR (position(email,'://')>0 AND position(url,'://')>0)) FROM ulp.credentials WHERE $P")"
echo "t.me/ in password or login: $(ch "SELECT countIf(position(password,'t.me/')>0 OR position(email,'t.me/')>0) FROM ulp.credentials WHERE $P")"
echo "double-encoded text (UTF-8 read as Latin-1) in password / login / url: $(ch "SELECT concat(toString(countIf(match(password, '[\\\\xC2-\\\\xEF][\\\\x80-\\\\xBF]'))), ' / ', toString(countIf(match(email, '[\\\\xC2-\\\\xEF][\\\\x80-\\\\xBF]'))), ' / ', toString(countIf(match(url, '[\\\\xC2-\\\\xEF][\\\\x80-\\\\xBF]')))) FROM ulp.credentials WHERE $P")"
echo "empty login or empty password: $(ch "SELECT countIf(email='' OR password='') FROM ulp.credentials WHERE $P")"
echo "rows whose url is empty (e-mail:password pairs): $(ch "SELECT countIf(url='') FROM ulp.credentials WHERE $P")"
echo "stored T3 rows by country signal is not recorded; T3 rows in the partition: $(ch "SELECT countIf(country_tier = 'T3') FROM ulp.credentials WHERE $P")"
echo "files with rows: $(ch "SELECT uniqExact(source_file) FROM ulp.credentials WHERE $P")  sources rows since the cut: $(ch "SELECT count() FROM ulp.sources WHERE imported_at >= '$CUT'")"
echo "sources.line_count total vs partition rows: $(ch "SELECT concat(toString(sumIf(line_count, imported_at >= '$CUT')), ' vs ', toString((SELECT count() FROM ulp.credentials WHERE $P))) FROM ulp.sources")"
[ "${QUICK:-0}" = 1 ] && exit 0
for k in 0 1 2 3; do
  echo "collisions with the older partitions, hash bucket $k of 4: $(ch "SELECT count() FROM ulp.credentials WHERE _partition_id != '$PARTITION' AND content_key_hash % 4 = $k AND content_key_hash IN (SELECT content_key_hash FROM ulp.credentials WHERE $P AND content_key_hash % 4 = $k)")"
done
