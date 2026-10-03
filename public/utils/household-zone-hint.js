/**
 * Modul: Zonen-Hinweis fuer Bestandshaushalte (#1607, Punkt 4)
 * Zweck: Ein Haushalt ohne gesetzte Zone rechnet serverseitig in `TZ` - im
 *        Container meist UTC. "Essen heute" bleibt dann bis zum Offset leer,
 *        der Ueberfaellig-Zaehler stimmt nicht. Die Ersteinrichtung schickt die
 *        Zone des Browsers mit; wer schon eingerichtet ist, wird EINMAL
 *        gefragt, statt dass die Zone still nachgezogen wird: an ihr haengen
 *        der Tag der Server-Jobs, der ICS-Feed und die Uhrzeit, mit der Termine
 *        zu Google und Outlook gehen.
 * Abhaengigkeiten: ./timezone.js. `t` und `api` kommen herein, damit die
 *        Bedingung, die zwei Handlungen und die Bauform ohne Loader und ohne
 *        Browser pruefbar sind (test/test-household-zone-hint.js).
 *
 * ZWEI ORTE, EINE BEDINGUNG. Die Uebersicht zeigt den Hinweis Admins, bis einer
 * von ihnen entschieden hat (`zonePrompt`); die Zeitzonen-Karte der
 * Einstellungen zeigt dieselbe Zeile, solange die Abweichung besteht
 * (`zoneMismatch`) - dort ohne Wegklick, und ohne Handlung fuer Mitglieder.
 *
 * WOHER DER STAND KOMMT. `rememberZonePrefs()` bekommt die Antwort, die der
 * Router beim Anmelden ohnehin abwartet, BEVOR die erste Seite zeichnet. Der
 * Hinweis steht deshalb schon neben dem Skelett und schiebt nichts nach.
 * Danach aendern ihn nur noch die zwei Handlungen hier und `noteZoneDecision()`,
 * das der Router an `timezone-changed` haengt - das Ereignis feuert nur nach
 * einem geglueckten Schreiben, auch dem des Auswahlfelds. Bewusst NICHT die
 * `/preferences`-Antwort, die die Uebersicht bei jedem Aufbau selbst holt: eine
 * Anfrage, die vor dem Schreiben losging und danach ankommt, stellte den
 * Hinweis wieder hin (die veraltete Antwort ueberholt den Schreibvorgang).
 */

import { browserTimeZone, isValidTimeZone, setDisplayTimeZone, zonedFields } from './timezone.js';

const DAY_MS = 86_400_000;
const QUARTER_MS = 900_000;
/** Ein Jahr zurueck, ein Jahr voraus: beide Umstellungen jeder Zone, zweimal. */
const WINDOW_DAYS = 366;

/** UTC-Versatz der Zone zu einem Zeitpunkt, in Sekunden. */
function offsetAt(zone, ms) {
  const f = zonedFields(new Date(ms), zone);
  return (Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - ms) / 1000;
}

const _sameClockCache = new Map();

/**
 * Zeigen zwei Zonen-IDs dieselbe Uhr?
 *
 * DIE ID ALLEIN REICHT NICHT, DER OFFSET VON HEUTE AUCH NICHT. Chrome meldet
 * fuer Indien `Asia/Calcutta`, Firefox `Asia/Kolkata`; ein Hinweis "dein
 * Browser steht in Asia/Calcutta, der Haushalt rechnet in Asia/Kolkata"
 * behauptete eine Abweichung, die es nicht gibt. Umgekehrt stehen Phoenix und
 * Denver im Januar auf demselben Offset und im Juli nicht.
 *
 * Eine Alias-Tabelle hat der Browser nicht (`resolvedOptions()` gibt je nach
 * Engine den Alias oder den kanonischen Namen zurueck). Gemessen wird deshalb
 * das Verhalten: dieselbe Uhr ist es nur, wenn beide Zonen ueber ein Jahr
 * zurueck und ein Jahr voraus an JEDEM Tag denselben Offset haben und an den
 * Umstelltagen im Viertelstundenraster ebenfalls (Havanna und New York stellen
 * an denselben Tagen um, zu verschiedenen Stunden).
 *
 * KONSERVATIV HEISST HIER: im Zweifel "abweichend". Ein ueberfluessiger Hinweis
 * kostet einen Klick auf "So lassen", ein fehlender laesst den falschen Tag
 * stehen. Zwei Zonen, die diese Probe bestehen (Europe/Berlin und
 * Europe/Paris), liefern in diesem Fenster jedes "heute" und jede Uhrzeit
 * gleich - der Hinweis haette nichts zu aendern. Was sie VOR dem Fenster
 * unterschied, betrifft nur Zeitpunkte, die laengst umgerechnet gespeichert
 * sind.
 *
 * @param {string} a  IANA-Zone
 * @param {string} b  IANA-Zone
 * @param {Date} [now]  Ersetzbar fuer Tests
 * @returns {boolean}
 */
