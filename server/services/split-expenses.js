/**
 * Module: Split Expenses Service
 * Purpose: Money parsing, split allocation, ledger balance derivation, and debt simplification.
 */

/**
 * Die ISO-4217-Ausnahmen: Waehrungen, die NICHT mit zwei Nachkommastellen
 * rechnen. Sie steht bewusst VOR der Auswahl - sechs dieser Codes (BHD, IQD,
 * JOD, KWD, OMR, TND) sind heute gar nicht waehlbar. Das ist kein toter Code,
 * sondern der Sinn der Tabelle: wer eine Waehrung zu `CURRENCY_CODES`
 * hinzufuegt, soll ihre Nachkommastellen schon vorfinden statt sie zu vergessen
 * und Betraege stillschweigend um Faktor 100 zu verschieben.
 *
 * NICHT AUF DEN CLDR UMSTELLEN. `Intl` liefert Anzeige-Konventionen, nicht die
 * Rechen-Norm, und die beiden gehen auseinander: IQD steht im CLDR auf 0 und in
 * ISO 4217 auf 3, COP/HUF/IDR/IRR zeigt der CLDR ohne Nachkommastellen,
 * waehrend ISO ihnen zwei gibt. Was hier steht, entscheidet, wie ein Betrag in
 * der Datenbank LIEGT - eine Anzeigekonvention darf das nicht bestimmen.
 * (Geprueft beim Nachtragen von VND, #297.)
 */
const CURRENCY_MINOR_UNITS = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
  CLP: 0, JPY: 0, KRW: 0, VND: 0,
};

// Eine Eingabe, die sich nicht aufteilen laesst: ungueltiger Betrag, fehlender
// Anteil, Summe daneben. Ein eigener Typ, damit ein Aufrufer ohne Nutzer vor dem
// Bildschirm (der Buchungslauf der Serien) "diese Eingabe ist unbuchbar" von
// einem Fehler im Code unterscheiden kann, ohne Meldungstexte zu vergleichen.
// Fuer die Routen aendert sich nichts: sie reichen `message` als 400 weiter.
class SplitInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SplitInputError';
  }
}

function minorUnit(currency = 'EUR') {
  return CURRENCY_MINOR_UNITS[String(currency).toUpperCase()] ?? 2;
}

function parseMoneyToMinor(value, currency = 'EUR', field = 'amount') {
  if (typeof value === 'number') {
    throw new SplitInputError(`${field} must be sent as a decimal string to avoid floating point loss.`);
  }
  const raw = String(value ?? '').trim();
  const scale = minorUnit(currency);
  const re = /^-?\d+(\.\d+)?$/;
  if (!re.test(raw)) throw new SplitInputError(`${field} must be a valid decimal string.`);
  // Kein Aufrufer hat einen negativen Betrag: Ausgabe, Anteil und Zahlung liegen
  // in Spalten mit CHECK(> 0) bzw. CHECK(>= 0), eine Erstattung ist ein Storno
  // und keine negative Buchung. Bis #1607 liess diese Funktion ein Minus durch
  // und ueberliess die Ablehnung dem Schema - die Antwort war dann der rohe
  // SQLite-Text, und "-0" kam als Anteil 0 an der Null-Pruefung vorbei.
  if (raw.startsWith('-')) throw new SplitInputError(`${field} must be greater than zero.`);
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > scale) throw new SplitInputError(`${field} has too many decimal places for ${currency}.`);
  const padded = fraction.padEnd(scale, '0');
  const minor = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(padded || '0');
  if (minor <= 0n) throw new SplitInputError(`${field} must be greater than zero.`);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new SplitInputError(`${field} is too large.`);
  return Number(minor);
}

