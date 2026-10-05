/**
 * Der Weg aus einem Küchen-Tab auf die Einkaufsliste.
 *
 * Drei Tabs erzeugen Artikel in einer fremden Liste - Vorrat, Rezept, Mahlzeit -
 * und alle drei laufen durch dieselbe Abfolge: Gibt es überhaupt eine Liste?
 * Welche? Was ist passiert, und wie nehme ich es zurück? Jeder Tab hatte darauf
 * eine eigene Antwort:
 *
 *   - „Es gibt keine Einkaufsliste" existierte in VIER Ausprägungen - zwei
 *     Zeichenketten, zwei Töne (`warning` im Vorrat, `danger` in Rezepten und
 *     Mahlzeiten) und genau ein Ausweg, nämlich der des Vorrats. Rot behauptet
 *     dabei, etwas sei kaputt; eine noch nicht angelegte Liste ist aber keine
 *     Störung, sondern eine fehlende Voraussetzung. Und die Rezepte liehen sich
 *     dafür `meals.noShoppingLists` - ein Refactor im Essensplan hätte den Text
 *     der Rezepte stillschweigend mitgenommen (Audit 2026-07-30, P1-A).
 *   - Zurücknehmen konnte man nur im Vorrat. Die Begründung, die dort im Code
 *     steht, gilt für die anderen beiden genauso: es ist der Pfad, der etwas
 *     ERZEUGT, und er ist leicht versehentlich auszulösen. Das Rezept überträgt
 *     sogar mehr auf einmal - eine ganze Zutatenliste - in eine Liste, die der
 *     Nutzer gerade nicht ansieht (P1-B).
 *
 * Deshalb kapselt dieses Modul die PRÜFUNG und die ANTWORT, nicht nur den Text.
 * Ein geteilter Locale-Key allein hätte die Töne, die Ausgänge und das fehlende
 * Undo unberührt gelassen - genau die Teile, die auseinandergelaufen waren.
 *
 * Der Namensraum der Keys ist `kitchen.*`. Vorher gehörte der Text einem der
 * aufrufenden Module; jetzt gehört er der Gruppe, und alle drei nutzen ihn
 * gleichberechtigt.
 *
 * DIE ZIELLISTE GEHOERT EINEM FREMDEN MODUL (#1265). Zwei Antworten dieses
 * Bausteins schreiben selbst in den Einkauf, egal von welchem Tab aus: der
 * Ausweg „Neue Liste erstellen" (`POST /shopping`) und die Ruecknahme
 * (`POST /shopping/items/undo-transfer`). Beide fragen deshalb das
 * Einkaufs-Recht ueber `mayWritePath()` und entfallen ohne es - eine Ruecknahme,
 * die im 403 endet, ist schlechter als keine, und ein Ausweg auf eine Seite,
 * auf der man nichts anlegen darf, ist eine Sackgasse. Den Transfer SELBST
 * misst der Pfad-Guard je nach Weg verschieden (Vorrat als `shopping`,
 * Mahlzeit und Rezept als `meals`); seit #1290 verlangt die Route in jedem
 * Fall das Einkaufs-Recht. Der Transfer-Knopf fragt deshalb BEIDE Riegel
 * (`mayTransferMealToShopping()`, `mayTransferRecipeToShopping()`), und
 * dasselbe tut die Gegenrichtung im Einkauf (`mayImportMealPlan()`).
 * Vorrat und Einkauf untereinander brauchen je Richtung nur den Riegel des
 * Ziels (`mayTransferPantryToShopping()`, `mayTransferShoppingToPantry()`).
 * `resolveShoppingTarget()` prueft bewusst nichts:
 * es ist die Listenwahl, nicht der Riegel - der sitzt am Knopf und im Handler.
 *
 * `selectModal` kommt aus `components/`, obwohl diese Datei in `utils/` liegt.
 * Die Alternative wäre, die Listenauswahl beim Aufrufer zu lassen - dann kapselt
 * der Helfer wieder nur den Text, und die Vorprüfung stünde erneut dreimal da.
 * Ein Zyklus entsteht nicht: `components/modal.js` importiert nur `i18n.js` und
 * `utils/html.js`.
 */

