/**
 * Modul: Gesundheit - die EINE Personenwahl (R23, D4)
 * Zweck: Jeder Bereich der Gesundheit (Uebersicht, Werte, Medikamente, Labor,
 *        Aktivitaet, Vorsorge, Ernaehrung, Zyklus, Fasten) fuehrte seine eigene
 *        Person. Wer bei den Werten "Emma" waehlte und in die Medikamente
 *        wechselte, stand dort wieder bei sich - und trug womoeglich fuer die
 *        falsche Person ein. Jetzt gilt EINE Wahl fuer das ganze Modul und die
 *        ganze Sitzung (sessionStorage): jeder Bereich liest sie beim Oeffnen,
 *        jede Wahl schreibt sie.
 *
 * Je angemeldetem Konto: der Schluessel traegt die eigene ID, damit ein
 * Kontowechsel im selben Tab nicht die Wahl des Vorgaengers erbt. Ohne
 * Speicher (privates Fenster, gesperrt) gilt die eigene Person - die Wahl ist
 * eine Bequemlichkeit, keine Zusage.
 *
 * Die Person ist nur ein Vorschlag: jeder Bereich prueft sie gegen seine
 * Mitgliederliste (`pickHealthPerson`). Wer nicht (mehr) darin steht, faellt
 * auf die eigene Person zurueck, statt eine Anfrage zu stellen, die der Server
 * abweist.
 */

const KEY_PREFIX = 'yuvomi-health-person';
export const HEALTH_PERSON_EVENT = 'yuvomi:health-person';

function storageKey(meId) {
  return `${KEY_PREFIX}:${meId ?? 'anon'}`;
}

/** Die gewaehlte Person dieser Sitzung, oder null. */
export function readHealthPerson(meId) {
  try {
    const raw = globalThis.sessionStorage?.getItem(storageKey(meId));
    const id = raw == null ? NaN : Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Merkt die Wahl und sagt es den anderen Bereichen (`HEALTH_PERSON_EVENT`):
 * die Liste der Bereiche blendet ihren Status fuer eine fremde Person aus, das
 * Fasten (eigenes Modul) liest die Wahl beim naechsten Oeffnen.
 */
export function writeHealthPerson(meId, personId) {
  const id = Number(personId);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    if (meId != null && id === Number(meId)) globalThis.sessionStorage?.removeItem(storageKey(meId));
    else globalThis.sessionStorage?.setItem(storageKey(meId), String(id));
  } catch { /* ohne Speicher gilt die Wahl nur in diesem Bereich */ }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(HEALTH_PERSON_EVENT, { detail: { meId, personId: id } }));
  } catch { /* kein Fenster (Tests) */ }
}

/**
 * Welche Person ein Bereich zeigt: die gemerkte, wenn sie in seiner Liste
 * steht, sonst die eigene, sonst das erste Mitglied.
 * @param {{ members?: {id:number}[], meId?: number|null, stored?: number|null }} input
 */
export function pickHealthPerson({ members = [], meId = null, stored = null } = {}) {
  if (stored != null && (Number(stored) === Number(meId) || members.some((m) => Number(m.id) === Number(stored)))) {
    return Number(stored);
  }
  return meId ?? members[0]?.id ?? null;
}

/** Steht gerade eine FREMDE Person in der Gesundheit? */
export function healthPersonIsOther(meId) {
  const stored = readHealthPerson(meId);
  return stored != null && meId != null && stored !== Number(meId);
}
