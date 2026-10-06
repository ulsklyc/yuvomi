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
 * Einheiten der Haushaltswaehrung (wie `amount_minor` der geteilten Ausgaben),
 * nie als Gleitkommazahl.
 *
 * KEIN `await` IN DIESER DATEI. Der Treiber ist synchron, und jede Pruefung
 * "reicht der Saldo" steht mit ihrer Buchung in EINER Transaktion: zwischen
 * Lesen und Schreiben kommt kein anderer Request dazwischen.
 */

import { householdMemberSql, isHouseholdMember, memberOrderSql, memberPositionSql } from './household-members.js';
import { ledgerBalance, ledgerBalanceSql } from './rewards.js';
import { minorUnit, parseMoneyToMinor } from './split-expenses.js';
import { isDisplayRequest } from './display-acting.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { addInterval, dateKey, liftToAnchorDay, nextRunNotBefore, parseDateKey } from '../utils/interval-date.js';
import { householdCurrency } from '../utils/household-currency.js';
import { todayKey } from '../utils/timezone.js';

export const MONEY_KINDS = Object.freeze(['withdrawal', 'deposit']);
export const ALLOWANCE_FREQUENCIES = Object.freeze(['weekly', 'monthly']);

/** Obergrenze eines einzelnen Betrags, in kleinsten Einheiten. */
export const MAX_MONEY_MINOR = 100_000_000;

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

/** Waehrung und Nachkommastellen, in denen dieser Haushalt Geld fuehrt. */
export function moneyCurrency(d) {
  const currency = householdCurrency(d);
  return { currency, minor_unit: minorUnit(currency) };
}

/**
 * Ein Betrag aus dem Request als ganze kleinste Einheiten.
 *
 * Als Dezimal-TEXT ("5.00"), nie als Zahl: derselbe Parser wie die geteilten
 * Ausgaben, mit den ISO-4217-Stellen der Haushaltswaehrung. Er wirft
 * `SplitInputError` mit einem Satz, den die Route als 400 weiterreicht.
 */
export function parseMoneyAmount(d, value, field = 'amount') {
  const { currency } = moneyCurrency(d);
  const minor = parseMoneyToMinor(value, currency, field);
  if (minor > MAX_MONEY_MINOR) {
    const err = new Error(`${field} is too large.`);
    err.name = 'SplitInputError';
    throw err;
  }
  return minor;
}

// --------------------------------------------------------
// Konten
// --------------------------------------------------------

/** Der Geld-Saldo einer Person, in kleinsten Einheiten. */
export function moneyBalance(d, userId) {
  return ledgerBalance(d, userId, 'money');
}

const HAS_ACCOUNT_SQL = (userCol) => `(
  EXISTS (SELECT 1 FROM reward_allowances acc_a WHERE acc_a.user_id = ${userCol})
  OR EXISTS (SELECT 1 FROM reward_ledger acc_l WHERE acc_l.user_id = ${userCol} AND acc_l.unit = 'money')
)`;

/**
 * Hat diese Person ein Taschengeldkonto?
 *
 * EIN KONTO IST KEINE ZEILE, SONDERN EINE FOLGE: wer einen Plan oder eine
 * Geldbuchung hat, hat eins - unabhaengig von `reward_participants`. Ein
 * Haushalt kann Taschengeld fuehren, ohne das Punktesystem zu betreiben, und
 * umgekehrt. Eroeffnet wird es von den Eltern: mit dem ersten Plan oder der
 * ersten Buchung.
 */
export function hasMoneyAccount(d, userId) {
  if (!userId) return false;
  return !!d.prepare(`SELECT 1 AS yes FROM users u WHERE u.id = ? AND ${HAS_ACCOUNT_SQL('u.id')}`).get(userId);
}

function planView(row) {
  if (!row) return null;
  return {
    amount_minor: row.amount_minor,
    frequency: row.frequency,
    anchor_day: row.anchor_day,
    next_run_date: row.next_run_date,
    paused: row.paused_at != null,
  };
}

/**
 * Die Konten, die dieser Leser sehen darf - mit Saldo und Plan. Fuer ein Kind
 * hoechstens das eigene, fuer Admins alle, fuer ein Display keins. Nur
 * Haushaltsmitglieder (#1207): ein deaktiviertes Konto behaelt seine
 * Buchungen, steht aber in keiner Liste.
 */
export function listMoneyAccounts(d, reader) {
  const rows = d.prepare(`
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
  return rows.map((row) => ({ ...row, plan: planView(plan.get(row.id)) }));
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
    SELECT l.id, l.user_id, l.delta, l.type, l.reason, l.allowance_date,
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
  `).all({ ...moneyParams(reader), ...(userId ? { userId } : {}), limit });
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
export function readPlanInput(d, body) {
  const frequency = body?.frequency;
  if (!ALLOWANCE_FREQUENCIES.includes(frequency)) return { error: 'frequency must be weekly or monthly.' };
  const anchorDay = Number(body?.anchor_day);
  const max = frequency === 'weekly' ? 7 : 31;
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > max) {
    return { error: `anchor_day must be a whole number from 1 to ${max}.` };
  }
  let amountMinor;
  try {
    amountMinor = parseMoneyAmount(d, body?.amount);
  } catch (err) {
    if (err?.name === 'SplitInputError') return { error: err.message };
    throw err;
  }
  if (body?.paused !== undefined && typeof body.paused !== 'boolean') return { error: 'paused must be a boolean.' };
  return { frequency, anchorDay, amountMinor, paused: body?.paused === true };
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
 */
export function savePlan(d, userId, input, { actorId = null, today = todayKey(d) } = {}) {
  return d.transaction(() => {
    const existing = d.prepare('SELECT * FROM reward_allowances WHERE user_id = ?').get(userId);
    const rasterChanged = !existing
      || existing.frequency !== input.frequency || existing.anchor_day !== input.anchorDay;
    let nextRun;
    if (rasterChanged) nextRun = firstRunDate(input.frequency, input.anchorDay, today);
    else if (existing.paused_at != null && !input.paused) {
      nextRun = nextRunNotBefore(existing.next_run_date, existing.frequency, today, stepAnchor(existing)).date;
    } else nextRun = existing.next_run_date;

    if (!existing) {
      d.prepare(`
        INSERT INTO reward_allowances (user_id, amount_minor, frequency, anchor_day, next_run_date, paused_at, created_by)
        VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') END, ?)
      `).run(userId, input.amountMinor, input.frequency, input.anchorDay, nextRun, input.paused ? 1 : 0, actorId);
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
  INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, unit, allowance_date)
  VALUES (?, ?, 'bonus', NULL, NULL, 'money', ?)
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
    d.prepare(`
      UPDATE reward_allowances
      SET paused_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND paused_at IS NULL
    `).run(plan.id);
    return { credited: 0, paused: true };
  }
  const credit = d.prepare(CREDIT_SQL);
  const anchor = stepAnchor(plan);
  let date = plan.next_run_date;
  let credited = 0;
  for (let step = 0; step < MAX_CATCH_UP_STEPS && date <= today; step += 1) {
    credited += credit.run(plan.user_id, plan.amount_minor, date).changes;
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
  for (const plan of due) {
    try {
      const out = d.transaction(() => creditPlan(d, plan, today))();
      result.credited += out.credited;
      if (out.paused) result.paused += 1;
    } catch (err) {
      result.failed += 1;
      onError?.(plan, err);
    }
  }
  return result;
}
