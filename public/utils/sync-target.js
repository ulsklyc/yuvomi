/**
 * Modul: Kennungen der Kalender-Sync-Ziele (#620)
 * Zweck: Eine Quelle für das Format, mit dem Event-Modal und Einstellungen ein
 *        Sync-Ziel benennen. Das Format wurde bisher an jeder Verwendungsstelle
 *        von Hand zusammengesetzt und wieder zerlegt; das Standard-Ziel wäre die
 *        dritte Stelle gewesen. Läuft eine davon aus dem Tritt, zeigt die
 *        Einstellungsseite stillschweigend "Lokal speichern", während in der
 *        Datenbank ein gültiges Ziel steht.
 * Abhängigkeiten: keine (bewusst frei von DOM und i18n, damit direkt testbar)
 *
 * Format:
 *   ''                              lokal speichern
 *   'google:<calendarId>'           Google-Kalender
 *   'caldav:<accountId>|<url>'      CalDAV-Kalender eines Kontos
 *   'outlook:<accountId>|<id>'      Outlook-Kalender eines Kontos (Graph-Id)
 */

export const SYNC_TARGET_LOCAL = '';

/** @returns {string} Kennung eines Google-Kalenders. */
export function googleTargetValue(calendarId) {
  return `google:${calendarId}`;
}

/** @returns {string} Kennung eines CalDAV-Kalenders. */
export function caldavTargetValue(accountId, calendarUrl) {
  return `caldav:${accountId}|${calendarUrl}`;
}

/** @returns {string} Kennung eines Outlook-Kalenders. */
export function outlookTargetValue(accountId, calendarId) {
  return `outlook:${accountId}|${calendarId}`;
}

/**
 * Zerlegt eine Kennung in ihre Bestandteile.
 *
 * Die CalDAV-URL wird nur am ERSTEN '|' abgetrennt: Ein Pipe-Zeichen ist in
 * einer URL zulässig, und ein Split über alle Vorkommen würde sie abschneiden.
 *
 * @returns {{kind: 'local'}
 *          |{kind: 'google', calendarId: string}
 *          |{kind: 'caldav', accountId: number, calendarUrl: string}
 *          |{kind: 'outlook', accountId: number, calendarId: string}
 *          |null} null bei unbekanntem Format.
 */
export function parseSyncTargetValue(value) {
  const raw = (value ?? '').trim();
  if (!raw) return { kind: 'local' };

  if (raw.startsWith('google:')) {
    const calendarId = raw.slice('google:'.length);
    return calendarId ? { kind: 'google', calendarId } : null;
  }

  if (raw.startsWith('caldav:')) {
    const rest = raw.slice('caldav:'.length);
    const separator = rest.indexOf('|');
    if (separator < 1) return null;
    const accountId = Number(rest.slice(0, separator));
    const calendarUrl = rest.slice(separator + 1);
    if (!Number.isInteger(accountId) || accountId < 1 || !calendarUrl) return null;
    return { kind: 'caldav', accountId, calendarUrl };
  }

  if (raw.startsWith('outlook:')) {
    const rest = raw.slice('outlook:'.length);
    const separator = rest.indexOf('|');
    if (separator < 1) return null;
    const accountId = Number(rest.slice(0, separator));
    const calendarId = rest.slice(separator + 1);
    if (!Number.isInteger(accountId) || accountId < 1 || !calendarId) return null;
    return { kind: 'outlook', accountId, calendarId };
  }

  return null;
}

/**
 * Baut die Auswahlliste aus der Antwort von /calendar/sync-targets.
 *
 * Labels kommen als Parameter herein, damit dieses Modul ohne i18n auskommt.
 * `current` trägt ein gespeichertes, aber nicht mehr angebotenes Ziel als eigene
 * Option nach: sonst zeigte die Oberfläche "Lokal speichern" an, während in der
 * Datenbank etwas anderes steht.
 *
 * @param {{google?: Array, caldav?: Array, outlook?: Array}} targets
 * @param {{local: string, google: string, caldav: string, outlook?: string, unavailable: string}} labels
 * @param {string} current
 * @returns {Array<{value: string, label: string, group: string|null}>}
 */
export function buildSyncTargetOptions(targets, labels, current = '') {
  const options = [{ value: SYNC_TARGET_LOCAL, label: labels.local, group: null }];

  for (const cal of targets?.google || []) {
    options.push({
      value: googleTargetValue(cal.id),
      label: cal.summary || cal.id,
      group: labels.google,
    });
  }

  for (const cal of targets?.caldav || []) {
    options.push({
      value: caldavTargetValue(cal.accountId, cal.calendarUrl),
      label: cal.calendarName || cal.calendarUrl,
      group: `${labels.caldav} · ${cal.accountName}`,
    });
  }

  for (const cal of targets?.outlook || []) {
    options.push({
      value: outlookTargetValue(cal.accountId, cal.calendarId),
      label: cal.calendarName || cal.calendarId,
      group: `${labels.outlook ?? 'Outlook'} · ${cal.accountName}`,
    });
  }

  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: labels.unavailable, group: null });
  }

  return options;
}
