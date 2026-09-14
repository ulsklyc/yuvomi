# Digest des Multi-Arch-Index von node:24.20.0-slim (bookworm), Stand 4.9.2026.
# Ein Tag allein ist eine Behauptung, der Digest ist das Image, das gebaut wurde;
# Dependabot (docker) hebt ihn mit dem Tag. Beide FROM-Zeilen tragen denselben.
FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build

# Toolchain als Notnagel für native Module. Seit v13 ist
# better-sqlite3-multiple-ciphers auf Node-API gebaut und liefert die Binaries
# im Paket mit (linux-{x64,arm64}, glibc und musl) - es gibt keinen
# ABI-spezifischen Prebuild-Download mehr, den ein Quell-Build auffangen müsste.
# Erst wenn eine Plattform ohne mitgeliefertes Binary baut, greift node-gyp.
# Die Cipher-Schicht steckt im Modul selbst - ein System-SQLCipher wird nicht
# benötigt.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Abhängigkeiten zuerst (Docker-Layer-Caching)
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Runtime stage ----
FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

RUN apt-get update && apt-get install -y \
    gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node modules aus Build-Stage kopieren
COPY --from=build /app/node_modules ./node_modules

# Anwendungscode (docs/ wird via .dockerignore ausgeschlossen)
COPY . .

# Daten-Volume-Verzeichnisse anlegen (Permissions werden zur Laufzeit gesetzt)
RUN mkdir -p /data /backups /app/modules /documents

# Container-Default für das Backup-Ziel. Ohne diesen ENV fällt die App auf ihren
# Bare-Metal-Default './backups' (= /app/backups) zurück - dort hat der node-User
# keine Schreibrechte, und die Backups landeten nicht im gemounteten Volume.
# Deployments, die BACKUP_DIR selbst setzen (Compose, TrueNAS, Umbrel, Quadlet),
# überschreiben diesen Wert wie gehabt.
ENV BACKUP_DIR=/backups

# Entrypoint: korrigiert Volume-Permissions und startet als node-User
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Die Build-Revision kommt aus dem unveränderlichen Git-Commit des Build-Jobs.
# Sie ist kein Installationswert und wird deshalb nicht über .env gesetzt. Erst
# nach den Dateisystem-Layern setzen, damit ein neuer Commit deren Cache behält.
ARG APP_BUILD_REVISION
ENV APP_BUILD_REVISION=${APP_BUILD_REVISION}

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
