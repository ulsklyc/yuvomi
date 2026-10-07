/**
 * Modul: Taschengeld (Rewards, #1734)
 * Zweck: Der Geld-Saldo je Kind auf dem Ledger der Belohnungen - wer ihn lesen
 *        darf, der Plan fuer die Gutschrift und der Lauf, der sie bucht.
 * Abhängigkeiten: better-sqlite3-Handle (synchron), vom Aufrufer uebergeben;
 *        services/rewards.js (die eine Summe), utils/interval-date.js (der
 *        eine Schritt einer Serie), services/split-expenses.js (die
 *        ISO-4217-Stellen und der Betrags-Parser).
 *
 * WARUM DAS HIER LEBT UND NICHT IM BUDGET (Discussion #916, DECISIONS.md
 * Eintrag 6): Ledger, Anfrage, Freigabe und Gegenbuchung gibt es in diesem
 * Modul schon. Ein Budgetkonto hat keinen Besitzer und keine Anfrage, die
 * einer stellt und ein anderer entscheidet. Eine Auszahlung erzeugt keine
 * Budgetbuchung.
 *
 * GELD UND PUNKTE BEGEGNEN SICH NIE. Beide liegen in `reward_ledger`, getrennt
 * durch `unit`; es gibt keinen Umtausch. Geld steht in ganzen kleinsten
 * Einheiten mit ihrem Waehrungscode (wie `amount_minor` der geteilten Ausgaben),
 * nie als Gleitkommazahl.
 *
 * KEIN `await` IN DIESER DATEI. Der Treiber ist synchron, und jede Pruefung
 * "reicht der Saldo" steht mit ihrer Buchung in EINER Transaktion: zwischen
 * Lesen und Schreiben kommt kein anderer Request dazwischen.
 */

import { activeAccountSql, deactivatedAtColumnSql, householdMemberSql, isActiveAccount, isHouseholdMember, memberOrderSql, memberPositionSql } from './household-members.js';
import { ledgerBalance, ledgerBalanceSql, postLedger } from './rewards.js';
import { minorUnit, parseMoneyToMinor } from './split-expenses.js';
import { isDisplayRequest } from './display-acting.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { addInterval, dateKey, liftToAnchorDay, nextRunNotBefore, parseDateKey } from '../utils/interval-date.js';
import { householdCurrency } from '../utils/household-currency.js';
import { householdTimeZone, todayKey, utcToWall } from '../utils/timezone.js';

export const MONEY_KINDS = Object.freeze(['withdrawal', 'deposit']);
export const ALLOWANCE_FREQUENCIES = Object.freeze(['weekly', 'monthly']);

/*
 * DIE OBERGRENZE EINES BETRAGS HAENGT NICHT AN EINER WAEHRUNG. Die erste
 * Fassung trug 100 000 000 kleinste Einheiten - in EUR eine Million, in IDR
 * oder IRR eine Million Rupiah bzw. Rial, also weniger als ein Geburtstagsgeld
 * (Review zu #1745). Eine Zahl, die fuer jede waehlbare Waehrung reicht, ist
 * keine Aussage ueber Taschengeld mehr, sondern nur noch ueber die Rechnung:
 * `parseMoneyToMinor()` laesst wie bei den geteilten Ausgaben alles bis
 * Number.MAX_SAFE_INTEGER durch, und HIER kommt dazu, was dort keine Rolle
 * spielt - es wird SUMMIERT. Der einzelne Betrag ist deshalb auf 10^12
 * gedeckelt (zehn Milliarden bei zwei Stellen), und jede Gutschrift prueft in
 * ihrer Transaktion, dass der Saldo danach noch eine exakte Zahl ist
 * (`creditFits()`).
 */
export const MAX_MONEY_MINOR = 1_000_000_000_000;

/** Bleibt der Saldo nach dieser Gutschrift eine exakt darstellbare Zahl? */
export function creditFits(d, userId, amountMinor) {
  return ledgerBalance(d, userId, 'money') + amountMinor <= Number.MAX_SAFE_INTEGER;
}

/** Ein Fehler in der Form, die die Routen als 400 weiterreichen - mit maschinenlesbarem Grund, wo es einen gibt. */
function inputError(message, reason = null) {
  const err = new Error(message);
  err.name = 'SplitInputError';
  if (reason) err.reason = reason;
  return err;
}

/** Wie viele versaeumte Termine ein Lauf je Plan hoechstens nachbucht. */
const MAX_CATCH_UP_STEPS = 520;

// --------------------------------------------------------
// Wer liest das Geld von wem
// --------------------------------------------------------

