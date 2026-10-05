/**
 * Modul: Belohnungen - Oberflaeche (Re-Kritik 2026-09-28, P1 "Handwerk")
 * Zweck: Das Anfrage-Panel der Belohnungen hatte KEIN Innenpolster. Die Liste
 *        traegt zwei Klassen (`rw-pending-list rw-pending-panel`), und der
 *        Listen-Reset `padding: 0` stand im Stylesheet HINTER dem Polster des
 *        Panels - gleiche Spezifitaet, spaetere Regel gewinnt. Gemessen:
 *        computed `padding: 0px`, der Avatar sass bei x=16 genau auf der Kante
 *        der getoenten Flaeche.
 *
 * WIE GEMESSEN WIRD. Nicht die Schreibweise einer Regel, sondern die Kaskade
 * fuer GENAU die Klassenliste, die rewards.js baut: alle Basisregeln aus
 * rewards.css, deren Selektor eine dieser Klassen allein nennt, in
 * Quelltextreihenfolge; die letzte `padding`-Angabe gewinnt. Wandert der
 * Reset wieder nach hinten oder bekommt das Panel eine Nachbarklasse mit
 * eigenem Reset, faellt die Rechnung auf null und die Suite wird rot.
 *
 * Ausfuehren: npm run test:rewards-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Die Klassenlisten aller Elemente in rewards.js, die das Panel tragen. */
function panelClassLists() {
  const js = read('public/pages/rewards.js');
  return [...js.matchAll(/class="([^"$]*\brw-pending-panel\b[^"$]*)"/g)]
    .map((m) => m[1].trim().split(/\s+/));
}

/** Letzte `padding`-Kurzschrift der Kaskade fuer eine Klassenliste (Basisebene). */
function winningPadding(classes) {
  const css = read('public/styles/rewards.css');
  let winner = null;
  for (const { selector, body, at } of eachRule(css)) {
    if (at.length) continue;
    const hit = selector.split(',').map((s) => s.trim())
      .some((s) => classes.some((c) => s === `.${c}`));
    if (!hit) continue;
    for (const m of body.matchAll(/(?:^|;)\s*padding\s*:\s*([^;]+)/g)) winner = { selector, value: m[1].trim() };
  }
  return winner;
}

test('das Anfrage-Panel der Belohnungen behaelt sein Innenpolster', () => {
  const lists = panelClassLists();
  assert.ok(lists.length > 0, 'rewards.js baut kein Element mit rw-pending-panel - die Suite misst ins Leere');
  for (const classes of lists) {
    const win = winningPadding(classes);
    assert.ok(win, `keine padding-Angabe fuer ${classes.join(' ')}`);
    const zero = win.value.split(/\s+/).every((v) => /^0(px)?$/.test(v));
    assert.equal(zero, false,
      `fuer "${classes.join(' ')}" gewinnt "${win.selector} { padding: ${win.value} }" - `
      + 'der Listen-Reset hebt das Polster des Panels auf');
    const horizontal = win.value.split(/\s+/)[1] ?? win.value.split(/\s+/)[0];
    assert.doesNotMatch(horizontal, /^0(px)?$/, 'das Panel braucht seitliches Polster, sonst klebt der Avatar an der Kante');
  }
});

/* R16 (Critique 2026-10-05, P1 mobil): die Praemie stand als gestapelte Kachel
 * 358x218 (zweieinhalb je Bildschirm), darueber „Praemien" unter dem Reiter
 * „Praemien", und die Uebersicht endete mobil mit sechs Buchungen unter den
 * Punktestaenden. Mobil: kompakte Karte (rund 130px), Titel nur im Baum, drei
 * Buchungen. */
test('R16: Praemien mobil - kompakte Karte, kein doppelter Titel, drei letzte Buchungen', () => {
  const phone = [...eachRule(read('public/styles/rewards.css'))]
    .filter((r) => r.at.some((a) => /max-width:\s*639px/.test(a)))
    .map((r) => ({ ...r, selector: r.selector.trim() }));
  const body = (sel) => phone.filter((r) => r.selector === sel).map((r) => r.body).join(';');
  assert.match(body('.rw-reward-card'), /display:\s*grid/);
  assert.match(body('.rw-reward-card'), /grid-template-columns:\s*auto minmax\(0, 1fr\)/, 'Zeichen und Text stehen nebeneinander');
  assert.match(body('.rw-reward-card__foot'), /grid-column:\s*1 \/ -1/, 'Preis und Aktion ueber die ganze Breite');
  // Seit R16 Schritt 2 auf JEDER Breite: die Ueberschrift ist `.sr-only` im
  // Markup (sie wiederholt den Reiter), keine Mobil-Regel im Stylesheet mehr.
  assert.match(readFileSync(new URL('../public/pages/rewards.js', import.meta.url), 'utf8'),
    /<h2 class="sr-only">\$\{esc\(t\('rewards\.tabCatalog'\)\)\}<\/h2>/, 'die Ueberschrift bleibt in der Gliederung');
  assert.match(body('.rw-recent .rw-ledger > :nth-child(n + 4)'), /display:\s*none/);
});
