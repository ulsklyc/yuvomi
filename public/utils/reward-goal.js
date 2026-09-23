/**
 * Modul: Belohnungen - naechstes Ziel
 * Zweck: EINE Regel dafuer, worauf ein Punktestand gerade zulaeuft. Die
 *        Belohnungen-Seite zeichnet damit den Balken in jeder Mitgliedszeile,
 *        das Dashboard-Widget den Balken des Kindes und der Eltern-Uebersicht.
 *        Zwei eigene Fassungen liefen auseinander, sobald eine davon lernt,
 *        was "vergriffen" heisst - und genau das ist der Fall, der hier steht.
 * Abhaengigkeiten: keine (reine Funktionen, im Browser und in Node ladbar)
 */

/*
 * VERGRIFFEN IST SO GUT WIE NICHT DA - fuer alles, was auf eine Einloesung
 * zulaeuft (#1310). `remaining` kommt vom Server: `null` heisst unbegrenzt, `0`
 * heisst, jede Einheit ist vergeben. Eine Praemie mit 0 bleibt im Katalog
 * sichtbar, damit der Haushalt sieht, dass es sie gibt - aber sie taugt weder
 * als Ziel eines Fortschrittsbalkens noch als Angebot im Einloese-Dialog.
 */
export function isRedeemable(c) {
  return c.is_active !== 0 && c.remaining !== 0;
}

/**
 * Worauf laeuft dieser Stand zu?
 *
 * Das Ziel ist die GUENSTIGSTE einloesbare Praemie, die noch nicht reicht - der
 * naechste Schritt, nicht der groesste Wunsch. Reicht der Stand schon fuer
 * alles, ist das Ziel erreicht; gibt es gar keine einloesbare Praemie, gibt es
 * auch kein Ziel (null) - ein leerer Balken wuerde dann einen Weg behaupten,
 * den niemand angelegt hat.
 *
 * Ein negativer Stand (Korrekturbuchung) fuellt den Balken nicht unter null,
 * die fehlenden Punkte zaehlen aber ehrlich ab dort: wer bei -5 steht, braucht
 * fuer eine 60er-Praemie 65, nicht 60.
 *
 * @param {number} balance
 * @param {Array<{name: string, cost: number, is_active?: number, remaining?: number|null}>} catalog
 * @returns {null | {reached: true, pct: 100} | {reached: false, pct: number, missing: number, target: object}}
 */
export function nextRewardGoal(balance, catalog) {
  const active = (Array.isArray(catalog) ? catalog : []).filter(isRedeemable);
  if (!active.length) return null;
  const have = Number(balance) || 0;
  const target = active
    .filter((c) => c.cost > have)
    .sort((a, b) => a.cost - b.cost)[0];
  if (!target) return { reached: true, pct: 100 };
  const pct = Math.max(0, Math.min(100, Math.round((have / target.cost) * 100)));
  return { reached: false, pct, missing: target.cost - have, target };
}
