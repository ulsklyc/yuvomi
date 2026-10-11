/**
 * Modul: Darlehens-Amortisation (Annuitätendarlehen nach deutschem Muster, #569)
 * Zweck: Aus Kreditsumme, Sollzins und Anfangstilgung die konstante Monatsrate und
 *        daraus den vollständigen Tilgungsplan (Zins-/Tilgungsanteil, Restschuld,
 *        Laufzeit) berechnen. Optional wechselt der Zins nach der Zinsbindung auf
 *        einen Prognose-Anschlusszins (fixed_then_variable).
 *
 * Modell (bewusst als Prognose):
 *   - Monatsrate A = Kreditsumme × (Sollzins% + Anfangstilgung%) / 100 / 12, konstant.
 *   - Je Monat: Zinsanteil = Restschuld × Monatszins; Tilgung = A − Zinsanteil.
 *   - Nach der Zinsbindung bleibt die Rate A gleich, es rechnet aber der
 *     Prognose-Anschlusszins weiter (mehr Zins-, weniger Tilgungsanteil → längere
 *     Restlaufzeit). Reale variable Zinsen schwanken monatlich; hier ein
 *     angenommener Wert, daher „Prognose".
 *   - interestMode 'variable' (Darlehen ganz ohne Zinsbindung) rechnet identisch
 *     zu 'fixed': ein Zinssatz über die ganze Laufzeit, keine Phasen. Der
 *     Unterschied ist die Zusage, nicht die Mathematik — der Satz ist der aktuelle
 *     und kann sich jederzeit ändern, die Laufzeit ist also nur eine Momentaufnahme.
 *   - Die Laufzeit ergibt sich aus der Tilgung (kein manuelles Ratenlimit).
 *
 * Rein synchron, ohne Seiteneffekte/DB — netzfrei testbar (test:budget-loans-amortization).
 */

// Sicherheitskappe: 50 Jahre. Verhindert Endlosschleifen bei Eingaben, deren Rate
// die Tilgung nie abschließt; solche Fälle werden als nicht tilgend gemeldet.
export const MAX_LOAN_MONTHS = 600;

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} params
 * @param {number} params.principal            Kreditsumme in Euro (> 0)
 * @param {number} params.fixedRate            Sollzins p.a. in % (>= 0), Phase 1
 *                                             (bei 'variable': aktueller variabler Zins)
 * @param {number} params.initialRepaymentRate Anfangstilgung p.a. in % (> 0)
 * @param {'fixed'|'variable'|'fixed_then_variable'} params.interestMode
 * @param {number|null} [params.fixedPeriodMonths] Zinsbindung in Monaten (nur fixed_then_variable)
 * @param {number|null} [params.followupRate]      Prognose-Anschlusszins p.a. in % (nur fixed_then_variable)
 * @returns {{ ok: true, monthlyPayment: number, totalMonths: number, totalInterest: number,
 *             totalRepayment: number, remainingAfterBinding: number,
 *             schedule: Array<{ n: number, rate: number, interest: number, principal: number, balance: number, phase: 1|2 }> }
 *           | { ok: false, reason: 'not_amortizing' | 'too_long' }}
 */
