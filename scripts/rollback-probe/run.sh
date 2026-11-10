#!/bin/bash
# Rollback probe before a foundation release (docs/RELEASING.md, step 7).
#
# Runs the previous image and the new build in turn on ONE demo database, in
# production mode with a generated encryption key, and records at every stage:
# the database fingerprint (fp.mjs), the API answers (api.mjs) and the service
# worker in one browser profile (sw.mjs). Then the way back: a backup made on
# the new build is restored on the previous image.
#
# Usage:
#   scripts/rollback-probe/run.sh <previous-image> <new-image> [work-dir]
# Example:
#   docker build -t yuvomi-foundation:probe .
#   scripts/rollback-probe/run.sh ghcr.io/ulsklyc/yuvomi:2.88.0 yuvomi-foundation:probe
#
# Needs Docker, curl and `npm ci` in this checkout (the seed and the browser
# probe run from here). The work directory defaults to a new temp directory and
# keeps data/, copies/, logs/, shots/ and the fp-*/api-*/sw-*.json files. Port
# 3871 unless PROBE_PORT says otherwise.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
[ $# -ge 2 ] || { sed -n '2,20p' "$0"; exit 2; }
export PROBE_PREV_IMAGE="$1" PROBE_NEW_IMAGE="$2"
export PROBE_DIR="${3:-$(mktemp -d "${TMPDIR:-/tmp}/yuvomi-rollback-probe.XXXXXX")}"
export PROBE_PORT="${PROBE_PORT:-3871}"
mkdir -p "$PROBE_DIR/data" "$PROBE_DIR/backups" "$PROBE_DIR/logs" "$PROBE_DIR/copies"
# Absolute before the cd below: a relative work dir would resolve twice.
PROBE_DIR="$(cd "$PROBE_DIR" && pwd)"
[ -z "$(ls -A "$PROBE_DIR/data")" ] || { echo "$PROBE_DIR/data is not empty: the probe starts on an empty volume"; exit 2; }
echo "work dir: $PROBE_DIR"
cd "$PROBE_DIR" || exit 1

probe() { "$HERE/probe.sh" "$@"; }
node_() { node "$HERE/$1" "${@:2}"; }
step() { echo; echo "##### $* #####"; }
need() { "$@" || { echo "ABORTED at: $*"; exit 1; }; }
snapdb() {
  cp data/yuvomi.db "copies/$1.db"
  for s in wal shm; do [ -f "data/yuvomi.db-$s" ] && cp "data/yuvomi.db-$s" "copies/$1.db-$s"; done
  node_ fp.mjs "$1" || exit 1
}

step "1 first start of the previous image on an empty volume"
need probe up prev; probe down 01-prev-first
echo "migrations at first start: $(grep -c 'Migration .* applied' logs/01-prev-first.log)"

step "2 demo seed from the host"
DB_PATH="$PROBE_DIR/data/yuvomi.db" DB_ENCRYPTION_KEY="$(tr -d '\n' < data/.secrets/DB_ENCRYPTION_KEY)" \
  SESSION_SECRET="$(tr -d '\n' < data/.secrets/SESSION_SECRET)" \
  node "$REPO/scripts/seed-demo.js" --db "$PROBE_DIR/data/yuvomi.db" --locale en > logs/02-seed.log 2>&1 \
  || { echo "SEED FAILED"; tail -5 logs/02-seed.log; exit 1; }
snapdb 00-seeded

step "3 previous image on the seed"
need probe up prev; node_ api.mjs snap 10-prev; node_ sw.mjs 10-prev | tail -3; probe down 10-prev; snapdb 11-after-prev
node_ fpdiff.mjs 00-seeded 11-after-prev

step "4 CONTROL previous -> previous"
need probe up prev; node_ api.mjs snap 12-prev-again; node_ apidiff.mjs 10-prev 12-prev-again; node_ sw.mjs 12-prev-again | tail -3
probe down 12-prev-again; snapdb 13-after-prev-again
node_ fpdiff.mjs 11-after-prev 13-after-prev-again

step "5 previous -> new build"
need probe up new; node_ api.mjs snap 20-new; node_ apidiff.mjs 12-prev-again 20-new; node_ sw.mjs 20-new | tail -6
need node_ api.mjs backup; ls backups; node_ api.mjs write "after-backup-on-new-build"; node_ api.mjs snap 22-new-after-write | head -1
probe down 20-new; snapdb 21-after-new
node_ fpdiff.mjs 13-after-prev-again 21-after-new

step "6 WAY BACK new build -> previous image"
need probe up prev; node_ api.mjs snap 30-prev-back; node_ apidiff.mjs 22-new-after-write 30-prev-back; node_ sw.mjs 30-prev-back | tail -6
probe down 30-prev-back; snapdb 31-after-prev-back
node_ fpdiff.mjs 21-after-new 31-after-prev-back

step "7 restore of the new build's backup on the previous image"
BK="$(ls backups/*.db | head -1)"; [ -n "$BK" ] || { echo "ABORTED: no backup in backups/"; exit 1; }; cp "$BK" copies/backup.db; node_ fp.mjs backup copies/backup.db
need probe up prev; need node_ api.mjs restore "$BK"; sleep 3
curl -s "http://127.0.0.1:$PROBE_PORT/health" | cut -c1-120; echo
node_ api.mjs snap 32-prev-restored; node_ apidiff.mjs 20-new 32-prev-restored; node_ sw.mjs 32-prev-restored | tail -6
probe down 32-prev-restored; snapdb 33-after-restore
node_ fpdiff.mjs backup 33-after-restore
ls -la data | awk '{print $5, $9}'

step "logs: what stands out per stage"
for f in logs/1*.log logs/2*.log logs/3*.log; do
  echo "--- $f: $(grep -c . "$f") lines, version: $(grep -o 'Version [0-9.]*' "$f" | head -1), env: $(grep -o 'Environment: [a-z]*' "$f" | head -1)"
  grep -i -E "migrat|error|fail|refus|newer|exception|cannot|ENOENT" "$f" | cut -c1-200 | head -8
done
echo; echo "RUN DONE ($PROBE_DIR)"