export function sameClock(a, b, now = new Date()) {
  if (!isValidTimeZone(a) || !isValidTimeZone(b)) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;

  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const key = `${a}|${b}|${today}`;
  if (_sameClockCache.has(key)) return _sameClockCache.get(key);

  let same = true;
  let previous = null;
  for (let day = -WINDOW_DAYS; same && day <= WINDOW_DAYS; day += 1) {
    const ms = today + day * DAY_MS;
    const offset = offsetAt(a, ms);
    if (offset !== offsetAt(b, ms)) { same = false; break; }
    // Zwischen zwei Tagesproben hat die Zone umgestellt: diesen Tag fein lesen.
    if (previous !== null && offset !== previous) {
      for (let q = ms - DAY_MS + QUARTER_MS; q < ms; q += QUARTER_MS) {
        if (offsetAt(a, q) !== offsetAt(b, q)) { same = false; break; }
      }
    }
    previous = offset;
  }
  _sameClockCache.clear();   // ein Eintrag reicht: es gibt je Sitzung ein Paar
  _sameClockCache.set(key, same);
  return same;
}

/**
 * Steht der Browser in einer anderen Zone, als der Haushalt rechnet - und hat
 * der Haushalt noch keine gewaehlt?
 *
 * Das ist die Bedingung der Zeile in den Einstellungen. Sie kennt weder Rolle
 * noch Merker: dort gibt es keinen Wegklick, und ein Mitglied sieht den
 * Zustand ohne Handlung.
 *
 * @param {object|null} prefs  `timezone` und `timezone_effective` aus /preferences
 * @param {string|null} [browserZone]
 * @param {Date} [now]
 * @returns {{browser:string,household:string}|null}
 */
export function zoneMismatch(prefs, browserZone = browserTimeZone(), now = new Date()) {
  // `=== null` und nicht "falsy": eine Antwort OHNE das Feld (Fehler, das
  // Wandtablett bekommt einen Ausschnitt) ist kein "nie gesetzt".
  if (!prefs || prefs.timezone !== null) return null;
  const household = prefs.timezone_effective;
  if (!browserZone || !isValidTimeZone(household)) return null;
  if (sameClock(browserZone, household, now)) return null;
  return { browser: browserZone, household };
}

/**
 * Soll dieser Nutzer gefragt werden?
 *
 * Die billigen Fragen zuerst: der Zonenvergleich liest ein paar hundert
 * Offsets und laeuft so nur fuer den einen Fall, der ihn braucht.
 *
 * @param {object|null} prefs
 * @param {{role?:string,access_scope?:string}|null} user
 * @param {{browserZone?:string|null, wall?:boolean, now?:Date}} [options]
 * @returns {{browser:string,household:string}|null}
 */
export function zonePrompt(prefs, user, { browserZone, wall = false, now } = {}) {
  if (wall || user?.role !== 'admin' || user.access_scope === 'display') return null;
  if (!prefs || prefs.timezone_hint_dismissed !== false) return null;
  return zoneMismatch(prefs, browserZone === undefined ? browserTimeZone() : browserZone, now);
}

let _prefs = null;

function pick(data) {
  if (!data || typeof data !== 'object') return null;
  // Fehlende Felder bleiben `undefined` - siehe `zoneMismatch`.
  return {
    timezone: data.timezone,
    timezone_effective: data.timezone_effective,
    timezone_hint_dismissed: data.timezone_hint_dismissed,
  };
}

/** Der Stand aus einer /preferences-Antwort (Router, beim Anmelden). */
export function rememberZonePrefs(data) {
  _prefs = pick(data);
}

