import {
  formatTime,
  formatUnit,
  getLocale,
  getSupportedLocales,
  setLocale,
  t,
} from '/i18n.js';
import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { currencyName, currencyShortLabel, persistCurrencySelection } from '/settings/currency.js';
import { CURRENCY_CODES } from '/utils/currency-codes.js';
import { getPreferences, resetPreferencesCache, savePreferences } from '/settings/preferences-cache.js';
import { settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { wireTablist } from '/utils/tablist.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { isWallModeEnabled, setWallModeEnabled } from '/utils/wall-mode.js';
import { getNightHours, setNightHours } from '/utils/night-hours.js';
import {
  SCREENSAVER_IDLE_STEPS,
  getScreensaverIdleSeconds,
  isScreensaverClockOn,
  isScreensaverCoverOn,
  setScreensaverClockOn,
  setScreensaverCoverOn,
  setScreensaverIdleSeconds,
} from '/utils/screensaver-idle.js';
import { setDisplayTimeZone } from '/utils/timezone.js';
import { adoptZone, zoneHintEl, zoneMismatch } from '/utils/household-zone-hint.js';
import {
  CUSTOM_REGION,
  REGION_CODES,
  REGION_PRESETS,
  detectRegion,
  resolveRegion,
  regionLabel,
  regionShortLabel,
  languageLabel,
  languageShortLabel,
  languageShortKey,
  SHORT_NAME_COUNTRIES,
  SHORT_NAME_LANGUAGES,
  numberLocaleFor,
} from '/settings/region-presets.js';
import { errorSentence } from '/utils/friendly-error.js';

// Der Name jedes Segments ist sein sichtbares Wort - vorher trug es ein
// abweichendes aria-label („Dunkles Design" zu „Dunkel"), und die Gruppe
// selbst heisst schon „Design" (WCAG 2.5.3, Label im Namen).
const THEME_OPTIONS = [
  { value: 'system', icon: 'monitor', labelKey: 'settings.themeSystem' },
  { value: 'light', icon: 'sun', labelKey: 'settings.themeLight' },
  { value: 'dark', icon: 'moon', labelKey: 'settings.themeDark' },
];

const DATE_FORMATS = [
  ['mdy', 'MM/DD/YYYY'],
  ['dmy', 'DD.MM.YYYY'],
  ['dmy_slash', 'DD/MM/YYYY'],
  ['dmy_dash', 'DD-MM-YYYY'],
  ['ymd', 'YYYY-MM-DD'],
  ['mdy_dot', 'MM.DD.YYYY'],
  ['ymd_dot', 'YYYY.MM.DD'],
  ['ymd_slash', 'YYYY/MM/DD'],
];

function safeStorageGet(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function currentTheme() {
  return safeStorageGet('yuvomi-theme', 'system') || 'system';
}

function formatOptions(selected) {
  return DATE_FORMATS.map(([value, label]) => (
    `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`
  )).join('');
}

/**
 * Die Zeitzonen-Optionen: "Automatisch" plus alle IANA-Zonen, nach Region
 * gruppiert.
 *
 * Die Liste kommt aus dem ICU des BROWSERS und nicht vom Server - sie hat
 * einige hundert Einträge, und sie über die Preferences-Antwort zu schicken
 * hiesse, diesen Ballast in jeden Settings-Aufruf zu legen, obwohl jeder
 * Browser sie selbst besitzt. Der Server prüft den gewählten Wert trotzdem
 * gegen sein eigenes ICU (#829); eine Zone, die nur der Browser kennt,
 * bekommt ein 400 statt still zu landen.
 *
 * Die erste Option speichert den leeren Wert und stellt damit auf den Rückfall
 * zurück (TZ → Systemzone → UTC). Die Zone, die dann tatsächlich gilt, nennt
 * die Hinweiszeile (`timezoneHintText`) - sonst wäre "Automatisch" eine Zusage
 * ohne Inhalt. Bis R21 stand sie im Label selbst und wurde mobil gekappt
 * ("Automatisch (Eur…").
 */
function timeZoneList(selected) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  // Eine gespeicherte Zone, die dieses ICU nicht (mehr) kennt, muss sichtbar
  // bleiben: sonst zeigte das Feld "Automatisch", während der Server weiter die
  // alte Zone benutzt - ein Select, das die Wahrheit verschweigt.
  if (selected && !zones.includes(selected)) zones = [...zones, selected].sort();
  return zones;
}

const zoneArea = (zone) => (zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other');
// Was nach der Region (der optgroup) uebrig bleibt: "Argentina/Buenos Aires".
const zoneRest = (zone) => (zone.includes('/') ? zone.slice(zone.indexOf('/') + 1) : zone).replace(/_/g, ' ');

/**
 * Name einer Zone in der Auswahl (#2166): die Stadt ("New Salem" statt
 * "North Dakota/New Salem", das am Telefon gekappt war). Teilen sich zwei
 * Zonen einer Gruppe die Stadt, behalten beide den Rest mit Zwischenstufe -
 * die Liste bleibt unterscheidbar. Der volle Name steht dann in der
 * Hinweiszeile (`timezoneHintText`).
 */
function timeZoneLabels(zones) {
  const city = (zone) => zone.slice(zone.lastIndexOf('/') + 1).replace(/_/g, ' ');
  const seen = new Map();
  for (const zone of zones) {
    const key = `${zoneArea(zone)}/${city(zone)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Map(zones.map((zone) => [zone, seen.get(`${zoneArea(zone)}/${city(zone)}`) > 1 ? zoneRest(zone) : city(zone)]));
}

function timeZoneOptions(selected) {
  const zones = timeZoneList(selected);
  const labels = timeZoneLabels(zones);

  const auto = `<option value=""${selected ? '' : ' selected'}>${esc(t('settings.timezoneAuto'))}</option>`;

  // UTC von Hand davor. `Intl.supportedValuesOf('timeZone')` fuehrt WEDER `UTC`
  // NOCH ein einziges `Etc/*` - und UTC ist ausgerechnet der Auslieferungs-
  // Default dieser App. Ohne diese Zeile ist die eine Zone nicht waehlbar, die
  // ein Admin ausdruecklich festnageln will, damit die Anzeige nicht mit `TZ`
  // mitwandert. Steht vor den Gruppen statt in einer eigenen "Other"-Gruppe mit
  // genau einem Eintrag: sie ist der Sonderfall, nicht eine Region.
  const utc = `<option value="UTC"${selected === 'UTC' ? ' selected' : ''}>UTC</option>`;

  const groups = new Map();
  for (const zone of zones) {
    if (zone === 'UTC') continue; // steht schon oben
    const area = zoneArea(zone);
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(zone);
  }
  const body = [...groups.entries()].map(([area, list]) => {
    const opts = list.map((zone) => {
      // Das Label laesst die Region weg - die steht schon an der optgroup, und
      // "America > America/New York" liest sich wie ein Fehler. Seit #2166
      // auch eine Zwischenstufe ("Argentina/", "North Dakota/"): die Stadt
      // allein, siehe `timeZoneLabels`. Der VALUE bleibt die volle IANA-Kennung.
      const label = labels.get(zone);
      return `<option value="${esc(zone)}"${zone === selected ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
    return `<optgroup label="${esc(area)}">${opts}</optgroup>`;
  }).join('');

  return auto + utc + body;
}

const withLanguage = (region, language) => t('settings.regionWithLanguage', { region, language });

/** Voller Name einer Region ("Vereinigte Arabische Emirate", "Kanada (Französisch)"). */
function regionFullName(code) {
  return regionLabel(code, getLocale(), withLanguage);
}

/**
 * Name einer Region in der Auswahl (#2151): kurz genug fuer die geschlossene
 * Auswahl am Telefon ("VAE", "Kanada (FR)"). Der volle Name steht dann in der
 * Hinweiszeile (`regionHintText`).
 */
export function regionShortName(code) {
  return regionShortLabel(code, getLocale(), {
    countryName: (country) => (SHORT_NAME_COUNTRIES.includes(country) ? t(`settings.regionShort.${country}`) : null),
    withLanguage,
  });
}

/**
 * Die Hinweiszeile der Region: beginnt mit dem vollen Namen, wenn die Auswahl
 * nur die Kurzform zeigt - dasselbe Muster wie Datensprache und Zone (R21).
 */
export function regionHintText(code) {
  if (!REGION_CODES.includes(code)) return t('settings.regionHint');
  const full = regionFullName(code);
  return hintWithCurrent(t('settings.regionHint'), full === regionShortName(code) ? null : full);
}

function regionOptions(selectedRegion) {
  const locale = getLocale();
  // Nach dem angezeigten Namen sortieren, nicht nach der Reihenfolge in
  // REGION_PRESETS: die ist nach Sprachfamilie gruppiert und war bei einem
  // Dutzend Einträgen noch überschaubar. Mit der Amerika-Abdeckung sind es
  // über 60 - da findet man "Spanisch (Peru)" nur alphabetisch wieder.
  // detectRegion() bleibt von der Sortierung unberührt, es liest das Objekt.
  const presets = [...REGION_CODES]
    .map((code) => ({ code, label: regionShortName(code) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale))
    .map(({ code, label }) => (
      `<option value="${esc(code)}"${selectedRegion === code ? ' selected' : ''}>${esc(label)}</option>`
    )).join('');
  const custom = `<option value="${CUSTOM_REGION}"${selectedRegion === CUSTOM_REGION ? ' selected' : ''}>${t('settings.regionCustom')}</option>`;
  return presets + custom;
}

function localeLabel(locale) {
  return languageLabel(locale, getLocale());
}

/**
 * Name einer Sprache in den beiden Sprachwahlen, kurz (#2151, siehe
 * `languageShortLabel`). Der volle Name (`localeLabel`) steht in der
 * Hinweiszeile der Datensprache.
 */
export function localeShortLabel(locale) {
  return languageShortLabel(locale, getLocale(), (tag) => (
    SHORT_NAME_LANGUAGES.includes(tag) ? t(`settings.languageShort.${languageShortKey(tag)}`) : null
  ));
}

function localeOptions() {
  const storedLocale = safeStorageGet('yuvomi-locale');
  return [
    `<option value="system"${storedLocale ? '' : ' selected'}>${t('settings.localeSystem')}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${storedLocale === locale ? ' selected' : ''}>${esc(localeShortLabel(locale))}</option>`
    )),
  ].join('');
}

/**
 * DER WERT IST KURZ, DAS DETAIL STEHT VORN IN DER HINWEISZEILE (R21, Critique
 * 2026-10-21, Entscheidung Ulas): mobil hat die geschlossene Auswahl rund
 * 180 px, und "Automatisch (Englisch)" endete dort als "Automatisch (Engl…" -
 * abgeschnitten genau an der Stelle, die sagt, was gilt. Die Zeile sagt jetzt
 * "Automatisch", die Hinweiszeile beginnt mit "Zurzeit: Englisch." (bis R24
 * "Gerade Englisch." - G6-Einst-P3-6: neben deutscher Oberflaeche las sich
 * das wie "sogar Englisch"; jetzt dieselbe Form wie in jeder anderen Sprache).
 *
 * Ohne `current` bleibt der Hinweis, wie er ist: eine ausdrücklich gewählte
 * Sprache oder Zone steht schon vollständig in der Auswahl. Seit #2151 gilt
 * dasselbe fuer Region und Sprache in Kurzform: "VAE" in der Auswahl,
 * "Zurzeit: Vereinigte Arabische Emirate." vorn im Hinweis.
 */
export function hintWithCurrent(hint, current) {
  return current ? t('settings.hintWithCurrent', { value: current, hint }) : hint;
}

/**
 * Die Hinweiszeile der Datensprache. Bei "automatisch" nennt sie die Sprache,
 * auf die die Automatik fiele - `language_auto`, nicht `language_effective`.
 * Bei explizit gewählter Sprache sind die beiden verschieden, und
 * `language_effective` würde dort genau die gewählte Sprache als
 * Automatik-Ergebnis ausgeben.
 */
export function dataLanguageHintText(selected, auto_) {
  if (!selected) return hintWithCurrent(t('settings.dataLanguageHint'), localeLabel(auto_ || 'en'));
  const full = localeLabel(selected);
  return hintWithCurrent(t('settings.dataLanguageHint'), full === localeShortLabel(selected) ? null : full);
}

/**
 * Die Hinweiszeile der Haushaltszone: bei "automatisch" mit der Zone, die gilt.
 * Eine gewaehlte Zone, die in der Auswahl nur als Stadt steht ("New Salem"),
 * nennt hier ihren vollen Namen (#2166).
 */
export function timezoneHintText(selected, effective) {
  if (!selected) return hintWithCurrent(t('settings.timezoneHint'), effective || 'UTC');
  const short = timeZoneLabels(timeZoneList(selected)).get(selected);
  return hintWithCurrent(t('settings.timezoneHint'), short === zoneRest(selected) ? null : selected.replace(/_/g, ' '));
}

/**
 * Die Waehrungen der Auswahl (#2166): Code und Symbol ("GBP £"), der Code
 * haelt jede Option unterscheidbar. "AED - Dirham der Vereinigten Arabischen
 * Emirate" war am Telefon in 17 von 26 Sprachen gekappt; der volle Name steht
 * jetzt vorn in der Hinweiszeile (`currencyHintText`). Der Kreditdialog im
 * Budget hat die volle Breite und behaelt "Code - Name".
 */
function currencyOptions(selected) {
  return CURRENCY_CODES.map((code) => (
    `<option value="${esc(code)}"${code === selected ? ' selected' : ''}>${esc(currencyShortLabel(code))}</option>`
  )).join('');
}

/** Die Hinweiszeile der Waehrung: beginnt mit ihrem vollen Namen. */
export function currencyHintText(code) {
  return hintWithCurrent(t('settings.currencyHint'), code ? currencyName(code) : null);
}

function syncCurrencyHint(container) {
  setHint(container, 'currency-hint', currencyHintText(container.querySelector('#currency-select')?.value));
}

/** Setzt den Text einer Hinweiszeile (per id), wenn es sie gibt. */
function setHint(container, id, text) {
  const hint = container.querySelector(`#${id}`);
  if (hint) hint.textContent = text;
}

/**
 * Optionen für die Datensprache des Haushalts (#631, #632). Der leere Wert steht
 * für "automatisch"; welche Sprache das gerade ist, sagt die Hinweiszeile
 * (`dataLanguageHintText`).
 */
function dataLanguageOptions(selected) {
  const auto = t('settings.dataLanguageAuto');
  return [
    `<option value=""${selected ? '' : ' selected'}>${esc(auto)}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${selected === locale ? ' selected' : ''}>${esc(localeShortLabel(locale))}</option>`
    )),
  ].join('');
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

// Minutes in the UI language (CLDR via formatUnit), so the five steps need no
// plural keys of their own in 26 locales.
function screensaverIdleText(seconds) {
  return formatUnit(seconds / 60, 'minute', { unitDisplay: 'long' });
}

// Exported so test:screensaver-idle can check the select opens on the stored
// value.
export function screensaverIdleOptions() {
  const current = getScreensaverIdleSeconds();
  return SCREENSAVER_IDLE_STEPS.map((seconds) => `
    <option value="${seconds}"${seconds === current ? ' selected' : ''}>${esc(screensaverIdleText(seconds))}</option>`).join('');
}

/**
 * The clock and full-bleed switches (#1766). Device-local like the select
 * above; the screensaver reads both when it next starts, which is what the
 * toast says, since nothing on this page changes visibly. Exported so
 * test:screensaver-device can drive the real handler.
 */
export function bindScreensaverSwitch(toggle, store) {
  toggle?.addEventListener('change', () => {
    store(toggle.checked);
    window.yuvomi?.showToast(t('settings.screensaverDeviceSaved'), 'success');
  });
}

/**
 * Device-local like wall mode: no server request, no preference. The
 * screensaver watches the attribute this sets, so the new delay applies without
 * a reload, and the toast confirms it like the wall-mode toggle above it.
 * Exported so test:screensaver-idle can drive the real handler.
 */
export function bindScreensaverIdleSelect(select) {
  select?.addEventListener('change', () => {
    const seconds = setScreensaverIdleSeconds(Number(select.value));
    window.yuvomi?.showToast(t('settings.screensaverIdleSaved', { delay: screensaverIdleText(seconds) }), 'success');
  });
}

// A whole hour as the household writes its times ("22:00", "10:00 PM"). A
// bare "HH:MM" is wall time to formatTime, so no zone shifts the hour.
function nightHourText(hour) {
  return formatTime(`${String(hour).padStart(2, '0')}:00`);
}

/**
 * The 24 hours of one end of the night window (#2234). The hour the OTHER end
 * stands on is disabled: equal ends would be an empty window, an "off" the
 * setting does not offer. Exported so test:screensaver-device can check the
 * selects open on the stored value.
 */
export function nightHourOptions(selected, other) {
  return Array.from({ length: 24 }, (_, hour) => `
    <option value="${hour}"${hour === selected ? ' selected' : ''}${hour === other ? ' disabled' : ''}>${esc(nightHourText(hour))}</option>`).join('');
}

/**
 * Device-local like wall mode (#2234): no server request. Wall and
 * screensaver ask the stored hours each time they look - the wall on the next
 * route change and the clock's minute, the screensaver at every photo - so
 * nothing needs a reload. Each select disables the hour the other one holds, and the toast
 * names the window that now applies. Exported so test:screensaver-device can
 * drive the real handler.
 */
export function bindNightHoursSelects(fromSelect, untilSelect) {
  if (!fromSelect || !untilSelect) return;
  const sync = () => {
    for (const [select, other] of [[fromSelect, untilSelect], [untilSelect, fromSelect]]) {
      for (const option of select.options) option.disabled = option.value === other.value;
    }
  };
  const onChange = () => {
    const hours = setNightHours(Number(fromSelect.value), Number(untilSelect.value));
    fromSelect.value = String(hours.from);
    untilSelect.value = String(hours.to);
    sync();
    window.yuvomi?.showToast(
      t('settings.nightHoursSaved', { from: nightHourText(hours.from), until: nightHourText(hours.to) }),
      'success',
    );
  };
  fromSelect.addEventListener('change', onChange);
  untilSelect.addEventListener('change', onChange);
}

function renderLoadError(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="settings-card">
      <p class="form-error" role="alert">${t('settings.loadError')}</p>
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" id="appearance-retry">${t('settings.retry')}</button>
      </div>
    </div>
  `);
}

/**
 * Region, Währung, Datums- und Zeitformat bleiben eine Gruppe, obwohl sie sich
 * in der Berechtigung teilen: Region und Währung schreiben nur Admins, die
 * beiden Formate darf jedes Mitglied ändern (`server/routes/preferences.js:351`
 * dokumentiert das ausdrücklich). Zwei Gründe gegen eine Trennung:
 *
 * 1. Der Region-Select setzt die anderen drei Werte mit (`syncRegionSelect` /
 *    `detectRegion`) - auseinandergezogen reißt das #486 wieder auf.
 * 2. Die ganze Gruppe nach `admin` zu schieben nähme Mitgliedern genau das
 *    Formatändern, das die Route ihnen gewährt.
 *
 * Der Preis ist, dass ein "persönliches" Blatt vier haushaltweite Werte
 * schreibt. Das trägt die Copy (`regionAdminOnly`, `formatsHouseholdHint`),
 * nicht die Struktur (Critique 2026-07-27).
 */
function renderPage(container, preferences, isAdmin) {
  const theme = currentTheme();
  const activeRegion = resolveRegion(preferences);
  const customHidden = isAdmin && activeRegion !== CUSTOM_REGION;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionDesign')}</h2>
      <!-- EIN TRAEGER JE ABSCHNITT (R17, E9): bis dahin stand jede dieser
           Einstellungen in ihrer eigenen Karte - zehn Einstellungen in acht
           Karten, drei davon im ersten Bild. -->
      <div class="row-carrier settings-group">
        <!-- Hell / Dunkel / System ist EIN Wert aus drei - das Segment der
             Shell im Well (.segmented, panel.css; DESIGN.md "Segmented
             Controls"). Bis 2026-09-26 standen hier drei getrennte
             Rahmenknoepfe ohne Traeger (Critique A7). radiogroup statt
             aria-pressed: genau einer gilt, und Pfeiltasten gehoeren dazu.
             Die Zeile traegt kein eigenes Label: die Abschnittsueberschrift
             direkt darueber IST es (aria-label am Segment). -->
        <div class="settings-setting-row settings-setting-row--stacked">
          <div class="settings-setting-row__control">
            <div class="segmented settings-segmented" id="theme-toggle" role="radiogroup" aria-label="${esc(t('settings.sectionDesign'))}">
              ${THEME_OPTIONS.map(({ value, icon, labelKey }) => {
                const on = theme === value;
                return `<button type="button" class="segmented__item${on ? ' is-active' : ''}" role="radio"
                  data-tab-id="${value}" aria-checked="${on}" tabindex="${on ? '0' : '-1'}">
                  <i data-lucide="${icon}" class="icon-md" aria-hidden="true"></i>${esc(t(labelKey))}
                </button>`;
              }).join('')}
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.languageTitle')}</h2>
      <div class="row-carrier settings-group">
        ${settingRowHtml({
          label: t('settings.localeLabel'),
          labelFor: 'locale-select',
          extra: '<div id="locale-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input locale-picker__select" id="locale-select" aria-describedby="locale-error">
            ${localeOptions()}
          </select>`,
        })}
        <!-- Eigene Zeile mit eigenem Hinweis, nicht als Fuss der Gruppe: unter
             beiden Zeilen läse sich der Hinweis wie die Erklärung der
             Anzeigesprache - und beide sagen etwas Gegensätzliches aus. -->
        ${isAdmin ? settingRowHtml({
          label: t('settings.dataLanguageLabel'),
          labelFor: 'data-language-select',
          description: dataLanguageHintText(preferences.language, preferences.language_auto),
          descriptionId: 'data-language-hint',
          extra: '<div id="data-language-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="data-language-select" aria-describedby="data-language-hint data-language-error">
            ${dataLanguageOptions(preferences.language)}
          </select>`,
        }) : ''}
      </div>
      ${isAdmin ? '' : `<p class="form-hint settings-group__footer">${t('settings.dataLanguageAdminOnly')}</p>`}
    </section>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.regionTitle')}</h2>
      ${isAdmin ? `
      <div class="row-carrier settings-group">
        ${settingRowHtml({
          label: t('settings.regionLabel'),
          labelFor: 'region-select',
          description: regionHintText(activeRegion),
          descriptionId: 'region-hint',
          extra: '<div id="region-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="region-select" aria-describedby="region-hint region-error">
            ${regionOptions(activeRegion)}
          </select>`,
        })}
        <!-- Die Waehrung stand bis #934 in der Formatkarte darunter, die
             ausgeblendet ist, solange eine Region-Voreinstellung genau passt.
             Das ergab eine Falle mit Ansage: sichtbar wurde das Feld erst, WENN
             man die Waehrung schon einmal geaendert hatte (dann passt kein
             Preset mehr und die Karte klappt auf) - wer sie suchte, fand sie
             also nie. Der Wegweiser aus den Modul-Optionen fuehrte genau
             dorthin, wo nichts zu sehen war.

             Sie steht jetzt hier, weil sie kein Format ist: Datum und Uhrzeit
             sagen, WIE ein Wert dasteht, und folgen dem Ort. Die Waehrung folgt
             dem Geld, und das ist nicht dasselbe - ein Haushalt kann sehr wohl
             deutsche Formate und ein Konto in Dollar haben. Die Region belegt
             sie weiterhin vor; das bleibt der bequeme Weg, nur nicht mehr der
             einzige. -->
        ${settingRowHtml({
          label: t('settings.currencyLabel'),
          labelFor: 'currency-select',
          description: currencyHintText(preferences.currency),
          descriptionId: 'currency-hint',
          extra: '<div id="currency-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="currency-select" aria-describedby="currency-hint currency-error">
            ${currencyOptions(preferences.currency)}
          </select>`,
        })}
        <!-- Eigene Zeile, nicht im Formatblock darunter: die Zeitzone ist
             keine Formatierung. Datum und Uhrzeit dort ändern nur, WIE ein Wert
             dasteht; die Zone ändert, WELCHER Tag "heute" ist, wann Erinnerungen
             auslösen und mit welcher Uhrzeit ein Termin bei Google ankommt.
             Die Zeile traegt den Namen des Feldes ("Zeitzone des Haushalts",
             der Suchtreffer); der Kartentitel "Zeitzone" darueber sagte
             dasselbe ein zweites Mal. -->
        ${settingRowHtml({
          label: t('settings.timezoneLabel'),
          labelFor: 'timezone-select',
          description: timezoneHintText(preferences.timezone, preferences.timezone_effective),
          descriptionId: 'timezone-hint',
          extra: '<div id="timezone-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="timezone-select" aria-describedby="timezone-hint timezone-error">
            ${timeZoneOptions(preferences.timezone)}
          </select>`,
          attrs: { id: 'timezone-card' },
        })}
      </div>` : `
      <div class="row-carrier settings-group">
        <!-- Dieselbe Aufteilung wie in der Auswahl der Admins: der Wert kurz,
             die gerade geltende Zone vorn im Hinweis. Eine gesetzte Zone steht
             selbst da - bis R21 hiess sie hier immer "Automatisch (...)", auch
             wenn ein Admin sie ausdruecklich gewaehlt hatte. -->
        ${settingRowHtml({
          label: t('settings.timezoneTitle'),
          description: hintWithCurrent(
            t('settings.timezoneAdminOnly'),
            preferences.timezone ? null : (preferences.timezone_effective || 'UTC'),
          ),
          control: `<span class="settings-setting-row__value">${esc(preferences.timezone ? preferences.timezone.replace(/_/g, ' ') : t('settings.timezoneAuto'))}</span>`,
          attrs: { id: 'timezone-card' },
        })}
      </div>
      <p class="form-hint settings-group__footer">${t('settings.regionAdminOnly')}</p>`}
      <div class="row-carrier settings-group" id="custom-formats"${customHidden ? ' hidden' : ''}>
        ${settingRowHtml({
          label: t('settings.dateFormatLabel'),
          labelFor: 'date-format-select',
          extra: '<div id="date-format-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="date-format-select" aria-describedby="formats-household-hint date-format-error">
            ${formatOptions(preferences.date_format)}
          </select>`,
        })}
        ${settingRowHtml({
          label: t('settings.timeFormatLabel'),
          labelFor: 'time-format-select',
          extra: '<div id="time-format-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="time-format-select" aria-describedby="formats-household-hint time-format-error">
            <option value="24h"${preferences.time_format === '24h' ? ' selected' : ''}>24 ${t('settings.timeFormatHours')}</option>
            <option value="12h"${preferences.time_format === '12h' ? ' selected' : ''}>AM/PM</option>
          </select>`,
        })}
      </div>
      <p class="form-hint settings-group__footer" id="formats-household-hint"${customHidden ? ' hidden' : ''}>${t('settings.formatsHouseholdHint')}</p>
    </section>
  `);
}

function applyTheme(value) {
  safeStorageSet('yuvomi-theme', value);
  if (window.yuvomi?.applyTheme) {
    try {
      window.yuvomi.applyTheme(value);
      return;
    } catch {
      // Fall back to applying the theme directly when router storage fails.
    }
  }

  if (value === 'dark' || value === 'light') {
    document.documentElement.setAttribute('data-theme', value);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// Spiegelt die aktive Region als Formatier-Locale für Zahlen/Währung in den
// localStorage (getFormatLocale() in i18n.js liest ihn). Leert den Schlüssel bei
// "Benutzerdefiniert", damit die Zahlenformatierung auf die UI-Sprache zurückfällt.
function applyNumberLocale({ region, currency, date_format, time_format }) {
  const numberLocale = numberLocaleFor({ region, currency, date_format, time_format });
  if (numberLocale) {
    safeStorageSet('yuvomi-number-locale', numberLocale);
  } else {
    safeStorageRemove('yuvomi-number-locale');
  }
}

// Liest den aktuellen Format-Zustand aus den vier Selects der Seite.
function readFormatState(container) {
  return {
    region: container.querySelector('#region-select')?.value,
    currency: container.querySelector('#currency-select')?.value,
    date_format: container.querySelector('#date-format-select')?.value,
    time_format: container.querySelector('#time-format-select')?.value,
  };
}

// Hält den Region-Dropdown mit den drei Einzel-Selects synchron (Preset oder
// "Benutzerdefiniert"), nachdem ein Einzelwert manuell geändert wurde.
/**
 * Blendet die Formatkarte passend zur aufgeloesten Region ein oder aus.
 *
 * Eine eigene Funktion, weil zwei verschiedene Wege hier hineinfuehren und nur
 * einer von beiden `detectRegion` benutzen darf: der Regionswechsel kennt die
 * gewaehlte Region und muss sie behalten (sonst springt der Select auf die
 * erste Region mit gleichem Format-Triple, #486), waehrend eine Aenderung an
 * einem Einzelfeld die Region erst herleiten muss.
 */
function applyCustomVisibility(container, region) {
  const customBlock = container.querySelector('#custom-formats');
  if (customBlock) customBlock.hidden = region !== CUSTOM_REGION;
  // Der Gruppenfuss steht unter dem Traeger, nicht in ihm - er geht mit.
  const customHint = container.querySelector('#formats-household-hint');
  if (customHint) customHint.hidden = region !== CUSTOM_REGION;
}

/**
 * Zieht den Region-Select den Einzelfeldern nach.
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {boolean} [opts.mayHide] Darf die Formatkarte dabei zugehen?
 *        `false` fuer Aenderungen, die AUS der Karte kommen: wer ein eigenes
 *        Format zusammenstellt, laeuft unterwegs durch Zwischenstaende, und
 *        einer davon trifft leicht zufaellig ein Preset. `EUR/mdy/24h` auf
 *        `EUR/dmy/12h` umzustellen geht ueber `EUR/dmy/24h` - also durch
 *        `de-DE`. Die Karte waere nach dem ersten Schritt verschwunden, mitsamt
 *        dem Feld, in dem der Fokus gerade stand.
 * @param {string} [opts.region] Erzwungene Region statt der hergeleiteten.
 */
function syncRegionSelect(container, { mayHide = true, region = null } = {}) {
  const regionSelect = container.querySelector('#region-select');
  if (!regionSelect) return;
  regionSelect.value = region ?? detectRegion({
    currency: container.querySelector('#currency-select')?.value,
    date_format: container.querySelector('#date-format-select')?.value,
    time_format: container.querySelector('#time-format-select')?.value,
  });
  setHint(container, 'region-hint', regionHintText(regionSelect.value));
  // Die Karte muss der Anzeige folgen. Seit die Waehrung ausserhalb von ihr
  // steht (#934), kann eine Aenderung die Region auf "Benutzerdefiniert"
  // schieben, ohne dass der Nutzer die Karte je gesehen hat - stuende sie dann
  // weiter auf `hidden`, behauptete der Select etwas, das die Seite nicht zeigt.
  if (mayHide || regionSelect.value === CUSTOM_REGION) {
    applyCustomVisibility(container, regionSelect.value);
  }
}

/**
 * Baut die Optionen der Datensprache neu auf. Nötig nach einem Regionswechsel:
 * steht die Datensprache auf "automatisch", leitet der Server sie aus der Region
 * ab, und das Label nennt dann eine andere Sprache. Die Ableitung bleibt dabei
 * beim Server - hier wird nur der frisch gelesene Wert angezeigt, statt die
 * Regel im Client zu wiederholen. Die Hinweiszeile geht mit (R21).
 */
export async function refreshDataLanguageOptions(container) {
  const select = container.querySelector('#data-language-select');
  if (!select) return;
  const preferences = await getPreferences();
  select.replaceChildren();
  select.insertAdjacentHTML('beforeend', dataLanguageOptions(preferences.language || null));
  // Die Hinweiszeile traegt das Automatik-Ergebnis ("Zurzeit: Englisch.") - sie
  // geht mit, auch wenn sich nur die Ableitung geaendert hat (Regionswechsel).
  setHint(container, 'data-language-hint', dataLanguageHintText(preferences.language || null, preferences.language_auto));
}

/**
 * Zieht Auswahl und Hinweiszeile der Haushaltszone einer frischen Antwort nach.
 * Zwei Wege fuehren hierher: der Wechsel in der Auswahl (PUT-Antwort) und das
 * "Uebernehmen" im Zonen-Hinweis - der setzte die Zone bis R21, waehrend die
 * Auswahl darunter weiter "Automatisch" zeigte. Exportiert wie
 * `refreshDataLanguageOptions`, damit test:settings-navigation beide Wege fahren kann.
 */
export function refreshTimezone(container, { timezone, timezone_effective: effective } = {}) {
  const select = container.querySelector('#timezone-select');
  if (select) {
    select.replaceChildren();
    select.insertAdjacentHTML('beforeend', timeZoneOptions(timezone ?? null));
  }
  setHint(container, 'timezone-hint', timezoneHintText(timezone ?? null, effective));
}

/**
 * Die Zeile zum Zonen-Hinweis (#1607) in der Zeitzonen-Karte: solange der
 * Haushalt keine Zone gewaehlt hat und der Browser in einer anderen steht, als
 * der Server dann rechnet. Dieselbe Zeile wie auf der Uebersicht, hier ohne
 * Wegklick - wer dort "So lassen" gesagt hat, findet die Handlung hier wieder.
 * Ein Mitglied sieht den Zustand, aber keinen Knopf: der Server beantwortete
 * ihn mit 403.
 */
function mountTimezoneMismatch(container, preferences, isAdmin) {
  const card = container.querySelector('#timezone-card');
  const mismatch = zoneMismatch(preferences);
  if (!card || !mismatch) return;
  const errorElement = container.querySelector('#timezone-error');
  card.appendChild(zoneHintEl({
    mismatch,
    t,
    onAdopt: isAdmin ? async () => {
      clearError(errorElement);
      // Schreiben ueber savePreferences(), damit der geteilte Cache der
      // Settings-Blaetter faellt; gelesen wird am Cache vorbei, sonst saehe
      // die Gegenprobe "hat inzwischen jemand entschieden?" nur den alten Stand.
      const result = await adoptZone(mismatch.browser, {
        api: { get: (path) => api.get(path), put: (_path, patch) => savePreferences(patch) },
      });
      resetPreferencesCache();
      // Gesetzt ist die Zone in beiden Faellen (uebernommen oder schon von
      // jemand anderem gewaehlt) - Auswahl und Hinweiszeile zeigen sie.
      if (result.timezone) refreshTimezone(container, { timezone: result.timezone, timezone_effective: result.timezone });
      if (result.adopted) window.yuvomi?.showToast(t('settings.timezoneSaved'), 'success');
    } : undefined,
    onError: (error) => {
      if (errorElement) showError(errorElement, errorSentence(error, 'settings.preferenceSaveFailed'));
      else window.yuvomi?.showToast(errorSentence(error, 'settings.preferenceSaveFailed'), 'danger');
    },
  }));
}

/**
 * WAND-MODUS UND BILDSCHIRMSCHONER IM BLATT "DIESES GERAET" (R19, Critique
 * 2026-10-16: "Geraete-Einstellungen buendeln"). Beide sind geraetelokal
 * (localStorage) und standen unter "Darstellung" zwischen Theme und Sprache,
 * waehrend "Dieses Geraet" nur die App-Installation trug. Der Abschnitt
 * `device-display` (registry.js, `props.part: 'device'`) rendert sie dort -
 * derselbe Baustein, dieselben Handler.
 */
function deviceDisplayRowsHtml({ screensaverOn = true, isAdmin = false } = {}) {
  return `
        <!-- DER WAND-MODUS WOHNT HIER UND NICHT IM ANPASSEN-PANEL.
             Er ist wie Theme und Sprache GERÄTELOKAL (localStorage) - das
             Anpassen-Panel schreibt dagegen die haushaltweite Widget-Konfiguration
             auf den Server. Ein gerätelokaler Schalter dort wäre eine zweite
             Speicher-Semantik im selben Panel; und der Anpassen-Modus bearbeitet
             das Raster, während dieser Schalter eine Betriebsart wählt. -->
        ${settingSwitchRowHtml({
          label: t('settings.wallModeLabel'),
          checked: isWallModeEnabled(),
          icon: 'tablet',
          description: t('settings.wallModeHint'),
          descriptionId: 'wall-mode-hint',
          attrs: { id: 'wall-mode-toggle', 'aria-describedby': 'wall-mode-hint' },
        })}
        ${nightHoursRowHtml()}
        <!-- Next to wall mode and for the same reason: device-local (#885). A
             photo frame and a kitchen tablet in one household want different
             delays, and a household value would reach every phone too. The
             Immich connection itself stays under Household -> Integrations.
             OHNE IMMICH KEINE OPTIONEN (R20, Re-Critique 2026-10-17 a5 P3):
             drei Schalter fuer etwas, das nie startet, standen aktiv da. Jetzt
             EINE Zeile, die sagt, was fehlt - fuer Admins mit dem Weg dorthin. -->
        ${screensaverOn ? '' : settingRowHtml({
          label: t('settings.screensaverOffTitle'),
          description: t('settings.screensaverNeedsImmich'),
          descriptionId: 'screensaver-off-hint',
          control: isAdmin
            ? `<a class="btn btn--secondary" id="screensaver-connect" href="/settings/admin/integrations" aria-describedby="screensaver-off-hint">${esc(t('settings.screensaverConnectImmich'))}</a>`
            : '',
          attrs: { id: 'screensaver-off-row' },
        })}
        ${!screensaverOn ? '' : `${settingRowHtml({
          label: t('settings.screensaverIdleLabel'),
          labelFor: 'screensaver-idle-select',
          description: t('settings.screensaverIdleHint'),
          descriptionId: 'screensaver-idle-hint',
          control: `<select class="form-input" id="screensaver-idle-select" aria-describedby="screensaver-idle-hint">
            ${screensaverIdleOptions()}
          </select>`,
        })}
        <!-- What the screensaver shows, on this device too (#1766). -->
        ${settingSwitchRowHtml({
          label: t('settings.screensaverClockLabel'),
          checked: isScreensaverClockOn(),
          icon: 'clock',
          description: t('settings.screensaverClockHint'),
          descriptionId: 'screensaver-clock-hint',
          attrs: { id: 'screensaver-clock-toggle', 'aria-describedby': 'screensaver-clock-hint' },
        })}
        ${settingSwitchRowHtml({
          label: t('settings.screensaverCoverLabel'),
          checked: isScreensaverCoverOn(),
          icon: 'maximize',
          description: t('settings.screensaverCoverHint'),
          descriptionId: 'screensaver-cover-hint',
          attrs: { id: 'screensaver-cover-toggle', 'aria-describedby': 'screensaver-cover-hint' },
        })}`}
`;
}

/**
 * DIE NACHTSTUNDEN STEHEN UNTER DEM WAND-MODUS UND VOR DEM SCHONER (#2234,
 * #1901): sie gelten fuer beide, deshalb immer sichtbar - auch ohne Immich,
 * denn die Wand dunkelt trotzdem ab. Eine Zeile, zwei randlose Auswahlen im
 * zusammengesetzten Feld ("22:00 - 06:00"), die Gruppe heisst wie die Zeile.
 */
function nightHoursRowHtml() {
  const { from, to } = getNightHours();
  return settingRowHtml({
    label: t('settings.nightHoursLabel'),
    labelId: 'night-hours-label',
    description: t('settings.nightHoursHint'),
    descriptionId: 'night-hours-hint',
    control: `<span class="form-composite" role="group" aria-labelledby="night-hours-label" aria-describedby="night-hours-hint">
      <select class="form-input" id="night-hours-from" aria-label="${esc(t('settings.nightHoursFrom'))}">${nightHourOptions(from, to)}</select>
      <span class="form-composite__sep" aria-hidden="true">-</span>
      <select class="form-input" id="night-hours-until" aria-label="${esc(t('settings.nightHoursUntil'))}">${nightHourOptions(to, from)}</select>
    </span>`,
    attrs: { id: 'night-hours-row' },
  });
}

function renderDeviceDisplay(container, options = {}) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionDeviceDisplay')}</h2>
      <div class="row-carrier settings-group">${deviceDisplayRowsHtml(options)}</div>
      ${/* WAND AN ZWEI ORTEN, GEGENSEITIG VERWIESEN (R22, D13): der Modus
           dieses Geraets hier, das eigene Konto eines Wandtabletts unter
           "Wandtabletts" - das darf nur ein Admin anlegen. */ ''}
      ${options.isAdmin ? `<p class="form-hint settings-group__footer" id="wall-displays">
        ${esc(t('settings.wallDisplaysLinkHint'))}
        <a href="/settings/admin/displays" id="wall-displays-link">${esc(t('settings.pageDisplays'))}</a>
      </p>` : ''}
    </section>`);
  bindDeviceDisplay(container);
  window.lucide?.createIcons({ el: container });
}

/** Wand-Modus und Bildschirmschoner verdrahten (Blatt "Dieses Geraet"). */
function bindDeviceDisplay(container) {
  // Gerätelokal wie das Theme: kein Server-Request, keine Preference.
  // Wirksam wird er auf der Dashboard-Route - der Toast sagt das, statt den
  // Nutzer wortlos aus den Einstellungen zu werfen.
  const wallToggle = container.querySelector('#wall-mode-toggle');
  wallToggle?.addEventListener('change', () => {
    setWallModeEnabled(wallToggle.checked);
    window.yuvomi?.showToast(
      wallToggle.checked
        ? t('settings.wallModeOn', { page: t('nav.dashboard') })
        : t('settings.wallModeOff'),
      'success',
    );
  });

  // Der Weg zu Immich bleibt in der App (wie die Links der Settings-Shell):
  // navigate() fragt den Verlassen-Schutz, ein harter Seitenwechsel nicht.
  container.querySelector('#screensaver-connect')?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !window.yuvomi?.navigate) return;
    event.preventDefault();
    window.yuvomi.navigate('/settings/admin/integrations');
  });

  bindNightHoursSelects(container.querySelector('#night-hours-from'), container.querySelector('#night-hours-until'));
  bindScreensaverIdleSelect(container.querySelector('#screensaver-idle-select'));
  bindScreensaverSwitch(container.querySelector('#screensaver-clock-toggle'), setScreensaverClockOn);
  bindScreensaverSwitch(container.querySelector('#screensaver-cover-toggle'), setScreensaverCoverOn);

}

function bindEvents(container, user) {
  // Geteilte gleitende Kapsel (Re-Critique 2026-09-27, D8).
  const themeToggle = container.querySelector('#theme-toggle');
  if (themeToggle) attachSegmentIndicator(themeToggle);
  wireTablist(themeToggle, {
    activeId: currentTheme(),
    activeClass: 'is-active',
    mode: 'select',
    onChange: (value) => applyTheme(value),
  });

  bindDeviceDisplay(container);

  const localeSelect = container.querySelector('#locale-select');
  // Die Auswahl, die wirklich gilt (auch "System") - dorthin geht ein
  // gescheiterter Wechsel zurueck.
  const appliedLocaleChoice = localeSelect?.value;
  localeSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#locale-error');
    clearError(errorElement);
    localeSelect.disabled = true;
    try {
      if (localeSelect.value === 'system') {
        safeStorageRemove('yuvomi-locale');
        location.reload();
        return;
      }
      const locale = localeSelect.value;
      await setLocale(locale);
      await render(container, { user });
    } catch {
      // Die Sprachdatei kam nicht (offline, und dieses Geraet hat die Sprache
      // nie geladen). setLocale() hat dann nichts umgestellt - die Auswahl geht
      // zurueck auf die Sprache, die wirklich gilt, und die Zeile sagt warum.
      // Vorher stand hier der Parserfehler der Offline-Seite im Wortlaut.
      localeSelect.value = appliedLocaleChoice;
      showError(errorElement, t('common.errorOffline'));
    } finally {
      if (localeSelect.isConnected) localeSelect.disabled = false;
    }
  });

  // Datensprache: anders als der Locale-Picker darüber schreibt sie eine
  // haushaltweite Preference und betitelt serverseitig die bereits gespeicherten
  // Geburtstags-Termine um. Danach neu rendern, damit das Automatik-Label die
  // eventuell veränderte Ableitung zeigt.
  const dataLanguageSelect = container.querySelector('#data-language-select');
  let persistedDataLanguage = dataLanguageSelect?.value ?? '';
  dataLanguageSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#data-language-error');
    clearError(errorElement);
    dataLanguageSelect.disabled = true;
    try {
      await savePreferences({ language: dataLanguageSelect.value || null });
      persistedDataLanguage = dataLanguageSelect.value;
      // Nur die Optionen neu aufbauen statt die Seite: ein voller Re-Render nähme
      // dem gerade bedienten Select den Fokus und würde eine noch nicht
      // gespeicherte "Benutzerdefiniert"-Wahl im Region-Block wieder zuklappen.
      await refreshDataLanguageOptions(container);
      window.yuvomi?.showToast(t('settings.dataLanguageSaved'), 'success');
    } catch (error) {
      // Zurück auf den gespeicherten Wert: sonst zeigt die Seite eine
      // Datensprache an, die nie geschrieben wurde.
      dataLanguageSelect.value = persistedDataLanguage;
      showError(errorElement, errorSentence(error, 'settings.preferenceSaveFailed'));
    } finally {
      if (dataLanguageSelect.isConnected) dataLanguageSelect.disabled = false;
    }
  });

  const timezoneSelect = container.querySelector('#timezone-select');
  timezoneSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#timezone-error');
    clearError(errorElement);
    timezoneSelect.disabled = true;
    try {
      const saved = await savePreferences({ timezone: timezoneSelect.value || null });
      // Neu beschriften statt nur zu speichern: die Hinweiszeile nennt die Zone,
      // die bei "Automatisch" GILT. Wer von einer gesetzten Zone auf Automatisch
      // zurückstellt, sieht sonst weiter den alten Rückfallwert. Genommen wird
      // die PUT-Antwort, nicht ein zweiter GET - beide Felder stehen dort, und
      // der Server hat sie gerade frisch aufgelöst.
      refreshTimezone(container, saved?.data);
      // Die Anzeige folgt der neuen Zone sofort - dasselbe Paar aus Spiegeln und
      // Neuzeichnen wie bei Datums- und Zeitformat. Ohne das Ereignis blieben die
      // bereits gezeichneten Uhrzeiten bis zum naechsten Seitenwechsel stehen.
      setDisplayTimeZone(saved?.data?.timezone ?? null);
      window.dispatchEvent(new CustomEvent('timezone-changed', {
        detail: { timezone: saved?.data?.timezone ?? null },
      }));
      window.yuvomi?.showToast(t('settings.timezoneSaved'), 'success');
    } catch (error) {
      showError(errorElement, errorSentence(error, 'settings.preferenceSaveFailed'));
    } finally {
      if (timezoneSelect.isConnected) timezoneSelect.disabled = false;
    }
  });

  const regionSelect = container.querySelector('#region-select');
  regionSelect?.addEventListener('change', async () => {
    // Der volle Name gehoert zur Auswahl, nicht zum Speichern: er folgt sofort.
    setHint(container, 'region-hint', regionHintText(regionSelect.value));
    if (regionSelect.value === CUSTOM_REGION) {
      applyCustomVisibility(container, CUSTOM_REGION);
      return;
    }
    const preset = REGION_PRESETS[regionSelect.value];
    if (!preset) return;
    const errorElement = container.querySelector('#region-error');
    clearError(errorElement);
    regionSelect.disabled = true;
    // Die Waehrung mitsperren: der Regionswechsel schreibt sie mit und setzt das
    // Feld nach der Antwort auf den Preset-Wert. Wer waehrenddessen eine andere
    // waehlt, hat je nach Reihenfolge der Antworten entweder seine Wahl serverseitig
    // verloren oder sieht die des Presets, obwohl gespeichert wurde, was er wollte.
    // Zwei unabhaengige PUTs auf dasselbe Feld sind kein Zustand, den eine
    // Fehlermeldung heilt - also erst gar nicht zulassen.
    const currencyDuringRegion = container.querySelector('#currency-select');
    if (currencyDuringRegion) currencyDuringRegion.disabled = true;
    try {
      await savePreferences({
        currency: preset.currency,
        date_format: preset.date_format,
        time_format: preset.time_format,
        // Gewählte Region mitspeichern, sonst würde detectRegion() beim
        // nächsten Laden auf die erste Region mit gleichem Triple springen (#486).
        region: regionSelect.value,
      });
      const currencySelect = container.querySelector('#currency-select');
      if (currencySelect) currencySelect.value = preset.currency;
      syncCurrencyHint(container);
      const dateSelect = container.querySelector('#date-format-select');
      if (dateSelect) dateSelect.value = preset.date_format;
      const timeSelect = container.querySelector('#time-format-select');
      if (timeSelect) timeSelect.value = preset.time_format;
      safeStorageSet('yuvomi-date-format', preset.date_format);
      safeStorageSet('yuvomi-time-format', preset.time_format);
      applyNumberLocale({
        region: regionSelect.value,
        currency: preset.currency,
        date_format: preset.date_format,
        time_format: preset.time_format,
      });
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: preset.date_format },
      }));
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: preset.time_format },
      }));
      applyCustomVisibility(container, regionSelect.value);
      // Scheitert das Nachladen, bleibt nur das Automatik-Label stale - kein
      // Grund, den erfolgreichen Regionswechsel als Fehler zu melden.
      await refreshDataLanguageOptions(container).catch(() => {});
      window.yuvomi?.showToast(t('settings.regionSaved'), 'success');
    } catch (error) {
      showError(errorElement, errorSentence(error, 'settings.preferenceSaveFailed'));
    } finally {
      if (regionSelect.isConnected) regionSelect.disabled = false;
      if (currencyDuringRegion?.isConnected) currencyDuringRegion.disabled = false;
    }
  });

  const currencySelect = container.querySelector('#currency-select');
  let persistedCurrency = currencySelect?.value;
  currencySelect?.addEventListener('change', async () => {
    if (currencySelect.disabled) return;
    // Der volle Name gehoert zur Auswahl, nicht zum Speichern: er folgt sofort.
    syncCurrencyHint(container);
    const errorElement = container.querySelector('#currency-error');
    clearError(errorElement);
    try {
      await persistCurrencySelection(
        currencySelect,
        persistedCurrency,
        () => savePreferences({ currency: currencySelect.value }),
      );
      persistedCurrency = currencySelect.value;
      // EINE WAEHRUNGSAENDERUNG DARF DIE REGION NICHT WECHSELN. `detectRegion`
      // liest die Waehrung als Unterscheidungsmerkmal mit, also traf ein
      // de-DE-Haushalt, der EUR auf CHF stellt, formal exakt `de-CH` - und
      // `applyNumberLocale` stellte daraufhin die Betraege von deutscher auf
      // Schweizer Gruppierung um (1.234,50 → 1'234.50). Das ist das Gegenteil
      // dessen, was dieses Feld verspricht: die Waehrung sollte sich UNABHAENGIG
      // vom regionalen Format aendern lassen (#934).
      //
      // Bestaetigen darf die Herleitung die Region also, wechseln nicht. Passt
      // sie nicht mehr, ist der Zustand ehrlicherweise "benutzerdefiniert" -
      // Datum und Uhrzeit bleiben dabei unangetastet.
      const regionBefore = container.querySelector('#region-select')?.value;
      const derived = detectRegion({
        currency: currencySelect.value,
        date_format: container.querySelector('#date-format-select')?.value,
        time_format: container.querySelector('#time-format-select')?.value,
      });
      syncRegionSelect(container, { region: derived === regionBefore ? regionBefore : CUSTOM_REGION });
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.currencySaved'), 'success');
    } catch (error) {
      syncCurrencyHint(container);
      showError(errorElement, errorSentence(error, 'settings.preferenceSaveFailed'));
    }
  });

  const dateFormatSelect = container.querySelector('#date-format-select');
  dateFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#date-format-error');
    clearError(errorElement);
    dateFormatSelect.disabled = true;
    try {
      await savePreferences({ date_format: dateFormatSelect.value });
      safeStorageSet('yuvomi-date-format', dateFormatSelect.value);
      window.dispatchEvent(new CustomEvent('date-format-changed', {
        detail: { dateFormat: dateFormatSelect.value },
      }));
      syncRegionSelect(container, { mayHide: false });
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.dateFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, errorSentence(error, 'settings.preferenceSaveFailed'));
    } finally {
      dateFormatSelect.disabled = false;
    }
  });

  const timeFormatSelect = container.querySelector('#time-format-select');
  timeFormatSelect?.addEventListener('change', async () => {
    const errorElement = container.querySelector('#time-format-error');
    clearError(errorElement);
    timeFormatSelect.disabled = true;
    try {
      await savePreferences({ time_format: timeFormatSelect.value });
      safeStorageSet('yuvomi-time-format', timeFormatSelect.value);
      window.dispatchEvent(new CustomEvent('time-format-changed', {
        detail: { timeFormat: timeFormatSelect.value },
      }));
      syncRegionSelect(container, { mayHide: false });
      applyNumberLocale(readFormatState(container));
      window.yuvomi?.showToast(t('settings.timeFormatSavedToast'), 'success');
    } catch (error) {
      showError(errorElement, errorSentence(error, 'settings.preferenceSaveFailed'));
    } finally {
      timeFormatSelect.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  if (container.dataset?.part === 'device') {
    // `screensaver_enabled` (GET /preferences): ist Immich verbunden? Scheitert
    // die Frage, bleiben die Optionen stehen - lieber einstellbar als versteckt.
    let screensaverOn = true;
    try { screensaverOn = (await getPreferences()).screensaver_enabled !== false; } catch { /* s. o. */ }
    renderDeviceDisplay(container, { screensaverOn, isAdmin: user?.role === 'admin' });
    return;
  }
  try {
    const loaded = await getPreferences();
    const preferences = {
      currency: loaded.currency || 'EUR',
      date_format: loaded.date_format || 'dmy',
      time_format: loaded.time_format || '24h',
      region: loaded.region || null,
      language: loaded.language || null,
      language_auto: loaded.language_auto || 'en',
      // Beide Zonen-Felder gehoeren hier durchgereicht: renderPage() liest sie
      // (Auswahlzustand und Automatik-Label), und ohne sie stand das Feld nach
      // dem Speichern beim naechsten Oeffnen wieder auf "Automatisch (UTC)" -
      // die Zone WAR gesetzt, das Formular zeigte sie nur nicht.
      timezone: loaded.timezone || null,
      timezone_effective: loaded.timezone_effective || null,
    };

    safeStorageSet('yuvomi-date-format', preferences.date_format);
    safeStorageSet('yuvomi-time-format', preferences.time_format);
    setDisplayTimeZone(preferences.timezone);
    applyNumberLocale(preferences);
    const isAdmin = user?.role === 'admin';
    renderPage(container, preferences, isAdmin);
    bindEvents(container, user);
    mountTimezoneMismatch(container, preferences, isAdmin);
    window.lucide?.createIcons({ el: container });
  } catch {
    renderLoadError(container);
    container.querySelector('#appearance-retry')?.addEventListener('click', () => {
      render(container, { user });
    });
  }
}
