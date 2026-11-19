# Digest des Multi-Arch-Index von node:24.22.1-slim (bookworm), Stand 26.10.2026.
# Ein Tag allein ist eine Behauptung, der Digest ist das Image, das gebaut wurde;
# Dependabot (docker) hebt ihn mit dem Tag. Beide FROM-Zeilen tragen denselben.
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build

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

# Abhängigkeiten zuerst (Docker-Layer-Caching), MIT den devDependencies: der
# Build (Vite, Phase 1a Abschnitt D) braucht sie. Puppeteer laedt hier keinen
# Chrome - er ist nur fuer die Browser-Tests da, nie im Image.
COPY package*.json .npmrc ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci

# Die App bauen: public/ ist die Quelle, dist/ das, was der Server ausliefert.
# Die Revision (Git-Commit des Build-Jobs) setzt der Build in dist/sw.js ein.
COPY vite.config.ts ./
COPY scripts/build/ ./scripts/build/
COPY scripts/build-third-party-notices.mjs ./scripts/
COPY public/ ./public/
ARG APP_BUILD_REVISION
RUN APP_BUILD_REVISION="${APP_BUILD_REVISION}" npm run build

# Danach nur noch, was zur Laufzeit gebraucht wird.
RUN npm prune --omit=dev

# Jede Laufzeit-Abhaengigkeit muss hier laden, auf jeder Plattform einzeln.
# 2.77.1 ging auf linux/arm64 ohne googleapis raus: npm hatte das damals
# optionale Paket still verworfen (120 statt 137 Pakete), der Build war gruen
# und der Container startete nie (#2006). Das Skript laedt alles aus
# `dependencies` per import() und bricht den Build ab, wenn eines fehlt.
COPY scripts/check-runtime-deps.mjs ./scripts/
RUN node scripts/check-runtime-deps.mjs

# ---- Runtime stage ----
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# Der Entrypoint wechselt mit setpriv (util-linux, im Basis-Image enthalten) zum
# node-User. Kein eigenes Paket mehr wie früher gosu - aber falls ein neues
# Basis-Image setpriv nicht mehr mitbringt, bricht der Build hier ab statt erst
# der Start des Containers.
RUN setpriv --version

WORKDIR /app

# Node modules (ohne devDependencies) und die gebaute App aus der Build-Stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Laufzeitcode. public/ bleibt im Image: der Server importiert Module aus
# public/utils/ und liest public/locales/ (geteilter Code, Phase 2 zieht ihn
# nach shared/). Ausgeliefert wird an den Browser nur dist/.
COPY package.json package-lock.json setup.js LICENSE CHANGELOG.md ./
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/check-runtime-deps.mjs ./scripts/

# Daten-Volume-Verzeichnisse anlegen (Permissions werden zur Laufzeit gesetzt)
RUN mkdir -p /data /backups /app/modules /documents

# Container-Default für das Backup-Ziel. Ohne diesen ENV fällt die App auf ihren
# Bare-Metal-Default './backups' (= /app/backups) zurück - dort hat der node-User
# keine Schreibrechte, und die Backups landeten nicht im gemounteten Volume.
# Deployments, die BACKUP_DIR selbst setzen (Compose, TrueNAS, Umbrel, Quadlet),
# überschreiben diesen Wert wie gehabt.
ENV BACKUP_DIR=/backups

# Container-Default für die Datenbank, aus demselben Grund: ohne DB_PATH läge
# yuvomi.db unter /app, wo der node-User weder die Datenbank noch die beim ersten
# Start erzeugten Secrets (.secrets daneben) anlegen darf - der Container beendete
# sich sofort. Mit diesem Default reicht ein Volume auf /data. Gesetzte Werte
# (Compose, Quadlet, Kataloge, auch das Legacy-/data/oikos.db) gelten weiter.
ENV DB_PATH=/data/yuvomi.db

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
