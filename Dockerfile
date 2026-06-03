FROM node:22-slim AS build

# SQLCipher-Abhängigkeiten
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsqlcipher-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Abhängigkeiten zuerst (Docker-Layer-Caching)
COPY package*.json ./
RUN npm ci

# Production frontend assets: preserve module paths, strip comments, minify JS.
COPY public ./public
COPY scripts ./scripts
RUN npm run build:client && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    libsqlcipher0 \
    gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node modules aus Build-Stage kopieren
COPY --from=build /app/node_modules ./node_modules

# Anwendungscode (docs/ wird via .dockerignore ausgeschlossen)
COPY . .
COPY --from=build /app/dist ./dist

# Daten-Volume-Verzeichnis anlegen (Permissions werden zur Laufzeit gesetzt)
RUN mkdir -p /data

# Entrypoint: korrigiert /data-Permissions und startet als node-User
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
