/**
 * Modul: Familienmitglieder fuer Settings-Blaetter
 * Zweck: Die Mitgliederliste einmal je Seitenaufruf laden, fuer die
 *        Zuweisungs-Auswahlfelder der Sync-Blaetter.
 *
 * Liegt hier statt in einem der Blaetter, seit die Kalender-Abos aus
 * `sync-calendar` ausgezogen sind und beide Seiten dieselbe Liste brauchen.
 * Zwei Kopien haetten zwei Zwischenspeicher bedeutet - und damit zwei
 * Abfragen fuer dieselbe Antwort, sobald jemand zwischen den Blaettern wechselt.
 *
 * NUR HAUSHALTSMITGLIEDER (#1207): die Liste kommt aus `/family/members`, nicht
 * mehr aus der Benutzerverwaltung `/auth/users`, die jedes Konto kennt. Wer
 * heute schon als Zustaendige:r eingetragen ist, bleibt waehlbar - sonst fiele
 * die Auswahl beim Oeffnen auf die erste Option und das naechste Speichern
 * truege still jemand anderen ein. Nur fuer diese Faelle wird das
 * Kontenverzeichnis nach dem Namen gefragt.
 *
 * Nur Erfolge werden behalten: ein voruebergehender Fehler darf nicht die ganze
 * Sitzung mit leeren Auswahlfeldern zementieren.
 */

import { api } from '/api.js';
import { withChosenPeople } from '/utils/people-picker.js';

let cachedMembers = null;
let cachedDirectory = null;

async function members() {
  if (cachedMembers) return cachedMembers;
  try {
    cachedMembers = (await api.get('/family/members')).data ?? [];
    return cachedMembers;
  } catch {
    return [];
  }
}

async function directory() {
  if (cachedDirectory) return cachedDirectory;
  try {
    cachedDirectory = (await api.get('/auth/users')).data ?? [];
    return cachedDirectory;
  } catch {
    return [];
  }
}

/**
 * @param {...(number|string|null|undefined)} currentIds  wer im Feld schon steht
 * @returns {Promise<Array<object>>}
 */
export async function loadFamilyUsers(...currentIds) {
  const list = await members();
  const missing = currentIds
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0 && !list.some((person) => Number(person.id) === id));
  if (!missing.length) return list;
  const accounts = await directory();
  return withChosenPeople(list, accounts.filter((account) => missing.includes(Number(account.id))));
}
