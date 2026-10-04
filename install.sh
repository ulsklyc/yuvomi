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
SUPPORTED_LOCALES=(de en es fr it sv el ru tr zh ja ar hi pt-BR pt uk pl nl cs vi hu ko id fa fil nb)
FALLBACK_LOCALE=en
ACTIVE_LOCALE=$FALLBACK_LOCALE

in_array() { local needle="$1"; shift; local e; for e in "$@"; do [ "$e" = "$needle" ] && return 0; done; return 1; }

# Rohen Locale-Tag (z. B. de_DE.UTF-8, pt_BR.UTF-8, --lang pt-BR) auf eine
# unterstützte Locale abbilden: erst Sprache mit Region (pt-BR), dann die
# Basissprache (de). Gross/klein ueber tr statt ${x,,} - das kennt die bash 3.2
# von macOS nicht und brach dort mit "bad substitution" ab.
normalize_locale() {
  local raw="${1:-}" lang region="" alias=""
  raw="${raw%%.*}"; raw="${raw%%@*}"; raw="${raw//_/-}"
  lang="$(printf '%s' "${raw%%-*}" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    *-*) region="$(printf '%s' "${raw#*-}" | tr '[:lower:]' '[:upper:]')"; region="${region%%-*}" ;;
  esac
  if [ -n "$region" ] && in_array "$lang-$region" "${SUPPORTED_LOCALES[@]}"; then printf '%s' "$lang-$region"; return; fi
  if in_array "$lang" "${SUPPORTED_LOCALES[@]}"; then printf '%s' "$lang"; return; fi
  # Sprachcodes, die eine vorhandene Locale meinen: `no_NO.UTF-8` ist auf vielen
  # Systemen der Name fuer Norwegisch, `nn_NO` (Nynorsk) hat keine eigene Datei.
  # Rueckfall, kein Ersatz - dieselbe Zuordnung wie LANGUAGE_ALIAS in public/i18n.js.
  case "$lang" in
    no|nn) alias="nb" ;;
  esac
  if [ -n "$alias" ] && in_array "$alias" "${SUPPORTED_LOCALES[@]}"; then printf '%s' "$alias"
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

# Antworten auf Ja/Nein- und Auswahlfragen. Die Prompts zeigen den Buchstaben
# ihrer Sprache ([j/N], [s/N], [e/H], [R]učně ...), gelesen wurde aber nur `y`,
# `n` und `m`: wer auf Deutsch der Anzeige folgte und "j" tippte, bekam still
# ein Nein, und auf Tuerkisch brach "h" die Zusammenfassung nicht ab. y/yes,
# n/no und m gelten immer, dazu die Woerter aus MSG_yes_chars, MSG_no_chars und
# MSG_manual_chars der aktiven Locale (en.sh legt die Basis).
#
# Gross/klein: ${x,,} kennt die bash 3.2 von macOS nicht (siehe
# normalize_locale), und `tr '[:upper:]'` faltet je nach System und Locale
# verschieden - GNU-tr nur ASCII, BSD-tr unter UTF-8 auch Í. Deshalb wird hier
# nur A-Z gefaltet, unter LC_ALL=C auf allen Systemen gleich, und die Antwort
# zusaetzlich roh verglichen. Woerter mit anderen Zeichen (sí, НЕТ, ΝΑΙ, HAYİR)
# stehen dafuer in der Locale auch gross; test:installer-cli-i18n prueft das.
answer_matches() {
  local raw="${1:-}" folded word
  [ -n "$raw" ] || return 1
  folded="$(printf '%s' "$raw" | LC_ALL=C tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')"
  for word in $2; do
    if [ "$raw" = "$word" ] || [ "$folded" = "$word" ]; then return 0; fi
  done
  return 1
}
is_yes()    { answer_matches "${1:-}" "y yes ${MSG_yes_chars:-}"; }
is_no()     { answer_matches "${1:-}" "n no ${MSG_no_chars:-}"; }
is_manual() { answer_matches "${1:-}" "m ${MSG_manual_chars:-}"; }

ACTIVE_LOCALE="$(resolve_locale)"
load_locale "$ACTIVE_LOCALE"

generate_secret() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 32
  else
    LC_ALL=C tr -dc 'a-f0-9' </dev/urandom 2>/dev/null | head -c 64
  fi
}