export function computeLoanSchedule({
  principal,
  fixedRate,
  initialRepaymentRate,
  interestMode,
  fixedPeriodMonths = null,
  followupRate = null,
}) {
  const P = Number(principal);
  const rf = Number(fixedRate);
  const rt = Number(initialRepaymentRate);
  // Nur 'fixed_then_variable' hat zwei Phasen. 'variable' ist einphasig wie
  // 'fixed' (ein Satz, keine Bindung) — daher hier bewusst kein Sonderfall.
  const variable = interestMode === 'fixed_then_variable';
  const rv = variable ? Number(followupRate) : rf;
  const bindingMonths = variable && Number.isFinite(Number(fixedPeriodMonths))
    ? Number(fixedPeriodMonths)
    : null;

  // Konstante Monatsrate (auf Cent gerundet, wie real belastet).
  const monthly = round2((P * (rf + rt)) / 100 / 12);

  let balance = P;
  let totalInterest = 0;
  let remainingAfterBinding = 0;
  const schedule = [];

  for (let n = 1; n <= MAX_LOAN_MONTHS && balance > 0.005; n++) {
    const inFixed = !bindingMonths || n <= bindingMonths;
    const rate = inFixed ? rf : rv;
    const interest = balance * (rate / 100 / 12);
    let principalPart = monthly - interest;
    // Rate deckt den Zins nicht → das Darlehen tilgt nicht (z. B. Anschlusszins zu hoch).
    if (principalPart <= 0) return { ok: false, reason: 'not_amortizing' };
    if (principalPart > balance) principalPart = balance; // letzte (Teil-)Rate

    balance -= principalPart;
    totalInterest += interest;
    schedule.push({
      n,
      rate,
      interest: round2(interest),
      principal: round2(principalPart),
      balance: round2(Math.max(0, balance)),
      phase: inFixed ? 1 : 2,
    });
    if (bindingMonths && n === bindingMonths) remainingAfterBinding = round2(Math.max(0, balance));
  }

  if (balance > 0.005) return { ok: false, reason: 'too_long' };

  return {
    ok: true,
    monthlyPayment: monthly,
    totalMonths: schedule.length,
    totalInterest: round2(totalInterest),
    totalRepayment: round2(P + totalInterest),
    remainingAfterBinding,
    schedule,
  };
}

/**
 * Der Sollzins, zu dem Rate Nummer `n` verzinst wird (#1706).
 *
 * Dieselbe Phasenregel wie in computeLoanSchedule: waehrend der Zinsbindung der
 * feste Satz, danach der Anschlusssatz; 'fixed' und 'variable' kennen nur einen.
 * Die Darlehensliste sortiert danach - "welcher Satz gilt gerade" ist damit
 * dieselbe Antwort, mit der auch Restschuld und Restlaufzeit rechnen, und keine
 * zweite Lesart im Client (Aequivalenztest gegen den Plan in
 * test:budget-loans-amortization).
 *
 * @param {object} params Zins-Parameter wie bei computeLoanSchedule
 * @param {number} n      Ratennummer (1-basiert)
 * @returns {number} Sollzins p.a. in %
 */
export function rateForInstallment({
  fixedRate,
  interestMode,
  fixedPeriodMonths = null,
  followupRate = null,
}, n) {
  const rf = Number(fixedRate) || 0;
  const variable = interestMode === 'fixed_then_variable';
  const rv = variable ? (Number(followupRate) || 0) : rf;
  const bindingMonths = variable && Number.isFinite(Number(fixedPeriodMonths))
    ? Number(fixedPeriodMonths)
    : null;
  return (!bindingMonths || Number(n) <= bindingMonths) ? rf : rv;
}

/**
 * Planmäßige Restschuld (offenes Kapital) nach `paidInstallments` gezahlten Raten.
 *
 * Abgrenzung: Das ist NICHT die Summe der noch offenen Raten. Die enthält auch die
 * Zinsen der Restlaufzeit und liegt deshalb immer höher. Banken melden die
 * Restschuld, also den hier berechneten Wert - die Verwechslung war der Auslöser
 * dieser Funktion.
 *
 * Der Wert kommt aus dem Tilgungsplan, ist also planmäßig: er unterstellt, dass
 * jede Rate in Höhe der Annuität und zum Fälligkeitsmonat gezahlt wurde. Für die
 * ANZEIGE der Restschuld ist das seit #954 nicht mehr gut genug - dort rechnet
 * remainingPrincipalFromPayments die gebuchten Beträge nach. Diese Funktion bleibt
 * die planmäßige Lesart (Prognosen, Äquivalenzreferenz in den Tests).
 *
 * @param {Array<{ balance: number }>} schedule Tilgungsplan aus computeLoanSchedule
 * @param {number} principal        Kreditsumme (Restschuld vor der ersten Rate)
 * @param {number} paidInstallments Anzahl bereits gezahlter Raten (>= 0)
 * @returns {number} Restschuld in Euro, auf Cent gerundet
 */
