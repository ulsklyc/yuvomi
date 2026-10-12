/**
 * Test: Darlehens-Amortisation (#569)
 * Zweck: Kern-Mathematik des Annuitätendarlehens - konstante Monatsrate aus
 *        Sollzins + Anfangstilgung, korrekter Phasenwechsel nach der Zinsbindung
 *        auf den Prognose-Anschlusszins, Restschuld, Laufzeit-Ableitung und die
 *        Schutzfälle (Rate deckt Zins nicht / Laufzeit zu lang). Rein, ohne DB.
 * Ausführen: node --test test/test-budget-loans-amortization.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLoanSchedule, remainingPrincipalAfter, remainingPrincipalFromPayments, remainingInstallmentsForBalance, rateForInstallment, MAX_LOAN_MONTHS } from '../server/services/loan-amortization.js';

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

test('konstante Monatsrate = Kreditsumme × (Sollzins + Anfangstilgung) / 12', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(r.ok, true);
  assert.ok(near(r.monthlyPayment, 750), `monthlyPayment ${r.monthlyPayment}`);
  // Erste Rate: Zinsanteil 200000 × 2,5%/12 = 416,67, Tilgung = 333,33.
  assert.ok(near(r.schedule[0].interest, 416.67), `interest[0] ${r.schedule[0].interest}`);
  assert.ok(near(r.schedule[0].principal, 333.33), `principal[0] ${r.schedule[0].principal}`);
});

test('Plan tilgt vollständig: Restschuld endet bei 0, Summen stimmen', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(r.ok, true);
  assert.equal(r.schedule.at(-1).balance, 0);
  assert.equal(r.totalMonths, r.schedule.length);
  assert.ok(r.totalMonths > 0 && r.totalMonths <= MAX_LOAN_MONTHS);
  const sumPrincipal = r.schedule.reduce((s, x) => s + x.principal, 0);
  assert.ok(near(sumPrincipal, 200000, 0.5), `Σprincipal ${sumPrincipal}`);
  assert.ok(near(r.totalRepayment, 200000 + r.totalInterest, 0.02));
  assert.ok(r.schedule.every((x) => x.rate === 2.5 && x.phase === 1));
});

test('fixed_then_variable: Phasenwechsel nach der Zinsbindung', () => {
  const r = computeLoanSchedule({
    principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2,
    interestMode: 'fixed_then_variable', fixedPeriodMonths: 180, followupRate: 4,
  });
  assert.equal(r.ok, true);
  assert.ok(near(r.monthlyPayment, 750));
  const m180 = r.schedule.find((x) => x.n === 180);
  const m181 = r.schedule.find((x) => x.n === 181);
  assert.equal(m180.rate, 2.5);
  assert.equal(m180.phase, 1);
  assert.equal(m181.rate, 4);
  assert.equal(m181.phase, 2);
  assert.ok(r.remainingAfterBinding > 0 && r.remainingAfterBinding < 200000, `Restschuld ${r.remainingAfterBinding}`);
  assert.ok(near(r.remainingAfterBinding, m180.balance, 0.02));
});

test('höherer Anschlusszins verlängert die Laufzeit ggü. durchgängigem Festzins', () => {
  const base = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  const variable = computeLoanSchedule({
    principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2,
    interestMode: 'fixed_then_variable', fixedPeriodMonths: 180, followupRate: 4,
  });
  assert.equal(base.ok, true);
  assert.equal(variable.ok, true);
  assert.ok(variable.totalMonths > base.totalMonths, `variable ${variable.totalMonths} vs fixed ${base.totalMonths}`);
});

test("Modus 'fixed' ignoriert Zinsbindung/Anschlusszins (durchgängig Sollzins)", () => {
  const r = computeLoanSchedule({
    principal: 100000, fixedRate: 3, initialRepaymentRate: 2,
    interestMode: 'fixed', fixedPeriodMonths: 60, followupRate: 9,
  });
  assert.equal(r.ok, true);
  assert.ok(r.schedule.every((x) => x.rate === 3 && x.phase === 1));
  assert.equal(r.remainingAfterBinding, 0);
});

test("Modus 'variable' rechnet einphasig wie 'fixed' (keine Zinsbindung)", () => {
  const variable = computeLoanSchedule({
    principal: 150000, fixedRate: 3.5, initialRepaymentRate: 2, interestMode: 'variable',
  });
  const fixed = computeLoanSchedule({
    principal: 150000, fixedRate: 3.5, initialRepaymentRate: 2, interestMode: 'fixed',
  });
  assert.equal(variable.ok, true);
  assert.equal(variable.monthlyPayment, fixed.monthlyPayment);
  assert.equal(variable.totalMonths, fixed.totalMonths);
  assert.equal(variable.totalInterest, fixed.totalInterest);
  assert.ok(variable.schedule.every((x) => x.rate === 3.5 && x.phase === 1));
  assert.equal(variable.remainingAfterBinding, 0, 'ohne Bindung gibt es keine Restschuld-Marke');
});

test("Modus 'variable' ignoriert mitgeschickte Bindungsfelder", () => {
  const r = computeLoanSchedule({
    principal: 150000, fixedRate: 3.5, initialRepaymentRate: 2,
    interestMode: 'variable', fixedPeriodMonths: 120, followupRate: 9,
  });
  assert.equal(r.ok, true);
  assert.ok(r.schedule.every((x) => x.rate === 3.5 && x.phase === 1));
  assert.equal(r.remainingAfterBinding, 0);
});

test('Schutz: Anschlusszins zu hoch → tilgt nicht (not_amortizing)', () => {
  const r = computeLoanSchedule({
    principal: 100000, fixedRate: 1, initialRepaymentRate: 1,
    interestMode: 'fixed_then_variable', fixedPeriodMonths: 12, followupRate: 20,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_amortizing');
});

test('Schutz: unrealistisch lange Laufzeit wird abgewiesen (ok:false)', () => {
  const r = computeLoanSchedule({ principal: 100000, fixedRate: 8, initialRepaymentRate: 0.05, interestMode: 'fixed' });
  assert.equal(r.ok, false);
});

test('niedrigere Anfangstilgung → längere Laufzeit', () => {
  const low = computeLoanSchedule({ principal: 100000, fixedRate: 3, initialRepaymentRate: 1, interestMode: 'fixed' });
  const high = computeLoanSchedule({ principal: 100000, fixedRate: 3, initialRepaymentRate: 4, interestMode: 'fixed' });
  assert.equal(low.ok, true);
  assert.equal(high.ok, true);
  assert.ok(low.totalMonths > high.totalMonths);
});

// --------------------------------------------------------------------------
// Restschuld zum Ratenstand
// --------------------------------------------------------------------------

test('remainingPrincipalAfter: 0 Raten = Kreditsumme, n Raten = Plan-Restschuld', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(r.ok, true);
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, 0), 200000, 'vor der ersten Rate ist nichts getilgt');
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, 1), r.schedule[0].balance);
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, 60), r.schedule[59].balance);
  assert.ok(remainingPrincipalAfter(r.schedule, 200000, 60) < 200000, 'die Restschuld sinkt');
});

test('remainingPrincipalAfter: getilgt bleibt 0, auch über den Plan hinaus', () => {
  const r = computeLoanSchedule({ principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' });
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, r.totalMonths), 0);
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, r.totalMonths + 50), 0, 'kein negatives Kapital');
  assert.equal(remainingPrincipalAfter(r.schedule, 200000, -5), 200000, 'unsinnige Eingabe fällt auf die Kreditsumme zurück');
});

// Auslöser: Die Karte zeigte die Summe der Restraten und wurde als Restschuld
// gelesen. Beide Größen dürfen bei verzinsten Darlehen nie gleichgesetzt werden -
// die Differenz sind exakt die Zinsen, die in den Restraten noch stecken.
test('Restschuld liegt unter der Summe der Restraten, Differenz = Restzinsen', () => {
  // Nachgebauter Nutzerfall: 21.000 € zu 4,07 %, 72 Raten à 330,10 €, 44 gezahlt.
  const r = computeLoanSchedule({
    principal: 21000, fixedRate: 4.07, initialRepaymentRate: 14.792857, interestMode: 'fixed',
  });
  assert.equal(r.ok, true);
  assert.ok(near(r.monthlyPayment, 330.10), `monthlyPayment ${r.monthlyPayment}`);
  assert.equal(r.totalMonths, 72);

  const paid = 44;
  const principalLeft = remainingPrincipalAfter(r.schedule, 21000, paid);
  const rest = r.schedule.slice(paid);
  const paymentsLeft = rest.reduce((s, x) => s + x.interest + x.principal, 0);
  const interestLeft = rest.reduce((s, x) => s + x.interest, 0);

  assert.ok(principalLeft < paymentsLeft, `Restschuld ${principalLeft} muss unter ${paymentsLeft} liegen`);
  assert.ok(near(paymentsLeft - principalLeft, interestLeft, 0.5), 'die Differenz sind die Restzinsen');
  // Summe der planmäßigen Tilgungsanteile ab hier == Restschuld.
  assert.ok(near(rest.reduce((s, x) => s + x.principal, 0), principalLeft, 0.5));
});

// --------------------------------------------------------------------------
// Restschuld aus der Zahlungshistorie (#954, gemeldet in #935)
// --------------------------------------------------------------------------

test('remainingPrincipalFromPayments: exakte Annuität == Planposition (Äquivalenz)', () => {
  // Die Abkürzung über die Planposition war 44 Raten lang richtig, solange jede
  // Rate exakt der Annuität entsprach - genau diese Gleichheit muss der Ersatz
  // beweisen, sonst ist er nur eine zweite, leise abweichende Rechnung.
  const params = { principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' };
  const r = computeLoanSchedule(params);
  assert.equal(r.ok, true);
  for (const n of [1, 12, 60, r.totalMonths]) {
    const pays = Array.from({ length: n }, (_, i) => ({ installment_number: i + 1, amount: r.monthlyPayment }));
    // Die letzte Rate ist kleiner als die Annuität; im Plan wird sie gekappt,
    // hier zahlt der Test sie in voller Höhe - deshalb keine Cent-Gleichheit
    // am Laufzeitende, sondern die Null-Zusicherung darunter.
    if (n < r.totalMonths) {
      assert.equal(remainingPrincipalFromPayments(params, pays), remainingPrincipalAfter(r.schedule, 200000, n), `nach ${n} Raten`);
    } else {
      assert.equal(remainingPrincipalFromPayments(params, pays), 0, 'volle Laufzeit tilgt vollständig');
    }
  }
});

test('remainingPrincipalFromPayments: eine Sondertilgung senkt die Restschuld um genau ihren Betrag', () => {
  const params = { principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' };
  const r = computeLoanSchedule(params);
  const pays = Array.from({ length: 13 }, (_, i) => ({ installment_number: i + 1, amount: r.monthlyPayment }));
  pays[12] = { installment_number: 13, amount: r.monthlyPayment + 10000 };
  const withExtra = remainingPrincipalFromPayments(params, pays);
  const planAt13 = remainingPrincipalAfter(r.schedule, 200000, 13);
  // Bis Rate 12 laufen beide identisch, der Zinsanteil der 13. Rate ist deshalb
  // derselbe - das Extra geht eins zu eins in die Tilgung.
  assert.ok(near(withExtra, planAt13 - 10000), `mit Extra ${withExtra}, Plan ${planAt13}`);
});

test('remainingPrincipalFromPayments: eine Minderzahlung lässt mehr Kapital offen als der Plan behauptet', () => {
  const params = { principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' };
  const r = computeLoanSchedule(params);
  const pays = [
    { installment_number: 1, amount: r.monthlyPayment },
    { installment_number: 2, amount: 100 }, // deckt nicht einmal den Zinsanteil (~416 €)
  ];
  const real = remainingPrincipalFromPayments(params, pays);
  const planAt2 = remainingPrincipalAfter(r.schedule, 200000, 2);
  assert.ok(real > planAt2, `real ${real} muss über der Planposition ${planAt2} liegen`);
  // Unter dem Zinsanteil wächst die Restschuld gegenüber dem Stand nach Rate 1 -
  // ehrlich gerechnet, nicht stillschweigend als volle Rate gezählt.
  assert.ok(real > remainingPrincipalAfter(r.schedule, 200000, 1), 'Rückstand erhöht das offene Kapital');
});

test('remainingPrincipalFromPayments: Überzahlung endet bei 0, nie darunter', () => {
  const params = { principal: 21000, fixedRate: 4.07, initialRepaymentRate: 14.792857, interestMode: 'fixed' };
  const pays = [
    { installment_number: 1, amount: 22000 },
    { installment_number: 2, amount: 330.10 }, // Buchung nach der Tilgung schuldet nichts nach
  ];
  assert.equal(remainingPrincipalFromPayments(params, pays), 0);
});

test('remainingPrincipalFromPayments: nach der Zinsbindung rechnet der Anschlusszins', () => {
  const params = {
    principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2,
    interestMode: 'fixed_then_variable', fixedPeriodMonths: 2, followupRate: 4,
  };
  // Eine einzelne Rate mit Nummer 3 liegt hinter der Bindung: ihr Zinsanteil
  // muss mit 4 % gerechnet werden, nicht mit 2,5 %. Die Perioden 1 und 2 davor
  // sind Null-Zahlungen IN der Bindung und verzinsen mit 2,5 %.
  const rFix = 2.5 / 100 / 12;
  const rVar = 4 / 100 / 12;
  const paid = remainingPrincipalFromPayments(params, [{ installment_number: 3, amount: 1000 }]);
  let b3 = 200000 * (1 + rFix) * (1 + rFix);
  assert.ok(near(paid, b3 - (1000 - b3 * rVar)), `Restschuld ${paid}`);
  const paidFixed = remainingPrincipalFromPayments(params, [{ installment_number: 2, amount: 1000 }]);
  const b2 = 200000 * (1 + rFix);
  assert.ok(near(paidFixed, b2 - (1000 - b2 * rFix)), `Restschuld in der Bindung ${paidFixed}`);
  assert.ok(paidFixed < paid, 'in der Bindung tilgt dieselbe Rate mehr');
});

test('remainingPrincipalFromPayments: leere oder unbrauchbare Historie = Kreditsumme', () => {
  const params = { principal: 21000, fixedRate: 4.07, initialRepaymentRate: 14.792857, interestMode: 'fixed' };
  assert.equal(remainingPrincipalFromPayments(params, []), 21000);
  assert.equal(remainingPrincipalFromPayments(params, null), 21000);
  assert.equal(remainingPrincipalFromPayments(params, [{ installment_number: 0, amount: -5 }]), 21000);
});

test('remainingPrincipalFromPayments: eine Lücke ist eine Null-Zahlung, ihr Zins läuft auf', () => {
  // Lücken entstehen real: eine Zahlung wird gelöscht, oder eine spätere
  // Ratennummer wird direkt gebucht. Ohne Zinslauf über die ausgelassene
  // Periode meldete die Rechnung zu WENIG Restschuld - die bequeme Richtung.
  const params = { principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' };
  const r = computeLoanSchedule(params);
  const m = r.monthlyPayment;
  const rate = 2.5 / 100 / 12;

  const gapped = remainingPrincipalFromPayments(params, [
    { installment_number: 1, amount: m },
    { installment_number: 3, amount: m },
  ]);
  // Von Hand: Rate 1, dann verzinst Periode 2 ohne Zahlung, dann Rate 3.
  let b = 200000;
  b -= (m - b * rate);      // Rate 1
  b += b * rate;            // Periode 2: Null-Zahlung, Zins schlägt aufs Kapital
  b -= (m - b * rate);      // Rate 3
  assert.equal(gapped, Math.round(b * 100) / 100, 'die Lücke verzinst genau eine Periode');

  const dense = remainingPrincipalFromPayments(params, [
    { installment_number: 1, amount: m },
    { installment_number: 2, amount: m },
  ]);
  assert.ok(gapped > dense, `mit Lücke ${gapped} muss mehr offen sein als ohne ${dense}`);

  // Auch eine Lücke VOR der ersten Buchung verzinst: dieselbe Rate später
  // gebucht lässt mehr Kapital offen.
  const late = remainingPrincipalFromPayments(params, [{ installment_number: 3, amount: m }]);
  const early = remainingPrincipalFromPayments(params, [{ installment_number: 1, amount: m }]);
  assert.ok(late > early, `späte Erstbuchung ${late} > frühe ${early}`);
});

// --------------------------------------------------------
// Restlaufzeit am Kontostand (#964)
// --------------------------------------------------------

test('bei voller Restschuld ist die Prognose exakt die Planlaufzeit', () => {
  // DIE AEQUIVALENZ IST DER PRUEFSTEIN. Wer nichts extra zahlt, muss dieselbe
  // Zahl sehen wie vorher - eine Prognose, die schon ohne Sondertilgung von der
  // Planzahl abweicht, waere kein Fortschritt, sondern ein zweiter Wert, dem
  // niemand glauben kann.
  const plan = computeLoanSchedule({ principal: 100000, fixedRate: 3, initialRepaymentRate: 2, interestMode: 'fixed' });
  const prognose = remainingInstallmentsForBalance({
    balance: 100000, monthlyPayment: plan.monthlyPayment, fixedRate: 3, interestMode: 'fixed',
  });
  assert.equal(prognose, plan.totalMonths);
});

test('eine Sondertilgung verkuerzt die Laufzeit', () => {
  const plan = computeLoanSchedule({ principal: 100000, fixedRate: 3, initialRepaymentRate: 2, interestMode: 'fixed' });
  const halb = remainingInstallmentsForBalance({
    balance: 50000, monthlyPayment: plan.monthlyPayment, fixedRate: 3, interestMode: 'fixed',
  });
  assert.ok(halb < plan.totalMonths, `${halb} muss unter ${plan.totalMonths} liegen`);
  // Und zwar deutlich: die halbe Restschuld bei gleicher Rate ist nicht die
  // halbe Laufzeit, aber auch nicht fast dieselbe.
  assert.ok(halb < plan.totalMonths * 0.75, `${halb} ist kaum kuerzer als ${plan.totalMonths}`);
});

test('getilgt heisst null Raten, nicht amortisierend heisst keine Antwort', () => {
  assert.equal(remainingInstallmentsForBalance({
    balance: 0, monthlyPayment: 400, fixedRate: 3, interestMode: 'fixed',
  }), 0);
  // Eine Rate unter dem Monatszins tilgt nie - dafuer gibt es keine Laufzeit,
  // und eine erfundene waere schlimmer als keine.
  assert.equal(remainingInstallmentsForBalance({
    balance: 100000, monthlyPayment: 10, fixedRate: 3, interestMode: 'fixed',
  }), null);
});

test('nach der Zinsbindung rechnet die Prognose mit dem Anschlusssatz', () => {
  // `paidInstallments` sagt, wo im Vertrag wir stehen: ohne die Angabe finge die
  // Bindung von vorn an, und ein Darlehen kurz vor ihrem Ablauf bekaeme den
  // guenstigen Satz noch einmal geschenkt.
  const params = {
    balance: 80000, monthlyPayment: 500, fixedRate: 2, interestMode: 'fixed_then_variable',
    fixedPeriodMonths: 120, followupRate: 6,
  };
  const amAnfang = remainingInstallmentsForBalance({ ...params, paidInstallments: 0 });
  const kurzVorAblauf = remainingInstallmentsForBalance({ ...params, paidInstallments: 119 });
  assert.ok(amAnfang !== null && kurzVorAblauf !== null, 'beide muessen rechenbar sein');
  assert.ok(kurzVorAblauf > amAnfang,
    `kurz vor Ablauf (${kurzVorAblauf}) muss laenger dauern als am Anfang (${amAnfang}) - der teurere Satz greift sofort`);
});

test('rateForInstallment: derselbe Satz wie im Plan, fuer jede Rate und jeden Modus (#1706)', () => {
  // Aequivalenz statt Stichprobe: die Darlehensliste sortiert nach diesem Satz,
  // und er darf nie etwas anderes sagen als der Tilgungsplan, mit dem Restschuld
  // und Restlaufzeit rechnen.
  const faelle = [
    { principal: 200000, fixedRate: 2.5, initialRepaymentRate: 2, interestMode: 'fixed' },
    { principal: 50000, fixedRate: 6.1, initialRepaymentRate: 5, interestMode: 'variable' },
    { principal: 200000, fixedRate: 2, initialRepaymentRate: 3, interestMode: 'fixed_then_variable', fixedPeriodMonths: 120, followupRate: 5 },
    { principal: 9000, fixedRate: 0, initialRepaymentRate: 20, interestMode: 'fixed' },
  ];
  for (const params of faelle) {
    const plan = computeLoanSchedule(params);
    assert.equal(plan.ok, true);
    for (const row of plan.schedule) {
      assert.equal(rateForInstallment(params, row.n), row.rate, `${params.interestMode}, Rate ${row.n}`);
    }
  }
});

test('rateForInstallment: der Wechsel liegt NACH der letzten Rate der Bindung (#1706)', () => {
  const params = { fixedRate: 2, interestMode: 'fixed_then_variable', fixedPeriodMonths: 120, followupRate: 5 };
  assert.equal(rateForInstallment(params, 120), 2);
  assert.equal(rateForInstallment(params, 121), 5);
  // 'variable' und 'fixed' kennen keinen zweiten Satz, auch wenn einer mitkommt.
  assert.equal(rateForInstallment({ ...params, interestMode: 'variable' }, 300), 2);
  assert.equal(rateForInstallment({ ...params, interestMode: 'fixed' }, 300), 2);
});