function minorToDecimal(value, currency = 'EUR') {
  const scale = minorUnit(currency);
  const n = BigInt(value ?? 0);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  if (scale === 0) return `${negative ? '-' : ''}${whole}`;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(scale, '0')}`;
}

function assertIntegerIds(ids, field) {
  if (!Array.isArray(ids) || ids.length === 0) throw new SplitInputError(`${field} must contain at least one member.`);
  const normalized = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!normalized.length) throw new SplitInputError(`${field} must contain valid user ids.`);
  return normalized;
}

function allocateRemainder(totalMinor, baseRows) {
  const sum = baseRows.reduce((acc, row) => acc + row.amount_minor, 0);
  let remainder = totalMinor - sum;
  const rows = baseRows.map((row) => ({ ...row }));
  for (const row of rows) {
    if (remainder === 0) break;
    row.amount_minor += remainder > 0 ? 1 : -1;
    remainder += remainder > 0 ? -1 : 1;
  }
  return rows;
}

function withCurrency(rows, currency) {
  return rows.map((row) => ({ ...row, currency }));
}

function splitsByUser(splits) {
  // `s?.`: ein Eintrag, der kein Objekt ist, gehoert zu niemandem - der
  // Beteiligte ohne Wert faellt dann an der Regel seiner Split-Art auf, statt
  // dass hier ein TypeError wie ein Fehler im Code aussieht.
  return new Map((Array.isArray(splits) ? splits : []).map((s) => [Number(s?.user_id), s]));
}

function buildSplits({ method, amountMinor, currency, participants, splits = [] }) {
  const participantIds = assertIntegerIds(participants, 'participants');
  const splitMap = splitsByUser(splits);

  if (method === 'equal') {
    const base = Math.trunc(amountMinor / participantIds.length);
    return withCurrency(allocateRemainder(amountMinor, participantIds.map((userId) => ({ user_id: userId, amount_minor: base }))), currency);
  }

  if (method === 'exact') {
    const rows = participantIds.map((userId) => {
      const split = splitMap.get(userId);
      if (!split) throw new SplitInputError('Each participant needs an exact split amount.');
      return { user_id: userId, amount_minor: parseMoneyToMinor(split.amount, currency, 'split amount') };
    });
    const sum = rows.reduce((acc, row) => acc + row.amount_minor, 0);
    if (sum !== amountMinor) throw new SplitInputError('Exact splits must add up to the expense amount.');
    return withCurrency(rows, currency);
  }

  if (method === 'percentage') {
    const rows = participantIds.map((userId) => {
      const split = splitMap.get(userId);
      const percent = String(split?.percentage ?? '').trim();
      if (!/^\d+(\.\d{1,2})?$/.test(percent)) throw new SplitInputError('Percentages must be decimal strings with up to two decimals.');
      const [whole, fraction = ''] = percent.split('.');
      const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      return { user_id: userId, bps };
    });
    const totalBps = rows.reduce((acc, row) => acc + row.bps, 0);
    if (totalBps !== 10000) throw new SplitInputError('Percentages must add up to 100.');
    return withCurrency(allocateRemainder(amountMinor, rows.map((row) => ({
      user_id: row.user_id,
      amount_minor: Math.trunc((amountMinor * row.bps) / 10000),
    }))), currency);
  }

  if (method === 'shares') {
    const rows = participantIds.map((userId) => {
      const shares = Number(splitMap.get(userId)?.shares);
      if (!Number.isInteger(shares) || shares <= 0) throw new SplitInputError('Shares must be positive integers.');
      return { user_id: userId, shares };
    });
    const totalShares = rows.reduce((acc, row) => acc + row.shares, 0);
    return withCurrency(allocateRemainder(amountMinor, rows.map((row) => ({
      user_id: row.user_id,
      amount_minor: Math.trunc((amountMinor * row.shares) / totalShares),
    }))), currency);
  }

  throw new SplitInputError('Unsupported split method.');
}

// Der Wert je Person, den eine Split-Art liest. `equal` liest keinen.
const SPLIT_INPUT_FIELD = { exact: 'amount', percentage: 'percentage', shares: 'shares' };

// Eine Serie bewahrt ihre Aufteilung als EINGABE auf (Beteiligte + Wert je
// Person), der Buchungslauf rechnet sie an jedem Termin durch `buildSplits`.
// Geprueft wird deshalb genau das, was gespeichert wird: die Eingabe wird erst
// auf die Beteiligten und das eine Feld ihrer Split-Art gekuerzt, einmal durch
// JSON geschickt wie beim Speichern, und DIESE Fassung laeuft durch
// `buildSplits`. Wirft es hier nicht, wirft es mit denselben Werten auch im
// Buchungslauf nicht. Die Mitgliedschaft der Personen kennt diese Datei nicht,
// die prueft der Aufrufer.
function splitSnapshot({ method, amountMinor, currency, participants, splits = [] }) {
  const participantIds = assertIntegerIds(participants, 'participants');
  const field = SPLIT_INPUT_FIELD[method];
  const splitMap = splitsByUser(splits);
  const snapshot = JSON.parse(JSON.stringify({
    participants: participantIds,
    splits: field
      ? participantIds.filter((id) => splitMap.has(id)).map((id) => ({ user_id: id, [field]: splitMap.get(id)[field] }))
      : [],
  }));
  buildSplits({ method, amountMinor, currency, participants: snapshot.participants, splits: snapshot.splits });
  return snapshot;
}

// Zahler und Beteiligte muessen Mitglieder DIESER Gruppe sein
// (GHSA-4p5w-5346-8598): sonst schreibt ein Mitglied einer Person, die nie in
// der Gruppe war, eine Schuld zu, die diese nirgends sieht und nicht bestreiten
// kann. Eine Regel fuer alle Wege, auf denen Personen an eine Ausgabe kommen -
// Anlegen, Bearbeiten, Serie anlegen, und der Buchungslauf an jedem Termin
// (wer inzwischen ausgetreten ist, wird nicht weiter gebucht). Liefert den
// Ablehnungstext oder null.
function membershipRefusal(database, groupId, payerId, participants) {
  const isMember = database.prepare('SELECT 1 FROM expense_group_members WHERE group_id = ? AND user_id = ?');
  if (!isMember.get(groupId, payerId)) return 'Payer must be a group member.';
  if (participants.some((participantId) => !isMember.get(groupId, Number(participantId)))) return 'All participants must be group members.';
  return null;
}

// Die Buchungsregel einer Ausgabe: eine Zeile fuer den Zahler ueber den ganzen
// Betrag, eine je Anteil mit umgekehrtem Vorzeichen. Route (Anlegen, Bearbeiten)
// und Buchungslauf der Serien rufen diese eine Fassung (#1444).
//
// `created_by` jeder Ledger-Zeile ist `expense.created_by`, nie die Person, die
// gerade anlegt oder bearbeitet: Ausgabe und Zeilen haengen per ON DELETE
// CASCADE am selben Konto und fallen so nur gemeinsam. Trug ein PUT die
// bearbeitende Person ein, nahm deren Kontoloeschung die Zeilen mit, und die
// weiter aktive Ausgabe zaehlte nicht mehr im Saldo. Wer bearbeitet hat, steht
// in `expense_edited` (expense_activity.actor_id).
//
// Migration v226 baut verlorene Zeilen mit einer EINGEFRORENEN SQL-Fassung
// dieser Regel neu auf. Aendert sich die Regel, wird test:split-ledger-rebuild-
// migration rot - dann gilt die neue Regel ab hier, v226 bleibt, wie sie ist.
function insertExpenseLedger(database, expense, splits, sourceType = 'expense') {
  const actorId = expense.created_by;
  const insert = database.prepare(`
    INSERT INTO expense_ledger_entries
      (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(expense.group_id, sourceType, expense.id, expense.payer_id, null, expense.converted_amount_minor, expense.converted_currency, expense.title, actorId);
  for (const split of splits) {
    insert.run(expense.group_id, sourceType, expense.id, split.user_id, expense.payer_id, -split.amount_minor, split.currency, expense.title, actorId);
  }
}

