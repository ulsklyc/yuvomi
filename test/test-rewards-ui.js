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
