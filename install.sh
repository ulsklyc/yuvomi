#!/usr/bin/env bash
set -euo pipefail

# ── Color support ──────────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput &>/dev/null && tput colors &>/dev/null 2>&1 \
   && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
  BLUE=$(tput setaf 4); CYAN=$(tput setaf 6); BOLD=$(tput bold); RESET=$(tput sgr0)
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; RESET=''
fi

info()    { printf "%s%s%s\n" "$CYAN"   "$*" "$RESET"; }
success() { printf "%s✓ %s%s\n" "$GREEN"  "$*" "$RESET"; }
warn()    { printf "%s⚠  %s%s\n" "$YELLOW" "$*" "$RESET"; }
err()     { printf "%s✗ %s%s\n" "$RED"   "$*" "$RESET" >&2; exit 1; }
step()    { printf "\n%s%s── %s%s\n" "$BOLD" "$BLUE" "$*" "$RESET"; }
ask()     { printf "%s%s%s " "$BOLD" "$*" "$RESET"; }

# ── Internationalisierung (i18n) ────────────────────────────────────────────────
# Lädt gesourcte Locale-Dateien (tools/installer/locales/cli/<lang>.sh). en bildet
# die Fallback-Basis, die aktive Sprache überlagert sie. Sprache aus --lang oder
# der Umgebung (OIKOS_INSTALLER_LANG > LC_ALL > LC_MESSAGES > LANG), analog der App.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_LOCALES_DIR="$SCRIPT_DIR/tools/installer/locales/cli"
SUPPORTED_LOCALES=(de en es fr it sv el ru tr zh ja ar hi pt uk pl nl cs vi)
FALLBACK_LOCALE=en
ACTIVE_LOCALE=$FALLBACK_LOCALE

in_array() { local needle="$1"; shift; local e; for e in "$@"; do [ "$e" = "$needle" ] && return 0; done; return 1; }

# Rohen Locale-Tag (z. B. de_DE.UTF-8) auf eine unterstützte Basissprache abbilden.
normalize_locale() {
  local raw="${1:-}"
  raw="${raw%%.*}"; raw="${raw%%@*}"; raw="${raw%%_*}"; raw="${raw,,}"
  if in_array "$raw" "${SUPPORTED_LOCALES[@]}"; then printf '%s' "$raw"
  else printf '%s' "$FALLBACK_LOCALE"; fi
}

resolve_locale() {
  normalize_locale "${OIKOS_INSTALLER_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}"
}

# en zuerst als Basis sourcen, dann die aktive Sprache darüberlegen. Fehlen die
# Dateien (nur install.sh kopiert), zeigt t() die Schlüssel roh an.
load_locale() {
  local active="$1"
  [ -f "$CLI_LOCALES_DIR/$FALLBACK_LOCALE.sh" ] && source "$CLI_LOCALES_DIR/$FALLBACK_LOCALE.sh"
  if [ "$active" != "$FALLBACK_LOCALE" ] && [ -f "$CLI_LOCALES_DIR/$active.sh" ]; then
    source "$CLI_LOCALES_DIR/$active.sh"
  fi
}

# Übersetzung nachschlagen (Punkt-Schlüssel → MSG_<…>) und printf-Argumente einsetzen.
t() {
  local key="$1"; shift
  local var="MSG_${key//./_}"
  local fmt="${!var:-$key}"
  # shellcheck disable=SC2059
  printf "$fmt" "$@"
}

ACTIVE_LOCALE="$(resolve_locale)"
load_locale "$ACTIVE_LOCALE"

generate_secret() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 32
  else
    LC_ALL=C tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c 64
  fi
}

on_interrupt() { printf "\n%s%s%s\n" "$YELLOW" "$(t common.interrupted)" "$RESET"; exit 1; }
trap on_interrupt INT TERM

