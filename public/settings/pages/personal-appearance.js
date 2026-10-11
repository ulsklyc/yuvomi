import {
  formatUnit,
  getLocale,
  getSupportedLocales,
  setLocale,
  t,
} from '/i18n.js';
import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { appendCurrencyOptions, persistCurrencySelection } from '/settings/currency.js';
import { getPreferences, resetPreferencesCache, savePreferences } from '/settings/preferences-cache.js';
import { settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { wireTablist } from '/utils/tablist.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { isWallModeEnabled, setWallModeEnabled } from '/utils/wall-mode.js';
import {
  SCREENSAVER_IDLE_STEPS,
  getScreensaverIdleSeconds,
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
  numberLocaleFor,
} from '/settings/region-presets.js';

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
 * zurück (TZ → Systemzone → UTC). Ihr Label nennt die Zone, die dann tatsächlich
 * gilt - sonst wäre "Automatisch" eine Zusage ohne Inhalt.
 */
function timeZoneOptions(selected, effective) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  // Eine gespeicherte Zone, die dieses ICU nicht (mehr) kennt, muss sichtbar
  // bleiben: sonst zeigte das Feld "Automatisch", während der Server weiter die
  // alte Zone benutzt - ein Select, das die Wahrheit verschweigt.
  if (selected && !zones.includes(selected)) zones = [...zones, selected].sort();

  const auto = `<option value=""${selected ? '' : ' selected'}>`
    + `${esc(t('settings.timezoneAuto', { zone: effective || 'UTC' }))}</option>`;

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
    const area = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(zone);
  }
  const body = [...groups.entries()].map(([area, list]) => {
    const opts = list.map((zone) => {
      // Das Label laesst die Region weg - die steht schon an der optgroup, und
      // "America > America/New York" liest sich wie ein Fehler. Was uebrig
      // bleibt, behaelt seine restlichen Schraegstriche
      // ("Argentina/Buenos Aires"); der VALUE bleibt die volle IANA-Kennung.
      const label = (zone.includes('/') ? zone.slice(zone.indexOf('/') + 1) : zone).replace(/_/g, ' ');
      return `<option value="${esc(zone)}"${zone === selected ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
    return `<optgroup label="${esc(area)}">${opts}</optgroup>`;
  }).join('');

  return auto + utc + body;
}

function regionOptions(selectedRegion) {
  const locale = getLocale();
  // Nach dem angezeigten Namen sortieren, nicht nach der Reihenfolge in
  // REGION_PRESETS: die ist nach Sprachfamilie gruppiert und war bei einem
  // Dutzend Einträgen noch überschaubar. Mit der Amerika-Abdeckung sind es
  // über 60 - da findet man "Spanisch (Peru)" nur alphabetisch wieder.
  // detectRegion() bleibt von der Sortierung unberührt, es liest das Objekt.
  const presets = [...REGION_CODES]
    .map((code) => ({ code, label: regionLabel(code, locale) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale))
    .map(({ code, label }) => (
      `<option value="${esc(code)}"${selectedRegion === code ? ' selected' : ''}>${esc(label)}</option>`
    )).join('');
  const custom = `<option value="${CUSTOM_REGION}"${selectedRegion === CUSTOM_REGION ? ' selected' : ''}>${t('settings.regionCustom')}</option>`;
  return presets + custom;
}

function localeLabel(locale) {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(locale) || locale;
  } catch {
    return locale;
  }
}

function localeOptions() {
  const storedLocale = safeStorageGet('yuvomi-locale');
  return [
    `<option value="system"${storedLocale ? '' : ' selected'}>${t('settings.localeSystem')}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${storedLocale === locale ? ' selected' : ''}>${esc(localeLabel(locale))}</option>`
    )),
  ].join('');
}

/**
 * Optionen für die Datensprache des Haushalts (#631, #632). Der leere Wert steht
 * für "automatisch"; sein Label nennt die Sprache, auf die die Automatik fiele -
 * `language_auto`, nicht `language_effective`. Bei explizit gewählter Sprache
 * sind die beiden verschieden, und `language_effective` würde dort genau die
 * gewählte Sprache als Automatik-Ergebnis ausgeben.
 */
function dataLanguageOptions(selected, auto_) {
  const auto = t('settings.dataLanguageAuto', { language: localeLabel(auto_) });
  return [
    `<option value=""${selected ? '' : ' selected'}>${esc(auto)}</option>`,
    ...getSupportedLocales().map((locale) => (
      `<option value="${esc(locale)}"${selected === locale ? ' selected' : ''}>${esc(localeLabel(locale))}</option>`
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
        <!-- Next to wall mode and for the same reason: device-local (#885). A
             photo frame and a kitchen tablet in one household want different
             delays, and a household value would reach every phone too. The
             Immich connection itself stays under Household -> Integrations. -->
        ${settingRowHtml({
          label: t('settings.screensaverIdleLabel'),
          labelFor: 'screensaver-idle-select',
          description: t('settings.screensaverIdleHint'),
          descriptionId: 'screensaver-idle-hint',
          control: `<select class="form-input" id="screensaver-idle-select" aria-describedby="screensaver-idle-hint">
            ${screensaverIdleOptions()}
          </select>`,
        })}
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
          description: t('settings.dataLanguageHint'),
          descriptionId: 'data-language-hint',
          extra: '<div id="data-language-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="data-language-select" aria-describedby="data-language-hint data-language-error">
            ${dataLanguageOptions(preferences.language, preferences.language_auto)}
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
          description: t('settings.regionHint'),
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
          description: t('settings.currencyHint'),
          descriptionId: 'currency-hint',
          extra: '<div id="currency-error" class="form-error" role="alert" hidden></div>',
          control: '<select class="form-input" id="currency-select" aria-describedby="currency-hint currency-error"></select>',
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
          description: t('settings.timezoneHint'),
          descriptionId: 'timezone-hint',
          extra: '<div id="timezone-error" class="form-error" role="alert" hidden></div>',
          control: `<select class="form-input" id="timezone-select" aria-describedby="timezone-hint timezone-error">
            ${timeZoneOptions(preferences.timezone, preferences.timezone_effective)}
          </select>`,
          attrs: { id: 'timezone-card' },
        })}
      </div>` : `
      <div class="row-carrier settings-group">
        ${settingRowHtml({
          label: t('settings.timezoneTitle'),
          description: t('settings.timezoneAdminOnly'),
          control: `<span class="settings-setting-row__value">${esc(t('settings.timezoneAuto', { zone: preferences.timezone_effective || 'UTC' }))}</span>`,
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
 * Regel im Client zu wiederholen.
 */
async function refreshDataLanguageOptions(container) {
  const select = container.querySelector('#data-language-select');
  if (!select) return;
  const preferences = await getPreferences();
  select.replaceChildren();
  select.insertAdjacentHTML('beforeend', dataLanguageOptions(
    preferences.language || null,
    preferences.language_auto || 'en',
  ));
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
      if (result.adopted) window.yuvomi?.showToast(t('settings.timezoneSaved'), 'success');
    } : undefined,
    onError: (error) => {
      if (errorElement) showError(errorElement, error?.message);
      else window.yuvomi?.showToast(error?.message || t('common.errorGeneric'), 'danger');
    },
  }));
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

  // Gerätelokal wie das Theme darüber: kein Server-Request, keine Preference.
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

  bindScreensaverIdleSelect(container.querySelector('#screensaver-idle-select'));

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
      showError(errorElement, error.message);
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
      // Neu beschriften statt nur zu speichern: das Label der ersten Option
      // nennt die Zone, die bei "Automatisch" GILT. Wer von einer gesetzten Zone
      // auf Automatisch zurückstellt, sieht sonst weiter den alten Rückfallwert.
      // Genommen wird die PUT-Antwort, nicht ein zweiter GET - beide Felder
      // stehen dort, und der Server hat sie gerade frisch aufgelöst.
      timezoneSelect.replaceChildren();
      timezoneSelect.insertAdjacentHTML(
        'beforeend', timeZoneOptions(saved?.data?.timezone, saved?.data?.timezone_effective)
      );
      // Die Anzeige folgt der neuen Zone sofort - dasselbe Paar aus Spiegeln und
      // Neuzeichnen wie bei Datums- und Zeitformat. Ohne das Ereignis blieben die
      // bereits gezeichneten Uhrzeiten bis zum naechsten Seitenwechsel stehen.
      setDisplayTimeZone(saved?.data?.timezone ?? null);
      window.dispatchEvent(new CustomEvent('timezone-changed', {
        detail: { timezone: saved?.data?.timezone ?? null },
      }));
      window.yuvomi?.showToast(t('settings.timezoneSaved'), 'success');
    } catch (error) {
      showError(errorElement, error.message);
    } finally {
      if (timezoneSelect.isConnected) timezoneSelect.disabled = false;
    }
  });

  const regionSelect = container.querySelector('#region-select');
  regionSelect?.addEventListener('change', async () => {
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
      showError(errorElement, error.message);
    } finally {
      if (regionSelect.isConnected) regionSelect.disabled = false;
      if (currencyDuringRegion?.isConnected) currencyDuringRegion.disabled = false;
    }
  });

  const currencySelect = container.querySelector('#currency-select');
  let persistedCurrency = currencySelect?.value;
  currencySelect?.addEventListener('change', async () => {
    if (currencySelect.disabled) return;
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
      showError(errorElement, error.message);
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
      showError(errorElement, error.message);
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
      showError(errorElement, error.message);
    } finally {
      timeFormatSelect.disabled = false;
    }
  });
}

export async function render(container, { user }) {
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
    if (isAdmin) {
      appendCurrencyOptions(container.querySelector('#currency-select'), preferences.currency);
    }
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