import { t } from '/i18n.js';
import { api } from '/api.js';
import { selectModal } from '/components/modal.js';
import { refreshKitchenBadges } from '/utils/kitchen-tabs.js';
import { mayWritePath } from '/utils/module-access.js';

/**
 * Darf dieses Konto den AUSDRUECKLICHEN Transfer einer Mahlzeit bzw. eines
 * Rezepts in den Einkauf ausloesen (#1290)?
 *
 * ZWEI RIEGEL, UND BEIDE MUESSEN AUFGEHEN. Der Pfad-Guard in server/index.js
 * misst den Aufruf am Pfad - `/meals/...` und `/recipes/...` gehoeren beide
 * dem Scope-Modul `meals` -, und die Route verlangt dazu das Schreibrecht auf
 * `shopping`. Wer nur nach dem Ziel fragt, zeigt (bei der Mahlzeit) einem
 * Mitglied mit `meals: read` einen Knopf, den der Pfad-Guard abweist; wer nur
 * nach der Seite fragt, war der Stand vor diesem Fix.
 *
 * Was der Pfad-Guard verlangt, beantwortet `mayWritePath()`: fuer die Mahlzeit
 * `meals: write` (die Route kippt `on_shopping_list` im Essensplan), fuer das
 * Rezept nur `meals: read` - die zweite Serverausnahme, entschieden am
 * 22.09.2026 (`READ_LEVEL_WRITES` in server/scopes.js, Regel 8 in
 * utils/module-access.js). Die Funktionen hier bilden also nichts selbst ab.
 *
 * Je Quelle eine Funktion mit dem Pfad als LITERAL, statt eines Parameters:
 * `npm run test:module-write-access` liest jede Frage an `mayWritePath()` als
 * Text und gleicht sie mit dem Urteil des Servers ab - ein durchgereichter
 * Pfad waere fuer den Guard unsichtbar.
 *
 * @param {number|string} mealId
 * @returns {boolean}
 */
export function mayTransferMealToShopping(mealId) {
  return mayWritePath(`/meals/${mealId}/to-shopping-list`) && mayWritePath('/shopping');
}

/**
 * @param {number|string} recipeId
 * @returns {boolean}
 */
export function mayTransferRecipeToShopping(recipeId) {
  return mayWritePath(`/recipes/${recipeId}/to-shopping-list`) && mayWritePath('/shopping');
}

/**
 * Die Gegenrichtung: „Aus dem Essensplan uebernehmen" im Einkauf (#1290).
 * Der Pfad-Guard misst `shopping`, die Route verlangt dazu `meals` - schon fuer
 * die Vorschau, weil die den Schreibvorgang ankuendigt.
 *
 * @param {number|string} listId
 * @returns {boolean}
 */
export function mayImportMealPlan(listId) {
  return mayWritePath(`/shopping/${listId}/import-meal-plan`) && mayWritePath('/meals');
}

/**
 * Vorrat -> Einkauf: der Warenkorb einer Vorratszeile und die Sammel-Pille
 * „Alles auf die Einkaufsliste" (#1265).
 *
 * EIN RIEGEL, NICHT ZWEI. Der Pfad-Guard misst `POST /shopping/:id/import-pantry`
 * als `shopping`; die Route fragt dazu `pantry: read`, weil sie die
 * Vorratszeilen liest (`mayReadModule()`). Das zweite Recht muss hier niemand
 * fragen: der Knopf steht nur auf der Vorratsseite, und wer die sieht, hat den
 * Vorrat mindestens zum Lesen. Mit `shopping: read` endeten beide Wege bis
 * hierher im 403.
 *
 * OHNE LISTEN-ID: beim Zeichnen steht das Ziel noch nicht fest (es wird erst
 * nach dem Tippen gewaehlt), und das Urteil haengt nur am Praefix. Der Pfad
 * steht trotzdem als Literal da, damit `npm run test:module-write-access` ihn
 * gegen den Server lesen kann.
 *
 * @returns {boolean}
 */
export function mayTransferPantryToShopping() {
  return mayWritePath('/shopping/:listId/import-pantry');
}