function simplifyDebts(balanceRows) {
  const byCurrency = new Map();
  for (const row of balanceRows) {
    const currency = row.currency;
    if (!byCurrency.has(currency)) byCurrency.set(currency, []);
    byCurrency.get(currency).push({ ...row, net_minor: Number(row.net_minor || 0) });
  }

  const debts = [];
  for (const [currency, rows] of byCurrency.entries()) {
    const debtors = rows
      .filter((row) => row.net_minor < 0)
      .map((row) => ({ ...row, remaining: -row.net_minor }))
      .sort((a, b) => a.user_id - b.user_id);
    const creditors = rows
      .filter((row) => row.net_minor > 0)
      .map((row) => ({ ...row, remaining: row.net_minor }))
      .sort((a, b) => a.user_id - b.user_id);
    let d = 0;
    let c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amount = Math.min(debtors[d].remaining, creditors[c].remaining);
      if (amount > 0) {
        debts.push({
          from_user_id: debtors[d].user_id,
          from_name: debtors[d].display_name,
          to_user_id: creditors[c].user_id,
          to_name: creditors[c].display_name,
          currency,
          amount_minor: amount,
          amount: minorToDecimal(amount, currency),
        });
      }
      debtors[d].remaining -= amount;
      creditors[c].remaining -= amount;
      if (debtors[d].remaining === 0) d += 1;
      if (creditors[c].remaining === 0) c += 1;
    }
  }
  return debts;
}

/**
 * Die Salden EINER Gruppe: je Person und Waehrung die Summe ihrer
 * Buchungszeilen. Das ist die EINE Saldenquelle der Ausgleichs-Ansicht
 * (`GET /groups/:id/balances`) und der Kennzahl auf dem Dashboard
 * (`openBalancesForUser()` unten) - beide lesen sie hier, damit sie nie
 * auseinanderlaufen.
 *
 * Gezaehlt wird NUR das Ledger, ohne Blick auf `expenses`: der Saldo hat
 * keine zweite Quelle. Zeilen einer Ausgabe, die es nicht mehr gibt (#1445),
 * hat Migration v227 einmal entfernt; neue entstehen seit v225 nicht mehr,
 * weil jede Zeile `expenses.created_by` traegt und mit ihrer Ausgabe faellt.
 */
