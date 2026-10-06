/**
 * Modul: Budget-Tracker – Einträge
 * Zweck: Monatsübersicht, Eintragsliste, CSV-Export, Eintrags-CRUD + Serien.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, oneOf, date as validateDate, num, rrule, MAX_TITLE, MONTH_RE } from '../../middleware/validate.js';
import { normalizeBudgetVisibility, BUDGET_MASKED_CATEGORY } from '../../services/budget-visibility.js';
import { todayKey } from '../../utils/timezone.js';
import { foldSearchText } from '../../services/search.js';
import { sendDocumentDeletionConflict } from '../../services/document-deletion-lock.js';
import { assertDocumentLinkTargetsAvailable, documentViewer, sendDocumentLinkRefusal } from '../../services/document-links.js';
import { attachmentsFor, replaceAttachments, withAttachments } from './attachments.js';
import {
  budgetFilter, budgetCategoryExpr, maskEntries, getBudgetMode, mayEdit, bookedOnly,
  DATE_RE, thisMonthLocalKey, cents,
  generateRecurringInstances, RECURRENCE_INTERVAL_KEYS, MAX_INTERVAL_COUNT,
  normalizeIntervalCount, effectiveMonthly, occurrencesPerYear,
  validCategoryKeys, defaultCategory, validateSubcategory, validateAccountRef,
  entryWithLoanMeta, refreshLoanStatus, fromBudgetAmount, bookingFor,
  RESPONSIBLE_USERS_SQL, replaceResponsibles, withResponsibles, responsibleNonMembers,
  replaceSeriesResponsibles, seedSeriesResponsibles, materializeSeriesStart, freezeSeriesPast,
  refusal, refusals, refuse,
} from './helpers.js';
import { nonMemberMessage } from '../../services/household-members.js';

const log = createLogger('Budget');
const router = express.Router();

/**
 * "Alle N" (#636): ganze Zahl in [1, MAX_INTERVAL_COUNT].
 *
 * Ein unbrauchbarer Wert wird abgelehnt statt still geklemmt: eine stumme
 * Korrektur setzte einen Rhythmus, den niemand gewählt hat, und die Serie
 * schriebe ihn ab dem nächsten Monat fort.
 */
function intervalCountCheck(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_COUNT) {
    return { value: null, error: `Interval count must be between 1 and ${MAX_INTERVAL_COUNT}.` };
  }
  return { value: n, error: null };
}

/**
 * GET /api/v1/budget/summary
 * Monatsübersicht: Einnahmen, Ausgaben, Saldo, Aufschlüsselung nach Kategorie.
 * Query: ?month=YYYY-MM  (default: aktueller Monat)
 * Response: { data: { month, income, expenses, balance, byCategory: [] } }
 */