/**
 * Einkauf -> Vorrat: „In den Vorrat" in der Sammel-Pille des Einkaufs (#1265).
 * Der Pfad-Guard misst `POST /pantry/import-shopping` als `pantry`; die
 * Einkaufsseite fragte bisher nur, ob das Modul abgeschaltet ist, und zeigte
 * den Weg deshalb auch bei `pantry: read`. `shopping: read` verlangt die Route
 * zusaetzlich (sie liest die abgehakten Artikel), und das hat jeder, der die
 * Einkaufsseite sieht - also auch hier ein Riegel.
 *
 * @returns {boolean}
 */
export function mayTransferShoppingToPantry() {
  return mayWritePath('/pantry/import-shopping');
}

/**
 * Standzeit der Transfer-Toasts.
 *
 * 5s statt der 3s des Defaults, weil diese Toasts eine Aktion tragen: der
 * Nutzer muss den Satz lesen UND sich entscheiden können. Der Vorrat stand
 * schon auf 5s, die anderen beiden auf dem Default - ein Undo-Fenster, das je
 * nach Tab unterschiedlich lang offen steht, ist keine verlässliche Zusage.
 */
export const TRANSFER_TOAST_MS = 5000;

/**
 * Fuehrt der Ausweg irgendwohin? Der Einkaufs-Tab muss erreichbar sein UND
 * dieser Nutzer muss dort eine Liste anlegen duerfen (`POST /shopping`) - mit
 * `shopping: read` landete er auf einer Seite, deren Anlegeweg ausgeblendet ist.
 */
function shoppingReachable() {
  return !window.yuvomi?.isModuleDisabled?.('shopping') && mayWritePath('/shopping');
}

/**
 * Die eine Antwort auf „es gibt noch keine Einkaufsliste".
 *
 * Ton `warning`, nicht `danger`: eine fehlende Voraussetzung, keine Störung.
 *
 * Der Ausweg ist ein Knopf, kein Satz. Der Vorrat nannte den Zielort im Text
 * („Lege im Tab Einkaufen eine an."), was zwei Nachteile hat: er benennt einen
 * Tab-Namen ein zweites Mal, und er lässt den Nutzer den Weg selbst gehen,
 * obwohl die Tab-Leiste direkt darüber steht. Ist das Einkaufsmodul
 * abgeschaltet, entfällt der Knopf - ein Ausweg, der ins Leere führt, ist
 * schlechter als keiner.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.beforeLeave]  Läuft vor dem Wechsel; die Aufrufstelle
 *                                       räumt damit auf, was den Wechsel sonst
 *                                       blockiert (ein offenes Modal etwa).
 * @returns {{ message: string, action: { label: string, onClick: Function }|null }}
 */
export function missingShoppingListAnswer({ beforeLeave } = {}) {
  return {
    message: t('kitchen.noShoppingLists'),
    action: shoppingReachable()
      ? {
          label: t('kitchen.createShoppingList'),
          onClick: () => {
            beforeLeave?.();
            window.yuvomi?.navigate('/shopping');
          },
        }
      : null,
  };
}

/**
 * Bestimmt die Ziel-Liste eines Transfers - oder beantwortet, warum es keine gibt.
 *
 * Eine Liste → keine Rückfrage. Mehrere → einmal fragen. Keine → die geteilte
 * Antwort samt Ausweg.
 *
 * @param {Array<{id: number, name: string}>} lists
 * @param {object} [opts]  wie `missingShoppingListAnswer`
 * @returns {Promise<{ id: number, name: string }|null>}  `null` heißt: nicht
 *          weitermachen. Die Aufrufstelle hat dann nichts mehr zu melden - die
 *          Antwort steht schon auf dem Bildschirm oder der Nutzer hat abgebrochen.
 */
export async function resolveShoppingTarget(lists, opts) {
  const available = Array.isArray(lists) ? lists : [];

  if (!available.length) {
    const { message, action } = missingShoppingListAnswer(opts);
    window.yuvomi?.showToast(message, 'warning', TRANSFER_TOAST_MS, action);
    return null;
  }

  if (available.length === 1) {
    return { id: available[0].id, name: available[0].name };
  }

  const chosen = await selectModal(
    t('common.toShoppingListWhich'),
    available.map((list) => ({ value: String(list.id), label: list.name })),
  );
  if (chosen === null || chosen === undefined) return null;

  const id = Number(chosen);
  return { id, name: available.find((list) => list.id === id)?.name ?? '' };
}

