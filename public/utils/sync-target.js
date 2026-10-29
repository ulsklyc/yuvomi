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

/** Die Standard-Personen eines Ziels: die Menge, sonst (aeltere Antwort) die eine Person. */
function defaultSetOf(cal) {
  if (Array.isArray(cal?.defaultAssigneeUserIds)) {
    return cal.defaultAssigneeUserIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  }
  const one = Number(cal?.defaultAssigneeUserId);
  return Number.isInteger(one) && one > 0 ? [one] : [];
}

/**
 * Das Ziel, das ein neuer Termin ueber seine Zuweisung bekommt (#1060, #1897).
 *
 * Die Standard-Personen eines Kalenders (#459) werden hier rueckwaerts gelesen:
 * sind dem Termin GENAU die Personen zugewiesen, die EIN Kalender als Standard
 * nennt, ist das sein Ziel. Ein Termin fuer Anna und Ben geht so in den
 * gemeinsamen Kalender "Zusammen", einer fuer Anna allein in Annas Kalender.
 *
 * - Keine Zuweisung: kein Ziel, still der Standard.
 * - Mehrere Kalender nennen dieselbe Menge: kein Ziel, aber `ambiguous`. Den
 *   ersten zu nehmen hiesse raten, und ein Termin im falschen Kalender faellt
 *   erst auf, wenn ihn jemand dort vermisst.
 * - Mehrere Zugewiesene und kein Kalender mit genau dieser Menge: kein Ziel.
 *   Nennt ein Kalender wenigstens EINE von ihnen, traegt die Antwort
 *   `severalAssignees` (#1332), und der Dialog sagt, warum das Ziel ausbleibt,
 *   statt den Termin still im eigenen Standard des Autors landen zu lassen.
 *   Nennt keiner eine von ihnen, gibt es nichts zu erklaeren.
 * - Nur Google und CalDAV: Apple kennt kein Zielformat, Outlook keine
 *   Standard-Zuweisung.
 *
 * @param {{google?: Array, caldav?: Array}} targets  Antwort von /calendar/sync-targets
 * @param {Array<number|string>} assigneeIds
 * @returns {{value: string|null, ambiguous: boolean, severalAssignees: boolean}}
 */
export function assigneeSyncTarget(targets, assigneeIds) {
  // Keine gueltige Id ist niemand - und muss es bleiben: Number(null) ist 0.
  const ids = [...new Set((assigneeIds ?? []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return { value: null, ambiguous: false, severalAssignees: false };
  const calendars = [
    ...(targets?.google ?? []).map((cal) => ({ set: defaultSetOf(cal), value: googleTargetValue(cal.id) })),
    ...(targets?.caldav ?? []).map((cal) => ({ set: defaultSetOf(cal), value: caldavTargetValue(cal.accountId, cal.calendarUrl) })),
  ];
  const wanted = new Set(ids);
  const treffer = calendars
    .filter(({ set }) => set.length === wanted.size && set.every((id) => wanted.has(id)))
    .map(({ value }) => value);
  if (treffer.length === 1) return { value: treffer[0], ambiguous: false, severalAssignees: false };
  if (treffer.length > 1) return { value: null, ambiguous: true, severalAssignees: false };
  const severalAssignees = ids.length > 1 && calendars.some(({ set }) => set.some((id) => wanted.has(id)));
  return { value: null, ambiguous: false, severalAssignees };
}