/*
 * DIE EINE SICHTBARKEITSREGEL DES TASCHENGELDS (#1734, Entscheidung 6).
 *
 * Den Geld-Saldo und seine Historie sehen NUR das Kind selbst und Admins.
 * Geschwister nicht, das Wandtablett nicht. Das ist enger als bei Punkten, die
 * jeder mit Zugriff auf das Modul sieht - deshalb steht die Regel an JEDER
 * Leseabfrage und nicht im Client: was nicht ueber die Leitung geht, kann kein
 * Netzwerk-Tab zeigen.
 *
 * EIN GESCOPTES API-TOKEN FAELLT UNTER DIESELBE REGEL, ohne eigenen Zweig:
 * `requireAuth` legt sein Subjekt in `req.authUserId` und seine Rolle in
 * `req.authRole` ab, und gefragt wird hier nur das.
 *
 * EIN DISPLAY SIEHT KEIN GELD, AUCH NICHT "SEIN EIGENES". Das Geraet ist kein
 * Mitglied und hat kein Konto - aber die Absage haengt nicht daran, dass es
 * zufaellig keine Zeilen hat, sondern steht hier als eigene Antwort.
 *
 * Die Regel steht einmal, als SQL-Fragment (DECISIONS.md, Eintrag 2): jede
 * Leseabfrage fuer Geld setzt `moneyVisibleSql()` in ihr WHERE.
 */

/**
 * Wer fragt? Aus dem Request gelesen, einmal je Handler.
 * @returns {{ admin: boolean, display: boolean, me: number|null }}
 */
export function moneyReader(req) {
  const me = Number(req?.authUserId || req?.session?.userId) || null;
  return { admin: isAdminRequest(req), display: isDisplayRequest(req), me };
}

/**
 * Die Regel als WHERE-Fragment ueber eine Personenspalte. Die Abfrage
 * bindet `@moneyMe` (aus `moneyParams()`).
 *
 * @param {{ admin: boolean, display: boolean, me: number|null }} reader
 * @param {string} userCol  Spaltenausdruck aus dem Code (`l.user_id`), nie eine Eingabe
 */
export function moneyVisibleSql(reader, userCol) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(String(userCol))) throw new Error('userCol must be a qualified column.');
  if (!reader || reader.display) return '(0 = 1 AND @moneyMe IS NULL)';
  if (reader.admin) return '(1 = 1 OR @moneyMe IS NULL)';
  return `(${userCol} = @moneyMe)`;
}

/** Die Bindung zu `moneyVisibleSql()`. Fuer ein Display und ohne Person: NULL. */
export function moneyParams(reader) {
  return { moneyMe: reader && !reader.display ? reader.me : null };
}

// --------------------------------------------------------
// Betraege
// --------------------------------------------------------

/** Ein Waehrungscode mit den Nachkommastellen, in denen er gespeichert wird (ISO 4217). */
function currencyView(currency) {
  return { currency, minor_unit: minorUnit(currency) };
}

/**
 * Waehrung und Nachkommastellen des HAUSHALTS, heute. Darin wird ein NEUES
 * Konto eroeffnet - ein bestehendes rechnet in seiner eigenen (`accountCurrency`).
 */
export function moneyCurrency(d) {
  return currencyView(householdCurrency(d));
}

/*
 * EIN KONTO IST EINE ZEILE, UND SIE TRAEGT SEINE EINE WAEHRUNG (#1734).
 *
 * `reward_money_accounts` haelt je Person fest, DASS sie ein Taschengeldkonto
 * hat und in welcher Waehrung: der Haushaltswaehrung des Tages, an dem es
 * eroeffnet wurde. Ein spaeterer Wechsel des Haushalts laesst das Konto, wie
 * es ist - aus 1,00 EUR (100 kleinste Einheiten) werden keine hundert Yen.
 *
 * Bis zu dieser Zeile war beides eine Ableitung: "hat ein Konto" hiess "hat
 * einen Plan oder eine Geldbuchung", und die Waehrung kam aus dem Plan, sonst
 * aus einer offenen Anfrage, sonst aus der juengsten Buchung. Ein Konto ohne
 * Plan und ohne Geld gab es damit nicht - in der Oberflaeche entstand eines
 * nur ueber einen (notfalls pausierten) Plan.
 *
 * DIE WAEHRUNG WECHSELT NUR UEBER SCHLIESSEN UND NEU EROEFFNEN, und schliessen
 * laesst sich nur ein LEERES Konto (`isMoneyAccountEmpty()`): kein Plan, Saldo
 * null, nichts offen. Ein Konto mit Guthaben wechselt nie - umrechnen hiesse
 * einen Kurs erfinden. Die alten Buchungen bleiben mit ihrem Code stehen und
 * summieren sich in ihm zu null; deshalb bleibt die eine Summe ueber alle
 * Geldzeilen der Saldo, auch ueber einen Neuanfang hinweg.
 */
export function accountCurrency(d, userId) {
  return d.prepare('SELECT currency FROM reward_money_accounts WHERE user_id = ?').get(userId)?.currency ?? null;
}