function groupBalanceRows(database, groupId, memberOrder = 'u.display_name COLLATE NOCASE ASC') {
  // DIE PERSONENFOLGE JE WAEHRUNG WIRD GEREICHT (#1644): die Route der
  // Ausgleichs-Ansicht zeigt diese Zeilen als Liste und gibt `memberOrderSql('u')`
  // herein. Dieses Modul importiert `server/db.js` bewusst nicht und damit auch
  // nicht household-members.js. Der Standardwert gilt fuer Aufrufer, die die
  // Zeilen nur verrechnen (`openBalancesForUser()`, Tests): `simplifyDebts()`
  // sortiert Schuldner und Glaeubiger selbst nach user_id, die Folge hier
  // entscheidet also nie, wer wem zahlt - nur, wie `balances[]` dasteht.
  return database.prepare(`
    SELECT l.currency, l.user_id, u.display_name, SUM(l.amount_minor) AS net_minor
    FROM expense_ledger_entries l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.group_id = ?
    GROUP BY l.currency, l.user_id
    HAVING net_minor != 0
    ORDER BY l.currency ASC, ${memberOrder}
  `).all(groupId);
}

/**
 * Was der Betrachter ueber alle aktiven Gruppen, in denen er Mitglied ist,
 * offen hat - fuer die Kennzahl auf dem Dashboard.
 *
 * `positions` sind genau die Zeilen, die die Ausgleichs-Ansicht der jeweiligen
 * Gruppe zeigt (`simplifyDebts()` ueber `groupBalanceRows()`), gefiltert auf
 * die, an denen der Betrachter beteiligt ist. `net` ist sein Saldo je Waehrung
 * - dieselbe Summe, die das Kennzahlband des Moduls zeigt.
 *
 * MITGLIEDSCHAFT, NICHT ADMIN-RECHT: das Modul laesst einen Admin jede Gruppe
 * oeffnen, aber „was schulde ich" hat nur in den eigenen Gruppen eine Antwort.
 * Archivierte Gruppen zaehlen wie im Kennzahlband des Moduls nicht mit.
 *
 * REIHENFOLGE: die Haushaltswaehrung zuerst, darin die groesste Position -
 * Betraege verschiedener Waehrungen lassen sich nicht der Groesse nach
 * vergleichen, und die Kachel nennt die erste.
 */
function openBalancesForUser(database, userId, { householdCurrency = 'EUR' } = {}) {
  const uid = Number(userId);
  const groups = database.prepare(`
    SELECT g.id, g.name
    FROM expense_groups g
    JOIN expense_group_members m ON m.group_id = g.id AND m.user_id = ?
    WHERE g.status = 'active'
    ORDER BY g.id
  `).all(uid);
  const netByCurrency = new Map();
  const positions = [];
  for (const group of groups) {
    const rows = groupBalanceRows(database, group.id);
    for (const row of rows) {
      if (row.user_id !== uid) continue;
      netByCurrency.set(row.currency, (netByCurrency.get(row.currency) ?? 0) + Number(row.net_minor));
    }
    for (const debt of simplifyDebts(rows)) {
      const owe = debt.from_user_id === uid;
      if (!owe && debt.to_user_id !== uid) continue;
      positions.push({
        direction: owe ? 'owe' : 'owed',
        userId: owe ? debt.to_user_id : debt.from_user_id,
        name: (owe ? debt.to_name : debt.from_name) ?? '',
        groupId: group.id,
        groupName: group.name,
        currency: debt.currency,
        amountMinor: debt.amount_minor,
        amount: debt.amount,
      });
    }
  }
  const home = (currency) => (currency === householdCurrency ? 0 : 1);
  positions.sort((a, b) => home(a.currency) - home(b.currency)
    || a.currency.localeCompare(b.currency)
    || b.amountMinor - a.amountMinor
    || a.groupId - b.groupId);
  const net = [...netByCurrency.entries()]
    .filter(([, minor]) => minor !== 0)
    .sort(([a], [b]) => home(a) - home(b) || a.localeCompare(b))
    .map(([currency, netMinor]) => ({ currency, netMinor, amount: minorToDecimal(netMinor, currency) }));
  return { net, positions };
}

function decorateMoney(row, fields = ['amount_minor']) {
  const out = { ...row };
  for (const field of fields) {
    if (out[field] !== undefined) out[field.replace(/_minor$/, '')] = minorToDecimal(out[field], out.currency);
  }
  return out;
}

export {
  buildSplits,
  splitSnapshot,
  insertExpenseLedger,
  membershipRefusal,
  SplitInputError,
  decorateMoney,
  groupBalanceRows,
  minorToDecimal,
  minorUnit,
  openBalancesForUser,
  parseMoneyToMinor,
  simplifyDebts,
};