# Einen bereits vergebenen Wert aus einer vorhandenen .env lesen.
#
# Ein einmal benutzter DB_ENCRYPTION_KEY MUSS erhalten bleiben: die Datenbank ist
# damit verschlüsselt, und mit einem anderen Schlüssel bricht der Start ab. Ein
# Installer-Rerun (Update, geänderter Port, nachgetragenes SMTP) würde die
# Installation sonst unbrauchbar machen. Für SESSION_SECRET gilt dasselbe in
# harmloser: ein neuer Wert wirft alle angemeldeten Nutzer aus der App.
#
# Der Web-Installer schreibt Werte compose-sicher (Quotes, `\` maskiert, `$` als
# `$$`) - das wird hier zurückgedreht, damit ein CLI-Rerun nach einer
# Web-Installation denselben Schlüssel liest.
read_existing_env_value() {
  [ -f .env ] || return 1
  local line raw
  line=$(grep -E "^$1=" .env 2>/dev/null | tail -n1)
  [ -n "$line" ] || return 1
  raw="${line#*=}"
  if [ "${raw:0:1}" = '"' ] && [ "${raw: -1}" = '"' ] && [ ${#raw} -ge 2 ]; then
    raw="${raw:1:${#raw}-2}"
    raw="${raw//\\\"/\"}"
    raw="${raw//\\\\/\\}"
  fi
  raw="${raw//\$\$/\$}"
  [ -n "$raw" ] || return 1
  printf '%s' "$raw"
}

# Gegenstück beim Schreiben - spiegelt encodeEnvValue() aus
# tools/installer/install-server.js: `$` wird zu `$$` (Compose-Literal),
# riskante Werte (Whitespace, #, Quotes, Backtick, `\`) werden doppelt
# gequotet, darin `\` und `"` maskiert. Ohne das würde ein Rerun einen vom
# Web-Installer quotiert geschriebenen Wert entschärft lesen und roh
# zurückschreiben - Compose interpoliert oder kappt ihn dann.
escape_env_value() {
  local raw="$1" out
  out="${raw//\$/\$\$}"
  case "$raw" in
    *[[:space:]\#\"\'\`\\]*)
      out=$(printf '%s' "$out" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
      printf '"%s"' "$out"
      ;;
    *)
      printf '%s' "$out"
      ;;
  esac
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
  # if statt `[ ... ] && err`: als letzte Zeile gab die Kurzform bei erfuellten
  # Voraussetzungen 1 zurueck, und `set -e` beendete den Installer lautlos
  # direkt nach der Pruefung. Dasselbe gilt fuer die Abbruchfrage in review_and_confirm.
  if [ $ok -eq 0 ]; then err "$(t prereq.fix)"; fi
}

# ── Step 1: Basic config ───────────────────────────────────────────────────────
configure_basic() {
  step "$(t basic.step)"

  ask "$(t basic.host)"
  read -r YUVOMI_HOST; YUVOMI_HOST="${YUVOMI_HOST:-localhost}"

  ask "$(t basic.port)"
  read -r YUVOMI_PORT; YUVOMI_PORT="${YUVOMI_PORT:-3000}"

  local sys_tz="UTC"
  if [ -f /etc/timezone ]; then
    sys_tz=$(cat /etc/timezone)
  elif command -v timedatectl &>/dev/null; then
    sys_tz=$(timedatectl show --property=Timezone --value 2>/dev/null || echo "UTC")
  elif [ -L /etc/localtime ]; then
    sys_tz=$(readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||' || echo "UTC")
  fi

  ask "$(t basic.tz "$sys_tz")"
  read -r YUVOMI_TZ; YUVOMI_TZ="${YUVOMI_TZ:-$sys_tz}"

  # BASE_URL wird nicht aus Host und Port zusammengesetzt und gut: hinter einem
  # Reverse-Proxy lautet die Origin https://planer.example.com, während der
  # Container weiter auf localhost:3000 hört. Aus dem Request-Header darf der
  # Server sie nicht nehmen (Reset-Poisoning), also ist Fragen der einzige Weg.
  local default_base="http://${YUVOMI_HOST}:${YUVOMI_PORT}"
  ask "$(t basic.base_url "$default_base")"
  read -r YUVOMI_BASE_URL; YUVOMI_BASE_URL="${YUVOMI_BASE_URL:-$default_base}"

  # Der Web-Installer setzt das Schema selbst zusammen und kann es nicht
  # verlieren; hier tippt der Nutzer frei. Ohne Schema ist der Reset-Link
  # kaputt, und die VAPID-Subject-Kette verwirft den Wert stumm als
  # "nicht routbar". Ein Schrägstrich am Ende ergäbe `https://host//reset`.
  case "$YUVOMI_BASE_URL" in
    http://*|https://*) ;;
    *) YUVOMI_BASE_URL="http://${YUVOMI_BASE_URL}" ;;
  esac
  while [ "${YUVOMI_BASE_URL%/}" != "$YUVOMI_BASE_URL" ]; do
    YUVOMI_BASE_URL="${YUVOMI_BASE_URL%/}"
  done

  configure_proxy
}

# Reverse-Proxy-Betrieb aus dem Schema der Basis-URL ableiten.
#
# Der CLI-Installer hat diese beiden Variablen nie geschrieben, und beide
# Server-Defaults sind für die jeweils andere Betriebsart falsch:
#
#   SESSION_SECURE ist per Default aus (`=== 'true'`). Hinter einem HTTPS-Proxy
#   fehlen damit HSTS und das Secure-Flag am Sitzungscookie.
#
#   TRUST_PROXY ist per Default 1, also "vertraue einem Proxy-Hop". Beim
#   Direktzugriff OHNE Proxy nimmt Express damit den X-Forwarded-For-Header
#   ungeprüft an - jeder Client kann sich eine beliebige Absender-IP geben und
#   das Anmelde-Rate-Limit umgehen, weil es pro IP zählt.
#
# Das Schema der Basis-URL trägt genau diese Information, und der Web-Installer
# leitet dieselbe Entscheidung aus derselben Quelle ab (`S.scheme`).
#
# Ein bereits vorhandener Wert gewinnt ohne Rückfrage - wie bei den Secrets. Wer
# TRUST_PROXY von Hand auf `2` oder ein Subnetz gesetzt hat, weiss besser als
# eine Heuristik, wie seine Kette aussieht.
configure_proxy() {
  local existing
  if existing=$(read_existing_env_value SESSION_SECURE); then
    YUVOMI_SESSION_SECURE="$existing"
  else
    case "$YUVOMI_BASE_URL" in
      https://*) YUVOMI_SESSION_SECURE='true' ;;
      *)         YUVOMI_SESSION_SECURE='false' ;;
    esac
  fi

  if existing=$(read_existing_env_value TRUST_PROXY); then
    YUVOMI_TRUST_PROXY="$existing"
  else
    case "$YUVOMI_BASE_URL" in
      https://*) YUVOMI_TRUST_PROXY='1' ;;
      *)         YUVOMI_TRUST_PROXY='loopback' ;;
    esac
  fi
}

# ── Step 2: Secrets ────────────────────────────────────────────────────────────
configure_secrets() {
  step "$(t secrets.step)"
  info "$(t secrets.intro)"; printf "\n"

  SESSION_SECRET_REUSED=''; DB_ENCRYPTION_KEY_REUSED=''

  for varname in SESSION_SECRET DB_ENCRYPTION_KEY; do
    printf "\n  %s%s:%s\n" "$BOLD" "$varname" "$RESET"

    # Bestehender Wert gewinnt ohne Rückfrage. Wer bewusst neu anfangen will,
    # entfernt die Zeile aus der .env - das ist die explizite Geste dafür.
    local existing
    if existing=$(read_existing_env_value "$varname"); then
      printf -v "$varname" '%s' "$existing"
      printf -v "${varname}_REUSED" '%s' 'yes'
      success "$(t secrets.reused)"
      continue
    fi

    ask "$(t secrets.choice)"
    read -r choice
    if is_manual "$choice"; then
      ask "$(t secrets.enter)"
      local val; read -rs val; printf "\n"
      printf -v "$varname" '%s' "$val"
    else
      local generated; generated=$(generate_secret)
      printf -v "$varname" '%s' "$generated"
      success "$(t secrets.generated)"
    fi
  done
}

# ── Step 3: Weather ────────────────────────────────────────────────────────────
# Open-Meteo ist seit 2026-06-07 der Standard: kostenlos, ohne Konto, ohne
# Schlüssel, dafür mit Koordinaten statt Ortsname. Der Dialog fragte trotzdem
# weiter nach einem OpenWeather-API-Schlüssel und schickte damit jeden, der das
# Wetter-Widget wollte, zu einer Registrierung, die er nicht braucht.
# OPENWEATHER_* bleibt als Legacy erhalten, wird aber nicht mehr erfragt: wer
# es schon nutzt, behält es über den Preserve-Zweig in write_env_and_start.

# Zahl im Bereich [min,max]? Bash kann kein Fliesskomma, awk schon.
valid_number() {
  [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || return 1
  awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN { exit !(v >= lo && v <= hi) }'
}

configure_weather() {
  step "$(t weather.step)"
  WEATHER_LAT=''; WEATHER_LON=''; WEATHER_CITY=''; WEATHER_UNITS='metric'

  ask "$(t weather.enable)"
  read -r want_weather
  if is_yes "$want_weather"; then
    info "$(t weather.coords_hint)"

    # Leere Eingabe bricht ab statt erneut zu fragen. Ohne diesen Ausstieg ist
    # die Schleife für jeden, der sich bei der Ja/Nein-Frage vertippt hat, nur
    # noch mit Ctrl+C verlassbar - und der trap beendet den ganzen Installer,
    # er müsste also von vorn anfangen. Enter heisst im übrigen Dialog überall
    # "weiter"; das darf hier nicht die einzige Stelle sein, wo es das nicht tut.
    while true; do
      ask "$(t weather.lat)"; read -r WEATHER_LAT
      [ -z "$WEATHER_LAT" ] && { WEATHER_LAT=''; WEATHER_LON=''; WEATHER_CITY=''; return 0; }
      valid_number "$WEATHER_LAT" -90 90 && break
      warn "$(t weather.err_lat)"
    done

    while true; do
      ask "$(t weather.lon)"; read -r WEATHER_LON
      [ -z "$WEATHER_LON" ] && { WEATHER_LAT=''; WEATHER_LON=''; WEATHER_CITY=''; return 0; }
      valid_number "$WEATHER_LON" -180 180 && break
      warn "$(t weather.err_lon)"
    done

    ask "$(t weather.city)"; read -r WEATHER_CITY
    ask "$(t weather.units)"; read -r units; WEATHER_UNITS="${units:-metric}"
  fi
}

# ── Step 4: Calendar ───────────────────────────────────────────────────────────
configure_calendar() {
  step "$(t calendar.step)"
  GOOGLE_CLIENT_ID=''; GOOGLE_CLIENT_SECRET=''; GOOGLE_REDIRECT_URI=''
  APPLE_USERNAME=''; APPLE_APP_SPECIFIC_PASSWORD=''
  MS_CLIENT_ID=''; MS_CLIENT_SECRET=''; MS_REDIRECT_URI=''

  ask "$(t calendar.google_enable)"
  read -r want_google
  if is_yes "$want_google"; then
    info "$(t calendar.google_hint)"
    info "$(t calendar.redirect_hint "${YUVOMI_BASE_URL}/api/v1/calendar/google/callback")"
    ask "$(t calendar.client_id)"; read -r GOOGLE_CLIENT_ID
    ask "$(t calendar.client_secret)"; read -rs GOOGLE_CLIENT_SECRET; printf "\n"
    GOOGLE_REDIRECT_URI="${YUVOMI_BASE_URL}/api/v1/calendar/google/callback"
  fi

  ask "$(t calendar.apple_enable)"
  read -r want_apple
  if is_yes "$want_apple"; then
    info "$(t calendar.apple_hint)"
    ask "$(t calendar.apple_id)"; read -r APPLE_USERNAME
    ask "$(t calendar.apple_pass)"; read -rs APPLE_APP_SPECIFIC_PASSWORD; printf "\n"
  fi

  ask "$(t calendar.outlook_enable)"
  read -r want_outlook
  if is_yes "$want_outlook"; then
    info "$(t calendar.outlook_hint)"
    info "$(t calendar.redirect_hint "${YUVOMI_BASE_URL}/api/v1/calendar/outlook/callback")"
    ask "$(t calendar.client_id)"; read -r MS_CLIENT_ID
    ask "$(t calendar.client_secret)"; read -rs MS_CLIENT_SECRET; printf "\n"
    MS_REDIRECT_URI="${YUVOMI_BASE_URL}/api/v1/calendar/outlook/callback"
  fi
}

# ── Optional: WebDAV document storage ─────────────────────────────────────────
configure_document_storage() {
  DOCUMENT_STORAGE_LOCAL_ENABLED='false'
  DOCUMENT_STORAGE_LOCAL_PATH=''
  DOCUMENT_STORAGE_WEBDAV_ENABLED='false'
  DOCUMENT_STORAGE_WEBDAV_URL=''
  DOCUMENT_STORAGE_WEBDAV_USERNAME=''
  DOCUMENT_STORAGE_WEBDAV_PASSWORD=''
  DOCUMENT_STORAGE_WEBDAV_PATH=''
  GOOGLE_DRIVE_CLIENT_ID=''
  GOOGLE_DRIVE_CLIENT_SECRET=''
  GOOGLE_DRIVE_REDIRECT_URI=''

  step "$(t document_local.step)"
  info "$(t document_local.hint)"
  ask "$(t document_local.enable)"
  read -r want_document_local
  if is_yes "$want_document_local"; then
    DOCUMENT_STORAGE_LOCAL_ENABLED='true'
    ask "$(t document_local.path)"; read -r DOCUMENT_STORAGE_LOCAL_PATH
    DOCUMENT_STORAGE_LOCAL_PATH="${DOCUMENT_STORAGE_LOCAL_PATH:-/documents}"
  fi

  step "$(t document_webdav.step)"
  info "$(t document_webdav.hint)"
  ask "$(t document_webdav.enable)"
  read -r want_document_webdav
  if is_yes "$want_document_webdav"; then
    DOCUMENT_STORAGE_WEBDAV_ENABLED='true'
    ask "$(t document_webdav.url)"; read -r DOCUMENT_STORAGE_WEBDAV_URL
    ask "$(t document_webdav.username)"; read -r DOCUMENT_STORAGE_WEBDAV_USERNAME
    ask "$(t document_webdav.password)"; read -rs DOCUMENT_STORAGE_WEBDAV_PASSWORD; printf "\n"
    ask "$(t document_webdav.path)"; read -r DOCUMENT_STORAGE_WEBDAV_PATH
    DOCUMENT_STORAGE_WEBDAV_PATH="${DOCUMENT_STORAGE_WEBDAV_PATH:-yuvomi-documents}"
  fi

  step "$(t document_google_drive.step)"
  info "$(t document_google_drive.hint)"
  ask "$(t document_google_drive.enable)"
  read -r want_document_google_drive
  if is_yes "$want_document_google_drive"; then
    info "$(t document_google_drive.redirect_hint "${YUVOMI_BASE_URL}/api/v1/documents/storage/google-drive/callback")"
    ask "$(t document_google_drive.client_id)"; read -r GOOGLE_DRIVE_CLIENT_ID
    ask "$(t document_google_drive.client_secret)"; read -rs GOOGLE_DRIVE_CLIENT_SECRET; printf "\n"
    if { [ -n "$GOOGLE_DRIVE_CLIENT_ID" ] && [ -z "$GOOGLE_DRIVE_CLIENT_SECRET" ]; } || { [ -z "$GOOGLE_DRIVE_CLIENT_ID" ] && [ -n "$GOOGLE_DRIVE_CLIENT_SECRET" ]; }; then
      err "$(t document_google_drive.err_pair)"
    fi
    if [ -z "$GOOGLE_DRIVE_CLIENT_ID" ] && { [ -z "$GOOGLE_CLIENT_ID" ] || [ -z "$GOOGLE_CLIENT_SECRET" ]; }; then
      err "$(t document_google_drive.err_credentials)"
    fi
    GOOGLE_DRIVE_REDIRECT_URI="${YUVOMI_BASE_URL}/api/v1/documents/storage/google-drive/callback"
  fi
}

# ── Step 5: Review ─────────────────────────────────────────────────────────────
review_and_confirm() {
  step "$(t review.step)"
  printf "\n"
  printf "  %-16s %s%s%s\n"  "$(t review.host)"     "$CYAN"   "$YUVOMI_HOST" "$RESET"
  printf "  %-16s %s%s%s\n"  "$(t review.port)"     "$CYAN"   "$YUVOMI_PORT" "$RESET"
  printf "  %-16s %s%s%s\n"  "$(t review.timezone)" "$CYAN"   "$YUVOMI_TZ"   "$RESET"
  printf "  %-16s %s%s%s\n"  "$(t review.base_url)" "$CYAN"   "$YUVOMI_BASE_URL" "$RESET"
  printf "  %-16s %s***%s%s\n" "SESSION_SECRET" "$YELLOW" "$RESET" "${SESSION_SECRET_REUSED:+ $(t review.secret_reused)}"
  printf "  %-16s %s***%s%s\n" "DB_ENCRYPT_KEY" "$YELLOW" "$RESET" "${DB_ENCRYPTION_KEY_REUSED:+ $(t review.secret_reused)}"
  # Variablennamen statt übersetzter Labels: dieselbe Geste wie bei den beiden
  # Zeilen darüber. Sichtbar müssen sie sein, weil hier eine Sicherheitsfrage
  # entschieden wird, ohne dass jemand danach gefragt wurde.
  printf "  %-16s %s%s%s\n" "SESSION_SECURE" "$CYAN" "$YUVOMI_SESSION_SECURE" "$RESET"
  printf "  %-16s %s%s%s\n" "TRUST_PROXY"    "$CYAN" "$YUVOMI_TRUST_PROXY"    "$RESET"
  [ -n "$WEATHER_LAT" ] && printf "  %-16s %s%s%s\n" "$(t review.weather)" "$GREEN" "$(t review.weather_value "${WEATHER_CITY:-$WEATHER_LAT, $WEATHER_LON}")" "$RESET"
  [ -n "$GOOGLE_CLIENT_ID" ]    && printf "  %-16s %s%s%s\n" "$(t review.google)"  "$GREEN" "$(t review.google_value)" "$RESET"
  [ -n "$APPLE_USERNAME" ]      && printf "  %-16s %s%s%s\n" "$(t review.apple)"   "$GREEN" "$APPLE_USERNAME" "$RESET"
  [ -n "$MS_CLIENT_ID" ]        && printf "  %-16s %s%s%s\n" "$(t review.outlook)" "$GREEN" "$(t review.outlook_value)" "$RESET"
  [ "$DOCUMENT_STORAGE_LOCAL_ENABLED" = "true" ] && printf "  %-16s %s%s%s\n" "$(t review.document_local)" "$GREEN" "${DOCUMENT_STORAGE_LOCAL_PATH:-/documents}" "$RESET"
  [ "$DOCUMENT_STORAGE_WEBDAV_ENABLED" = "true" ] && printf "  %-16s %s%s%s\n" "$(t review.document_webdav)" "$GREEN" "$DOCUMENT_STORAGE_WEBDAV_URL" "$RESET"
  [ -n "$GOOGLE_DRIVE_REDIRECT_URI" ] && printf "  %-16s %s%s%s\n" "$(t review.document_google_drive)" "$GREEN" "$(t review.google_value)" "$RESET"
  printf "\n"
  ask "$(t review.proceed)"
  read -r confirm
  if is_no "$confirm"; then info "$(t review.aborted)"; exit 0; fi
}

# Die Schlüssel, die dieser Dialog selbst belegt. Alles andere in einer
# bestehenden .env stammt von Hand oder aus dem Web-Installer und wird
# übernommen - siehe preserve_unmanaged().
MANAGED_KEYS=(
  SESSION_SECRET DB_ENCRYPTION_KEY
  WEATHER_LAT WEATHER_LON WEATHER_CITY WEATHER_UNITS
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI
  GOOGLE_DRIVE_CLIENT_ID GOOGLE_DRIVE_CLIENT_SECRET GOOGLE_DRIVE_REDIRECT_URI
  APPLE_USERNAME APPLE_APP_SPECIFIC_PASSWORD
  MS_CLIENT_ID MS_CLIENT_SECRET MS_REDIRECT_URI
  DOCUMENT_STORAGE_LOCAL_ENABLED DOCUMENT_STORAGE_LOCAL_PATH
  DOCUMENT_STORAGE_WEBDAV_ENABLED DOCUMENT_STORAGE_WEBDAV_URL
  DOCUMENT_STORAGE_WEBDAV_USERNAME DOCUMENT_STORAGE_WEBDAV_PASSWORD
  DOCUMENT_STORAGE_WEBDAV_PATH
  SYNC_INTERVAL_MINUTES TZ OIKOS_HTTP_PORT BASE_URL
  SESSION_SECURE TRUST_PROXY
)

# Jede Zuweisung aus der alten .env, die dieser Dialog NICHT selbst setzt.
#
# Der Grund: `cat > .env` schrieb 24 Schlüssel und warf alles andere weg. Wer
# SMTP, OIDC oder WebDAV-Backups von Hand ergänzt hatte - oder den Wizard
# benutzte, der 55 Schlüssel kennt - verlor sie beim nächsten Lauf lautlos.
# Ein Rerun ist der Normalfall (Update, geänderter Port, nachgetragenes SMTP),
# nicht die Ausnahme. Das Backup daneben half nicht: die laufende Installation
# war trotzdem kaputt, und zwar erst beim nächsten Anmeldeversuch sichtbar.
#
# Kommentare fallen bewusst weg: sie beziehen sich auf den alten Aufbau der
# Datei und stünden im neuen an falscher Stelle.
preserve_unmanaged() {
  local source_file="$1" line key
  [ -f "$source_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    in_array "$key" "${MANAGED_KEYS[@]}" && continue
    printf '%s\n' "$line"
  done < "$source_file"
}

# ── Step 6: Container ───────────────────────────────────────────────────────────
write_env_and_start() {
  step "$(t container.step "$ENGINE_NAME")"

  backup=''
  if [ -f .env ]; then
    backup=".env.bak-$(date +%Y-%m-%dT%H-%M-%S)"
    if ! cp .env "$backup"; then
      warn "$(t container.backup_fail)"
      exit 1
    fi
    success "$(t container.backup_ok "$backup")"
  fi

  # Rerun-Erhalt: das Sync-Intervall fragt der Dialog nie ab - ein von Hand
  # oder vom Wizard gesetzter Wert darf hier nicht auf 15 zurückfallen.
  local sync_interval
  sync_interval=$(read_existing_env_value SYNC_INTERVAL_MINUTES) || sync_interval=15

  cat > .env << ENVEOF
# Generated by Yuvomi installer
SESSION_SECRET=$(escape_env_value "${SESSION_SECRET}")
DB_ENCRYPTION_KEY=$(escape_env_value "${DB_ENCRYPTION_KEY}")
WEATHER_LAT=${WEATHER_LAT}
WEATHER_LON=${WEATHER_LON}
WEATHER_CITY=$(escape_env_value "${WEATHER_CITY}")
WEATHER_UNITS=${WEATHER_UNITS}
GOOGLE_CLIENT_ID=$(escape_env_value "${GOOGLE_CLIENT_ID}")
GOOGLE_CLIENT_SECRET=$(escape_env_value "${GOOGLE_CLIENT_SECRET}")
GOOGLE_REDIRECT_URI=$(escape_env_value "${GOOGLE_REDIRECT_URI}")
GOOGLE_DRIVE_CLIENT_ID=$(escape_env_value "${GOOGLE_DRIVE_CLIENT_ID}")
GOOGLE_DRIVE_CLIENT_SECRET=$(escape_env_value "${GOOGLE_DRIVE_CLIENT_SECRET}")
GOOGLE_DRIVE_REDIRECT_URI=$(escape_env_value "${GOOGLE_DRIVE_REDIRECT_URI}")
APPLE_USERNAME=$(escape_env_value "${APPLE_USERNAME}")
APPLE_APP_SPECIFIC_PASSWORD=$(escape_env_value "${APPLE_APP_SPECIFIC_PASSWORD}")
MS_CLIENT_ID=$(escape_env_value "${MS_CLIENT_ID}")
MS_CLIENT_SECRET=$(escape_env_value "${MS_CLIENT_SECRET}")
MS_REDIRECT_URI=$(escape_env_value "${MS_REDIRECT_URI}")
DOCUMENT_STORAGE_LOCAL_ENABLED=${DOCUMENT_STORAGE_LOCAL_ENABLED}
DOCUMENT_STORAGE_LOCAL_PATH=$(escape_env_value "${DOCUMENT_STORAGE_LOCAL_PATH}")
DOCUMENT_STORAGE_WEBDAV_ENABLED=${DOCUMENT_STORAGE_WEBDAV_ENABLED}
DOCUMENT_STORAGE_WEBDAV_URL=$(escape_env_value "${DOCUMENT_STORAGE_WEBDAV_URL}")
DOCUMENT_STORAGE_WEBDAV_USERNAME=$(escape_env_value "${DOCUMENT_STORAGE_WEBDAV_USERNAME}")
DOCUMENT_STORAGE_WEBDAV_PASSWORD=$(escape_env_value "${DOCUMENT_STORAGE_WEBDAV_PASSWORD}")
DOCUMENT_STORAGE_WEBDAV_PATH=$(escape_env_value "${DOCUMENT_STORAGE_WEBDAV_PATH}")
SYNC_INTERVAL_MINUTES=${sync_interval}
TZ=${YUVOMI_TZ}
OIKOS_HTTP_PORT=${YUVOMI_PORT}
# Absolute origin for password-reset links and push. The request Host header is
# deliberately not trusted (reset poisoning), so without this value the server
# sends no reset mails at all.
BASE_URL=${YUVOMI_BASE_URL}
# Derived from the base URL's scheme. SESSION_SECURE=true enables HSTS and the
# Secure flag on the session cookie; TRUST_PROXY=loopback stops Express from
# believing an X-Forwarded-For header when there is no proxy in front (that
# header is what the login rate limit counts per client).
SESSION_SECURE=${YUVOMI_SESSION_SECURE}
TRUST_PROXY=${YUVOMI_TRUST_PROXY}
ENVEOF

  if [ -n "$backup" ]; then
    local preserved
    preserved=$(preserve_unmanaged "$backup")
    if [ -n "$preserved" ]; then
      printf '\n# Carried over from the previous .env\n%s\n' "$preserved" >> .env
      success "$(t container.preserved "$(printf '%s\n' "$preserved" | grep -c .)")"
    fi
  fi

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
      "http://localhost:${YUVOMI_PORT}/health" 2>/dev/null || echo "000")
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
    -X POST "http://localhost:${YUVOMI_PORT}/api/v1/auth/setup" \
    -H "Content-Type: application/json" \
    -d "$payload")
  http_code=$(printf '%s' "$response" | tail -n1)
  # sed '$d' statt head -n-1: das BSD-head von macOS kennt keine negative Zeilenzahl,
  # und `set -e` beendete den Installer nach dem Anlegen des Kontos ohne Meldung.
  body=$(printf '%s' "$response" | sed '$d')

  # Die Adresse, unter der der Haushalt die App tatsächlich öffnet, nicht die,
  # auf die der Container hört. Hinter einem Proxy sind das zwei verschiedene,
  # und ein Link auf http://host:port führt dort ins Leere.
  local url="${YUVOMI_BASE_URL:-http://${YUVOMI_HOST}:${YUVOMI_PORT}}"
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
    printf "  curl -X POST http://localhost:%s/api/v1/auth/setup \\\n" "$YUVOMI_PORT"
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

  # Host-Port ist OIKOS_HTTP_PORT (Compose mappt ${OIKOS_HTTP_PORT:-3000}:3000).
  # PORT wäre der Container-Innenport - der Health-Poll und die curl-Anleitung
  # liefen damit gegen den falschen Anschluss.
  YUVOMI_PORT=$(grep -E '^OIKOS_HTTP_PORT=' .env 2>/dev/null | cut -d= -f2- | head -n1)
  YUVOMI_PORT="${YUVOMI_PORT:-3000}"
  YUVOMI_HOST="localhost"

  if ! "${COMPOSE[@]}" up -d; then "${COMPOSE[@]}" logs --tail 50; exit 1; fi

  printf '%s' "$(t noninteractive.waiting)"
  local elapsed=0
  while [ $elapsed -lt 120 ]; do
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:${YUVOMI_PORT}/health" 2>/dev/null || echo "000")
    [ "$http_code" = "200" ] && { printf "\n"; success "$(t noninteractive.ready)"; break; }
    printf "."; sleep 2; elapsed=$((elapsed + 2))
  done

  printf "\n%s%s%s %s\n\n" "$GREEN" "$(t noninteractive.started)" "$RESET" "$(t noninteractive.create_admin)"
  printf "  curl -X POST http://localhost:%s/api/v1/auth/setup \\\n" "$YUVOMI_PORT"
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
  printf "  ║       Yuvomi Installer       ║\n"
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