/** Beim Abmelden und beim Sitzungsablauf: der naechste Nutzer liest neu. */
export function forgetZonePrefs() {
  _prefs = null;
}

/** @returns {{timezone:any,timezone_effective:any,timezone_hint_dismissed:any}|null} */
export function knownZonePrefs() {
  return _prefs;
}

/**
 * Ein Admin hat die Zone geschrieben - irgendwo, nicht hier (das Auswahlfeld
 * der Einstellungen). Der Router ruft das bei jedem `timezone-changed`.
 *
 * Ohne das blieb der Stand der Sitzung bei `timezone: null`, und die Uebersicht
 * fragte weiter, obwohl der Server laengst eine Zone fuehrt. Auch `null` ist
 * eine Entscheidung ("Automatisch"): der Server setzt bei jeder angenommenen
 * timezone-Schreibung den Merker, dieser Stand also ebenfalls.
 *
 * Kein Stand geladen heisst: nichts erfinden - `timezone_effective` kennt nur
 * der Server.
 * @param {string|null|undefined} timezone  `detail.timezone` des Ereignisses
 */
export function noteZoneDecision(timezone) {
  if (!_prefs) return;
  const chosen = isValidTimeZone(timezone) ? timezone : null;
  _prefs = {
    timezone: chosen,
    timezone_effective: chosen ?? _prefs.timezone_effective,
    timezone_hint_dismissed: true,
  };
}

/**
 * Die Anzeige auf die Zone des Haushalts stellen und offene Ansichten neu
 * zeichnen - dasselbe Paar, das das Auswahlfeld der Einstellungen nach seinem
 * Speichern ausloest (router.js haengt an `timezone-changed`).
 */
function mirror(timezone) {
  setDisplayTimeZone(timezone ?? null);
  window.dispatchEvent(new CustomEvent('timezone-changed', { detail: { timezone: timezone ?? null } }));
}

/**
 * "Uebernehmen": die Zone des Browsers wird die Zone des Haushalts.
 *
 * ERST NACHLESEN. Der Hinweis kann in einem zweiten Tab oder beim zweiten Admin
 * noch stehen, nachdem der erste laengst entschieden hat - mit der Zone SEINES
 * Browsers. Ein blindes PUT ueberschriebe dessen Wahl. Steht inzwischen eine
 * Zone, gilt sie, und die Anzeige folgt ihr.
 *
 * `respectDismissed` ist das Band der Uebersicht: hat inzwischen jemand "So
 * lassen" gesagt, ist die Frage fuer den Haushalt beantwortet, und ein alter
 * Tab darf sie nicht umdrehen - das Band verschwindet, geschrieben wird nichts.
 * Die Zeile der Zeitzonen-Karte setzt es NICHT: sie hat keinen Wegklick und ist
 * der Ort, an dem die Handlung nach "So lassen" auffindbar bleibt.
 *
 * @param {string} zone  IANA-Zone
 * @param {{api:{get:Function,put:Function}, respectDismissed?:boolean}} deps
 * @returns {Promise<{adopted:boolean,timezone:string|null}>}
 */
export async function adoptZone(zone, { api, respectDismissed = false }) {
  const current = (await api.get('/preferences'))?.data;
  if (current && current.timezone) {
    _prefs = pick(current);
    mirror(current.timezone);
    return { adopted: false, timezone: current.timezone };
  }
  if (respectDismissed && current?.timezone_hint_dismissed === true) {
    _prefs = pick(current);
    return { adopted: false, timezone: null };
  }
  const saved = (await api.put('/preferences', { timezone: zone }))?.data ?? {};
  const timezone = saved.timezone ?? null;
  _prefs = pick({ ...saved, timezone });
  mirror(timezone);
  return { adopted: true, timezone };
}

/**
 * "So lassen": die Entscheidung wird am HAUSHALT gemerkt (sync_config), nicht
 * am Geraet - sonst fragte jedes Telefon jedes Admins einzeln nach.
 * @param {{api:{put:Function}}} deps
 */