/** Kein Plan, kein Guthaben, keine offene Anfrage: an diesem Konto haengt nichts mehr. */
export function isMoneyAccountEmpty(d, userId) {
  if (d.prepare('SELECT 1 AS yes FROM reward_allowances WHERE user_id = ?').get(userId)) return false;
  if (ledgerBalance(d, userId, 'money') !== 0) return false;
  return !d.prepare("SELECT 1 AS yes FROM reward_redemptions WHERE user_id = ? AND status = 'pending' AND kind != 'reward'").get(userId);
}

/**
 * Das Konto dieser Person - angelegt, falls es noch keines gibt, in der
 * Haushaltswaehrung von jetzt. Laeuft in der Transaktion des Aufrufers: der
 * erste Plan und die erste Gutschrift der Eltern eroeffnen das Konto mit.
 * @returns {{ currency: string, created: boolean }}
 */
export function ensureMoneyAccount(d, userId, actorId = null) {
  const existing = accountCurrency(d, userId);
  if (existing) return { currency: existing, created: false };
  const currency = householdCurrency(d);
  d.prepare('INSERT INTO reward_money_accounts (user_id, currency, created_by) VALUES (?, ?, ?)').run(userId, currency, actorId);
  return { currency, created: true };
}

/**
 * Ein leeres Konto schliessen. Die Buchungen und entschiedenen Anfragen
 * bleiben als Verlauf stehen; nur die Kontozeile geht.
 * @returns {'closed'|'not_found'|'not_empty'}
 */
export function closeMoneyAccount(d, userId) {
  return d.transaction(() => {
    if (!accountCurrency(d, userId)) return 'not_found';
    if (!isMoneyAccountEmpty(d, userId)) return 'not_empty';
    d.prepare('DELETE FROM reward_money_accounts WHERE user_id = ?').run(userId);
    return 'closed';
  })();
}

/** Waehrung und Nachkommastellen, in denen DIESES Konto rechnet (gibt es noch keines: die des Haushalts, in der es eroeffnet wuerde). */
export function moneyCurrencyOf(d, userId) {
  return currencyView(accountCurrency(d, userId) ?? householdCurrency(d));
}

/**
 * Die Waehrung fuer eine Buchung, eine Anfrage oder einen Plan dieser Person.
 * Nennt der Aufrufer selbst einen Code (`requested`), muss es dieser sein -
 * sonst ein Eingabefehler mit `currency_mismatch`. Ohne Angabe gilt die des
 * Kontos.
 */
export function resolveMoneyCurrency(d, userId, requested = undefined) {
  const view = moneyCurrencyOf(d, userId);
  if (requested !== undefined && requested !== null && requested !== view.currency) {
    throw inputError(`This pocket money account is kept in ${view.currency}.`, 'currency_mismatch');
  }
  return view;
}

/**
 * DIE EINE STELLE, DIE EINE GELDZEILE SCHREIBT (ausser der Gutschrift nach
 * Plan, die den Code ihres Plans traegt). Sie prueft IN DER TRANSAKTION des
 * Aufrufers, dass die Zeile die Waehrung des Kontos traegt: zwischen dem
 * Lesen der Kontowaehrung und der Buchung liegt kein `await`.
 */
export function postMoney(d, { userId, delta, type, reason = null, redemptionId = null, createdBy = null, currency }) {
  const account = accountCurrency(d, userId);
  // Ohne Konto keine Geldzeile: wer bucht, hat es vorher eroeffnet (`ensureMoneyAccount`).
  if (!account) throw inputError('This person has no pocket money account.', 'no_money_account');
  if (account !== currency) {
    throw inputError(`This pocket money account is kept in ${account}.`, 'currency_mismatch');
  }
  return postLedger(d, { userId, delta, type, reason, redemptionId, createdBy, unit: 'money', currency });
}

/**
 * Ein Betrag aus dem Request als ganze kleinste Einheiten.
 *
 * Als Dezimal-TEXT ("5.00"), nie als Zahl: derselbe Parser wie die geteilten
 * Ausgaben, mit den ISO-4217-Stellen der KONTO-Waehrung (`currency`, aus
 * `resolveMoneyCurrency()`). Er wirft `SplitInputError` mit einem Satz, den die
 * Route als 400 weiterreicht.
 */
export function parseMoneyAmount(value, currency, field = 'amount') {
  // NUR EIN TEXT. `parseMoneyToMinor()` zwingt alles andere durch String():
  // aus `["5"]` wurde "5" und damit ein gueltiger Betrag (Review zu #1745).
  if (typeof value !== 'string') throw inputError(`${field} must be sent as a decimal string.`);
  const minor = parseMoneyToMinor(value, currency, field);
  if (minor > MAX_MONEY_MINOR) throw inputError(`${field} is too large.`);
  return minor;
}