# ── Container engine detection (Docker preferred, Podman fallback) ──────────────
# Sets the COMPOSE array used everywhere a compose command is run. Podman uses
# the dedicated podman-compose.yml (SELinux :Z labels). Also sets ENGINE_BIN for
# direct engine calls (e.g. inspect) and ENGINE_NAME for messages.
COMPOSE=(); ENGINE_BIN=""; ENGINE_NAME=""
detect_engine() {
  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    COMPOSE=(docker compose); ENGINE_BIN=docker; ENGINE_NAME="Docker"; return 0
  fi
  if command -v podman &>/dev/null; then
    if podman compose version &>/dev/null 2>&1; then
      COMPOSE=(podman compose -f podman-compose.yml)
    elif command -v podman-compose &>/dev/null; then
      COMPOSE=(podman-compose -f podman-compose.yml)
    else
      return 1
    fi
    ENGINE_BIN=podman; ENGINE_NAME="Podman"; return 0
  fi
  return 1
}

# ── Prerequisites ──────────────────────────────────────────────────────────────
check_prereqs() {
  step "$(t prereq.step)"
  local ok=1
  if ! command -v curl &>/dev/null; then warn "$(t prereq.curl_missing)"; ok=0; else success "$(t prereq.curl_found)"; fi
  if detect_engine; then
    success "$(t prereq.engine_found "$ENGINE_NAME" "${COMPOSE[*]}")"
  else
    warn "$(t prereq.engine_missing)"
    ok=0
  fi
  [ $ok -eq 0 ] && err "$(t prereq.fix)"
}

