/**
 * Modul: Identitaetsfelder eines verknuepften Kontakts
 * Zweck: EINE Regel dafuer, wer die E-Mail-Adressen eines Kontakts mit
 *        `family_user_id` aendern darf - fuer jeden Schreibweg auf contacts.
 *
 * Ein Kontakt mit `family_user_id` IST das Konto eines Menschen im Haushalt,
 * und seine E-Mail-Adressen sind mehr als Kontaktdaten. Sie speisen
 * Anmelde- und Identitaetspfade:
 *
 * - `contacts.email` - forgot-password findet das Konto ueber diese Adresse
 *   (`resolveUser` in server/auth.js) und schickt den Reset-Link dorthin
 *   (`memberEmail()` in server/services/member-email.js); die SSO-Verknuepfung
 *   (`findOrCreateOidcUser`) haengt ein Konto ueber sie an eine
 *   OIDC-Identitaet; derselbe Wert ist Empfaenger fuer Einkaufsliste und
 *   Test-Mail (server/routes/email.js).
 * - `contact_emails.value` - dieselbe SSO-Verknuepfung prueft auch die
 *   Zweitadressen, ebenso die Eindeutigkeitspruefung beim Anlegen eines
 *   SSO-only-Kontos.
 *
 * Die Regel: an einem verknuepften Kontakt aendern diese Adressen nur die
 * verknuepfte Person selbst oder ein Admin, und nur mit vollem Zugriff - also
 * in einer Sitzung oder mit einem ungescopten Token. Ein gescoptes Token ist
 * auf Module beschraenkt (etwa `contacts:write`); die Adressen sind aber der
 * Schluessel zum Konto, und wer sie umschreibt, holt sich per Reset oder SSO
 * mehr als das Modul. Die Scope-Grenze darf hier nicht an der Rolle des
 * Token-Inhabers vorbei. Alle anderen Felder bleiben fuer jeden mit
 * Schreibrecht auf Kontakte editierbar. Ein Schreibweg ohne handelnde Person
 * (der CardDAV-Sync) erfuellt nichts davon und laesst die Adressen stehen.
 */

import { isAdminRequest } from '../middleware/require-admin.js';
import { accountIdsByEmail, emailMatchKey } from '../utils/email-match.js';

/**
 * Wer handelt - aus einem authentifizierten Request.
 *
 * `fullAccess` folgt `req.authScopes`, das `requireAuth` setzt: `null` fuer
 * eine Sitzung und ein ungescoptes Token, eine Liste fuer ein gescoptes Token
 * und ein Wandtablett. Dieselbe Unterscheidung trifft das Scope-Gate in
 * server/index.js.
 * @param {import('express').Request} req
 * @returns {{ userId: number|null, isAdmin: boolean, fullAccess: boolean }}
 */
export function contactActorFromRequest(req) {
  return {
    userId: req.authUserId ?? null,
    isAdmin: isAdminRequest(req),
    fullAccess: req.authScopes == null,
  };
}

/**
 * Darf `actor` die E-Mail-Adressen dieses Kontakts aendern?
 * @param {{ family_user_id?: number|null }} contact
 * @param {{ userId: number|null, isAdmin: boolean, fullAccess: boolean }|null} actor
 *   `null` = Schreibweg ohne handelnde Person (Hintergrund-Sync).
 * @returns {boolean}
 */
export function mayChangeContactEmails(contact, actor) {
  if (!contact?.family_user_id) return true;
  if (!actor) return false;
  // Ein gescoptes Token nie - auch nicht das des Admins oder der Person selbst.
  if (actor.fullAccess !== true) return false;
  if (actor.isAdmin === true) return true;
  return actor.userId != null && Number(actor.userId) === Number(contact.family_user_id);
}

// Verglichen wird mit GENAU der Regel der Pfade, die die Adresse lesen
// (SSO-Verknuepfung, Eindeutigkeitspruefung, forgot-password):
// `emailMatchKey()` aus server/utils/email-match.js - Leerraum am Rand weg,
// nur A-Z klein. Was diese Regel fuer gleich haelt, fuehrt zu keinem anderen
// Konto und ist keine Aenderung. Eine weitere Faltung hier (Unicode-
// Kleinschreibung, NFC) hiesse eine Aenderung durchzulassen, die fuer die
// Anmeldung eine andere Adresse ist.
const norm = (value) => (typeof value === 'string' ? emailMatchKey(value) : '') || null;

