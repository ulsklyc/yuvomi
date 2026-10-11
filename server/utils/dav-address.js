// --------------------------------------------------------
// EIN Leser für Adressen von CalDAV-Objekten und -Kalendern (#1860).
//
// Wem eine Zeile gehört, steht in gespeicherten Schlüsseln, nicht hier. Diese
// Datei beantwortet nur die Frage danach: liegt die Adresse, an die eine
// Anfrage ginge, in dem Kalender, dem die Zeile laut diesen Schlüsseln gehört -
// und wie lautet sie, so wie der HTTP-Client sie liest?
//
// Beides aus EINEM Durchgang, weil zwei Leser sich widersprechen können: ein
// Vergleich, der eine Adresse anders liest als der Client, der sie abschickt,
// prüft eine andere Adresse als die angefragte. Deshalb
//
//   - liest `new URL()` jede Adresse, derselbe Parser wie in `fetch`: Host klein,
//     Standardport weg, `.`/`..` aufgelöst (auch als `%2e`), Backslash als
//     Schrägstrich;
//   - wird der Pfad je SEGMENT verglichen, nie als Zeichenkette - ein Kalender
//     `/cal/family` enthält `/cal/family-2/x.ics` nicht;
//   - wird je Segment dekodiert und neu kodiert, damit `@` und `%40` dasselbe
//     sind, ohne dass ein kodierter Schrägstrich zu einer Pfadgrenze wird;
//   - geht die Anfrage an `href` aus genau diesem Durchgang, nie an die
//     gespeicherte Zeichenkette.
//
// Was sich nicht eindeutig lesen lässt, ist `null`, und `null` liegt nirgends:
// kein http(s), Benutzerangaben in der Adresse, kaputte Prozentkodierung, ein
// kodierter Schrägstrich oder Backslash in einem Segment (ob der Server daraus
// eine Pfadgrenze macht, weiss hier niemand).
//
// Ohne Importe und ohne Datenbank.
// --------------------------------------------------------

/**
 * @param {unknown} raw
 * @returns {{origin: string, segments: string[], search: string, href: string}|null}
 */
export function davAddress(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';

  const segments = [];
  for (const part of url.pathname.split('/').slice(1)) {
    let plain;
    try { plain = decodeURIComponent(part); } catch { return null; }
    if (plain.includes('/') || plain.includes('\\') || plain === '.' || plain === '..') return null;
    segments.push(encodeURIComponent(plain));
  }
  return { origin: url.origin, segments, search: url.search, href: url.href };
}

/** Segmente einer Sammlung ohne den leeren Rest hinter dem letzten Schrägstrich. */
function collectionSegments(address) {
  const { segments } = address;
  return segments[segments.length - 1] === '' ? segments.slice(0, -1) : segments;
}

function startsWithSegments(segments, prefix) {
  return segments.length > prefix.length && prefix.every((segment, i) => segment === segments[i]);
}

/**
 * Die Adresse eines Objekts, wenn es in einem dieser Kalender liegt - in der
 * Form, in der die Anfrage hinausgeht. Sonst `null`.
 *
 * @param {unknown} objectUrl
 * @param {Iterable<unknown>} calendarUrls
 * @returns {string|null}
 */
export function addressWithin(objectUrl, calendarUrls) {
  const object = davAddress(objectUrl);
  // Ein Objekt hat einen Namen: eine Adresse, die auf `/` endet, ist keins.
  if (!object || object.segments[object.segments.length - 1] === '') return null;
  for (const calendarUrl of calendarUrls || []) {
    const calendar = davAddress(calendarUrl);
    if (!calendar || calendar.origin !== object.origin || calendar.search !== object.search) continue;
    if (startsWithSegments(object.segments, collectionSegments(calendar))) return object.href;
  }
  return null;
}

/** Dieselbe Adresse, durch denselben Leser. Nicht lesbar ist nie dieselbe. */
export function sameDavAddress(a, b) {
  const left = davAddress(a);
  const right = davAddress(b);
  return !!left && !!right
    && left.origin === right.origin && left.search === right.search
    && left.segments.length === right.segments.length
    && left.segments.every((segment, i) => segment === right.segments[i]);
}

/**
 * Liegt dieses Objekt in einem Kalender NEBEN einem dieser Kalender - im selben
 * Kalender-Home, also beim selben Benutzer desselben Servers?
 *
 * Wo sich kein Besitzer erkennen lässt, gilt nichts als zugehörig: eine Adresse
 * mit Abfrage (dort unterscheidet womöglich sie die Benutzer) oder ein
 * Kalender direkt an der Wurzel.
 */
export function inCalendarHomeOf(objectUrl, calendarUrls) {
  const object = davAddress(objectUrl);
  if (!object || object.search || object.segments[object.segments.length - 1] === '') return false;
  // .../<home>/<kalender>/<objekt>
  const home = object.segments.slice(0, -2);
  if (object.segments.length < 3 || home.length < 1) return false;
  for (const calendarUrl of calendarUrls || []) {
    const calendar = davAddress(calendarUrl);
    if (!calendar || calendar.search || calendar.origin !== object.origin) continue;
    const calendarHome = collectionSegments(calendar).slice(0, -1);
    if (calendarHome.length === home.length && calendarHome.every((segment, i) => segment === home[i])) return true;
  }
  return false;
}