router.get('/summary', (req, res) => {
  try {
    // DER VOREINGESTELLTE MONAT IST EINE FRAGE AN DIE UHR, und die folgt der
    // Haushaltszone. `new Date().toISOString().slice(0, 7)` stand hier und ist
    // der UTC-Monat: oestlich von UTC zeigt er am Ersten frueh noch den
    // Vormonat, westlich davon am Letzten abends schon den naechsten. Die
    // Uebersicht sprang damit fuer ein paar Stunden im Monat auf den falschen
    // Zeitraum, ohne dass jemand etwas anders gemacht haette
    // (dieselbe Familie wie die Tagesschluessel-Falle; die Datei importiert
    // `todayKey` fuer genau diese Frage schon, nur nicht hier).
    const month = req.query.month || todayKey(db.get()).slice(0, 7);

    if (!MONTH_RE.test(month))
      return res.status(400).json({ error: 'month must be in YYYY-MM format.', code: 400 });

    const from = `${month}-01`;
    const to   = `${month}-31`;

    // Sichtbarkeit/Scope (#476/#505): dieselbe Filterung wie die Eintragsliste,
    // damit Summen private Fremd-Einträge nicht mit einrechnen.
    const filter = budgetFilter(req, 'budget_entries');

    const totals = db.get().prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(amount) AS balance
      FROM budget_entries
      WHERE date BETWEEN ? AND ?${filter.clause}${bookedOnly()}
    `).get(from, to, ...filter.params);

    // Fremde 'shared_amount'-Eintraege laufen unter dem Sammel-Bucket (#659):
    // ihr Betrag zaehlt mit, ihre Kategorie verriete sonst den Zweck.
    const catExpr = budgetCategoryExpr(req, 'budget_entries');
    const byCategory = db.get().prepare(`
      SELECT ${catExpr.expr} AS category,
             SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
             SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
             SUM(amount) AS total
      FROM budget_entries
      WHERE date BETWEEN ? AND ?${filter.clause}${bookedOnly()}
      -- GROUP BY 1, nicht GROUP BY category: bei gleichnamigem Output-Alias
      -- gewinnt in SQLite die ECHTE Spalte, und dann gruppierte die Auswertung
      -- weiter nach der unmaskierten Kategorie - der Sammel-Bucket bliebe leer.
      GROUP BY 1
      ORDER BY ABS(SUM(amount)) DESC
    `).all(...catExpr.params, from, to, ...filter.params);

    // Was noch aussteht, wird eigens ausgewiesen (#637). Ohne diese Zahl
    // verschwaende eine erwartete Buchung spurlos aus der Uebersicht, und die
    // Bestaetigung liesse sich nur noch in der Liste finden.
    const pending = db.get().prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
             COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses
      FROM budget_entries
      WHERE date BETWEEN ? AND ?${filter.clause} AND is_pending = 1
    `).get(from, to, ...filter.params);

    res.json({
      data: {
        month,
        income:     totals.income   || 0,
        expenses:   totals.expenses || 0,
        balance:    totals.balance  || 0,
        byCategory,
        pending: {
          count:    pending.count,
          income:   pending.income,
          expenses: pending.expenses,
        },
      },
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * Leitet Zeitraum aus from/to oder month ab.
 * @param {object} query - { from?, to?, month? }
 * @returns {object} { from: YYYY-MM-DD, to: YYYY-MM-DD }
 */
export function resolveExportRange({ from, to, month }) {
  if (DATE_RE.test(from || '') && DATE_RE.test(to || '')) return { from, to };
  const m = MONTH_RE.test(month || '') ? month : thisMonthLocalKey();
  return { from: `${m}-01`, to: `${m}-31` };
}

/**
 * GET /api/v1/budget/export
 * Monatseinträge als CSV-Download.
 * Query: ?month=YYYY-MM or ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Response: text/csv
 */
router.get('/export', (req, res) => {
  try {
    const { from, to } = resolveExportRange(req.query);
    const filename = (DATE_RE.test(req.query.from || '') && DATE_RE.test(req.query.to || ''))
      ? `budget-${from}_${to}.csv`
      : `budget-${req.query.month || thisMonthLocalKey()}.csv`;
    const filter = budgetFilter(req, 'b');
    // Der Export ist ein Lesepfad wie jeder andere: fremde 'shared_amount'-
    // Eintraege muessen auch hier ihren Betrag beitragen, ohne ihren Zweck zu
    // nennen (#659). Ohne die Maske waere die CSV der bequemste Weg, genau das
    // auszulesen, was die Oberflaeche verbirgt.
    const entries = maskEntries(req, db.get().prepare(`
      SELECT b.*, u.display_name AS creator_name
      FROM budget_entries b
      LEFT JOIN users u ON u.id = b.created_by
      WHERE b.date BETWEEN ? AND ?${filter.clause}
      ORDER BY b.date ASC
    `).all(from, to, ...filter.params));

    const header = 'Date,Title,Amount,Category,Subcategory,Recurring,Status,Created by\n';
    const csvSafe = (val) => {
      let s = String(val || '').replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s}"`;
    };
    const rows   = entries.map((e) =>
      [
        e.date,
        csvSafe(e.details_hidden ? 'Private entry' : e.title),
        // Punkt-Dezimal ohne Tausendertrennung: in einem komma-getrennten CSV
        // wäre ein Komma-Dezimaltrenner ein zweites Feldtrennzeichen (Spalte
        // zerreißt). Punkt-Dezimal ist maschinenlesbar, überall parsebar und
        // deckt sich mit der region-abhängigen Anzeige für Punkt-Locales (#521).
        e.amount.toFixed(2),
        e.details_hidden ? 'Private' : e.category,
        e.subcategory || '',
        e.is_recurring ? 'Yes' : 'No',
        // Der Export ist ein Beleg: eine erwartete Buchung darf darin nicht wie
        // eine erfolgte aussehen (#637). Sie bleibt drin, aber gekennzeichnet.
        e.is_pending ? 'Expected' : 'Booked',
        csvSafe(e.creator_name),
      ].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + header + rows); // BOM für Excel
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/* SUCHE IM HAUPTBUCH (Re-Critique 2026-09-27, C6).
 *
 * "Wann war die letzte Zahnarztrechnung?" hiess bisher Monate blaettern. `?q=`
 * sucht ueber ALLE Monate im Titel - im Wortinneren ("arzt" findet die
 * "Zahnarztrechnung"), ohne Gross-/Kleinschreibung und Akzente ("muller" findet
 * "Müller"), mit derselben Faltung wie die globale Suche (foldSearchText).
 *
 * WARUM IN JS UND NICHT PER LIKE: LIKE faltet in SQLite nur ASCII, und `%`/`_`
 * waeren Platzhalter, die jeder Aufrufer escapen muesste. Die Zeilen eines
 * Haushalts sind wenige tausend; die Sichtbarkeit filtert weiter die SQL-Abfrage.
 *
 * GESUCHT WIRD IM MASKIERTEN TITEL. Eine fremde "nur Betrag"-Buchung hat fuer
 * den Betrachter keinen Titel (maskEntries leert ihn) - wuerde die Suche den
 * echten pruefen, verriete ein Treffer genau den Zweck, den die Stufe schuetzt. */
const LEDGER_SEARCH_LIMIT = 200;
const LEDGER_SEARCH_MAX_LENGTH = 100;

/**
 * GET /api/v1/budget
 * Einträge eines Monats abrufen - oder mit `q` die Treffer aller Monate.
 * Query: ?month=YYYY-MM&category=<cat>  |  ?q=<text>&account_id=&scope=
 * Response: { data: Entry[] }  |  { data: Entry[], meta: { query, limit, truncated } }
 */
router.get('/', (req, res) => {
  try {
    if (req.query.q !== undefined && !req.query.loan_id) return searchEntries(req, res);
    // Haushaltszone, nicht UTC - dieselbe Begruendung wie bei `/summary`
    // darueber. Beide Vorgaben muessen denselben Monat nennen: die Liste und
    // die Zusammenfassung darueber stehen auf einer Seite, und zwei Stunden
    // im Monat zeigten sie verschiedene Zeitraeume.
    const month = req.query.month || todayKey(db.get()).slice(0, 7);
    const loanId = req.query.loan_id ? parseInt(req.query.loan_id, 10) : null;

    if (!loanId && !MONTH_RE.test(month))
      return res.status(400).json({ error: 'month must be in YYYY-MM format.', code: 400 });

    if (!loanId) generateRecurringInstances(db.get(), month);

    const from   = `${month}-01`;
    const to     = `${month}-31`;
    let sql      = `
      SELECT b.*, u.display_name AS creator_name,
             ${RESPONSIBLE_USERS_SQL},
             p.id AS loan_payment_id,
             p.loan_id AS loan_id,
             p.installment_number AS loan_installment_number,
             l.title AS loan_title,
             l.borrower AS loan_borrower
      FROM budget_entries b
      LEFT JOIN users u ON u.id = b.created_by
      LEFT JOIN budget_loan_payments p ON p.budget_entry_id = b.id
      LEFT JOIN budget_loans l ON l.id = p.loan_id
    `;
    const params = [];

    if (loanId) {
      sql += ' WHERE p.loan_id = ?';
      params.push(loanId);
    } else {
      sql += ' WHERE b.date BETWEEN ? AND ?';
      params.push(from, to);
    }

    // GEFILTERT WIRD AUF DIE MASKIERTE KATEGORIE (#659), nicht auf die Spalte.
    // Fremde 'shared_amount'-Zeilen tragen in der Antwort '__private__'; ein
    // Filter auf die echte Spalte liesse sie trotzdem genau unter ihrer echten
    // Kategorie erscheinen, und die Treffermenge verriete den Zweck, den die
    // Maske verbirgt. Wie in Summary und Statistik laufen sie deshalb unter dem
    // Sammel-Bucket - und der ist hier auch filterbar, damit jede Zeile der
    // Kategorie-Aufschluesselung einen Drilldown hat. Der Bind des Ausdrucks
    // steht an seiner Stelle im WHERE, also VOR dem Vergleichswert.
    const categoryKey = req.query.category;
    if (categoryKey && (categoryKey === BUDGET_MASKED_CATEGORY || validCategoryKeys().includes(categoryKey))) {
      const catExpr = budgetCategoryExpr(req, 'b');
      sql += ` AND ${catExpr.expr} = ?`;
      params.push(...catExpr.params, categoryKey);
    }

    if (req.query.account_id) {
      const accountId = parseInt(req.query.account_id, 10);
      if (Number.isInteger(accountId) && accountId > 0) {
        sql += ' AND b.account_id = ?';
        params.push(accountId);
      }
    }

    // Sichtbarkeit/Scope (#476/#505). In der Loan-Drilldown-Ansicht kein
    // Mein/Haushalt-Scope, nur Sichtbarkeit.
    const filter = budgetFilter(req, 'b', { scoped: !loanId });
    sql += filter.clause;
    params.push(...filter.params);

    sql += ' ORDER BY b.date DESC, b.created_at DESC';

    const entries = db.get().prepare(sql).all(...params).map(withResponsibles);
    const masked = maskEntries(req, withAttachments(entries, documentViewer(req)));
    // Der Darlehens-Drilldown filtert auf eine Verknuepfung, und die nimmt die
    // Maske einer fremden 'shared_amount'-Rate weg (#659). Auf die maskierte
    // Sicht gefiltert passt eine solche Rate deshalb zu keinem Darlehen - sonst
    // verriete die Treffermenge, wofuer das Geld war.
    res.json({
      data: loanId ? masked.filter((row) => !row.details_hidden) : masked,
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

function searchEntries(req, res) {
  const raw = String(Array.isArray(req.query.q) ? req.query.q[0] : req.query.q).trim();
  if (!raw || raw.length > LEDGER_SEARCH_MAX_LENGTH) {
    return res.status(400).json({ error: `q must be 1-${LEDGER_SEARCH_MAX_LENGTH} characters long.`, code: 400 });
  }
  const needle = foldSearchText(raw);
  let sql = `
    SELECT b.*, u.display_name AS creator_name,
           ${RESPONSIBLE_USERS_SQL},
           p.id AS loan_payment_id,
           p.loan_id AS loan_id,
           p.installment_number AS loan_installment_number,
           l.title AS loan_title,
           l.borrower AS loan_borrower
    FROM budget_entries b
    LEFT JOIN users u ON u.id = b.created_by
    LEFT JOIN budget_loan_payments p ON p.budget_entry_id = b.id
    LEFT JOIN budget_loans l ON l.id = p.loan_id
    WHERE 1 = 1
  `;
  const params = [];
  if (req.query.account_id) {
    const accountId = parseInt(req.query.account_id, 10);
    if (Number.isInteger(accountId) && accountId > 0) {
      sql += ' AND b.account_id = ?';
      params.push(accountId);
    }
  }
  const filter = budgetFilter(req, 'b');
  sql += filter.clause;
  params.push(...filter.params);
  sql += ' ORDER BY b.date DESC, b.created_at DESC';

  const hits = maskEntries(req, db.get().prepare(sql).all(...params))
    .filter((row) => row.title && foldSearchText(row.title).includes(needle));
  const shown = hits.slice(0, LEDGER_SEARCH_LIMIT).map(withResponsibles);
  res.json({
    data: withAttachments(shown, documentViewer(req)),
    meta: { query: raw, limit: LEDGER_SEARCH_LIMIT, truncated: hits.length > LEDGER_SEARCH_LIMIT },
  });
}

/**
 * POST /api/v1/budget
 * Neuen Eintrag anlegen.
 * Body: { title, amount, category?, subcategory?, date, is_recurring?, recurrence_rule? }
 * Response: { data: Entry }
 */
router.post('/', (req, res) => {
  try {
    const vTitle  = str(req.body.title,    'Title',  { max: MAX_TITLE });
    const vAmount = num(req.body.amount,  'Amount', { required: true });
    const fallbackCategory = defaultCategory(Number(req.body.amount) < 0 ? 'expense' : 'income');
    const vCat    = oneOf(req.body.category || fallbackCategory, validCategoryKeys(), 'Category');
    const vDate   = validateDate(req.body.date,   'Date',  true);
    const vRrule  = rrule(req.body.recurrence_rule, 'recurrence_rule');
    const vInterval = oneOf(req.body.recurrence_interval || 'monthly', RECURRENCE_INTERVAL_KEYS, 'Interval');
    const vCount = req.body.recurrence_interval_count !== undefined
      ? intervalCountCheck(req.body.recurrence_interval_count)
      : { value: 1, error: null };
    const errors  = [
      ...refusals('entry_title_invalid', [vTitle]),
      ...refusals('entry_amount_invalid', [vAmount]),
      ...refusals('entry_category_invalid', [vCat]),
      ...refusals('entry_date_invalid', [vDate]),
      ...refusals('entry_recurrence_invalid', [vRrule, vInterval]),
      ...refusals('entry_interval_count_invalid', [vCount]),
    ];
    if (errors.length) return refuse(res, errors);
    const subcategory = validateSubcategory(vCat.value, req.body.subcategory);
    if (subcategory === null) {
      return refuse(res, [refusal('entry_subcategory_invalid', 'Invalid subcategory.')]);
    }

    const accountRef = validateAccountRef(req.body.account_id);
    if (accountRef.error) return refuse(res, [refusal('entry_account_invalid', accountRef.error)]);
    // Zustaendig nur Haushaltsmitglieder (#1207).
    const strangers = responsibleNonMembers(null, req.body.responsible_user_ids);
    if (strangers.length) return refuse(res, [refusal('entry_responsible_invalid', nonMemberMessage(strangers))]);

    // Intervall + virtuelles Budget nur für wiederkehrende Einträge.
    const isRecurring = req.body.is_recurring ? 1 : 0;
    const interval    = isRecurring ? vInterval.value : 'monthly';
    const intervalCount = isRecurring ? normalizeIntervalCount(vCount.value) : 1;
    // Bestaetigung je Serie (#637): nur sinnvoll, wo Instanzen entstehen.
    const confirmFirst = isRecurring && req.body.recurrence_confirm ? 1 : 0;
    const isVirtual   = isRecurring && req.body.recurrence_virtual ? 1 : 0;
    // Virtuell: amount hält den geglätteten Monatsanteil, full den eingegebenen Periodenbetrag.
    const storeAmount = isVirtual ? effectiveMonthly(vAmount.value, interval, intervalCount) : vAmount.value;
    const fullAmount  = isVirtual ? cents(vAmount.value) : null;

    // Eigentümerschaft (fix = Ersteller:in) + Sichtbarkeit (#476/#505).
    // Default-Sichtbarkeit hängt vom Haushalts-Modus ab: personal → private.
    const me = req.authUserId || req.session.userId;
    const visibility = normalizeBudgetVisibility(
      req.body.visibility,
      getBudgetMode() === 'personal' ? 'private' : 'shared'
    );
    assertDocumentLinkTargetsAvailable(db.get(), req.body.attachment_document_ids, documentViewer(req));

    const result = db.get().prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, recurrence_rule,
         recurrence_interval, recurrence_interval_count, recurrence_virtual,
         recurrence_confirm, recurrence_full_amount, account_id, created_by, owner_id, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vTitle.value, storeAmount, vCat.value || fallbackCategory, subcategory, vDate.value,
      isRecurring, vRrule.value,
      interval, intervalCount, isVirtual, confirmFirst, fullAmount, accountRef.value,
      me, me, visibility
    );

    // Belege (#583): optional, deshalb erst nach dem Insert - der Eintrag steht
    // auch ohne sie, ein unbekanntes Dokument darf ihn nicht scheitern lassen.
    replaceAttachments(result.lastInsertRowid, req.body.attachment_document_ids, documentViewer(req));
    // Zustaendige (#1057) - ein Etikett neben der Buchung, keine Forderung.
    replaceResponsibles(result.lastInsertRowid, req.body.responsible_user_ids);
    // Eine neue Serie ist ihre eigene Vorlage (#1035): die Werte legt der
    // Trigger aus v228 an, die Zustaendigen kommen erst hier dazu.
    if (isRecurring) seedSeriesResponsibles(result.lastInsertRowid);

    const entry = entryWithLoanMeta(result.lastInsertRowid);

    res.status(201).json({ data: { ...entry, attachments: attachmentsFor(entry.id, documentViewer(req)) } });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
    if (sendDocumentLinkRefusal(res, err)) return;
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/:id/series
 * Ändert eine Serie "für alle künftigen": ihre Definition (budget_series) und
 * jede Buchung der Serie ab heute (Haushaltszone). Was davor liegt, ist gebucht
 * und bleibt - die erste Buchung eingeschlossen (#1035). Einzige Ausnahme ist
 * die Sichtbarkeit, die bewusst für die ganze Serie gilt.
 * Body: wie PUT /:id, dazu optional start_date (YYYY-MM-DD, der Starttag der
 * Serie, #1545). `date` wird ignoriert: es ist das Datum einer Buchung.
 * Response: { data: Anker-Buchung + series: Definition | null }
 */
router.put('/:id/series', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const parentId = entry.recurrence_parent_id ?? (entry.is_recurring ? entry.id : null);
    if (!parentId) return refuse(res, [refusal('entry_not_recurring', 'Not a recurring entry.')]);

    const parent = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(parentId);
    if (!parent) return res.status(404).json({ error: 'Series parent not found', code: 404 });

    // DIE VORLAGE IST DIE DEFINITION, NICHT DIE ERSTE BUCHUNG (#1035). Bis v227
    // war der Anker beides, und diese Route schrieb Titel, Betrag, Kategorie,
    // Unterkategorie, Konto und Zustaendige per `WHERE id = parentId` auf eine
    // Buchung, die Jahre zurueckliegen konnte - die Miete von 2020 zog auf das
    // neue Konto um. Fehlt die Definition, ist die Serie beendet; dann bleibt
    // der Anker die Grundlage, wie bei jedem Neubeginn (Trigger aus v228).
    const series = db.get().prepare('SELECT * FROM budget_series WHERE anchor_id = ?').get(parentId);
    const base = series ?? {
      title: parent.title, amount: parent.amount, full_amount: parent.recurrence_full_amount,
      category: parent.category, subcategory: parent.subcategory,
    };

    const checks = [];
    if (req.body.title    !== undefined) checks.push(['entry_title_invalid', str(req.body.title,    'Title',  { max: MAX_TITLE, required: false })]);
    if (req.body.amount   !== undefined) checks.push(['entry_amount_invalid', num(req.body.amount,   'Amount')]);
    if (req.body.category !== undefined) checks.push(['entry_category_invalid', oneOf(req.body.category, validCategoryKeys(), 'Category')]);
    if (req.body.recurrence_rule !== undefined) checks.push(['entry_recurrence_invalid', rrule(req.body.recurrence_rule, 'recurrence_rule')]);
    if (req.body.recurrence_interval !== undefined) checks.push(['entry_recurrence_invalid', oneOf(req.body.recurrence_interval, RECURRENCE_INTERVAL_KEYS, 'Interval')]);
    if (req.body.recurrence_interval_count !== undefined) checks.push(['entry_interval_count_invalid', intervalCountCheck(req.body.recurrence_interval_count)]);
    if (req.body.start_date !== undefined) checks.push(['entry_start_date_invalid', validateDate(req.body.start_date, 'start_date', true)]);
    const errors = checks.flatMap(([reason, result]) => refusals(reason, [result]));
    if (errors.length) return refuse(res, errors);
    // EINE SERIEN-AENDERUNG BEENDET DIE SERIE NICHT (#1546).
    //
    // `is_recurring: false` hiess hier "Serie beenden, jedes Vorkommen ab heute
    // loeschen" - und kam fast nie gewollt: der Bearbeiten-Dialog eines
    // Vorkommens belegte sein Formular mit dem Vorkommen vor, und ein
    // Vorkommen traegt is_recurring = 0. "Alle kuenftigen aendern" beendete so
    // still die ganze Serie, mit Erfolgs-Toast. Der Dialog schickt den Rhythmus
    // jetzt gar nicht mehr mit; diese Grenze ist die zweite Sicherung, und sie
    // faengt genau den Body, den ein noch zwischengespeicherter alter Client
    // schickt: der wird laut abgewiesen, statt still Vorkommen zu loeschen.
    //
    // Abweisen statt ignorieren: ein Aufrufer, der die Serie wirklich beenden
    // will, bekaeme sonst 200 und eine Serie, die weiterlaeuft - dieselbe
    // stille Luege in die andere Richtung. Beenden hat zwei eigene Wege:
    // PUT /budget/:id mit is_recurring: false an der ersten Buchung (so beendet
    // der Dialog eine Serie) oder DELETE /budget/:id/series.
    if (req.body.is_recurring !== undefined && !req.body.is_recurring) {
      return refuse(res, [refusal(
        'series_end_refused',
        'A series edit cannot end the series. To end it, set is_recurring to false on its first entry (PUT /budget/:id) or delete it (DELETE /budget/:id/series).',
      )]);
    }
    // Neu nur Haushaltsmitglieder (#1207), gegen den Stand der Serie - ihrer
    // Definition, nicht ihrer ersten Buchung (#1035).
    const strangers = responsibleNonMembers(parentId, req.body.responsible_user_ids, { series: true });
    if (strangers.length) return refuse(res, [refusal('entry_responsible_invalid', nonMemberMessage(strangers))]);

    const { title, amount, category, subcategory: requestedSubcategory, is_recurring, recurrence_rule } = req.body;
    const finalTitle    = title     !== undefined ? title.trim()                        : base.title;
    const finalAmount   = amount    !== undefined ? Number(amount)                     : base.amount;
    const finalCategory = category  !== undefined ? category                           : base.category;
    const finalSubcat   = requestedSubcategory !== undefined
      ? (validateSubcategory(finalCategory, requestedSubcategory) ?? base.subcategory)
      : base.subcategory;
    const finalRecurring = is_recurring !== undefined ? (is_recurring ? 1 : 0) : parent.is_recurring;
    const finalInterval  = req.body.recurrence_interval !== undefined
      ? req.body.recurrence_interval
      : (parent.recurrence_interval || 'monthly');
    const finalCount     = normalizeIntervalCount(req.body.recurrence_interval_count !== undefined
      ? req.body.recurrence_interval_count
      : parent.recurrence_interval_count);
    const finalVirtual   = req.body.recurrence_virtual !== undefined
      ? (req.body.recurrence_virtual ? 1 : 0)
      : parent.recurrence_virtual;
    const finalConfirm   = req.body.recurrence_confirm !== undefined
      ? (req.body.recurrence_confirm ? 1 : 0)
      : parent.recurrence_confirm;
    // DER BETRAG EINES VORKOMMENS IST SEIN BETRAG (#1546). Bei einer virtuellen
    // Serie zeigt ein Vorkommen den Monatsanteil, die erste Buchung dagegen den
    // Periodenbetrag. Kommt die Aenderung ueber ein Vorkommen, ist der Betrag
    // also ein Monatsanteil - als Periodenbetrag gelesen, wuerde er ein zweites
    // Mal geglaettet (aus 100 im Monat wurden 8,33). Der Periodenbetrag wird
    // deshalb aus ihm zurueckgerechnet, und die Vorkommen tragen genau den
    // eingegebenen Anteil.
    const shareFromOccurrence = amount !== undefined && entry.id !== parentId
      && finalVirtual && parent.recurrence_virtual;
    const finalFull      = finalVirtual
      ? (amount !== undefined
        ? cents(shareFromOccurrence
          ? finalAmount * 12 / occurrencesPerYear(finalInterval, finalCount)
          : finalAmount)
        : (base.full_amount ?? base.amount))
      : null;
    const storeAmount    = shareFromOccurrence
      ? cents(finalAmount)
      : (finalVirtual ? effectiveMonthly(finalFull, finalInterval, finalCount) : finalAmount);
    const finalRrule     = recurrence_rule !== undefined ? (recurrence_rule || null) : parent.recurrence_rule;

    // SICHTBARKEIT GILT BEWUSST RUECKWIRKEND, fuer die ganze Serie (#476/#505,
    // Entscheidung in #1035). Anders als die Werte oben ist sie keine Tatsache
    // ueber eine einzelne Buchung, sondern eine Aussage ueber die Serie: wer sie
    // privat stellt, meint auch ihre alten Buchungen, und eine private Serie,
    // deren Vergangenheit im Haushalt sichtbar bliebe, waere die Ueberraschung
    // (privat->geteilt waere dazu ein Leck in die andere Richtung). Sie trifft
    // deshalb die Definition, den Anker und JEDE Instanz ohne Datumsschnitt.
    const nextVisibility = req.body.visibility !== undefined
      ? normalizeBudgetVisibility(req.body.visibility)
      : null;

    // Konto-Zuordnung wie im Einzel-PUT: undefined ⇒ unverändert; null/'' ⇒ Zuordnung
    // entfernen; id ⇒ setzen. Sie fehlte hier ganz (#973), und damit lief die einzige
    // Reparatur ins Leere, die dem Melder offenstand: das Konto an einer Folgebuchung
    // nachtragen und "alle künftigen ändern" wählen: die Route ignorierte das Feld und
    // löschte die Instanz gleich darauf mit weg.
    //
    // Anders als die Sichtbarkeit wirkt sie NICHT auf bereits vergangene Buchungen -
    // auch nicht auf die erste (#1035). Ein Konto ist eine Tatsache über eine bereits
    // erfolgte Abbuchung.
    const accountProvided = req.body.account_id !== undefined;
    let accountValue = null;
    if (accountProvided) {
      const accountRef = validateAccountRef(req.body.account_id);
      if (accountRef.error) return refuse(res, [refusal('entry_account_invalid', accountRef.error)]);
      accountValue = accountRef.value;
    }

    // Schnitt bei HEUTE, nicht am Monatsersten (#973, zweite Runde).
    //
    // Der Monatserste war fuer Monatsserien gedacht, wo er dasselbe bedeutet.
    // Eine WOCHENserie hat mehrere Instanzen im Monat: steht heute der 6., dann
    // liegt die Buchung vom 1. bereits hinter uns, wurde aber mitgeloescht und
    // aus dem Original neu erzeugt. Solange nur Titel und Betrag wanderten, fiel
    // das kaum auf; seit das Konto mitkommt, zieht eine bereits erfolgte
    // Abbuchung auf ein anderes Konto um und verfaelscht dessen Saldo.
    // Nebenbei bleiben damit die Belege vergangener Buchungen erhalten, die die
    // CASCADE bisher mitnahm (siehe #583 weiter unten).
    //
    // `todayKey(db)` ist hier der richtige Helfer, nicht `todayLocalDateKey()`
    // und erst recht nicht `toISOString()`: nur er folgt der HAUSHALTSZONE.
    // Genau die benutzt `listAccounts()` fuer seinen Stichtag (#829). Laufen die
    // beiden auseinander, loescht diese Route kurz nach Mitternacht noch einen
    // Tag, den die Kontoansicht bereits als vergangen fuehrt - und erzeugt ihn
    // mit dem neuen Konto neu. Dieselbe Zone auf beiden Seiten, sonst ist der
    // Schnitt eine andere Grenze als die, an der die Zahlen abgelesen werden.
    //
    // Der Schnitt gilt fuer JEDE Buchung der Serie gleich, die erste
    // eingeschlossen (#1035): sie ist eine gewoehnliche Buchung. Liegt sie
    // selbst noch vor uns (die Serie beginnt naechsten Monat), zieht sie mit.
    const cutoffDate = todayKey(db.get());
    const anchorAhead = parent.date >= cutoffDate;

    // DER STARTTAG GEHOERT DER DEFINITION (#1545). Er aendert sich nur, wenn
    // die Anfrage ihn ausdruecklich als `start_date` nennt - nie ueber `date`:
    // das ist das Datum der Buchung, an der der Dialog offen war, und Clients
    // haben es hier jahrelang mitgeschickt, weil diese Route es ignorierte.
    // Ein neuer Starttag verschiebt das Raster und wird deshalb wie ein
    // geaenderter Rhythmus behandelt (Schritt 4). Die erste Buchung zieht mit,
    // solange sie selbst noch vor uns liegt - wie ihre Werte in Schritt 2.
    const currentStart = series?.start_date ?? parent.date;
    const finalStart   = req.body.start_date !== undefined ? req.body.start_date : currentStart;
    const startChanged = finalStart !== currentStart;
    // NICHT VOR DEN MONAT DER GEBUCHTEN ERSTEN BUCHUNG. Der Monatsaufruf laesst
    // nur den Monat des Starttags aus - er gehoert der ersten Buchung. Laege
    // der Starttag einen Monat frueher, entstuende in ihrem Monat ein zweites
    // Vorkommen neben ihr, und davor Buchungen, die es vor dem Beginn der
    // Serie nie gab (Review-Befund in #1585). Im selben Monat ist der Tag frei
    // ("ab jetzt am 4. statt am 5."); liegt die erste Buchung noch vor uns,
    // zieht sie ohnehin mit.
    if (startChanged && !anchorAhead && finalStart.slice(0, 7) < parent.date.slice(0, 7)) {
      return refuse(res, [refusal(
        'series_start_too_early',
        'The start day of a series cannot lie in a month before its first entry once that entry is booked.',
      )]);
    }

    // Verschieben sich die Termine (Rhythmus oder Starttag)? Dann gilt ab heute
    // ein neues Raster - Schritt 0 und 4.
    const rhythmChanged = finalInterval !== parent.recurrence_interval
      || finalCount !== parent.recurrence_interval_count
      || finalVirtual !== parent.recurrence_virtual
      || finalRrule !== parent.recurrence_rule
      || finalRecurring !== parent.is_recurring
      || startChanged;

    db.get().transaction(() => {
      // 0. DIE VERGANGENHEIT EINFRIEREN, solange das alte Raster noch gilt
      //    (Entscheidung in #1585). Ab Schritt 4 entsteht vor heute nichts mehr
      //    (grid_from); ein Monat, der nie aufgeschlagen wurde, bekommt seine
      //    Vorkommen deshalb jetzt - auf dem alten Raster, mit den Werten der
      //    Definition vor dieser Aenderung. Ohne Definition (beendete Serie,
      //    die hier neu beginnt) gibt es kein altes Raster.
      if (rhythmChanged && series) freezeSeriesPast(db.get(), parentId, cutoffDate);

      // 1. Der Anker: Rhythmus und Serienschalter immer - sie haben nur eine
      //    Bedeutung. Beendet `is_recurring = 0` die Serie, raeumt der Trigger
      //    aus v228 die Definition ab; ein Neubeginn legt sie aus dem Anker an
      //    und bekommt in Schritt 3 die Werte dieser Anfrage.
      db.get().prepare(`
        UPDATE budget_entries SET
          is_recurring              = ?,
          recurrence_rule           = ?,
          recurrence_interval       = ?,
          recurrence_interval_count = ?,
          recurrence_virtual        = ?,
          recurrence_confirm        = ?,
          visibility                = COALESCE(?, visibility)
        WHERE id = ?
      `).run(finalRecurring, finalRrule, finalInterval, finalCount, finalVirtual,
             finalConfirm, nextVisibility, parentId);

      // 2. Seine WERTE nur, wenn er noch nicht gebucht ist - und mit ihnen
      //    sein Datum, wenn der Starttag sich aendert (#1545).
      if (anchorAhead) {
        db.get().prepare(`
          UPDATE budget_entries SET
            title                  = ?,
            amount                 = ?,
            category               = ?,
            subcategory            = ?,
            recurrence_full_amount = ?,
            account_id             = CASE WHEN ? = 1 THEN ? ELSE account_id END,
            date                   = CASE WHEN ? = 1 THEN ? ELSE date END
          WHERE id = ?
        `).run(finalTitle, storeAmount, finalCategory, finalSubcat, finalFull,
               accountProvided ? 1 : 0, accountValue,
               startChanged ? 1 : 0, finalStart, parentId);
      }

      // 3. Die Definition - die Vorlage fuer jedes Vorkommen, das noch entsteht.
      db.get().prepare(`
        UPDATE budget_series SET
          title       = ?,
          amount      = ?,
          full_amount = ?,
          category    = ?,
          subcategory = ?,
          visibility  = COALESCE(?, visibility),
          account_id  = CASE WHEN ? = 1 THEN ? ELSE account_id END,
          start_date  = ?,
          updated_at  = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE anchor_id = ?
      `).run(finalTitle, storeAmount, finalFull, finalCategory, finalSubcat, nextVisibility,
             accountProvided ? 1 : 0, accountValue, finalStart, parentId);

      // 4. Die vorhandenen Instanzen ab heute.
      //
      // LÖSCHEN NUR, WENN SICH DIE TERMINE VERSCHIEBEN.
      //
      // Bis hierher war der einzige Weg, künftige Instanzen an eine geänderte
      // Serie anzugleichen: alle wegwerfen und beim nächsten Lesen neu bauen.
      // Das ist richtig, wenn sich der Rhythmus ändert - dann liegen die
      // Termine anderswo. Für eine reine Wertänderung ist es zu grob: die
      // Zeilen verlieren ihre Identität, ihre Belege gehen über die CASCADE
      // mit (#583), und sie kommen mit allem zurück, was an der Definition
      // steht - auch mit einem Konto, das sie vorher bewusst nicht hatten.
      //
      // Ändert sich nur ein Wert, werden die vorhandenen Zeilen deshalb
      // aktualisiert statt ersetzt. Der Schnitt bleibt derselbe: was vor
      // heute liegt, ist gebucht und wird nicht mehr angefasst.
      if (rhythmChanged) {
        db.get().prepare(`
          DELETE FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?
        `).run(parentId, cutoffDate);
        // Das neue Raster gilt ab heute, auch fuer den Monatsaufruf: davor
        // steht der Bestand auf dem alten (Schritt 0), und ein Vorkommen auf
        // dem neuen daneben waere eine zweite Buchung fuer denselben Zeitraum
        // (Review-Befund in #1585). Siehe occurrenceWriter().
        db.get().prepare('UPDATE budget_series SET grid_from = ? WHERE anchor_id = ?')
          .run(cutoffDate, parentId);
        // Ein verlegter Starttag bei schon gebuchter erster Buchung: das
        // Vorkommen am neuen Starttag legt kein Monatsaufruf an (siehe
        // materializeSeriesStart), also hier - wenn es ab heute liegt.
        if (startChanged && !anchorAhead && finalStart >= cutoffDate) {
          materializeSeriesStart(db.get(), parentId);
        }
      } else {
        // `account_id` folgt derselben CASE-Form wie an der Definition: ein
        // nicht mitgesendetes Feld lässt die Zuordnung in Ruhe. Eine virtuelle
        // Serie gibt ihr Konto nicht weiter - ihre Instanzen sind Planwerte,
        // und `generateRecurringInstances` hält es genauso.
        db.get().prepare(`
          UPDATE budget_entries SET
            title       = ?,
            amount      = ?,
            category    = ?,
            subcategory = ?,
            is_pending  = ?,
            account_id  = CASE WHEN ? = 1 THEN ? ELSE account_id END
          WHERE recurrence_parent_id = ? AND date >= ?
        `).run(finalTitle, storeAmount, finalCategory, finalSubcat,
               finalConfirm ? 1 : 0,
               accountProvided ? 1 : 0, finalVirtual ? null : accountValue,
               parentId, cutoffDate);
      }

      // 5. Sichtbarkeit: jede Instanz, ohne Schnitt (siehe nextVisibility).
      if (nextVisibility) {
        db.get().prepare(`
          UPDATE budget_entries SET visibility = ? WHERE recurrence_parent_id = ?
        `).run(nextVisibility, parentId);
      }
    })();

    // Belege bleiben hier bewusst unberuehrt (#583): sie gehoeren zur einzelnen
    // Buchung, nicht zur Serie - eine Stromrechnung hat je Monat einen eigenen
    // Beleg. Der Preis dafuer: die oben geloeschten kuenftigen Instanzen nehmen
    // ihre Verknuepfungen mit. Die Dokumente selbst bleiben im Dokumente-Modul.
    //
    // DIE ZUSTAENDIGKEIT DAGEGEN GEHOERT DER SERIE (#1057): "wer kuemmert sich
    // um die Wasserrechnung" ist keine Eigenschaft des einzelnen Monats. Sie
    // folgt deshalb demselben Schnitt wie Titel und Betrag daneben - ab
    // cutoffDate, also ab heute: in die Definition, in jede Buchung ab heute,
    // und in den Anker nur, wenn er selbst noch vor uns liegt (#1035). Eine
    // bereits gebuchte Buchung behaelt, wer damals zustaendig war; wer die
    // Rechnung uebernimmt, uebernimmt sie nicht rueckwirkend.
    //
    // WAS DER SCHNITT NICHT LEISTET, und das gilt fuer jedes Serienfeld gleich:
    // ein Monat, der noch NIE geoeffnet wurde, hat noch keine Instanz. Sie
    // entsteht beim ersten Aufruf aus dem HEUTIGEN Serienstand - auch wenn ihr
    // Datum in der Vergangenheit liegt. Wer den Juli nie aufgeschlagen hat,
    // sieht dort also die neue zustaendige Person, so wie er dort auch den
    // neuen Titel saehe.
    if (req.body.responsible_user_ids !== undefined) {
      db.get().transaction(() => {
        replaceSeriesResponsibles(parentId, req.body.responsible_user_ids);
        if (anchorAhead) replaceResponsibles(parentId, req.body.responsible_user_ids);
        const future = db.get().prepare(
          'SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?'
        ).all(parentId, cutoffDate);
        for (const row of future) replaceResponsibles(row.id, req.body.responsible_user_ids);
      })();
    }

    const updated = entryWithLoanMeta(parentId);
    const definition = db.get().prepare(`
      SELECT title, amount, full_amount, category, subcategory, account_id, visibility, start_date
        FROM budget_series WHERE anchor_id = ?
    `).get(parentId) ?? null;
    res.json({ data: {
      ...updated,
      series: definition,
      attachments: attachmentsFor(parentId, documentViewer(req)),
    } });
  } catch (err) {
    log.error('PUT /budget/:id/series error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/:id/series
 * Löscht das Serien-Original und alle zugehörigen Instanzen.
 * Response: 204 No Content
 */
router.delete('/:id/series', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const parentId = entry.recurrence_parent_id ?? (entry.is_recurring ? entry.id : null);
    if (!parentId) return refuse(res, [refusal('entry_not_recurring', 'Not a recurring entry.')]);

    db.get().transaction(() => {
      db.get().prepare('DELETE FROM budget_entries WHERE recurrence_parent_id = ?').run(parentId);
      db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(parentId);
    })();

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /budget/:id/series error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/:id
 * Eintrag bearbeiten.
 * Body: alle Felder optional
 * Response: { data: Entry }
 */
router.put('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const checks = [];
    if (req.body.title    !== undefined) checks.push(['entry_title_invalid', str(req.body.title,    'Title',  { max: MAX_TITLE, required: false })]);
    if (req.body.amount   !== undefined) checks.push(['entry_amount_invalid', num(req.body.amount,   'Amount')]);
    if (req.body.category !== undefined) checks.push(['entry_category_invalid', oneOf(req.body.category, validCategoryKeys(), 'Category')]);
    if (req.body.date     !== undefined) checks.push(['entry_date_invalid', validateDate(req.body.date,    'Date')]);
    if (req.body.recurrence_rule !== undefined) checks.push(['entry_recurrence_invalid', rrule(req.body.recurrence_rule, 'recurrence_rule')]);
    if (req.body.recurrence_interval !== undefined) checks.push(['entry_recurrence_invalid', oneOf(req.body.recurrence_interval, RECURRENCE_INTERVAL_KEYS, 'Interval')]);
    if (req.body.recurrence_interval_count !== undefined) checks.push(['entry_interval_count_invalid', intervalCountCheck(req.body.recurrence_interval_count)]);
    const errors = checks.flatMap(([reason, result]) => refusals(reason, [result]));
    if (errors.length) return refuse(res, errors);
    // Neu nur Haushaltsmitglieder (#1207); wer schon zustaendig ist, bleibt es.
    const strangers = responsibleNonMembers(id, req.body.responsible_user_ids);
    if (strangers.length) return refuse(res, [refusal('entry_responsible_invalid', nonMemberMessage(strangers))]);
    const { title, amount, category, subcategory: requestedSubcategory, date, is_recurring, recurrence_rule } = req.body;
    const linkedPayment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE budget_entry_id = ?
    `).get(id);
    // Währung je Darlehen (#582): Der Budget-Eintrag steht in Budget-Währung, die
    // gekoppelte Rate dagegen in Darlehenswährung. Beide Richtungen unten rechnen
    // deshalb über den festen Kurs des Darlehens um - sonst würde ein Edit des
    // Eintrags die Restschuld eines Fremdwährungs-Darlehens verfälschen.
    const linkedLoan = linkedPayment
      ? db.get().prepare('SELECT total_amount, currency, exchange_rate, direction FROM budget_loans WHERE id = ?').get(linkedPayment.loan_id)
      : null;
    // Richtung (#638/#859): Das Vorzeichen des Eintrags gehört dem Darlehen, nicht
    // dem Request. Eine Rate auf einen aufgenommenen Kredit ist eine Ausgabe und
    // kommt folglich negativ herein - die frühere Prüfung "muss Einkommen bleiben"
    // stammte aus der Zeit, als jedes Darlehen ein verliehenes war, und sperrte
    // jede Korrektur an einer solchen Rate. Statt abzuweisen wird der Betrag jetzt
    // nach derselben Regel gebucht wie beim Anlegen und beim Richtungswechsel.
    // Die Rate selbst bleibt vorzeichenlos: budget_loan_payments.amount trägt einen
    // CHECK(amount > 0) und wird gegen die Restschuld gerechnet.
    const linkedSign = linkedPayment ? bookingFor(linkedLoan?.direction).sign : 1;
    const linkedPaymentAmount = linkedPayment && amount !== undefined
      ? Math.abs(fromBudgetAmount(amount, linkedLoan))
      : null;
    if (linkedPayment && amount !== undefined) {
      if (!(linkedPaymentAmount > 0)) {
        return refuse(res, [refusal('entry_amount_invalid', 'Amount must be greater than zero.')]);
      }
      const otherPaid = db.get().prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM budget_loan_payments
        WHERE loan_id = ? AND id != ?
      `).get(linkedPayment.loan_id, linkedPayment.id).total;
      if (linkedPaymentAmount - (Number(linkedLoan?.total_amount || 0) - Number(otherPaid || 0)) > 0.005) {
        return refuse(res, [refusal('entry_amount_exceeds_loan', 'Amount cannot be greater than the remaining loan amount.')]);
      }
    }
    const nextCategory = category ?? entry.category;
    const subcategory = requestedSubcategory !== undefined || category !== undefined
      ? validateSubcategory(nextCategory, requestedSubcategory ?? entry.subcategory)
      : undefined;
    if (subcategory === null) {
      return refuse(res, [refusal('entry_subcategory_invalid', 'Invalid subcategory.')]);
    }

    // Konto-Zuordnung: undefined ⇒ unverändert; null/'' ⇒ Zuordnung entfernen; id ⇒ setzen.
    const accountProvided = req.body.account_id !== undefined;
    let accountValue = null;
    if (accountProvided) {
      const accountRef = validateAccountRef(req.body.account_id);
      if (accountRef.error) return refuse(res, [refusal('entry_account_invalid', accountRef.error)]);
      accountValue = accountRef.value;
    }

    // Wiederkehrungs-Felder auflösen (Intervall + virtuelles Budget).
    const finalRecurring = is_recurring !== undefined ? (is_recurring ? 1 : 0) : entry.is_recurring;
    const finalInterval = req.body.recurrence_interval !== undefined
      ? req.body.recurrence_interval
      : (entry.recurrence_interval || 'monthly');
    const finalCount = normalizeIntervalCount(req.body.recurrence_interval_count !== undefined
      ? req.body.recurrence_interval_count
      : entry.recurrence_interval_count);
    let finalVirtual = req.body.recurrence_virtual !== undefined
      ? (req.body.recurrence_virtual ? 1 : 0)
      : entry.recurrence_virtual;
    if (!finalRecurring) finalVirtual = 0;
    let finalConfirm = req.body.recurrence_confirm !== undefined
      ? (req.body.recurrence_confirm ? 1 : 0)
      : entry.recurrence_confirm;
    if (!finalRecurring) finalConfirm = 0;
    // Konfigurierter Periodenbetrag (vorzeichenbehaftet): neue Eingabe, sonst bisheriger Vollbetrag.
    // Bei einer gekoppelten Rate setzt die Darlehensrichtung das Vorzeichen (#638/#859):
    // Ein Client, der den Typ-Umschalter umgeht, darf eine Ausgabe nicht zur Einnahme
    // machen - daran hängen Monatsbilanz, Statistik und der Kontosaldo.
    const configuredFull = amount !== undefined
      ? (linkedPayment ? linkedSign * Math.abs(Number(amount)) : Number(amount))
      : (entry.recurrence_full_amount != null ? entry.recurrence_full_amount : entry.amount);
    const nextAmount = finalVirtual ? effectiveMonthly(configuredFull, finalInterval, finalCount) : cents(configuredFull);
    const nextFull   = finalVirtual ? cents(configuredFull) : null;

    // Sichtbarkeit umschaltbar (privat/geteilt); owner_id bleibt fix (#476/#505).
    const nextVisibility = req.body.visibility !== undefined
      ? normalizeBudgetVisibility(req.body.visibility)
      : null;

    // Guard attachment targets before the main entry/loan transaction: a 409
    // (deletion lock) or 403 (no documents access, #1358) must leave every
    // requested field unchanged, not only the link table.
    if (req.body.attachment_document_ids !== undefined) {
      assertDocumentLinkTargetsAvailable(db.get(), req.body.attachment_document_ids, documentViewer(req));
    }

    // DER RHYTHMUS STEHT AM ANKER und gilt fuer die ganze Serie - auch wenn er
    // hier, ueber "nur dieser Eintrag" an der ersten Buchung, geaendert wird.
    // Das ist dieselbe Rasteraenderung wie ueber PUT /:id/series und bekommt
    // dieselbe Behandlung (#1545, Entscheidung in #1585): Vergangenheit im
    // alten Raster einfrieren, Vorkommen ab heute neu bauen, davor nichts mehr
    // erzeugen. Bis hierher blieben vergangene und kuenftige Vorkommen im alten
    // Raster stehen, und der Monatsaufruf legte die des neuen daneben.
    const finalRrule = recurrence_rule !== undefined ? (recurrence_rule || null) : entry.recurrence_rule;
    const runningSeries = entry.is_recurring && finalRecurring && entry.recurrence_parent_id == null
      && db.get().prepare('SELECT 1 FROM budget_series WHERE anchor_id = ?').get(id);
    const gridChanged = Boolean(runningSeries) && (
      finalInterval !== entry.recurrence_interval
      || finalCount !== entry.recurrence_interval_count
      || finalVirtual !== entry.recurrence_virtual
      || finalRrule !== entry.recurrence_rule);
    const cutoffDate = gridChanged ? todayKey(db.get()) : null;

    const tx = db.get().transaction(() => {
      if (gridChanged) freezeSeriesPast(db.get(), id, cutoffDate);

      db.get().prepare(`
        UPDATE budget_entries
        SET title                  = COALESCE(?, title),
            amount                 = ?,
            category               = COALESCE(?, category),
            subcategory            = COALESCE(?, subcategory),
            date                   = COALESCE(?, date),
            is_recurring           = ?,
            recurrence_rule        = ?,
            recurrence_interval    = ?,
            recurrence_interval_count = ?,
            recurrence_virtual     = ?,
            recurrence_confirm     = ?,
            recurrence_full_amount = ?,
            visibility             = COALESCE(?, visibility),
            account_id             = CASE WHEN ? = 1 THEN ? ELSE account_id END
        WHERE id = ?
      `).run(
        title?.trim() ?? null,
        nextAmount,
        category ?? null,
        subcategory !== undefined ? subcategory : null,
        date ?? null,
        finalRecurring,
        finalRrule,
        finalInterval,
        finalCount,
        finalVirtual,
        finalConfirm,
        nextFull,
        nextVisibility,
        accountProvided ? 1 : 0,
        accountValue,
        id
      );

      if (linkedPayment) {
        db.get().prepare(`
          UPDATE budget_loan_payments
          SET amount = COALESCE(?, amount),
              paid_date = COALESCE(?, paid_date)
          WHERE id = ?
        `).run(
          linkedPaymentAmount,
          date ?? null,
          linkedPayment.id
        );
        refreshLoanStatus(linkedPayment.loan_id);
      }

      if (gridChanged) {
        db.get().prepare('DELETE FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?')
          .run(id, cutoffDate);
        db.get().prepare('UPDATE budget_series SET grid_from = ? WHERE anchor_id = ?').run(cutoffDate, id);
      }
    });
    tx();

    // Belege (#583): nur anfassen, wenn das Feld mitkommt. Ein PUT, das nur den
    // Betrag korrigiert, darf die angehaengten Belege nicht stillschweigend
    // abraeumen.
    if (req.body.attachment_document_ids !== undefined) {
      replaceAttachments(id, req.body.attachment_document_ids, documentViewer(req));
    }
    // Dieselbe Zurueckhaltung wie bei den Belegen: nur anfassen, wenn das Feld
    // mitkommt (#1057). replaceResponsibles() prueft das selbst.
    replaceResponsibles(id, req.body.responsible_user_ids);
    // Wird eine Einzelbuchung hier zur Serie, ist sie deren Vorlage (#1035) -
    // die Werte uebernimmt der Trigger aus v228, die Zustaendigen dieser Aufruf.
    // Eine Buchung, die schon Serie WAR, bleibt dagegen nur Buchung: ihre Werte
    // aendern hier die erste Buchung, nicht die Definition - ihr Datum
    // eingeschlossen, der Starttag steht in der Definition (#1545).
    if (!entry.is_recurring && finalRecurring && entry.recurrence_parent_id == null) {
      seedSeriesResponsibles(id);
    }

    const updated = entryWithLoanMeta(id);

    res.json({ data: { ...updated, attachments: attachmentsFor(id, documentViewer(req)) } });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
    if (sendDocumentLinkRefusal(res, err)) return;
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PATCH /api/v1/budget/:id/confirm
 * Eine erwartete Buchung als tatsächlich erfolgt verbuchen (#637).
 * Body: { amount?, date? } - beide optional, beide korrigierbar.
 * Response: { data: Entry }
 *
 * Betrag und Datum sind hier änderbar, weil genau ihre Abweichung der Anlass
 * ist: Dienste buchen selten auf den Tag und den Cent so ab, wie die Serie es
 * vorzeichnet. Ein reines "bestätigt"-Häkchen hätte die Diskrepanz zum
 * Kontoauszug stehen lassen, um die es geht.
 */
router.patch('/:id/confirm', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });
    if (!entry.is_pending) {
      return refuse(res, [refusal('entry_already_booked', 'Entry is already booked.')]);
    }

    const errors = [];
    if (req.body.amount !== undefined) errors.push(...refusals('entry_amount_invalid', [num(req.body.amount, 'Amount')]));
    if (req.body.date   !== undefined) errors.push(...refusals('entry_date_invalid', [validateDate(req.body.date, 'Date')]));
    if (errors.length) return refuse(res, errors);

    // Das Vorzeichen bleibt: eine erwartete Ausgabe wird beim Abbuchen nicht zur
    // Einnahme, auch wenn jemand den Betrag ohne Minus einträgt.
    const corrected = req.body.amount !== undefined ? Math.abs(Number(req.body.amount)) : null;
    const nextAmount = corrected === null
      ? entry.amount
      : cents(entry.amount < 0 ? -corrected : corrected);

    db.get().prepare(`
      UPDATE budget_entries
         SET is_pending = 0,
             amount     = ?,
             date       = COALESCE(?, date)
       WHERE id = ?
    `).run(nextAmount, req.body.date ?? null, id);

    const updated = entryWithLoanMeta(id);
    res.json({ data: { ...updated, attachments: attachmentsFor(id, documentViewer(req)) } });
  } catch (err) {
    log.error('PATCH /budget/:id/confirm error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/:id
 * Eintrag löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const linkedPayment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE budget_entry_id = ?
    `).get(id);

    const tx = db.get().transaction(() => {
      if (linkedPayment) {
        db.get().prepare('DELETE FROM budget_loan_payments WHERE id = ?').run(linkedPayment.id);
      }
      db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(id);
      if (linkedPayment) refreshLoanStatus(linkedPayment.loan_id);
    });
    tx();

    // Wenn eine Instanz gelöscht wird: genau diesen Fälligkeitstag als
    // übersprungen vermerken. Am Monat festgemacht (bis #636) hätte das Löschen
    // eines Dienstags einer Wochenserie die übrigen Wochen mit unterdrückt.
    if (entry.recurrence_parent_id) {
      db.get().prepare(
        'INSERT OR IGNORE INTO budget_recurrence_skipped (parent_id, date) VALUES (?, ?)'
      ).run(entry.recurrence_parent_id, entry.date);
    }

    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