/**
 * Ein optionaler Freitext (Notiz, Grund) aus dem Request: fehlt er, ist er
 * `null`; ist er kein Text, ist das ein Eingabefehler. Ohne die Pruefung stand
 * ein gesendetes Objekt als "[object Object]" im Verlauf.
 */
export function readOptionalText(value, field, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw inputError(`${field} must be a string.`);
  return value.trim().slice(0, max) || null;
}

// --------------------------------------------------------
// Konten
// --------------------------------------------------------

/** Der Geld-Saldo einer Person, in kleinsten Einheiten. */
export function moneyBalance(d, userId) {
  return ledgerBalance(d, userId, 'money');
}

const HAS_ACCOUNT_SQL = (userCol) => `EXISTS (SELECT 1 FROM reward_money_accounts acc WHERE acc.user_id = ${userCol})`;

/**
 * Hat diese Person ein Taschengeldkonto? Die Kontozeile sagt es - unabhaengig
 * von `reward_participants`: ein Haushalt kann Taschengeld fuehren, ohne das
 * Punktesystem zu betreiben, und umgekehrt. Eroeffnet wird es von den Eltern:
 * ausdruecklich, oder mit dem ersten Plan oder der ersten Gutschrift.
 */
export function hasMoneyAccount(d, userId) {
  if (!userId) return false;
  return !!d.prepare(`SELECT 1 AS yes FROM users u WHERE u.id = ? AND ${HAS_ACCOUNT_SQL('u.id')}`).get(userId);
}

function planView(row) {
  if (!row) return null;
  return {
    amount_minor: row.amount_minor,
    ...currencyView(row.currency),
    frequency: row.frequency,
    anchor_day: row.anchor_day,
    next_run_date: row.next_run_date,
    paused: row.paused_at != null,
  };
}

/*
 * EIN EHEMALIGES KONTO WIRD NUR NOCH AUSGEZAHLT (#1734).
 *
 * Wer kein Haushaltsmitglied mehr ist (deaktiviertes Konto), sammelt nicht
 * weiter und stellt nichts mehr an - aber sein Restguthaben ist Geld, das die
 * Eltern noch verwahren. Die erste Fassung nahm das Konto aus jeder Liste: das
 * Guthaben stand dann auf einem Konto, das niemand mehr sah, und eine alte
 * offene Einzahlung liess sich darauf sogar noch freigeben.
 *
 * Die Regel fuer den Zustand, an EINER Stelle (`closeFormerMoney()` fuer den
 * Wechsel, `isFormerMoneyAccount()` fuer die Frage):
 *   - offene Geld-Anfragen werden storniert, der Plan pausiert;
 *   - solange Guthaben da ist, sehen ADMINS das Konto weiter (`former: true`)
 *     und duerfen nur noch abbuchen, nie unter null;
 *   - Gutschrift, Freigabe einer Anfrage, Plan aendern oder fortsetzen: abgewiesen
 *     mit `account_deactivated`;
 *   - bei Saldo null verschwindet es aus der Liste.
 * Wird das Konto wieder aktiviert, ist es ein Mitglied wie zuvor; der Plan
 * bleibt pausiert, bis ihn jemand fortsetzt, und Storniertes bleibt storniert.
 */

/** Gibt es dieses Konto, und ist es deaktiviert? */
export function isFormerMoneyAccount(d, userId) {
  if (!userId || !d.prepare('SELECT 1 AS yes FROM users WHERE id = ?').get(userId)) return false;
  return !isActiveAccount(userId, { db: d });
}

/**
 * Was am Geld endet, wenn jemand kein Haushaltsmitglied mehr ist: offene
 * Geld-Anfragen werden storniert (mit Grund, `decided_by` NULL - das war
 * niemand), der Plan pausiert. Idempotent. Gerufen dort, wo der Zustand
 * wechselt (`deactivate()` in server/services/user-removal.js), und vom Lauf
 * fuer Konten, die schon vorher deaktiviert waren.
 */
/** Der Haushaltstag, an dem dieses Konto deaktiviert wurde - oder `null`, wenn es das nicht ist. */
function formerSince(d, userId) {
  // Die Spalte nennt nur server/services/account-state.js beim Namen (Guard in
  // test:user-traces-guard); gelesen wird der eine Wert der einen Zeile.
  const row = d.prepare(`SELECT ${deactivatedAtColumnSql('u')} FROM users u WHERE u.id = ?`).get(userId);
  const stamp = row ? Object.values(row)[0] : null;
  if (!stamp) return null;
  return utcToWall(stamp, householdTimeZone(d))?.date ?? null;
}