export async function keepZone({ api }) {
  const saved = (await api.put('/preferences', { timezone_hint_dismissed: true }))?.data;
  _prefs = { ...(_prefs ?? {}), timezone_hint_dismissed: true };
  // Hat inzwischen ein anderer Admin eine Zone gewaehlt, traegt die Antwort
  // sie. Der Hinweis geht hier ohnehin - die Anzeige muss der Zone dann aber
  // folgen, sonst rechnete diese Sitzung bis zum Neuladen in der des Browsers.
  if (saved?.timezone) {
    _prefs = pick(saved);
    mirror(saved.timezone);
  }
}

/**
 * Die Zeile selbst. Die Bauform ist das Band, das der Router ueber ein
 * Nur-lesen-Modul setzt (`.module-readonly-banner` / `.page-notice`,
 * layout.css), mit den Knoepfen als zweiter Haelfte des Satzes.
 *
 * Ohne `onAdopt`/`onKeep` entsteht der jeweilige Knopf nicht: ein Mitglied
 * sieht den Zustand, aber keine Handlung, die der Server mit 403 beantwortet.
 *
 * @param {object} options
 * @param {{browser:string,household:string}} options.mismatch
 * @param {(key:string, params?:object)=>string} options.t
 * @param {() => Promise<unknown>} [options.onAdopt]
 * @param {() => Promise<unknown>} [options.onKeep]
 * @param {(error:Error) => void} [options.onError]
 * @returns {HTMLElement}
 */
export function zoneHintEl({ mismatch, t, onAdopt, onKeep, onError }) {
  const el = document.createElement('div');
  el.className = 'page-notice zone-hint';
  el.setAttribute('role', 'status');

  const text = document.createElement('p');
  text.className = 'zone-hint__text';
  text.textContent = t('settings.timezoneMismatch', mismatch);
  el.appendChild(text);

  const buttons = [];
  const button = (labelKey, tone, action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn--${tone} btn--sm`;
    btn.textContent = t(labelKey);
    btn.addEventListener('click', async () => {
      // Beide sperren: sonst liefen "Uebernehmen" und "So lassen" gegeneinander.
      for (const b of buttons) b.disabled = true;
      try {
        await action();
      } catch (error) {
        for (const b of buttons) b.disabled = false;
        onError?.(error);
      }
    });
    buttons.push(btn);
    return btn;
  };

  if (onAdopt || onKeep) {
    const actions = document.createElement('div');
    actions.className = 'zone-hint__actions';
    if (onAdopt) actions.appendChild(button('settings.timezoneMismatchAdopt', 'primary', onAdopt));
    if (onKeep) actions.appendChild(button('settings.timezoneMismatchKeep', 'ghost', onKeep));
    el.appendChild(actions);
  }
  el._zoneHintButtons = buttons;
  return el;
}

/** Die Knoepfe einer Zeile, in Reihenfolge - fuer Tests und fuer den Fokus. */
export function zoneHintButtons(el) {
  return el?._zoneHintButtons ?? [];
}

/**
 * Der Hinweis der Uebersicht: setzt die Zeile in `host` (vor `before`), wenn
 * dieser Nutzer gefragt werden soll.
 *
 * @param {HTMLElement|null} host
 * @param {object} deps
 * @param {object|null} deps.user
 * @param {Function} deps.t
 * @param {{get:Function,put:Function}} deps.api
 * @param {boolean} [deps.wall]  Wandmodus: nie
 * @param {(message:string, type:string) => void} [deps.toast]
 * @param {Node|null} [deps.before]  Kind von `host`, vor dem die Zeile steht
 * @returns {HTMLElement|null}
 */
export function mountZonePrompt(host, { user, t, api, wall = false, toast, before = null } = {}) {
  if (!host) return null;
  const mismatch = zonePrompt(_prefs, user, { wall });
  if (!mismatch) return null;
  const el = zoneHintEl({
    mismatch,
    t,
    onAdopt: async () => {
      const result = await adoptZone(mismatch.browser, { api, respectDismissed: true });
      el.remove();
      if (result.adopted) toast?.(t('settings.timezoneSaved'), 'success');
    },
    onKeep: async () => {
      await keepZone({ api });
      el.remove();
    },
    onError: (error) => toast?.(error?.message || t('common.errorGeneric'), 'danger'),
  });
  host.insertBefore(el, before ?? host.firstChild);
  return el;
}