/**
 * Aendert ein PUT-Body die E-Mail-Adressen des Kontakts?
 *
 * Verglichen wird, was die Identitaetspfade lesen: die Hauptadresse
 * (`contacts.email`) fuer sich und die Menge ALLER Adressen. Ein unveraendert
 * mitgeschicktes Formular - das Frontend sendet bei jedem Speichern alle
 * Felder - ist damit keine Aenderung, auch wenn es die Hauptadresse
 * zusaetzlich als Zeile in `contact_emails` fuehrt. Labels, die Reihenfolge
 * der Zweitadressen und die Gross-/Kleinschreibung sind keine Identitaet.
 *
 * @param {object} contact  Gespeicherte Zeile aus `contacts`.
 * @param {string[]} storedEmails  Gespeicherte `contact_emails.value`.
 * @param {object} body  Request-Body (email?, emails?).
 * @returns {boolean}
 */
export function bodyChangesContactEmails(contact, storedEmails, body) {
  const oldPrimary = norm(contact.email);
  const newPrimary = body.email !== undefined ? norm(body.email) : oldPrimary;
  if (newPrimary !== oldPrimary) return true;

  const oldSecondary = storedEmails.map(norm).filter(Boolean);
  const newSecondary = Array.isArray(body.emails)
    ? body.emails.map((e) => norm(e?.value)).filter(Boolean)
    : oldSecondary;

  const asSet = (primary, list) => new Set([primary, ...list].filter(Boolean));
  const before = asSet(oldPrimary, oldSecondary);
  const after = asSet(newPrimary, newSecondary);
  if (before.size !== after.size) return true;
  for (const v of after) if (!before.has(v)) return true;
  return false;
}

/** Die Antwort, wenn eine neue Adresse schon an einem anderen Konto steht. */
export const EMAIL_IN_USE_MESSAGE = 'This email address already belongs to another account.';

/**
 * Alle gespeicherten Adressen des Kontakts eines Kontos (Haupt- und
 * Zweitadressen) - der Stand VOR einem Schreibvorgang.
 * @param {object} database
 * @param {number} userId
 * @returns {string[]}
 */
export function storedAccountEmails(database, userId) {
  const contact = database.prepare('SELECT id, email FROM contacts WHERE family_user_id = ?').get(userId);
  if (!contact) return [];
  const secondary = database.prepare('SELECT value FROM contact_emails WHERE contact_id = ?')
    .all(contact.id).map((r) => r.value);
  return [contact.email, ...secondary];
}

/**
 * Welche Adressen fuehrt ein Schreibvorgang an einem verknuepften Kontakt NEU
 * ein, die schon ein ANDERES Konto traegt?
 *
 * Neu ist, was nach `emailMatchKey()` nicht schon in `before` steht: ein
 * unveraendert mitgeschicktes Formular (das Frontend sendet bei jedem
 * Speichern alle Felder) bleibt speicherbar, auch wenn die Adresse aus der
 * Zeit vor dieser Pruefung schon doppelt vergeben ist.
 *
 * Gezaehlt wird mit derselben Funktion und derselben Regel wie die
 * SSO-Verknuepfung und "Passwort vergessen" (`accountIdsByEmail`, Haupt- und
 * Zweitadressen), verknuepfte Konten eingeschlossen - an ihnen haengt der
 * Passwort-Reset. Gaeste der geteilten Ausgaben zaehlen nicht: sie verknuepfen
 * nie ueber die Adresse, "Passwort vergessen" zieht ihnen das Mitglied vor, und
 * derselbe Mensch kann in zwei Gruppen als Gast stehen.
 *
 * @param {object} database
 * @param {{ userId?: number|null, before?: unknown[], after?: unknown[] }} change
 *   `userId` ist das Konto, dessen Kontakt geschrieben wird (`null` fuer ein
 *   Konto, das erst entsteht).
 * @returns {string[]} die belegten Adressen, wie sie im Schreibvorgang stehen
 */
export function emailsTakenByOtherAccounts(database, { userId = null, before = [], after = [] } = {}) {
  const known = new Set(before.map(emailMatchKey).filter(Boolean));
  const taken = [];
  for (const address of after) {
    const key = emailMatchKey(address);
    if (!key || known.has(key)) continue;
    known.add(key);
    const others = accountIdsByEmail(database, address, {
      secondary: true, withoutSplitGuests: true, excludeUserId: userId == null ? null : Number(userId),
    });
    if (others.length) taken.push(String(address));
  }
  return taken;
}