/**
 * Hängt die geteilte Antwort inline in eine Fläche, auf der ein Toast danebenläge.
 *
 * Gebraucht vom Mahlzeiten-Modal: dort saß der Zustand als deaktiviertes
 * `<option>` in einem Auswahlfeld neben einem Knopf, der nichts tat. Ein
 * Bedienelement, das den Grund seiner Nutzlosigkeit in sich trägt, ist die
 * schlechteste der vier Formen - es sieht bedienbar aus.
 *
 * @param {HTMLElement} target
 * @param {object} [opts]  wie `missingShoppingListAnswer`
 */
export function mountMissingShoppingList(target, opts) {
  if (!target) return null;
  const { message, action } = missingShoppingListAnswer(opts);

  const hint = document.createElement('p');
  hint.className = 'shopping-transfer__hint';
  hint.textContent = message;
  target.replaceChildren(hint);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--secondary shopping-transfer__btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    target.appendChild(btn);
  }
  return target;
}

/**
 * Meldet einen gelungenen Transfer und bietet ihn zur Rücknahme an.
 *
 * Echtes Rücknehmen, kein verzögerter Commit: der Server überspringt Duplikate,
 * die Anzahl im Toast kennt also erst er. Ein verzögerter Commit müsste sie
 * vorher versprechen. Stattdessen liefert der Server die erzeugten IDs, und das
 * Undo löscht genau diese - über `POST /shopping/items/undo-transfer`, das die
 * Rücknahme in EINE Transaktion legt und beim Mahlzeit-Pfad zusätzlich das
 * `on_shopping_list`-Flag der Zutaten zurücksetzt.
 *
 * Ohne IDs (ältere Serverantwort) erscheint der Toast bewusst OHNE Aktion,
 * statt einen Knopf zu zeigen, der nichts zurücknehmen kann. Dasselbe ohne
 * Schreibrecht auf den Einkauf: der Transfer aus Mahlzeit oder Rezept gelingt
 * dann trotzdem (der Server urteilt ihn als `meals`), die Rücknahme ist aber
 * ein Einkaufs-Pfad und endete im 403 (#1265).
 *
 * `refreshKitchenBadges()` läuft hier statt an den drei Aufrufstellen: die Zahl
 * des Einkaufs-Tabs ändert sich in beide Richtungen, und beide Male genau hier.
 *
 * @param {object}   opts
 * @param {string}   opts.message     Aufgelöster Erfolgstext des Moduls.
 * @param {number[]} [opts.addedIds]  `added_ids` aus der Transfer-Antwort.
 * @param {Function} [opts.onUndone]  Läuft nach erfolgreicher Rücknahme; die
 *                                    Aufrufstelle zeichnet damit ihre eigene
 *                                    Ansicht neu (der Essensplan etwa zeigt die
 *                                    Zutaten wieder als offen).
 */
export function announceTransfer({ message, addedIds = [], onUndone } = {}) {
  refreshKitchenBadges();

  const ids = Array.isArray(addedIds) ? addedIds.filter((id) => Number.isFinite(Number(id))) : [];
  const canUndo = mayWritePath('/shopping/items/undo-transfer');
  const undo = canUndo && ids.length
    ? async () => {
        try {
          await api.post('/shopping/items/undo-transfer', { ids });
          refreshKitchenBadges();
          await onUndone?.();
          // Zählfrei: die Anzahl stand eine Sekunde vorher im Toast, den der
          // Nutzer gerade angetippt hat. Ein zweiter Zähler wäre ein Key mit
          // _one/_few/_two-Kategorien über 23 Locales - für eine Bestätigung,
          // die nichts Neues sagt.
          window.yuvomi?.showToast(t('kitchen.transferUndone'), 'info');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      }
    : null;

  window.yuvomi?.showToast(message, 'success', TRANSFER_TOAST_MS, undo);
}
