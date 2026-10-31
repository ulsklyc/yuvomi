#!/bin/sh
# Entrypoint: Volume-Permissions zur Laufzeit korrigieren, dann als node-User starten.
# Notwendig, weil Docker beim Mounten eines named Volume die Image-Permissions überschreibt.
#
# Bei root-Start (normales Docker/Compose): Ownership der Volumes korrigieren und via
# setpriv zum unprivilegierten node-User wechseln.
# Bei non-root-Start (z. B. TrueNAS startet den Container als 568:568, nachdem ein
# eigener Permissions-Container die Volumes bereits gechownt hat): direkt als der
# zugewiesene User starten - ein User-Wechsel wäre hier ohnehin nicht möglich.
#
# setpriv statt gosu: gosu hängt unter no-new-privileges (Podman/crun) mit 100 % CPU
# und kommt nie beim exec an (#2380); setpriv wechselt auch dann. Anders als gosu
# lässt setpriv HOME stehen, deshalb wird es hier auf das Home des node-Users gesetzt -
# sonst sähe der Prozess /root.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data /backups /app/modules
  # Documents-Mount (Default-aktiv in den Compose-Dateien) mitbehandeln; der
  # Pfad ist konfigurierbar, daher mit Guard statt hart verdrahtet.
  docs_dir="${DOCUMENT_STORAGE_LOCAL_PATH:-/documents}"
  [ -d "$docs_dir" ] && chown -R node:node "$docs_dir"
  HOME=$(getent passwd node | cut -d: -f6)
  export HOME
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