export function closeFormerMoney(d, userId, { today = todayKey(d) } = {}) {
  // ERST BUCHEN, WAS FAELLIG WAR, DANN PAUSIEREN - dieselbe Reihenfolge wie in
  // `savePlan()`. Ohne das liess das Deaktivieren die Termine fallen, die
  // zwischen dem letzten Lauf und diesem Moment lagen: Geld, das dem Kind nach
  // der eigenen Regel zusteht und in der Auszahlung fehlte (Review zu #1745).
  // Gebucht wird bis zum Tag des Deaktivierens, nicht bis heute: ein Konto,
  // das der Lauf erst Wochen spaeter aufraeumt, sammelt die Wochen danach nicht.
  const plan = d.prepare('SELECT * FROM reward_allowances WHERE user_id = ? AND paused_at IS NULL').get(userId);
  const since = plan ? formerSince(d, userId) : null;
  if (plan && since) creditDueDates(d, plan, since < today ? since : today);
  const cancelled = d.prepare(`
    UPDATE reward_redemptions
    SET status = 'cancelled', decision_reason = 'account_deactivated', decided_by = NULL,
        decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE user_id = ? AND status = 'pending' AND kind != 'reward'
  `).run(userId).changes;
  const paused = d.prepare(`
    UPDATE reward_allowances
    SET paused_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE user_id = ? AND paused_at IS NULL
  `).run(userId).changes;
  return { cancelled, paused };
}

/**
 * Die Konten, die dieser Leser sehen darf - mit Saldo, Waehrung und Plan. Fuer
 * ein Kind hoechstens das eigene, fuer Admins alle, fuer ein Display keins.
 * Haushaltsmitglieder (#1207) - und, NUR FUER ADMINS, ehemalige Konten mit
 * Restguthaben (`former: true`, ans Ende sortiert). Der Admin-Zweig steht als
 * eigene Bedingung an dieser Abfrage und nicht in `moneyVisibleSql()`: ein
 * Ehemaliger ist auch fuer sich selbst keine Zeile mehr.
 */
export function listMoneyAccounts(d, reader) {
  const members = d.prepare(`
    SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
           ${memberPositionSql('u')} AS sort_order,
           ${ledgerBalanceSql('money', 'u.id')} AS balance_minor
    FROM users u
    WHERE ${householdMemberSql('u')}
      AND ${HAS_ACCOUNT_SQL('u.id')}
      AND ${moneyVisibleSql(reader, 'u.id')}
    ORDER BY ${memberOrderSql('u')}
  `).all(moneyParams(reader));
  const plan = d.prepare('SELECT * FROM reward_allowances WHERE user_id = ?');
  const view = (former) => (row) => ({
    ...row,
    former,
    ...moneyCurrencyOf(d, row.id),
    plan: planView(plan.get(row.id)),
    // Ob sich das Konto schliessen laesst, sagt der Server: dieselbe Frage,
    // die DELETE /money/accounts/:userId stellt.
    closable: accountCurrency(d, row.id) != null && isMoneyAccountEmpty(d, row.id),
  });
  return [...members.map(view(false)), ...listFormerMoneyAccounts(d, reader).map(view(true))];
}

/**
 * Ehemalige Konten mit Restguthaben - NUR FUER ADMINS, und die einzige
 * Personenliste dieses Moduls, die bewusst am Mitglieder-Praedikat vorbeigeht
 * (Allowlist in test/test-household-member-guard.js): sie zeigt genau die
 * Konten, die keine Mitglieder mehr sind, damit das Geld darauf nicht
 * unsichtbar wird. Fuer jeden anderen Leser ist sie leer, ohne die Datenbank
 * zu fragen.
 */
function listFormerMoneyAccounts(d, reader) {
  if (!reader || !reader.admin || reader.display) return [];
  const balance = ledgerBalanceSql('money', 'u.id');
  return d.prepare(`
    SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
           ${memberPositionSql('u')} AS sort_order,
           ${balance} AS balance_minor
    FROM users u
    WHERE NOT ${activeAccountSql('u')} AND ${balance} > 0
    ORDER BY ${memberOrderSql('u')}
  `).all();
}

/** Mitglieder ohne Konto - die Auswahl, aus der Eltern eines eroeffnen. */
export function listMoneyCandidates(d) {
  return d.prepare(`
    SELECT u.id, u.display_name, u.family_role
    FROM users u
    WHERE ${householdMemberSql('u')} AND NOT ${HAS_ACCOUNT_SQL('u.id')}
    ORDER BY ${memberOrderSql('u')}
  `).all();
}

/**
 * Die Geldbuchungen, die dieser Leser sehen darf. `userId` ist ein Filter, kein
 * Recht: wer nach dem Geschwisterkind fragt, bekommt eine leere Liste.
 */
