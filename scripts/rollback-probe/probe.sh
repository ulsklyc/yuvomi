#!/bin/bash
# Rollback probe: one container, one data directory, two images.
# Usage: probe.sh up prev|new|<image>   |   probe.sh down <label>
# Reads PROBE_DIR, PROBE_PREV_IMAGE, PROBE_NEW_IMAGE and PROBE_PORT (set by run.sh).
set -u
: "${PROBE_DIR:?PROBE_DIR is not set}"
NAME="${PROBE_CONTAINER:-yuvomi-probe}"
PORT="${PROBE_PORT:-3871}"

up() {
  local img="$1"
  [ "$img" = prev ] && img="${PROBE_PREV_IMAGE:?}"
  [ "$img" = new ] && img="${PROBE_NEW_IMAGE:?}"
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -v "$PROBE_DIR/data:/data" -v "$PROBE_DIR/backups:/backups" \
    -e NODE_ENV=production -e SESSION_SECURE=false "$img" >/dev/null || return 1
  for i in $(seq 1 90); do
    if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "up $img after ${i}s: $(curl -s "http://127.0.0.1:$PORT/health" | cut -c1-200)"
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]; then
      echo "CONTAINER EXITED"; docker logs "$NAME" 2>&1 | tail -20; return 1
    fi
    sleep 1
  done
  echo "TIMEOUT"; docker logs "$NAME" 2>&1 | tail -20; return 1
}

down() {
  mkdir -p "$PROBE_DIR/logs"
  docker logs "$NAME" > "$PROBE_DIR/logs/$1.log" 2>&1
  docker stop -t 30 "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null
  echo "down -> logs/$1.log ($(wc -l < "$PROBE_DIR/logs/$1.log") lines)"
}

case "${1:-}" in
  up) up "${2:?image: prev, new or a name}" ;;
  down) down "${2:?label}" ;;
  *) echo "Usage: probe.sh up prev|new|<image> | probe.sh down <label>"; exit 2 ;;
esac