# ── Step 1: Basic config ───────────────────────────────────────────────────────
configure_basic() {
  step "$(t basic.step)"

  ask "$(t basic.host)"
  read -r OIKOS_HOST; OIKOS_HOST="${OIKOS_HOST:-localhost}"

  ask "$(t basic.port)"
  read -r OIKOS_PORT; OIKOS_PORT="${OIKOS_PORT:-3000}"

  local sys_tz="UTC"
  if [ -f /etc/timezone ]; then
    sys_tz=$(cat /etc/timezone)
  elif command -v timedatectl &>/dev/null; then
    sys_tz=$(timedatectl show --property=Timezone --value 2>/dev/null || echo "UTC")
  elif [ -L /etc/localtime ]; then
    sys_tz=$(readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||' || echo "UTC")
  fi

  ask "$(t basic.tz "$sys_tz")"
  read -r OIKOS_TZ; OIKOS_TZ="${OIKOS_TZ:-$sys_tz}"
}

# ── Step 2: Secrets ────────────────────────────────────────────────────────────
configure_secrets() {
  step "$(t secrets.step)"
  info "$(t secrets.intro)"; printf "\n"

  for varname in SESSION_SECRET DB_ENCRYPTION_KEY; do
    printf "\n  %s%s:%s\n" "$BOLD" "$varname" "$RESET"
    ask "$(t secrets.choice)"
    read -r choice
    if [ "${choice,,}" = "m" ]; then
      ask "$(t secrets.enter)"
      local val; read -rs val; printf "\n"
      eval "$varname='$val'"
    else
      local generated; generated=$(generate_secret)
      eval "$varname='$generated'"
      success "$(t secrets.generated)"
    fi
  done
}

# ── Step 3: Weather ────────────────────────────────────────────────────────────
configure_weather() {
  step "$(t weather.step)"
  OPENWEATHER_API_KEY=''; OPENWEATHER_CITY='Berlin'
  OPENWEATHER_UNITS='metric'; OPENWEATHER_LANG='de'

  ask "$(t weather.enable)"
  read -r want_weather
  if [ "${want_weather,,}" = "y" ]; then
    info "$(t weather.apikey_hint)"
    ask "$(t weather.apikey)"; read -r OPENWEATHER_API_KEY
    ask "$(t weather.city)"; read -r city; OPENWEATHER_CITY="${city:-Berlin}"
    ask "$(t weather.units)"; read -r units; OPENWEATHER_UNITS="${units:-metric}"
  fi
}

# ── Step 4: Calendar ───────────────────────────────────────────────────────────
configure_calendar() {
  step "$(t calendar.step)"
  GOOGLE_CLIENT_ID=''; GOOGLE_CLIENT_SECRET=''; GOOGLE_REDIRECT_URI=''
  APPLE_USERNAME=''; APPLE_APP_SPECIFIC_PASSWORD=''

  ask "$(t calendar.google_enable)"
  read -r want_google
  if [ "${want_google,,}" = "y" ]; then
    info "$(t calendar.google_hint)"
    info "$(t calendar.redirect_hint "http://${OIKOS_HOST}:${OIKOS_PORT}/api/v1/calendar/google/callback")"
    ask "$(t calendar.client_id)"; read -r GOOGLE_CLIENT_ID
    ask "$(t calendar.client_secret)"; read -rs GOOGLE_CLIENT_SECRET; printf "\n"
    GOOGLE_REDIRECT_URI="http://${OIKOS_HOST}:${OIKOS_PORT}/api/v1/calendar/google/callback"
  fi

  ask "$(t calendar.apple_enable)"
  read -r want_apple
  if [ "${want_apple,,}" = "y" ]; then
    info "$(t calendar.apple_hint)"
    ask "$(t calendar.apple_id)"; read -r APPLE_USERNAME
    ask "$(t calendar.apple_pass)"; read -rs APPLE_APP_SPECIFIC_PASSWORD; printf "\n"
  fi
}

# ── Optional: WebDAV document storage ─────────────────────────────────────────
configure_document_storage() {
  DOCUMENT_STORAGE_WEBDAV_ENABLED='false'
  DOCUMENT_STORAGE_WEBDAV_URL=''
  DOCUMENT_STORAGE_WEBDAV_USERNAME=''
  DOCUMENT_STORAGE_WEBDAV_PASSWORD=''
  DOCUMENT_STORAGE_WEBDAV_PATH=''

  step "$(t document_webdav.step)"
  info "$(t document_webdav.hint)"
  ask "$(t document_webdav.enable)"
  read -r want_document_webdav
  if [ "${want_document_webdav,,}" = "y" ]; then
    DOCUMENT_STORAGE_WEBDAV_ENABLED='true'
    ask "$(t document_webdav.url)"; read -r DOCUMENT_STORAGE_WEBDAV_URL
    ask "$(t document_webdav.username)"; read -r DOCUMENT_STORAGE_WEBDAV_USERNAME
    ask "$(t document_webdav.password)"; read -rs DOCUMENT_STORAGE_WEBDAV_PASSWORD; printf "\n"
    ask "$(t document_webdav.path)"; read -r DOCUMENT_STORAGE_WEBDAV_PATH
    DOCUMENT_STORAGE_WEBDAV_PATH="${DOCUMENT_STORAGE_WEBDAV_PATH:-yuvomi-documents}"
  fi
}

# ── Step 5: Review ─────────────────────────────────────────────────────────────
review_and_confirm() {
  step "$(t review.step)"
  printf "\n"
  printf "  %-16s %s%s%s\n"  "$(t review.host)"     "$CYAN"   "$OIKOS_HOST" "$RESET"
  printf "  %-16s %s%s%s\n"  "$(t review.port)"     "$CYAN"   "$OIKOS_PORT" "$RESET"
  printf "  %-16s %s%s%s\n"  "$(t review.timezone)" "$CYAN"   "$OIKOS_TZ"   "$RESET"
  printf "  %-16s %s***%s\n" "SESSION_SECRET"       "$YELLOW" "$RESET"
  printf "  %-16s %s***%s\n" "DB_ENCRYPT_KEY"       "$YELLOW" "$RESET"
  [ -n "$OPENWEATHER_API_KEY" ] && printf "  %-16s %s%s%s\n" "$(t review.weather)" "$GREEN" "$(t review.weather_value "$OPENWEATHER_CITY")" "$RESET"
  [ -n "$GOOGLE_CLIENT_ID" ]    && printf "  %-16s %s%s%s\n" "$(t review.google)"  "$GREEN" "$(t review.google_value)" "$RESET"
  [ -n "$APPLE_USERNAME" ]      && printf "  %-16s %s%s%s\n" "$(t review.apple)"   "$GREEN" "$APPLE_USERNAME" "$RESET"
  [ "$DOCUMENT_STORAGE_WEBDAV_ENABLED" = "true" ] && printf "  %-16s %s%s%s\n" "$(t review.document_webdav)" "$GREEN" "$DOCUMENT_STORAGE_WEBDAV_URL" "$RESET"
  printf "\n"
  ask "$(t review.proceed)"
  read -r confirm
  [ "${confirm,,}" = "n" ] && { info "$(t review.aborted)"; exit 0; }
}

# ── Step 6: Container ───────────────────────────────────────────────────────────
write_env_and_start() {
  step "$(t container.step "$ENGINE_NAME")"

  if [ -f .env ]; then
    backup=".env.bak-$(date +%Y-%m-%dT%H-%M-%S)"
    if ! cp .env "$backup"; then
      warn "$(t container.backup_fail)"
      exit 1
    fi
    success "$(t container.backup_ok "$backup")"
  fi

  cat > .env << ENVEOF
# Generated by Yuvomi installer
SESSION_SECRET=${SESSION_SECRET}
DB_ENCRYPTION_KEY=${DB_ENCRYPTION_KEY}
OPENWEATHER_API_KEY=${OPENWEATHER_API_KEY}
OPENWEATHER_CITY=${OPENWEATHER_CITY}
OPENWEATHER_UNITS=${OPENWEATHER_UNITS}
OPENWEATHER_LANG=${OPENWEATHER_LANG}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
GOOGLE_REDIRECT_URI=${GOOGLE_REDIRECT_URI}
APPLE_USERNAME=${APPLE_USERNAME}
APPLE_APP_SPECIFIC_PASSWORD=${APPLE_APP_SPECIFIC_PASSWORD}
DOCUMENT_STORAGE_WEBDAV_ENABLED=${DOCUMENT_STORAGE_WEBDAV_ENABLED}
DOCUMENT_STORAGE_WEBDAV_URL=${DOCUMENT_STORAGE_WEBDAV_URL}
DOCUMENT_STORAGE_WEBDAV_USERNAME=${DOCUMENT_STORAGE_WEBDAV_USERNAME}
DOCUMENT_STORAGE_WEBDAV_PASSWORD=${DOCUMENT_STORAGE_WEBDAV_PASSWORD}
DOCUMENT_STORAGE_WEBDAV_PATH=${DOCUMENT_STORAGE_WEBDAV_PATH}
SYNC_INTERVAL_MINUTES=15
TZ=${OIKOS_TZ}
OIKOS_HTTP_PORT=${OIKOS_PORT}
ENVEOF

  success "$(t container.env_written)"

  if ! "${COMPOSE[@]}" up -d; then
    warn "$(t container.start_fail "$ENGINE_NAME")"
    "${COMPOSE[@]}" logs --tail 50
    exit 1
  fi

  printf '%s' "$(t container.waiting)"
  local elapsed=0
  while [ $elapsed -lt 120 ]; do
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:${OIKOS_PORT}/health" 2>/dev/null || echo "000")
    if [ "$http_code" = "200" ]; then
      printf "\n"; success "$(t container.healthy)"; return 0
    fi
    printf "."; sleep 2; elapsed=$((elapsed + 2))
  done

  printf "\n"
  warn "$(t container.timeout)"
  "${COMPOSE[@]}" logs --tail 50
  exit 1
}

# ── Step 7: Admin account ──────────────────────────────────────────────────────
create_admin() {
  step "$(t admin.step)"

  ask "$(t admin.username)"
  read -r admin_user

  ask "$(t admin.display)"
  read -r admin_display

  local admin_pass
  while true; do
    ask "$(t admin.password)"; read -rs admin_pass; printf "\n"
    ask "$(t admin.confirm)"; local admin_confirm; read -rs admin_confirm; printf "\n"
    [ "$admin_pass" = "$admin_confirm" ] && break
    warn "$(t admin.mismatch)"
  done

  # Build JSON payload (values must not contain " or \)
  local payload
  payload=$(printf '{"username":"%s","display_name":"%s","password":"%s"}' \
    "$admin_user" "$admin_display" "$admin_pass")

  local response http_code body
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "http://localhost:${OIKOS_PORT}/api/v1/auth/setup" \
    -H "Content-Type: application/json" \
    -d "$payload")
  http_code=$(printf '%s' "$response" | tail -n1)
  body=$(printf '%s' "$response" | head -n-1)

  local url="http://${OIKOS_HOST}:${OIKOS_PORT}"
  if [ "$http_code" = "201" ]; then
    success "$(t admin.created)"
    printf "\n%s%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n"   "$BOLD" "$GREEN" "$RESET"
    printf "%s%s%s%s\n"                                   "$BOLD" "$GREEN" "$(t admin.ready)" "$RESET"
    printf "%s%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n\n"   "$BOLD" "$GREEN" "$RESET"
    printf "%s%s%s\n\n" "$CYAN" "$(t admin.open "$url")" "$RESET"
  elif [ "$http_code" = "403" ]; then
    warn "$(t admin.exists)"
    printf "%s%s%s\n\n" "$CYAN" "$(t admin.open "$url")" "$RESET"
  else
    warn "$(t admin.failed "$http_code" "$body")"
    printf "%s\n" "$(t admin.manual)"
    printf "  curl -X POST http://localhost:%s/api/v1/auth/setup \\\n" "$OIKOS_PORT"
    printf "    -H 'Content-Type: application/json' \\\n"
    printf "    -d '{\"username\":\"admin\",\"display_name\":\"Admin\",\"password\":\"yourpassword\"}'\n\n"
  fi
}