export function listMoneyLedger(d, reader, { userId = null, limit = 100 } = {}) {
  return d.prepare(`
    SELECT l.id, l.user_id, l.delta, l.currency, l.type, l.reason, l.allowance_date,
           l.redemption_id, r.kind AS request_kind, l.created_at,
           u.display_name AS user_name, u.avatar_color AS user_color, u.avatar_data AS user_avatar,
           a.display_name AS actor_name
    FROM reward_ledger l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN users a ON a.id = l.created_by
    LEFT JOIN reward_redemptions r ON r.id = l.redemption_id
    WHERE l.unit = 'money'
      AND ${moneyVisibleSql(reader, 'l.user_id')}
      ${userId ? 'AND l.user_id = @userId' : ''}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT @limit
  `).all({ ...moneyParams(reader), ...(userId ? { userId } : {}), limit })
    .map((row) => ({ ...row, minor_unit: minorUnit(row.currency) }));
}

// --------------------------------------------------------
// Plan
// --------------------------------------------------------

/**
 * Der erste Termin eines Plans, der nicht vor `today` liegt.
 *
 * Monatlich ist `anchorDay` der Tag im Monat; ein Monat, der ihn nicht hat,
 * nimmt seinen letzten (`liftToAnchorDay`, dieselbe Regel wie #1721).
 * Woechentlich ist er der Wochentag, 1 = Montag bis 7 = Sonntag.
 */
export function firstRunDate(frequency, anchorDay, today) {
  if (frequency === 'weekly') {
    const date = parseDateKey(today);
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + ((anchorDay - weekday + 7) % 7));
    return dateKey(date);
  }
  const thisMonth = liftToAnchorDay(`${today.slice(0, 7)}-01`, anchorDay);
  return thisMonth >= today ? thisMonth : addInterval(thisMonth, 'monthly', anchorDay);
}

/** Der Anker, wie `addInterval` ihn versteht: nur monatlich ein Tag im Monat. */
function stepAnchor(plan) {
  return plan.frequency === 'monthly' ? plan.anchor_day : null;
}

/**
 * Plan einer Person lesen und pruefen. Gibt `{ error }` oder die Werte zurueck.
 */
export function readPlanInput(d, userId, body) {
  const frequency = body?.frequency;
  if (!ALLOWANCE_FREQUENCIES.includes(frequency)) return { error: 'frequency must be weekly or monthly.' };
  const anchorDay = Number(body?.anchor_day);
  const max = frequency === 'weekly' ? 7 : 31;
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > max) {
    return { error: `anchor_day must be a whole number from 1 to ${max}.` };
  }
  let amountMinor;
  let currency;
  try {
    ({ currency } = resolveMoneyCurrency(d, userId, body?.currency));
    amountMinor = parseMoneyAmount(body?.amount, currency);
  } catch (err) {
    if (err?.name === 'SplitInputError') return { error: err.message, reason: err.reason };
    throw err;
  }
  if (body?.paused !== undefined && typeof body.paused !== 'boolean') return { error: 'paused must be a boolean.' };
  // `undefined` heisst "nicht angefasst": der gespeicherte Zustand bleibt.
  return { frequency, anchorDay, amountMinor, currency, paused: body?.paused };
}

/**
 * Plan anlegen oder aendern (eine Zeile je Person).
 *
 * WANN DER NAECHSTE TERMIN NEU GERECHNET WIRD:
 *  - neuer Plan, oder Rhythmus oder Ankertag geaendert: der erste passende
 *    Termin ab heute;
 *  - Fortsetzen nach einer Pause: der erste Termin des alten Rasters, der nicht
 *    vor heute liegt. Die Termine der Pause werden UEBERSPRUNGEN, nicht
 *    nachgebucht (wie beim Fortsetzen einer Serie, #1714) - pausiert haben die
 *    Eltern mit Absicht, ein ausgeschalteter Server ist der andere Fall;
 *  - sonst (nur der Betrag): der Termin bleibt.
 *
 * WAS FAELLIG IST, WIRD VOR DER AENDERUNG GEBUCHT - MIT DEM ALTEN PLAN.
 * Zwischen zwei stuendlichen Laeufen (oder nach Tagen ohne Server) stehen
 * Termine aus, die dem Kind nach dem Plan zustehen, der an ihnen galt. Die
 * erste Fassung speicherte zuerst: ein geaenderter Wochentag rechnete den
 * Termin neu ab heute und liess fuenf ausstehende Wochen fallen, ein von 1,00
 * auf 50,00 geaenderter Betrag buchte alle fuenf mit 50,00 (Review zu #1745).
 * Buchen und Speichern liegen in EINER Transaktion.
 *
 * FEHLT `paused`, BLEIBT DER GESPEICHERTE ZUSTAND. Ein Client, der nur den
 * Betrag schickt, setzte sonst einen pausierten Plan fort.
 *
 * Faellt der erste Termin des neuen Plans auf heute, wird er in derselben
 * Transaktion gebucht - idempotent wie der Lauf.
 */