export function remainingPrincipalAfter(schedule, principal, paidInstallments) {
  const paid = Math.floor(Number(paidInstallments) || 0);
  if (paid <= 0) return round2(Number(principal) || 0);
  // Über den Plan hinaus gebuchte Raten können das Kapital nicht unter null drücken.
  if (paid >= schedule.length) return 0;
  return schedule[paid - 1].balance;
}

/**
 * Restschuld aus den tatsächlich gebuchten Raten (#954, gemeldet in #935).
 *
 * remainingPrincipalAfter liest die Planposition und unterstellt damit, dass jede
 * Rate exakt in Annuitätenhöhe floss. Sobald jemand mehr oder weniger zahlt, ist
 * die angezeigte Zahl falsch, nicht bloß unvollständig: eine Sondertilgung
 * verschwand aus der Anzeige, eine Minderzahlung beschönigte sie. Hier wird
 * stattdessen die Zahlungshistorie nachgerechnet: je gebuchter Rate der Zinsanteil
 * auf die REALE Restschuld zum Phasensatz ihrer Ratennummer, der Rest tilgt.
 * Eine Rate unter dem Zinsanteil erhöht die Restschuld - das ist ehrlich, kein
 * Rechenfehler.
 *
 * Wer exakt die Annuität zahlt, bekommt dasselbe Ergebnis wie aus der
 * Planposition (Äquivalenztest in test:budget-loans-amortization). Die
 * Prognose-Kennzahlen daneben (Monatsrate, Gesamtzins, Restlaufzeit,
 * remainingAfterBinding) bleiben bewusst planbasiert - sie beschreiben den
 * Vertrag, nicht den Kontostand.
 *
 * Eine LUECKE in den Ratennummern (Zahlung geloescht, spaetere Nummer direkt
 * gebucht) ist in diesem Modell eine Null-Zahlung: die Periode war da, ihr Zins
 * faellt an und schlaegt aufs Kapital. Ohne diese Regel unterschlüge die Rechnung
 * genau die Zinsen der ausgelassenen Monate und meldete zu wenig Restschuld.
 *
 * @param {object} params            Zins-Parameter wie bei computeLoanSchedule
 *                                   (initialRepaymentRate wird nicht gebraucht:
 *                                   getilgt wird, was nach dem Zins übrig ist)
 * @param {Array<{ installment_number: number, amount: number }>} payments
 *                                   Gebuchte Raten; Reihenfolge egal, gerechnet
 *                                   wird nach Ratennummer
 * @returns {number} Restschuld in Euro, auf Cent gerundet, nie negativ
 */
export function remainingPrincipalFromPayments({
  principal,
  fixedRate,
  interestMode,
  fixedPeriodMonths = null,
  followupRate = null,
}, payments) {
  const rf = Number(fixedRate);
  const variable = interestMode === 'fixed_then_variable';
  const rv = variable ? Number(followupRate) : rf;
  const bindingMonths = variable && Number.isFinite(Number(fixedPeriodMonths))
    ? Number(fixedPeriodMonths)
    : null;
  const rateFor = (n) => ((!bindingMonths || n <= bindingMonths) ? rf : rv);

  const rows = (Array.isArray(payments) ? payments : [])
    .map((p) => ({ n: Math.floor(Number(p?.installment_number) || 0), amount: Number(p?.amount) || 0 }))
    .filter((p) => p.n > 0 && p.amount > 0)
    .sort((a, b) => a.n - b.n);

  let balance = Number(principal) || 0;
  let prevN = 0;
  for (const { n, amount } of rows) {
    // Getilgt ist getilgt: auf null Restschuld fällt kein Zins mehr an, und eine
    // weitere Buchung kann das Kapital nicht unter null drücken.
    if (balance <= 0.005) { balance = 0; break; }
    // Ausgelassene Perioden zahlen nichts, verzinsen aber - gekappt bei
    // MAX_LOAN_MONTHS, damit eine absurde Ratennummer keine Endlosarbeit wird.
    for (let k = prevN + 1; k < n && k <= MAX_LOAN_MONTHS; k++) {
      balance += balance * (rateFor(k) / 100 / 12);
    }
    const interest = balance * (rateFor(n) / 100 / 12);
    balance -= (amount - interest);
    prevN = n;
  }
  return round2(Math.max(0, balance));
}