# ── Non-interactive mode (--env-file) ──────────────────────────────────────────
run_noninteractive() {
  local env_file="$1"
  [ -f "$env_file" ] || err "$(t noninteractive.env_not_found "$env_file")"
  info "$(t noninteractive.using "$env_file")"
  cp "$env_file" .env

  detect_engine || err "$(t noninteractive.no_engine)"
  info "$(t noninteractive.engine "$ENGINE_NAME" "${COMPOSE[*]}")"

  OIKOS_PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- | head -n1)
  OIKOS_PORT="${OIKOS_PORT:-3000}"
  OIKOS_HOST="localhost"

  if ! "${COMPOSE[@]}" up -d; then "${COMPOSE[@]}" logs --tail 50; exit 1; fi

  printf '%s' "$(t noninteractive.waiting)"
  local elapsed=0
  while [ $elapsed -lt 120 ]; do
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:${OIKOS_PORT}/health" 2>/dev/null || echo "000")
    [ "$http_code" = "200" ] && { printf "\n"; success "$(t noninteractive.ready)"; break; }
    printf "."; sleep 2; elapsed=$((elapsed + 2))
  done

  printf "\n%s%s%s %s\n\n" "$GREEN" "$(t noninteractive.started)" "$RESET" "$(t noninteractive.create_admin)"
  printf "  curl -X POST http://localhost:%s/api/v1/auth/setup \\\n" "$OIKOS_PORT"
  printf "    -H 'Content-Type: application/json' \\\n"
  printf "    -d '{\"username\":\"admin\",\"display_name\":\"Admin\",\"password\":\"yourpassword\"}'\n\n"
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  # Optionales --lang vor allem anderen auswerten (Sprach-Override).
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --lang)   shift; ACTIVE_LOCALE="$(normalize_locale "${1:-}")"; load_locale "$ACTIVE_LOCALE"; [ $# -gt 0 ] && shift ;;
      --lang=*) ACTIVE_LOCALE="$(normalize_locale "${1#*=}")"; load_locale "$ACTIVE_LOCALE"; shift ;;
      *)        positional+=("$1"); shift ;;
    esac
  done
  set -- ${positional[@]+"${positional[@]}"}

  printf "\n%s%s  ╔══════════════════════════════╗\n" "$BOLD" "$BLUE"
  printf "  ║      Yuvomi  Installer        ║\n"
  printf "  ╚══════════════════════════════╝%s\n\n" "$RESET"

  if [ "${1:-}" = "--env-file" ]; then
    [ -n "${2:-}" ] || err "$(t usage.envfile "$0")"
    run_noninteractive "$2"; exit 0
  fi

  check_prereqs
  configure_basic
  configure_secrets
  configure_weather
  configure_calendar
  configure_document_storage
  review_and_confirm
  write_env_and_start
  create_admin
}

main "$@"