export function savePlan(d, userId, input, { actorId = null, today = todayKey(d) } = {}) {
  return d.transaction(() => {
    const before = d.prepare('SELECT * FROM reward_allowances WHERE user_id = ?').get(userId);
    if (before && before.paused_at == null && before.next_run_date <= today) creditPlan(d, before, today);
    const existing = d.prepare('SELECT * FROM reward_allowances WHERE user_id = ?').get(userId);
    // DIE WAEHRUNG DES PLANS IST DIE DES KONTOS, geprueft hier in der
    // Transaktion. Gibt es noch kein Konto, eroeffnet der Plan es mit - in der
    // Haushaltswaehrung von heute.
    ensureMoneyAccount(d, userId, actorId);
    const { currency } = resolveMoneyCurrency(d, userId, input.currency);
    input = { ...input, paused: input.paused ?? (existing ? existing.paused_at != null : false) };
    const rasterChanged = !existing
      || existing.frequency !== input.frequency || existing.anchor_day !== input.anchorDay;
    let nextRun;
    if (rasterChanged) nextRun = firstRunDate(input.frequency, input.anchorDay, today);
    else if (existing.paused_at != null && !input.paused) {
      nextRun = nextRunNotBefore(existing.next_run_date, existing.frequency, today, stepAnchor(existing)).date;
    } else nextRun = existing.next_run_date;

    if (!existing) {
      d.prepare(`
        INSERT INTO reward_allowances (user_id, amount_minor, currency, frequency, anchor_day, next_run_date, paused_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') END, ?)
      `).run(userId, input.amountMinor, currency, input.frequency, input.anchorDay, nextRun, input.paused ? 1 : 0, actorId);
    } else {
      d.prepare(`
        UPDATE reward_allowances
        SET amount_minor = ?, frequency = ?, anchor_day = ?, next_run_date = ?,
            paused_at = CASE WHEN ? = 0 THEN NULL
                             ELSE COALESCE(paused_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE user_id = ?
      `).run(input.amountMinor, input.frequency, input.anchorDay, nextRun, input.paused ? 1 : 0, userId);
    }
    const saved = d.prepare('SELECT * FROM reward_allowances WHERE user_id = ?').get(userId);
    if (saved.paused_at == null && saved.next_run_date <= today) creditPlan(d, saved, today);
    return planView(d.prepare('SELECT * FROM reward_allowances WHERE user_id = ?').get(userId));
  })();
}

// --------------------------------------------------------
// Der Lauf
// --------------------------------------------------------

/*
 * JE PERSON UND TERMIN HOECHSTENS EINE GUTSCHRIFT, UND DAS STEHT IM SCHEMA.
 * `uniq_reward_allowance_credit` (die Migration zu #1734) liegt ueber `user_id` und
 * `allowance_date`. Die Buchung sagt deshalb ON CONFLICT DO NOTHING: ein Lauf,
 * der zweimal fuer denselben Tag feuert, ein Plan, der am selben Tag geloescht
 * und neu angelegt wird, zwei Prozesse auf derselben Datei - alle buchen einmal.
 */
const CREDIT_SQL = `
  INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, unit, currency, allowance_date)
  VALUES (?, ?, 'bonus', NULL, NULL, 'money', ?, ?)
  ON CONFLICT(user_id, allowance_date) WHERE allowance_date IS NOT NULL DO NOTHING
`;

/**
 * Bucht alle faelligen Termine EINES Plans bis einschliesslich `today` und
 * rueckt ihn weiter. Laeuft in der Transaktion des Aufrufers.
 *
 * VERSAEUMTE TERMINE WERDEN NACHGEBUCHT. War der Server ueber drei Wochen aus,
 * stehen danach drei Gutschriften da: dem Kind steht die Woche zu, ob das NAS
 * lief oder nicht. Jede traegt den Termin, fuer den sie gilt
 * (`allowance_date`), und den Zeitpunkt, an dem sie gebucht wurde
 * (`created_at`).
 *
 * IST DIE PERSON KEIN HAUSHALTSMITGLIED MEHR (Konto deaktiviert), wird der
 * Plan pausiert statt gebucht: ein Konto, das keine Liste mehr zeigt, sammelte
 * sonst unsichtbar weiter (wie die Punkte, #1207). Wird es wieder aktiviert,
 * setzen die Eltern den Plan fort - ohne die Termine der Zwischenzeit.
 *
 * @returns {{ credited: number, paused: boolean }}
 */
function creditPlan(d, plan, today) {
  if (!isHouseholdMember(plan.user_id, { db: d })) {
    closeFormerMoney(d, plan.user_id, { today });
    return { credited: 0, paused: true };
  }
  return creditDueDates(d, plan, today);
}