/**
 * Wie viele Raten bei der REALEN Restschuld noch bleiben (#964).
 *
 * DIE EINE ZAHL DER GRUPPE, DIE DEM KONTOSTAND FOLGEN DARF. Monatsrate und
 * Gesamtzins beschreiben den Vertrag - die Bank schickt keine kleinere Rechnung,
 * weil jemand mehr gezahlt hat, und das bleibt so. Die Restlaufzeit ist der
 * Punkt, an dem Vertrag und Kontostand verschieden antworten UND der Kontostand
 * die Frage ist, die gestellt wurde: wer sondertilgt, um frueher fertig zu sein,
 * und danach dieselbe Laufzeit abliest, bekommt genau die Enttaeuschung, gegen
 * die die Funktion gebaut ist.
 *
 * KEIN RATSCHLAG, NUR ARITHMETIK. Die Annuitaet wird fortgeschrieben, wie sie im
 * Vertrag steht; ob sich Sondertilgen lohnt, sagt diese Zahl nicht (#935:
 * Vorfaelligkeitsentgelte halten diese Frage ausserhalb des Rahmens).
 *
 * Der Zinsverlauf folgt derselben Zweiphasigkeit wie computeLoanSchedule: waehrend
 * der Bindung der feste Satz, danach der Anschlusssatz. `paidInstallments` sagt,
 * wo im Vertrag wir stehen - ohne diese Angabe faenge die Bindung von vorn an und
 * ein Darlehen kurz vor Ablauf bekaeme sie noch einmal geschenkt.
 *
 * @returns {number|null} Anzahl noch faelliger Raten; 0 bei getilgtem Darlehen,
 *   `null`, wenn die Rate den Zins nicht deckt (dann tilgt nichts) oder die
 *   Rechnung die Obergrenze reisst.
 */
export function remainingInstallmentsForBalance({
  balance,
  monthlyPayment,
  fixedRate,
  interestMode,
  fixedPeriodMonths = null,
  followupRate = null,
  paidInstallments = 0,
}) {
  let rest = Number(balance);
  if (!Number.isFinite(rest) || rest <= 0.005) return 0;

  const zahlung = Number(monthlyPayment);
  if (!Number.isFinite(zahlung) || zahlung <= 0) return null;

  const rf = Number(fixedRate) || 0;
  const variabel = interestMode === 'fixed_then_variable';
  const rv = variabel ? (Number(followupRate) || 0) : rf;
  const bindung = variabel && Number.isFinite(Number(fixedPeriodMonths))
    ? Number(fixedPeriodMonths)
    : null;

  let raten = 0;
  // Dieselbe Obergrenze wie der Plan: eine Rate, die kaum tilgt, soll die
  // Schleife nicht ewig laufen lassen.
  for (let n = Number(paidInstallments) + 1; n <= MAX_LOAN_MONTHS && rest > 0.005; n++) {
    const satz = (!bindung || n <= bindung) ? rf : rv;
    const zins = rest * (satz / 100 / 12);
    const tilgung = zahlung - zins;
    // ABKUERZUNG, KEIN SCHUTZ: ohne diese Zeile waechst `rest` statt zu fallen,
    // die Schleife laeuft bis MAX_LOAN_MONTHS und liefert am Ende dasselbe
    // `null`. Nachgemessen - die Gegenprobe bleibt gruen, wenn man sie
    // entfernt. Sie steht hier, damit ein nicht tilgendes Darlehen nicht
    // sechshundert Runden dreht, um das Offensichtliche zu bestaetigen.
    if (tilgung <= 0) return null;
    rest -= Math.min(tilgung, rest);
    raten += 1;
  }
  return rest > 0.005 ? null : raten;
}

