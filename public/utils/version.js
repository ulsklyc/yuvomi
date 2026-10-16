/**
 * Versionsvergleich für den Update-Hinweis (#490).
 *
 * Verglichen werden ausschließlich Releases aus derselben Quelle (GitHub-Tags
 * gegen die installierte package.json-Version), deshalb reicht ein bewusst
 * kleiner Semver-Teilausschnitt: numerische Segmente plus die Regel, dass eine
 * Vorabversion (`1.84.0-rc.1`) kleiner ist als ihr fertiges Release. Ein
 * unparsebarer Wert gilt als "unbekannt" und löst nie einen Hinweis aus - ein
 * falscher Punkt an der Navigation wäre schlimmer als ein fehlender.
 */

/** Zerlegt "v1.84.0-rc.1" in { parts: [1,84,0], prerelease: 'rc.1' } oder null. */
function parseVersion(value) {
  const raw = String(value ?? '').trim().replace(/^v/i, '');
  if (!raw) return null;
  const [core, ...rest] = raw.split('-');
  const parts = core.split('.').map((segment) => Number(segment));
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return { parts, prerelease: rest.join('-') };
}

/**
 * Vergleicht zwei Versionen.
 * @returns {number|null} <0 wenn a älter, 0 wenn gleich, >0 wenn a neuer;
 *                        null, wenn eine der beiden nicht lesbar ist.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i += 1) {
    // Fehlende Segmente zählen als 0, damit "1.84" und "1.84.0" gleich sind.
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Versionsnummer ohne `v`-Präfix. GitHub-Tags tragen es, package.json nicht -
 * ungefiltert stünde in „Version {{version}} ist verfügbar" ein zweites v.
 */
export function displayVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '');
}

/** True, wenn `candidate` nachweislich neuer ist als `current`. */
export function isNewerVersion(candidate, current) {
  const result = compareVersions(candidate, current);
  return result !== null && result > 0;
}

/**
 * Die Releases, die auf DIESER Instanz seit dem letzten Blick dazugekommen sind
 * (#496).
 *
 * ZWEI Grenzen, und beide sind noetig. Neuer als der letzte Blick - sonst ist
 * es nichts Neues. Und NICHT neuer als das, was hier laeuft - sonst stuende in
 * der Liste, was auf GitHub veroeffentlicht wurde, bei diesem Haushalt aber
 * noch gar nicht angekommen ist. Genau diese zweite Grenze unterscheidet die
 * Frage "was hat sich fuer mich geaendert" von der Frage "gibt es ein Update",
 * die der Punkt an der Navigation beantwortet.
 *
 * Ohne `seenInstalled` ist die Antwort leer: wer zum ersten Mal hinsieht, hat
 * nichts verpasst, das wir wuessten, und ihm alles zu zeigen waere die
 * Behauptung, er haette alles verpasst.
 *
 * @param {{version?: string}[]} releases
 * @param {string} currentVersion   die hier laufende Version
 * @param {string} seenInstalled    die laufende Version beim letzten Blick
 */
export function releasesNewForMe(releases, currentVersion, seenInstalled) {
  if (!seenInstalled || !currentVersion) return [];
  return (Array.isArray(releases) ? releases : []).filter((r) => {
    const v = r?.version;
    if (!v) return false;
    return isNewerVersion(v, seenInstalled) && !isNewerVersion(v, currentVersion);
  });
}

/**
 * Die Version, auf die der Update-Hinweis zeigt - oder '' (Critique R19).
 *
 * Der Punkt am Konto, an "Mehr" und an "Aenderungen" samt dem Zusatz im
 * Screenreader-Namen sagt: es gibt eine neuere Yuvomi-Version, die du noch
 * nicht angesehen hast. Handeln kann darauf nur, wer den Server betreibt -
 * ein Kind oder Gast sah einen Punkt, der zu nichts fuehrte, und hoerte bei
 * jedem Tab auf "Mehr" einen Satz ueber ein Update. Er gilt deshalb nur fuer
 * Admins; der Aenderungsverlauf selbst bleibt fuer alle lesbar.
 *
 * @param {object} opts
 * @param {string} opts.latest - neueste bekannte Version (GitHub)
 * @param {string} opts.current - laufende Version
 * @param {string} [opts.seen] - zuletzt angesehene neueste Version
 * @param {boolean} opts.isAdmin
 * @returns {string}
 */
export function pendingUpdateFor({ latest, current, seen = '', isAdmin }) {
  if (!isAdmin || !latest) return '';
  if (!isNewerVersion(latest, current)) return '';
  if (seen && !isNewerVersion(latest, seen)) return '';
  return latest;
}