/*
 * Die faelligen Termine eines Plans bis einschliesslich `until` buchen und ihn
 * weiterruecken - ohne die Frage, ob die Person noch Mitglied ist (die stellt
 * der Aufrufer).
 *
 * DIES IST DER EINE GELDSCHREIBER NEBEN `postMoney()`, und er traegt dieselbe
 * Pruefung: die Waehrung des PLANS muss die des KONTOS sein. Der Saldo ist
 * EINE Summe ueber alle Geldzeilen; dass alte Waehrungen sich darin zu null
 * summieren, haelt nur, solange keine Zeile in einer fremden Waehrung auf ein
 * Konto faellt. Eine Planzeile, die das behauptet (von Hand verdreht, aus einer
 * Wiederherstellung), wird NICHT gebucht, sondern pausiert - 800 EUR auf einem
 * Yen-Konto waeren 800 Yen im Saldo (Review zu #1745).
 */
function creditDueDates(d, plan, until) {
  if (accountCurrency(d, plan.user_id) !== plan.currency) {
    d.prepare(`
      UPDATE reward_allowances
      SET paused_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND paused_at IS NULL
    `).run(plan.id);
    return { credited: 0, paused: true, mismatch: true };
  }
  const today = until;
  const credit = d.prepare(CREDIT_SQL);
  const anchor = stepAnchor(plan);
  let date = plan.next_run_date;
  let credited = 0;
  for (let step = 0; step < MAX_CATCH_UP_STEPS && date <= today; step += 1) {
    // Ein Saldo jenseits der exakten Zahlen ist keiner mehr: der Plan bleibt
    // auf diesem Termin stehen, statt eine Summe zu bauen, die niemand lesen kann.
    if (!creditFits(d, plan.user_id, plan.amount_minor)) break;
    credited += credit.run(plan.user_id, plan.amount_minor, plan.currency, date).changes;
    const next = addInterval(date, plan.frequency, anchor);
    // Ein Schritt, der nicht vorrueckt, liefe sonst bis zur Obergrenze im Kreis.
    if (!(next > date)) break;
    date = next;
  }
  d.prepare("UPDATE reward_allowances SET next_run_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
    .run(date, plan.id);
  return { credited, paused: false };
}

/**
 * Alle faelligen Gutschriften buchen. `today` ist der Tag der HAUSHALTSZONE
 * (`todayKey`), nie der UTC-Tag: westlich von UTC buchte der Lauf sonst schon
 * am Vorabend.
 *
 * Jeder Plan bucht in seiner EIGENEN Transaktion: ein Plan, der scheitert,
 * haelt die anderen nicht auf (wie der Lauf der geteilten Ausgaben).
 *
 * @param {object} d
 * @param {object} [options]
 * @param {Date}   [options.now]    Ersetzbar fuer Tests - der Zeitpunkt, dessen
 *                                  Haushaltstag "heute" ist.
 * @param {string} [options.today]  Der Tag selbst, wenn der Aufrufer ihn kennt.
 * @param {(plan: object, err: Error) => void} [options.onError]
 * @returns {{ credited: number, paused: number, failed: number }}
 */
export function creditDueAllowances(d, { now = new Date(), today = todayKey(d, now), onError = null } = {}) {
  const due = d.prepare(`
    SELECT * FROM reward_allowances
    WHERE paused_at IS NULL AND next_run_date <= ?
    ORDER BY next_run_date ASC, id ASC
  `).all(today);
  const result = { credited: 0, paused: 0, failed: 0 };
  // Konten, die schon deaktiviert waren, bevor es diese Regel gab (oder deren
  // Zustand an `deactivate()` vorbei wechselte): ihre offenen Geld-Anfragen
  // enden beim naechsten Lauf. Den Plan faengt die Schleife darunter.
  const stranded = d.prepare(`
    SELECT DISTINCT r.user_id FROM reward_redemptions r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending' AND r.kind != 'reward' AND NOT ${householdMemberSql('u')}
  `).all();
  for (const row of stranded) {
    try {
      d.transaction(() => closeFormerMoney(d, row.user_id, { today }))();
    } catch (err) {
      result.failed += 1;
      onError?.({ id: null, user_id: row.user_id }, err);
    }
  }
  for (const plan of due) {
    try {
      const out = d.transaction(() => creditPlan(d, plan, today))();
      result.credited += out.credited;
      if (out.paused) result.paused += 1;
      // Ein Plan in fremder Waehrung ist pausiert und wird gemeldet - einmal,
      // weil er danach nicht mehr faellig wird.
      if (out.mismatch) onError?.(plan, new Error(`Allowance plan ${plan.id} is in ${plan.currency}, its account is not; the plan was paused.`));
    } catch (err) {
      result.failed += 1;
      onError?.(plan, err);
    }
  }
  return result;
}
