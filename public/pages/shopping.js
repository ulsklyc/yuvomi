/**
 * Modul: Einkaufslisten (Shopping)
 * Zweck: Multi-Listen-Tabs, Artikel mit Kategorie-Gruppierung, Quick-Add mit Autocomplete
 * Abhängigkeiten: /api.js
 */

import { api } from '/api.js';
import { stagger, vibrate, scheduleUndoableDelete } from '/utils/ux.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { promptModal, openModal, closeModal, confirmModal, reportFieldError } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { addLocalDays, todayKey } from '/utils/date.js';
import { renderKitchenTabsBar, refreshKitchenBadges } from '/utils/kitchen-tabs.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { popoverMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import '/components/category-manager.js';
import { findPageFab } from '/utils/fab.js';
import { setBulkPill, clearBulkPill, bulkPillLayer } from '/utils/bulk-pill.js';
import { makeSortable } from '/utils/sortable.js';
import { amountPlaceholder, centsToAmountInput, amountInputToCents, toDecimalString } from '/utils/money.js';


// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

/** Icon für eine Kategorie (aus state.categories, Fallback 'tag'). */
function catIcon(name) {
  return state.categories.find((c) => c.name === name)?.icon ?? 'tag';
}

/** Kategorienamen in DB-Reihenfolge. */
function categoryNames() {
  return state.categories.map((c) => c.name);
}

// --------------------------------------------------------
// State
// --------------------------------------------------------

const state = {
  lists:         [],
  activeListId:  null,
  items:         [],
  activeList:    null,
  categories:    [],   // { id, name, icon, sort_order }[]
  stores:        [],   // verwaltete Laeden fuer den Preis am Artikel (#1003)
  currency:      'EUR',// Haushaltswaehrung, nur fuer die Preisdarstellung
  /** Zwei getrennte Ladewege, zwei getrennte Fehler - sie haben verschiedene
   *  Wiederholungen: die Listen holt die ganze Seite neu, die Artikel nur die
   *  aktive Liste. Ein gemeinsames Feld hätte den einen Fehler mit der
   *  Wiederholung des anderen bedient. */
  listsError:    null,
  itemsError:    null,
  /** Wer gerade angemeldet ist - der Einklapp-Zustand der Kategorien ist pro
   *  Haushaltsmitglied gespeichert (#1039), nicht geteilt wie sonst nichts in
   *  diesem Modul: zwei Personen am selben Geraet sollen sich nicht gegenseitig
   *  die Gruppen zu- oder aufklappen. */
  currentUserId: null,
  /** Eingeklappte Kategorien der AKTIVEN Liste, als Menge stabiler Schluessel
   *  (siehe categoryStorageKey). Nur das Eingeklappte wird gespeichert - eine
   *  neu angelegte Kategorie ist damit ohne Zutun aufgeklappt (dieselbe Regel
   *  wie bei den Aufgaben-Gruppen, #812). */
  collapsedCategories: new Set(),
};

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function groupItemsByCategory(items) {
  const grouped = {};
  for (const item of items) {
    const cat = item.category || (state.categories[0]?.name ?? DEFAULT_CATEGORY_NAME);
    (grouped[cat] = grouped[cat] || []).push(item);
  }
  // In DB-Reihenfolge zurückgeben; unbekannte Kategorien ans Ende
  const names   = categoryNames();
  const known   = names.filter((c) => grouped[c]).map((c) => [c, grouped[c]]);
  const unknown = Object.keys(grouped).filter((c) => !names.includes(c)).map((c) => [c, grouped[c]]);
  return [...known, ...unknown];
}

// --------------------------------------------------------
// Kategorie-Einklappen (#1039)
//
// GESPEICHERT WIRD PRO HAUSHALTSMITGLIED UND PRO LISTE, NICHT GETEILT: anders
// als die Aufgaben-Gruppen (eine einzige, ungescopte localStorage-Zeile, #812)
// hat der Einkauf mehrere Listen UND mehrere Nutzer desselben Geraets - eine
// geteilte Zeile haette „Moabit" und „Neukoelln" dieselbe Klapp-Ansicht
// aufgezwungen und einem zweiten Haushaltsmitglied die Gruppen des ersten
// zugeklappt vorgesetzt.
//
// GESPEICHERT WIRD NUR DIE STABILE ID, NICHT DER NAME: eine Kategorie-
// Umbenennung darf den Klapp-Zustand nicht verlieren. Nur Kategorien ohne ID
// (geloescht, oder Altbestand vor der Kategorie-Verwaltung) fallen auf den
// normalisierten Namen zurueck - das einzige, was sie stabil identifiziert.
// --------------------------------------------------------

const COLLAPSED_CATEGORIES_VERSION = 1;

function collapsedCategoriesStorageKey(userId, listId) {
  return `yuvomi:shopping:collapsedCategories:v${COLLAPSED_CATEGORIES_VERSION}:${userId ?? 'anon'}:${listId}`;
}

/** Stabiler Speicherschluessel einer Kategorie: ID wenn bekannt, sonst normalisierter Name. */
function categoryStorageKey(name) {
  const known = state.categories.find((c) => c.name === name);
  return known ? `id:${known.id}` : `name:${String(name ?? '').trim().toLowerCase()}`;
}

function loadCollapsedCategories(userId, listId) {
  try {
    const raw = JSON.parse(localStorage.getItem(collapsedCategoriesStorageKey(userId, listId)) ?? 'null');
    if (!raw || raw.version !== COLLAPSED_CATEGORIES_VERSION || !Array.isArray(raw.collapsed)) {
      return new Set();
    }
    return new Set(raw.collapsed.filter((key) => typeof key === 'string'));
  } catch {
    // Privatmodus/kaputtes JSON/Quota: die Gruppen starten dann offen, statt
    // die Seite an einem defekten Speicherwert scheitern zu lassen.
    return new Set();
  }
}

function saveCollapsedCategories(userId, listId, collapsedSet) {
  try {
    localStorage.setItem(
      collapsedCategoriesStorageKey(userId, listId),
      JSON.stringify({ version: COLLAPSED_CATEGORIES_VERSION, collapsed: [...collapsedSet] }),
    );
  } catch { /* Privatmodus/Quota: der Zustand gilt dann nur fuer diese Sitzung */ }
}

/**
 * Entfernt Schluessel, die zu keiner der GERADE gerenderten Gruppen mehr
 * gehoeren (geloeschte Kategorie, oder die letzte Zeile einer unbekannten
 * Kategorie ist weg). Laeuft erst, NACHDEM Listen- und Kategorie-Metadaten
 * vollstaendig geladen sind - vorher liesse sich „gehoert nicht mehr dazu"
 * nicht von „ist nur noch nicht geladen" unterscheiden.
 */
function pruneCollapsedCategories(groups) {
  const validKeys = new Set(groups.map(([cat]) => categoryStorageKey(cat)));
  let changed = false;
  for (const key of [...state.collapsedCategories]) {
    if (!validKeys.has(key)) {
      state.collapsedCategories.delete(key);
      changed = true;
    }
  }
  if (changed) saveCollapsedCategories(state.currentUserId, state.activeListId, state.collapsedCategories);
}

/** Klappt eine Kategorie in-place um (kein Listen-Rerender, siehe renderItems). */
function toggleCategoryCollapse(button) {
  const key = button.dataset.categoryToggle;
  const rowsEl = button.closest('.list-group')?.querySelector('.list-rows');
  const chevron = button.querySelector('.list-group__chevron');
  const nowCollapsed = !state.collapsedCategories.has(key);

  if (nowCollapsed) state.collapsedCategories.add(key);
  else state.collapsedCategories.delete(key);

  button.setAttribute('aria-expanded', String(!nowCollapsed));
  chevron?.classList.toggle('list-group__chevron--collapsed', nowCollapsed);
  if (rowsEl) rowsEl.hidden = nowCollapsed;

  saveCollapsedCategories(state.currentUserId, state.activeListId, state.collapsedCategories);
}

function shouldIgnoreShoppingRowToggle(target) {
  return Boolean(target?.closest?.('button, a, input, select, textarea, [data-no-row-toggle]'));
}

// --------------------------------------------------------
// Sammelaktions-Pille: Zustandsautomat (#1039)
//
// VORHER rief updateCheckedActions() bei JEDEM Aufruf setBulkPill() auf,
// solange irgendein Artikel abgehakt war - die Pille blieb dadurch dauerhaft
// stehen, sobald beim Laden schon etwas abgehakt war, und nahm der Liste einen
// Streifen Flaeche fuer eine Rueckmeldung, die zur einzelnen Abhak-Handlung
// gehoert, nicht zum Ladezustand.
//
// JETZT vier Zustaende:
//   idle       - nichts abgehakt (der naechste Treffer eroeffnet einen Batch)
//   visible    - Pille steht, Fuenf-Sekunden-Frist laeuft
//   deferred   - Frist abgelaufen, aber Zeiger/Tastatur stehen noch auf der
//                Pille; sie verschwindet erst, wenn die Interaktion endet
//   suppressed - Frist (oder deferred-Interaktion) ist zu Ende, der Batch
//                bleibt aber > 0: dieselbe Teilmenge zeigt die Pille nicht
//                erneut, bis sie auf 0 faellt
//
// GENERATION UND `container.isConnected` STATT EINES ROUTER-HOOKS: die Seite
// hat keinen Teardown-Callback - switchList()/render() ersetzen den Inhalt
// einfach. Ein gestellter Timer wuerde ohne Gegenmassnahme nach einem
// Listenwechsel oder einer Navigation noch feuern und setBulkPill()/
// clearBulkPill() auf der SHELL-Schicht ausloesen, die ueber die Seite hinaus
// lebt - sichtbar als eine fremde Pille (Pantry/Kontakte teilen dieselbe
// Schicht), die ploetzlich verschwindet. Jeder Timer traegt die Generation,
// unter der er entstand, und prueft sie plus die Verbindung seiner Wurzel zum
// Dokument, bevor er etwas anfasst.
// --------------------------------------------------------

let BULK_PILL_HOLD_MS_OVERRIDE = null; // nur fuer Tests, siehe __test unten
const BULK_PILL_HOLD_MS = 5000;

let pillTimer = null;
let pillPhase = 'idle'; // 'idle' | 'visible' | 'deferred' | 'suppressed'
let pillInteracting = false;
/** Die Seiten-Wurzel, der der aktuell sichtbare Batch gehoert - siehe unten. */
let pillOwnerContainer = null;

function clearPillTimer() {
  if (pillTimer) { clearTimeout(pillTimer); pillTimer = null; }
}

function schedulePillHide(container) {
  clearPillTimer();
  pillTimer = setTimeout(() => {
    pillTimer = null;
    // Verlassene Seite: die Wurzel haengt nicht mehr im Dokument (der Router
    // hat sie beim Navigieren ersetzt). `resetPillMachine()` raeumt jeden
    // Listenwechsel/Seitenaufbau selbst per `clearPillTimer()` auf, deshalb
    // genuegt hier die Verbindung zum Dokument als einzige Pruefung.
    if (!container.isConnected) return;
    if (pillInteracting) { pillPhase = 'deferred'; return; }
    pillPhase = 'suppressed';
    clearBulkPill();
  }, BULK_PILL_HOLD_MS_OVERRIDE ?? BULK_PILL_HOLD_MS);
}

/**
 * Haengt Hover/Fokus-Beobachtung einmalig an die geteilte Pillen-Schicht - sie
 * lebt app-weit, der Aufruf ist deshalb idempotent (dataset-Flag) statt an
 * einen bestimmten Seitenbesuch gebunden.
 */
function wirePillInteractionGuards() {
  const layer = bulkPillLayer();
  if (!layer || layer.dataset.shoppingPillWired) return;
  layer.dataset.shoppingPillWired = '1';

  layer.addEventListener('mouseenter', () => { pillInteracting = true; });
  layer.addEventListener('focusin', () => { pillInteracting = true; });

  const endInteraction = () => {
    pillInteracting = false;
    if (pillPhase !== 'deferred') return;
    pillPhase = 'suppressed';
    // Diese Schicht ist GETEILT (Pantry/Kontakte zeigen hier ihre eigene
    // Pille) und der Listener bleibt app-weit bestehen, auch nachdem der
    // Einkauf laengst verlassen wurde - ohne die Eigentuems-Pruefung wuerde
    // ein Maus-Verlassen auf einer FREMDEN, gerade sichtbaren Pille sie
    // versehentlich loeschen, nur weil `pillPhase` hier zufaellig noch
    // 'deferred' vom letzten Einkaufsbesuch war.
    if (pillOwnerContainer?.isConnected) clearBulkPill();
  };
  layer.addEventListener('mouseleave', endInteraction);
  layer.addEventListener('focusout', (e) => {
    if (layer.contains(e.relatedTarget)) return; // Fokus bleibt innerhalb der Pille
    endInteraction();
  });
}

/** Setzt den Automaten zurueck - bei Listenwechsel und bei jedem Rendern der Seite. */
function resetPillMachine() {
  clearPillTimer();
  pillPhase = 'idle';
  pillInteracting = false;
  pillOwnerContainer = null;
}

async function toggleShoppingItem(id, checked, container) {
  const newVal = checked ? 0 : 1;

  const item = state.items.find((i) => i.id === id);
  if (item) {
    item.is_checked = newVal;
    // Nur die betroffene Zeile aktualisieren — kein Komplett-Re-Render,
    // damit die Scroll-Position der Liste erhalten bleibt (Issue #276).
    updateItemRow(container, item);
    // userChecked NUR beim Abhaken selbst (#1039): das Zurueckholen eines
    // Artikels eroeffnet keinen neuen Feedback-Batch.
    updateCheckedActions(container, { userChecked: newVal === 1 });
    updateListCounter(state.activeListId, 0, newVal ? 1 : -1);
    renderTabs(container);
  }

  try {
    await api.patch(`/shopping/items/${id}`, { is_checked: newVal });
    vibrate(10);
  } catch (err) {
    if (item) {
      item.is_checked = checked;
      updateItemRow(container, item);
      updateCheckedActions(container);
      updateListCounter(state.activeListId, 0, newVal ? -1 : 1);
      renderTabs(container);
    }
    window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * Löschen eines Artikels, fünf Sekunden lang widerrufbar: die Zeile geht sofort,
 * der Server-Delete erst nach Ablauf des Fensters (`scheduleUndoableDelete`).
 *
 * Benannt und geteilt, weil das Löschen in dieser Liste über ZWEI Wege geht -
 * den Knopf in der Zeile und die Wischgeste. Als Kopie nebeneinander lief das
 * auseinander: der Knopf hatte den Rückweg, der Wisch rief `api.delete` direkt
 * und löschte sofort und endgültig. Das war die einzige Stelle der App, an der
 * eine Geste unwiderruflich Daten entfernt - wer sie in Aufgaben und
 * Geburtstagen als harmlos gelernt hat, verlor hier ohne Rückweg.
 */
function deleteItemUndoable(id, container) {
  const item     = state.items.find((i) => i.id === id);
  const snapshot = item ? { ...item } : null;
  // DIE LISTE GEHOERT ZUR AKTION, NICHT ZUM ZEITPUNKT DER RUECKNAHME. Das
  // Undo-Fenster ist fuenf Sekunden lang, und ein Listenwechsel darin tauscht
  // `state.items` samt `state.activeListId` aus. Wer danach zurueckholte, legte
  // den Artikel in die FALSCHE Liste und zaehlte deren Zaehler hoch. Steht so
  // schon seit dem Knopf; mit dem Wisch daneben ist es nur viel leichter zu
  // treffen.
  const listId = state.activeListId;

  // Optimistisch entfernen
  state.items = state.items.filter((i) => i.id !== id);
  updateItemsList(container);
  updateListCounter(listId, -1, snapshot?.is_checked ? -1 : 0);
  renderTabs(container);

  scheduleUndoableDelete({
    message: t('shopping.itemDeletedToast', { name: snapshot?.name ?? '' }),
    commit: ({ keepalive }) => api.delete(`/shopping/items/${id}`, { keepalive }),
    restore: (err) => {
      if (snapshot) {
        // Der sichtbare Zustand nur, wenn die Liste noch die gezeigte ist -
        // sonst gehoert `state.items` bereits einer anderen. Der Server hat
        // nichts geloescht, also bringt `switchList` den Artikel beim
        // Zurueckwechseln ohnehin mit.
        if (state.activeListId === listId) {
          state.items.push(snapshot);
          state.items.sort((a, b) => a.id - b.id);
          updateItemsList(container);
        }
        updateListCounter(listId, 1, snapshot.is_checked ? 1 : 0);
        renderTabs(container);
      }
      if (err) window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    },
  });
}

// --------------------------------------------------------
// Render-Bausteine
// --------------------------------------------------------

function renderTabs(container) {
  const bar = container.querySelector('#list-tabs-bar');
  if (!bar) return;

  const tabsHtml = state.lists.map((list) => {
    const unchecked = list.item_total - list.item_checked;
    // Der Zähler ist aria-hidden, sonst klebt er am Buttonnamen („Einkauf23");
    // die Ansage steht als aria-label auf dem Tab selbst - dasselbe Muster wie
    // setSubTabBadge. „0 offene Artikel" deckt auch den ✓-Zustand ehrlich ab.
    return `
      <button class="list-tab ${list.id === state.activeListId ? 'list-tab--active' : ''}"
              data-action="switch-list" data-id="${list.id}"
              ${list.item_total > 0 ? `aria-label="${esc(list.name)}, ${esc(t('nav.shoppingOpen', { count: unchecked }))}"` : ''}>
        ${esc(list.name)}
        ${list.item_total > 0 ? `<span class="list-tab__count" aria-hidden="true">${unchecked > 0 ? unchecked : '✓'}</span>` : ''}
      </button>`;
  }).join('');

  bar.replaceChildren();
  // Führender Listen-Marker: signalisiert „das hier sind Listen" und grenzt die
  // Leiste sichtbar von den Küchen-Modul-Tabs darüber ab (dekorativ, aria-hidden).
  //
  // Am hinteren Ende die Aktionen der GEWÄHLTEN Liste. Sie standen bis 2026-08-11
  // in einem eigenen Kopf darunter, der den Namen der aktiven Liste ein zweites
  // Mal zeigte - der aktive Chip trägt ihn schon (Keine-sichtbare-
  // Titelwiederholung-Regel, DESIGN.md). Der Chip IST der Titel; was der Kopf
  // sonst noch trug, ist genau dieses Menü.
  //
  // Der Trigger klebt am rechten Rand (sticky), während die Chips darunter
  // durchscrollen - das Gegenstück zum Marker links. Sein Panel läuft über die
  // native Popover-API im Top-Layer und wird deshalb vom `overflow-x: auto`
  // dieser Leiste nicht geclippt; ein absolut positioniertes Eigenbau-Menü wäre
  // hier abgeschnitten worden.
  const actionsHtml = state.activeList ? `
    <div class="list-tabs-bar__actions">
      ${popoverMenuHtml({
        id: 'list-actions-menu',
        // Der Name muss die Liste nennen: der Trigger steht nicht mehr neben
        // einer Überschrift, die den Bezug herstellt. „Mehr" allein ließe offen,
        // worauf sich „Löschen" bezieht - und das löscht die Liste des Haushalts.
        label: t('shopping.listActionsLabel', { name: state.activeList.name }),
        items: [
          { action: 'rename-list', label: t('shopping.renameListLabel'), icon: 'pencil', id: state.activeList.id },
          { action: 'import-meals', label: t('shopping.importMeals'), icon: 'utensils' },
          { action: 'send-list', label: t('shopping.sendList'), icon: 'mail' },
          { action: 'manage-categories', label: t('shopping.manageCategories'), icon: 'tags' },
          { action: 'manage-stores', label: t('shopping.manageStores'), icon: 'store' },
          { action: 'delete-list', label: t('shopping.deleteListLabel'), icon: 'trash', id: state.activeList.id, danger: true },
        ],
      })}
    </div>` : '';

  bar.insertAdjacentHTML('beforeend', `
    <i data-lucide="list" class="list-tabs-bar__marker" aria-hidden="true"></i>
    ${tabsHtml}
    <button class="list-tab__new" data-action="new-list" aria-label="${t('shopping.newListButton')}">
      <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
    </button>
    ${actionsHtml}
  `);
  if (window.lucide) window.lucide.createIcons({ el: bar });
}

/**
 * Die offene Liste an ein Haushaltsmitglied mailen (#944).
 *
 * ABSCHRIFT, KEIN ZUGANG. Der Dialog sagt beides: wie viele Artikel mitgehen
 * und dass es eine Momentaufnahme ist. Wer im Laden steht, haekelt nicht mit -
 * die Mail kann von spaeteren Aenderungen nichts wissen, und der Absender soll
 * das vorher lesen, nicht hinterher merken.
 *
 * Die Auswahl kennt nur Mitglieder MIT hinterlegter Adresse. Ein Name, den man
 * anklicken kann und der dann scheitert, ist eine Zusage, die nicht haelt; die
 * Route lehnt denselben Fall ohnehin ab, aber sie ist die zweite Verteidigung,
 * nicht die erste.
 */
async function openSendListDialog(container) {
  const listId = state.activeListId;
  const openCount = state.items.filter((item) => !item.is_checked).length;
  if (!openCount) {
    window.yuvomi.showToast(t('shopping.sendListEmpty'), 'warning');
    return;
  }

  let members = [];
  try {
    // Nicht `/family/members`: der zeigt alle Konten ausser Hauspersonal, also
    // auch Geteilte-Ausgaben-Gaeste, die Externe sind. Dieser Endpunkt fragt
    // dieselbe Funktion wie die Versandroute, damit die Auswahl niemanden
    // anbietet, den der Server ablehnt - und umgekehrt.
    //
    // Sich selbst einzuschliessen ist Absicht: "schick mir die Liste aufs
    // Handy" ist derselbe Wunsch wie "schick sie meiner Mutter", und wer sie
    // sich selbst schickt, bekommt den Absendersatz nicht vorgesetzt (die
    // Route laesst ihn dann weg).
    const res = await api.get('/shopping/send-recipients');
    members = res.data || [];
  } catch {
    window.yuvomi.showToast(t('common.errorGeneric'), 'danger');
    return;
  }

  // WAEHREND DES LADENS KANN DIE LISTE GEWECHSELT HABEN. Der Dialog haelt
  // `listId` und die Artikelzahl von vorhin fest, sagt aber nirgends, welche
  // Liste er meint - er wuerde also die alte verschicken, waehrend auf dem
  // Bildschirm die neue steht. Bei etwas, das sich nicht zuruecknehmen laesst,
  // ist das der teuerste Fehler dieser Funktion.
  if (state.activeListId !== listId) return;

  if (!members.length) {
    window.yuvomi.showToast(t('shopping.sendListNoRecipients'), 'warning');
    return;
  }

  openModal({
    title: t('shopping.sendListTitle'),
    content: `
      <p class="form-hint">${esc(t('shopping.sendListDescription', { count: openCount }))}</p>
      <div class="form-group">
        <label class="form-label" for="send-list-recipient">${esc(t('shopping.sendListRecipient'))}</label>
        <select id="send-list-recipient" class="form-input">
          ${members.map((m) => `<option value="${m.id}">${esc(m.display_name)}</option>`).join('')}
        </select>
      </div>
      <p class="form-hint">${esc(t('shopping.sendListSnapshotHint'))}</p>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="send-list-confirm">${esc(t('shopping.sendListSubmit'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#send-list-confirm').addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        const select = panel.querySelector('#send-list-recipient');
        const userId = Number(select.value);
        const name = members.find((m) => m.id === userId)?.display_name ?? '';
        btn.disabled = true;
        try {
          await api.post(`/shopping/${listId}/send`, { userId });
          closeModal({ force: true });
          // BEWUSST KEIN success-Toast. Die Erfolgsmeldungen der App sind nach
          // 50 Bestaetigungen dauerhaft stummgeschaltet (`TOAST_SUCCESS_MAX` in
          // router.js) - richtig fuer Handlungen, deren Ergebnis auf dem
          // Bildschirm steht und die man taeglich wiederholt. Ein Mailversand
          // ist das Gegenteil: er passiert selten, laesst sich nicht
          // zuruecknehmen, und sein Ergebnis liegt in einem fremden Postfach.
          // Wer hier nichts sieht, weiss nicht, ob die Liste unterwegs ist.
          window.yuvomi.showToast(t('shopping.sendListSent', { name }), 'info');
        } catch (err) {
          // Der Server nennt seinen Grund maschinenlesbar mit, damit die drei
          // Absagen hier in der Sprache der Oberflaeche stehen koennen. Sein
          // Meldungstext bleibt der Rueckfall fuer alles Unerwartete - er ist
          // englisch wie jede Server-Meldung, aber besser als "ging nicht".
          const byReason = {
            recipient_no_email: 'shopping.sendListRecipientNoEmail',
            smtp_unconfigured: 'shopping.sendListSmtpMissing',
            nothing_open: 'shopping.sendListEmpty',
          }[err.data?.reason];
          window.yuvomi.showToast(
            byReason ? t(byReason) : (err.data?.error ?? t('shopping.sendListError')),
            'danger',
          );
          btn.disabled = false;
        }
      });
    },
  });
}

function renderListContent(container) {
  const content = container.querySelector('#list-content');
  if (!content) return;
  content.removeAttribute('aria-busy');

  // Listen nicht ladbar: Fehlerzustand statt Leerzustand. Muss VOR der
  // `!state.activeList`-Prüfung stehen - ohne geladene Listen ist auch keine
  // aktiv, und der Leerzustand darunter hätte „Keine Listen" behauptet und mit
  // „Neue Liste erstellen" ausgerechnet eine schreibende Handlung als einzigen
  // Ausweg angeboten (Critique P0, 2026-07-30).
  if (state.listsError) {
    mountLoadError(content, {
      title: t('shopping.listsLoadError'),
      description: t('common.loadErrorDescription'),
      error: state.listsError,
      retryLabel: t('common.retry'),
      onRetry: () => render(container, {}),
    });
    return;
  }

  if (!state.activeList) {
    // Ohne aktive Liste gibt es nichts zu benennen: renderTabs lässt die
    // Aktionszone der Leiste dann weg, statt vier tote Menü-Einträge zu zeigen.
    // Geteilter Renderer (utils/empty-state.js), damit dieser Zustand dieselbe
    // Reihenfolge und Rolle trägt wie die drei Geschwister-Tabs.
    mountEmptyState(content, {
      icon: 'shopping-cart',
      title: t('shopping.noLists'),
      description: t('shopping.noListsDescription'),
      // Nennt die EINGEHENDE Station des Kreislaufs (der Essensplan füllt die
      // Liste) - wie der Vorrat, dessen Hinweis auf den Einkauf zeigt. Dieser
      // Zustand war der einzige der vier ohne Hinweis (Critique 2026-07-29).
      hint: t('shopping.noListsHint'),
      action: {
        label: t('shopping.newListButton'),
        icon: 'plus',
        onClick: () => container.querySelector('[data-action="new-list"]')?.click(),
      },
    });
    return;
  }

  content.replaceChildren();
  content.insertAdjacentHTML('beforeend', `
    <!-- Quick-Add -->
    <div class="quick-add">
      <form class="quick-add__form" id="quick-add-form" novalidate autocomplete="off">
        <div class="quick-add__input-wrap">
          <input class="quick-add__input" type="text" id="item-name-input"
                 placeholder="${t('shopping.itemNamePlaceholder')}" aria-label="${t('shopping.itemNameLabel')}" autocomplete="off">
          <div class="autocomplete-dropdown" id="autocomplete-dropdown" hidden></div>
        </div>
        <input class="quick-add__qty" type="text" id="item-qty-input"
               placeholder="${t('shopping.itemQtyPlaceholder')}" aria-label="${t('shopping.itemQtyLabel')}" autocomplete="off">
        <select class="quick-add__cat" id="item-cat-select" aria-label="${t('shopping.categoryLabel')}">
          ${state.categories.map((c) => `<option value="${esc(c.name)}" ${c.name === DEFAULT_CATEGORY_NAME ? 'selected' : ''}>${esc(categoryLabel(c.name))}</option>`).join('')}
        </select>
        <button class="quick-add__btn" type="submit" aria-label="${t('shopping.addItemLabel')}">
          <i data-lucide="plus" class="icon-lg" aria-hidden="true"></i>
        </button>
      </form>
    </div>

    <!-- Die Sammelaktions-Leiste stand hier als statischer Block über der
         Liste. Seit Etappe 5 ist sie eine Pille in der unteren Shell-Zone
         (utils/bulk-pill.js) - der Grund steht dort und an .list-bulkbar in
         layout.css: 103px Listenfläche für einen einzigen abgehakten Artikel.
         Die alte Begründung („Geschwister der Liste, nicht Kind: mountItems()
         leert #items-list") ist damit erledigt statt umgezogen - was gar nicht
         mehr in dieser Seite hängt, kann von ihrem Rendern nicht getroffen
         werden. -->

    <!-- Artikel-Liste; Inhalt via mountItems(), damit der Leerzustand über den
         geteilten Renderer läuft statt als HTML-String hier drin. -->
    <div class="list-scroller page-scrollport items-list" id="items-list"></div>

    <!-- Ansage für Umsortierungen (#678), wie im Kategorie-Manager: das
         aria-label des Griffs allein ist zu leise - ob ein Screenreader die
         Label-Änderung am fokussierten Element vorliest, ist von Programm zu
         Programm verschieden. Eine Live-Region ist die verlässliche Zusage. -->
    <div class="sr-only" role="status" aria-live="polite" id="items-reorder-announce"></div>
  `);

  // Der Listenteil kommt aus updateItemsList - mountItems, Stagger,
  // Wischgesten, Sortierung und die Sammelaktions-Leiste, die erst dann
  // feststeht, wenn die abgehakten Artikel im DOM stehen.
  //
  // NICHT ein zweites Mal aufgezählt: die Aufzählung stand hier neben der in
  // updateItemsList und hatte genau einen Schritt verloren. `wireSwipeGestures`
  // lief nur im Nachlade-Pfad, also erst, wenn die Liste ein ZWEITES Mal gebaut
  // wurde - beim ersten Öffnen der Seite antwortete keine Zeile auf die Geste.
  // Der Aufruf stand seit dem Tag falsch, an dem die Geste eingeführt wurde.
  updateItemsList(container);

  // Für den ganzen Inhalt, nicht nur die Liste: Quick-Add und Kopfzeile tragen
  // eigene Icons. Der Lauf in updateItemsList hat die Zeilen schon ersetzt.
  if (window.lucide) window.lucide.createIcons({ el: content });
  wireAutocomplete(container);
  wireQuickAdd(container);
  syncQuickAddDisclosure(container, false);
}

/**
 * Füllt den Artikel-Container: entweder Kategorie-Gruppen oder den
 * Leerzustand über den geteilten Renderer.
 *
 * Der Leerzustand lag vorher als HTML-String in `renderItems()` und trug als
 * einziger im Modul ein handgezeichnetes Inline-SVG statt eines Lucide-Icons -
 * dieselbe Warenkorb-Form, nur mit eigener Strichstärke (Critique 2026-07-29).
 */
function mountItems(listEl, container) {
  if (!listEl) return;

  // Artikel nicht ladbar: eigener Fehler mit eigener Wiederholung. Die Liste
  // existiert und ist im Kopf benannt - nur ihr Inhalt fehlt, also lädt der
  // Retry auch nur diese eine Liste nach.
  if (state.itemsError) {
    mountLoadError(listEl, {
      title: t('shopping.itemsLoadError'),
      description: t('common.loadErrorDescription'),
      error: state.itemsError,
      retryLabel: t('common.retry'),
      onRetry: container
        ? () => switchList(state.activeListId, container)
        : undefined,
    });
    return;
  }

  if (!state.items.length) {
    mountEmptyState(listEl, {
      icon: 'shopping-cart',
      title: t('shopping.emptyList'),
      description: t('shopping.emptyListDescription'),
      hint: t('emptyHint.shopping'),
      action: {
        label: t('shopping.emptyAction'),
        icon: 'plus',
        onClick: () => document.querySelector('.page-fab')?.click(),
      },
    });
    return;
  }

  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', renderItems());
}

function renderItems() {
  const groups = groupItemsByCategory(state.items);
  pruneCollapsedCategories(groups);
  // Geteilte Gruppen-Grammatik (styles/list-row.css): .list-group ordnet,
  // .list-rows trägt die weiße Fläche und die Trennlinien. Die Zeilen selbst
  // sind flächenlos - vorher war Einkaufen eine Trennlinien-Liste und der Vorrat
  // eine Kartenliste, dieselbe Sache in zwei Paradigmen (Critique 2026-07-30).
  //
  // Gruppenkopf als echter Knopf im h2 (#1039, Muster aus tasks.js/#812): nur
  // ein <button> kennt die Tastatur und traegt aria-expanded ueberhaupt. Die
  // Zeilen (.list-rows) bleiben bei [hidden] im DOM - ein Rerender wuerde
  // Sortable-Instanzen und Swipe-Closures verwerfen, nur um eine Gruppe
  // zuzuklappen.
  return groups.map(([cat, items], idx) => {
    const key = categoryStorageKey(cat);
    const collapsed = state.collapsedCategories.has(key);
    const rowsId = `shopping-category-rows-${idx}`;
    return `
    <div class="list-group item-category" data-category="${esc(cat)}">
      <h2 class="list-group__title">
        <button type="button" class="list-group__toggle" data-category-toggle="${esc(key)}"
                aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${rowsId}">
          <i data-lucide="chevron-down" aria-hidden="true"
             class="list-group__chevron${collapsed ? ' list-group__chevron--collapsed' : ''}"></i>
          <i data-lucide="${catIcon(cat)}" class="icon-sm" aria-hidden="true"></i>
          <span>${esc(categoryLabel(cat))}</span>
        </button>
        <span class="list-group__count">${items.length}</span>
      </h2>
      <div class="list-rows" id="${rowsId}" ${collapsed ? 'hidden' : ''}>
        ${items.map(renderItem).join('')}
      </div>
    </div>`;
  }).join('');
}

/**
 * Dezente Inline-Indikatoren (Progressive Disclosure): zeigen an, dass ein
 * Artikel zusätzliche Details (Link/Notiz) trägt, ohne die Zeile zu überladen.
 * Rein visuell (aria-hidden) — der Zugang läuft über den beschrifteten Details-Button.
 */
function renderItemMeta(item) {
  const bits = [];
  if (item.url)   bits.push('<i data-lucide="link" class="item-meta__icon" aria-hidden="true"></i>');
  if (item.notes) bits.push('<i data-lucide="sticky-note" class="item-meta__icon" aria-hidden="true"></i>');
  return bits.length ? `<span class="item-meta">${bits.join('')}</span>` : '';
}

// Wie viele Tags eine Zeile zeigt, bevor sie zusammenfasst - wie auf den
// Aufgabenkarten, die am 12.08.2026 aus demselben Grund von drei auf EINEN
// gegangen sind: die Etiketten standen dort in einer Metazeile, die umbrach,
// hier auf einer dritten Zeile. Beides macht aus einer 64px-Zeile eine mit 91.
const ITEM_TAGS_VISIBLE = 1;

/**
 * Gespiegelte VTODO-CATEGORIES eines Einkaufspostens (#586).
 *
 * Anzeige, keine Bedienung: die Etiketten gehören der CalDAV-Quellliste, Yuvomi
 * verwaltet sie hier nicht und schreibt sie auch nicht zurück. Deshalb <span>
 * statt Button - anders als in den Aufgaben, wo ein Klick danach filtert.
 */
function renderItemTags(tags) {
  if (!tags?.length) return '';
  const shown = tags.slice(0, ITEM_TAGS_VISIBLE);
  const rest  = tags.length - shown.length;
  const chips = shown.map((tag) => `<span class="list-row__tag">${esc(tag)}</span>`);
  if (rest > 0) {
    chips.push(`<span class="list-row__tag list-row__tag--more"
                      title="${esc(tags.slice(ITEM_TAGS_VISIBLE).join(', '))}">+${rest}</span>`);
  }
  // KEIN eigener Block mehr: die Etiketten stehen in der Metazeile neben der
  // Menge, nicht als dritte Zeile darunter. Als Block kosteten sie 27px in
  // jeder Zeile, die welche hat - gemessen 90,9px gegen 64px, und das war die
  // ganze Streuung des Einkaufs.
  return chips.join('');
}

function renderItem(item) {
  const isDone = Boolean(item.is_checked);
  return `
    <div class="swipe-row" data-swipe-id="${item.id}" data-swipe-checked="${item.is_checked}">
      <div class="swipe-reveal swipe-reveal--done swipe-reveal--leading" aria-hidden="true">
        <i data-lucide="${isDone ? 'rotate-ccw' : 'check'}" class="icon-xl" aria-hidden="true"></i>
        <span>${isDone ? t('shopping.swipeBack') : t('shopping.swipeCheck')}</span>
      </div>
      <div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">
        <i data-lucide="trash-2" class="icon-xl" aria-hidden="true"></i>
        <span>${t('shopping.swipeDelete')}</span>
      </div>
      <div class="list-row shopping-item ${isDone ? 'shopping-item--checked' : ''}"
           data-item-id="${item.id}">
        <button class="item-check ${isDone ? 'item-check--checked' : ''}"
                data-action="toggle-item" data-id="${item.id}" data-checked="${item.is_checked}"
                aria-label="${isDone ? t('shopping.markUndoneLabel', { name: esc(item.name) }) : t('shopping.markDoneLabel', { name: esc(item.name) })}">
          <i data-lucide="check" class="item-check__icon" aria-hidden="true"></i>
        </button>
        <div class="list-row__main">
          <div class="list-row__name">${esc(item.name)}${renderItemMeta(item)}</div>
          ${item.quantity || item.tags?.length ? `<div class="list-row__meta">
            ${item.quantity ? `<span class="shopping-item__quantity">${esc(item.quantity)}</span>` : ''}
            ${renderItemTags(item.tags)}
          </div>` : ''}
        </div>
        <!-- Geteilte .row-action-Grammatik aus layout.css (app-weit von sieben
             Modulen genutzt), gruppiert in der geteilten .list-row__actions -
             vorher hingen die zwei Buttons als direkte Flex-Kinder in der Zeile,
             wodurch die Bedienzone in jedem Tab anders zusammengesetzt war. -->
        <div class="list-row__actions">
          <!-- Griff für die Handsortierung (#678). Ein BUTTON, kein role="img"
               wie im Kategorie-Manager: dort steht daneben ein Auf/Ab-Paar als
               Tastaturpfad, hier trägt der Griff ihn selbst (Pfeiltasten bei
               Fokus). Die Einkaufszeile hat schon Abhaken, Details, Löschen und
               zwei Wischgesten - zwei weitere Knöpfe hätten die Bedienzone auf
               dem Handy zugestellt. -->
          <button class="row-action list-row__drag" data-action="reorder-handle" data-id="${item.id}"
                  aria-label="${t('shopping.reorderHandle', { name: esc(item.name) })}"
                  title="${t('shopping.reorderHandleHint')}">
            <i data-lucide="grip-vertical" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="row-action" data-action="item-details" data-id="${item.id}"
                  aria-label="${t('shopping.detailsLabel', { name: esc(item.name) })}">
            <i data-lucide="pencil" class="icon-md" aria-hidden="true"></i>
          </button>
          <button class="row-action row-action--danger" data-action="delete-item" data-id="${item.id}"
                  aria-label="${t('shopping.deleteItemLabel', { name: esc(item.name) })}">
            ${/* trash-2 statt x: das Kreuz heisst app-weit „Schliessen"
                 (Modals, Chips), Loeschen traegt ueberall den Papierkorb
                 (Aufgaben, Geburtstage, Mahlzeiten). Der Einkauf war die eine
                 Zeile, die fuer dieselbe Tat ein anderes Zeichen sprach
                 (Critique 2026-08-27, P3). */ ''}
            <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>`;
}

// --------------------------------------------------------
// Autocomplete
// --------------------------------------------------------

let autocompleteTimeout = null;

function wireAutocomplete(container) {
  const input    = container.querySelector('#item-name-input');
  const dropdown = container.querySelector('#autocomplete-dropdown');
  if (!input || !dropdown) return;

  let activeIdx = -1;

  input.addEventListener('input', () => {
    clearTimeout(autocompleteTimeout);
    const q = input.value.trim();
    if (q.length < 1) { dropdown.hidden = true; return; }

    autocompleteTimeout = setTimeout(async () => {
      try {
        const data = await api.get(`/shopping/suggestions?q=${encodeURIComponent(q)}`);
        const suggestions = data.data ?? [];
        if (!suggestions.length) { dropdown.hidden = true; return; }

        dropdown.replaceChildren();
        dropdown.insertAdjacentHTML('beforeend', suggestions.map((s, i) =>
          `<div class="autocomplete-item" data-idx="${i}" data-value="${esc(s)}">${esc(s)}</div>`
        ).join(''));
        dropdown.hidden = false;
        activeIdx = -1;

        dropdown.querySelectorAll('.autocomplete-item').forEach((el) => {
          el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            input.value = el.dataset.value;
            dropdown.hidden = true;
          });
        });

        if (window.lucide) window.lucide.createIcons({ el: dropdown });
      } catch { dropdown.hidden = true; }
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden) return;
    const items = dropdown.querySelectorAll('.autocomplete-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('autocomplete-item--active', i === activeIdx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('autocomplete-item--active', i === activeIdx));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      input.value = items[activeIdx].dataset.value;
      dropdown.hidden = true;
    } else if (e.key === 'Escape') {
      dropdown.hidden = true;
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.hidden = true; }, 150);
  });
}

// --------------------------------------------------------
// Quick-Add Form
// --------------------------------------------------------

/**
 * Zeigt kurzes Checkmark-Feedback auf dem +-Button (700ms).
 * Verwendet DOM-API statt innerHTML um XSS-Risiken zu vermeiden.
 * @param {HTMLButtonElement|null} btn
 */
function _flashAddBtn(btn) {
  if (!btn) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('aria-hidden', 'true');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', '20 6 9 17 4 12');
  svg.appendChild(poly);

  const saved = [...btn.childNodes];
  btn.classList.add('btn--success');
  btn.replaceChildren(svg);
  setTimeout(() => {
    btn.classList.remove('btn--success');
    btn.replaceChildren(...saved);
    if (window.lucide) window.lucide.createIcons({ el: btn });
  }, 700);
}

// --------------------------------------------------------
// Quick-Add als Disclosure (nur Touch)
// --------------------------------------------------------

/**
 * Auf Touch ist das Quick-Add eingeklappt und der FAB öffnet es.
 *
 * WARUM: Der Einkauf trug mobil 439 von 852px Chrome, bevor ein Artikel sichtbar
 * war (52%; bei 320px 495 von 720 = 69%). Das zweizeilige Quick-Add ist davon
 * 126px - und es ist der einzige Tab, dessen FAB kein Formular öffnet, sondern
 * nur ein bereits sichtbares Feld fokussiert. Ein Griff löst beides: der FAB tut
 * dasselbe wie in Mahlzeiten, Rezepten und Vorrat, und die Liste beginnt weiter
 * oben (Critique 2026-07-30, P1).
 *
 * KEIN BOTTOM-SHEET, obwohl der FAB unten sitzt und die Tastatur unten aufgeht:
 * das Feld bleibt an seinem Platz über der Liste, wird nur enthüllt und
 * eingescrollt. Ein Sheet wäre die schönere Geste und ein zweiter Overlay-Typ mit
 * eigenem Focus-Trap - „Modal als erster Gedanke" ist in diesem Projekt ein
 * ausdrücklich verbotenes Muster, und die Eingabe gehört sichtbar zur Liste, in
 * die sie schreibt.
 *
 * Der Zustand hängt an `.shopping-page--adding` (siehe shopping.css) statt an
 * einem `hidden` am Formular: das Kriterium ist die Zeigerfähigkeit, und die
 * kennt nur CSS. JS setzt die Absicht, CSS entscheidet, ob sie überhaupt eine
 * Wirkung hat - auf Desktop ist die Klasse ein No-op.
 *
 * @param {Element} container
 * @param {boolean} open
 */
function syncQuickAddDisclosure(container, open) {
  const page = container.querySelector('.shopping-page');
  const fab = findPageFab('fab-new-item');
  if (!page || !fab) return;

  const collapsible = window.matchMedia('(hover: none)').matches && Boolean(state.activeList);
  page.classList.toggle('shopping-page--adding', collapsible && open);

  // `aria-expanded` NUR wo der Knopf tatsächlich etwas aufklappt. Auf Desktop
  // fokussiert er ein sichtbares Feld; ein „eingeklappt" zu melden, was gar nicht
  // eingeklappt ist, wäre eine Falschaussage an den Screenreader.
  if (collapsible) {
    fab.setAttribute('aria-expanded', String(open));
    fab.setAttribute('aria-controls', 'quick-add-form');
  } else {
    fab.removeAttribute('aria-expanded');
    fab.removeAttribute('aria-controls');
  }
}

function wireQuickAdd(container) {
  const form = container.querySelector('#quick-add-form');
  if (!form) return;

  // Esc klappt zu und gibt den Fokus an den FAB zurück - dieselbe Zusage wie im
  // Modal, wo Esc schließt und den Auslöser wieder fokussiert.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const page = container.querySelector('.shopping-page');
    if (!page?.classList.contains('shopping-page--adding')) return;
    e.stopPropagation();
    syncQuickAddDisclosure(container, false);
    findPageFab('fab-new-item')?.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = container.querySelector('#item-name-input');
    const qtyInput  = container.querySelector('#item-qty-input');
    const catSelect = container.querySelector('#item-cat-select');

    const name     = nameInput.value.trim();
    const quantity = qtyInput.value.trim() || null;
    const category = catSelect.value;

    if (!name) { nameInput.focus(); return; }

    try {
      const data = await api.post(`/shopping/${state.activeListId}/items`, { name, quantity, category });
      state.items.push(data.data);
      // Einfügen in DOM ohne komplettes Re-Render
      updateItemsList(container);
      updateListCounter(state.activeListId, 1, 0);
      renderTabs(container);
      nameInput.value = '';
      qtyInput.value  = '';
      // Erfolgs-Feedback auf dem +-Button (DOM-API, kein innerHTML)
      _flashAddBtn(form.querySelector('.quick-add__btn'));
      nameInput.focus();
      nameInput.classList.add('quick-add__input--flash');
      nameInput.addEventListener('animationend', () => nameInput.classList.remove('quick-add__input--flash'), { once: true });
    } catch (err) {
      window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  });
}

// --------------------------------------------------------
// Swipe-Affordance Hint (Long Loop)
// Zeigt den Nudge-Hinweis maximal 3x (gespeichert in localStorage).
// --------------------------------------------------------

// --------------------------------------------------------
// Handsortierung innerhalb einer Kategorie (#678)
// --------------------------------------------------------

/** Laufende Sortable-Instanzen, damit ein Neuaufbau der Liste sie abräumt. */
let itemSortables = [];

function destroyItemSortables() {
  itemSortables.forEach((inst) => { try { inst.destroy(); } catch { /* schon abgeräumt */ } });
  itemSortables = [];
}

/** Ziehbare (= nicht abgehakte) Zeilen einer Gruppe in DOM-Reihenfolge. */
function movableRows(rowsEl) {
  return Array.from(rowsEl.querySelectorAll(':scope > .swipe-row:not([data-swipe-checked="1"])'));
}

/**
 * Schreibt Position und Gesamtzahl in die Griff-Beschriftungen einer Gruppe.
 *
 * Nach jedem Zug erneut: der Griff ist bei der Tastaturbedienung das fokussierte
 * Element, und seine Beschriftung ist die einzige Rückmeldung darüber, wo der
 * Artikel jetzt steht. Ein statisches „Reihenfolge ändern" ließe Screenreader-
 * Nutzer nach dem Tastendruck ohne Bestätigung zurück.
 */
function refreshHandleLabels(rowsEl) {
  if (!rowsEl) return;
  const rows = movableRows(rowsEl);
  rows.forEach((row, idx) => {
    const handle = row.querySelector('.list-row__drag');
    const name   = row.querySelector('.list-row__name')?.textContent?.trim() ?? '';
    if (!handle) return;
    handle.removeAttribute('disabled');
    handle.setAttribute('aria-label', `${t('shopping.reorderHandle', { name })}, ${
      t('shopping.reorderPosition', { index: idx + 1, total: rows.length })}`);
  });
  // Abgehakte Artikel sortieren sich nicht: sie stehen ohnehin am Ende ihrer
  // Kategorie (ORDER BY is_checked vor sort_order), ein Zug an ihnen wäre
  // folgenlos. Der Griff bleibt sichtbar, damit die Zeile ihre Form behält.
  //
  // Beide Richtungen in EINER Funktion: das Zurückholen eines Artikels ist so
  // alltäglich wie das Abhaken, und ein nur gesetztes `disabled` hätte den Griff
  // bis zum nächsten Voll-Render tot gelassen.
  rowsEl.querySelectorAll(':scope > [data-swipe-checked="1"] .list-row__drag')
    .forEach((handle) => handle.setAttribute('disabled', ''));
}

/**
 * Sagt die neue Position einer bewegten Zeile über die Live-Region an.
 * Nutzt bewusst `category.reorderAnnounce` mit: der Satz ist wortgleich, und
 * eine zweite Fassung derselben Aussage wäre 24 Übersetzungen, die
 * auseinanderlaufen können.
 */
function announceItemMove(container, row) {
  const el = container?.querySelector('#items-reorder-announce');
  if (!el || !row) return;
  const rows = movableRows(row.parentElement);
  const idx  = rows.indexOf(row);
  if (idx === -1) return;
  el.textContent = t('category.reorderAnnounce', {
    name:     row.querySelector('.list-row__name')?.textContent?.trim() ?? '',
    position: idx + 1,
    total:    rows.length,
  });
}

/** Kategorien mit laufender Sicherung: Name -> { again: boolean }. */
const orderRuns = new Map();

/**
 * Einen Sicherungslauf ausführen: liest die Reihenfolge JETZT aus dem DOM.
 *
 * `listId` kommt vom Einreihen und nicht aus `state.activeListId`: wechselt der
 * Nutzer die Liste, während eine Nachfolge aussteht, hält `groupEl` noch die
 * abgehängten Zeilen der alten Liste. Deren IDs gegen die inzwischen aktive
 * Liste zu schicken, quittiert die Route zu Recht mit 400 - gemeint war der Zug
 * in der alten Liste, und dorthin gehört er auch gesichert.
 */
async function sendItemOrder(groupEl, container, listId) {
  const rowsEl   = groupEl.querySelector('.list-rows');
  const category = groupEl.dataset.category;
  if (!rowsEl) return true;

  // Alle Artikel der Kategorie, auch die abgehakten: die Route verlangt die
  // vollständige Gruppe, sonst kollidieren die neuen Ränge mit den alten.
  const order = Array.from(rowsEl.querySelectorAll(':scope > .swipe-row'))
    .map((row) => Number(row.dataset.swipeId));
  if (!order.length) return true;

  try {
    const data = await api.patch(`/shopping/${listId}/items/reorder`, { category, order });
    // Nur den State nachziehen, nicht neu zeichnen: das DOM steht bereits
    // richtig, und ein Re-Render würde den Fokus vom Griff nehmen - mitten in
    // einer Tastaturbedienung wäre das das Ende der Bedienkette.
    //
    // Und nur, solange dieselbe Liste offen ist: die Antwort trägt die Artikel
    // VON `listId`, ein zwischenzeitlicher Listenwechsel bekäme sonst den
    // Bestand der alten Liste in seinen State geschrieben.
    if (listId === state.activeListId) state.items = data.data ?? state.items;
    return true;
  } catch (err) {
    // Fehler einer Liste, die gar nicht mehr offen ist, nicht dem Nutzer
    // vorlegen und erst recht nicht die sichtbare Liste dafür neu bauen.
    if (listId !== state.activeListId) return false;
    window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    updateItemsList(container);
    return false;
  }
}

/**
 * Neue Reihenfolge einer Gruppe sichern. Geteilter Persistenz-Pfad von Drag und
 * Pfeiltasten - beide haben das DOM vorher schon umgestellt, deshalb baut der
 * Fehlerfall die Liste aus dem unveränderten State neu auf.
 *
 * JE KATEGORIE IMMER NUR EINE LAUFENDE ANFRAGE. Zwei schnell nacheinander
 * gedrückte Pfeiltasten schickten sonst zwei PATCHes parallel los, und es
 * entschied die Ankunftsreihenfolge beim Server statt die Bedienreihenfolge:
 * traf der erste zuletzt ein, schrieb er den Zwischenstand fest, das DOM zeigte
 * aber den zweiten Zug. Der Nutzer sah seine Reihenfolge und bekam beim
 * nächsten Laden eine andere. Bewusst als Warteschlange und nicht als Entprellung:
 * die Sicherung bleibt sofort, nur eben der Reihe nach.
 *
 * Weitere Züge während eines Laufs werden zu EINER Nachfolge zusammengefasst -
 * die liest die dann aktuelle Reihenfolge, also genügt sie für beliebig viele.
 *
 * @param {HTMLElement} [movedRow] - die bewegte Zeile, für die Ansage
 */
function persistItemOrder(groupEl, container, movedRow) {
  const category = groupEl?.dataset.category;
  if (!groupEl || !category) return;

  refreshHandleLabels(groupEl.querySelector('.list-rows'));
  announceItemMove(container, movedRow);

  const running = orderRuns.get(category);
  if (running) { running.again = true; return; }

  const run    = { again: false };
  const listId = state.activeListId;
  orderRuns.set(category, run);
  (async () => {
    try {
      let ok = true;
      do {
        run.again = false;
        ok = await sendItemOrder(groupEl, container, listId);
      } while (run.again && ok);   // nach einem Fehler hat updateItemsList das DOM zurückgesetzt
    } finally {
      orderRuns.delete(category);
    }
  })();
}

/**
 * Verschiebt eine Zeile um einen Platz und hält den Fokus auf ihrem Griff.
 * @param {HTMLElement} row
 * @param {-1|1} delta
 */
function moveItemRow(row, delta, container) {
  const rowsEl = row.parentElement;
  const rows   = movableRows(rowsEl);
  const idx    = rows.indexOf(row);
  const target = idx + delta;
  if (idx === -1 || target < 0 || target >= rows.length) return;

  if (delta < 0) rowsEl.insertBefore(row, rows[target]);
  else           rowsEl.insertBefore(row, rows[target].nextSibling);

  vibrate(15);
  row.querySelector('.list-row__drag')?.focus();
  persistItemOrder(rowsEl.closest('.list-group'), container, row);
}

/**
 * Verdrahtet je Kategorie-Gruppe das Ziehen und die Pfeiltasten am Griff.
 *
 * Je Gruppe eine eigene Instanz und kein `group`-Verbund: ein Zug von „Obst"
 * nach „Backwaren" wäre ein Kategoriewechsel, keine Umsortierung - dafür gibt es
 * den Detail-Dialog, und die Ränge gelten ohnehin je Kategorie.
 */
function wireItemReorder(container) {
  const listEl = container.querySelector('#items-list');
  if (!listEl) return;
  destroyItemSortables();

  listEl.querySelectorAll('.list-group').forEach((groupEl) => {
    const rowsEl = groupEl.querySelector('.list-rows');
    if (!rowsEl) return;
    refreshHandleLabels(rowsEl);

    makeSortable(rowsEl, {
      handle: '.list-row__drag',
      draggable: '.swipe-row',
      // Abgehaktes bleibt liegen: es steht am Ende der Kategorie, und ein Zug
      // daran würde beim nächsten Laden zurückspringen.
      filter: '[data-swipe-checked="1"]',
      onEnd: (evt) => persistItemOrder(groupEl, container, evt?.item),
    }).then((inst) => { if (inst) itemSortables.push(inst); })
      .catch(() => { /* ohne SortableJS bleibt der Tastaturpfad */ });
  });

  // Tastaturpfad, delegiert: derselbe Persistenz-Handler wie das Drag-Ende.
  // Einmal pro #items-list-Element - mountItems() tauscht nur dessen Inhalt aus,
  // ein Listener pro Aufruf hätte sich mit jedem Nachladen gestapelt.
  if (listEl.dataset.reorderWired) return;
  listEl.dataset.reorderWired = '1';
  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const handle = e.target.closest?.('.list-row__drag');
    if (!handle || handle.disabled) return;
    e.preventDefault();
    moveItemRow(handle.closest('.swipe-row'), e.key === 'ArrowUp' ? -1 : 1, container);
  });
}

// --------------------------------------------------------
// Swipe-Gesten
// --------------------------------------------------------

function wireSwipeGestures(container) {
  const listEl = container.querySelector('#items-list');
  if (!listEl) return;

  wireSwipeRows(listEl, {
    card: '.shopping-item',
    ignore: '.list-row__drag',
    // Vor 2.0.0 löschte der Wisch zum Zeilenende hier sofort: eine der zwei
    // Listen, in denen die Seiten wirklich getauscht haben.
    sidesSwapped: true,
    // Beide Seiten führen dieselbe Aktion aus wie der Knopf in der Zeile -
    // über dieselbe Funktion, nicht über eine zweite Schreibweise daneben.
    //
    // Zeilenanfang: abhaken / zurueck - die primäre positive Aktion der Liste
    // (§2). Die Karte fliegt hinaus, die Zeile bleibt - nur ihr Zustand
    // wechselt (Issue #276: kein Re-Render der Liste).
    leading: {
      reveal: '.swipe-reveal--done',
      flyOut: true,
      run: (row) => toggleShoppingItem(
        Number(row.dataset.swipeId),
        Number(row.dataset.swipeChecked),
        container,
      ),
    },
    // Zeilenende: loeschen, widerrufbar - dieselbe Kante wie bei den
    // Geburtstagen. Die Karte federt zurück statt hinauszufliegen, aus
    // demselben Grund wie dort: eine hinausgeflogene Karte behauptet, die
    // Sache sei erledigt, während der Rückgängig-Weg noch fünf Sekunden
    // offen steht.
    trailing: {
      reveal: '.swipe-reveal--delete',
      run: (row) => deleteItemUndoable(Number(row.dataset.swipeId), container),
    },
  });
}

// --------------------------------------------------------
// DOM-Updates (ohne komplettes Re-Render)
// --------------------------------------------------------

/**
 * Aktualisiert nur die DOM-Zeile eines einzelnen Artikels (Checked-Status),
 * ohne die gesamte Liste neu aufzubauen. Da das Abhaken die Gruppierung nicht
 * ändert, bleibt so die Scroll-Position des Listen-Containers erhalten (Issue #276).
 */
function updateItemRow(container, item) {
  const row = container.querySelector(`.swipe-row[data-swipe-id="${item.id}"]`);
  if (!row) return;
  const isDone = Boolean(item.is_checked);

  row.dataset.swipeChecked = String(item.is_checked);

  row.querySelector('.shopping-item')?.classList.toggle('shopping-item--checked', isDone);

  const checkBtn = row.querySelector('.item-check');
  if (checkBtn) {
    checkBtn.classList.toggle('item-check--checked', isDone);
    checkBtn.dataset.checked = String(item.is_checked);
    checkBtn.setAttribute('aria-label', isDone
      ? t('shopping.markUndoneLabel', { name: item.name })
      : t('shopping.markDoneLabel', { name: item.name }));
  }

  // Der Sortiergriff hängt am Erledigt-Zustand (#678): abgehaktes sortiert sich
  // nicht, und die Positionsangaben der Gruppe verschieben sich mit.
  refreshHandleLabels(row.closest('.list-rows'));

  // Swipe-Affordance (links) spiegelt den neuen Status
  const reveal = row.querySelector('.swipe-reveal--done');
  if (reveal) {
    reveal.replaceChildren();
    reveal.insertAdjacentHTML('beforeend', `
      <i data-lucide="${isDone ? 'rotate-ccw' : 'check'}" class="icon-xl" aria-hidden="true"></i>
      <span>${isDone ? t('shopping.swipeBack') : t('shopping.swipeCheck')}</span>`);
    if (window.lucide) window.lucide.createIcons({ el: reveal });
  }
}

/**
 * Aktualisiert Name, Menge und die Detail-Indikatoren (Link/Notiz) einer Zeile,
 * ohne das .shopping-item-Element zu ersetzen — so bleiben die
 * Swipe-Gesten-Closures (die die Karte einmalig referenzieren) intakt.
 *
 * Deckte vorher nur die Indikatoren ab: Name und Menge waren im Dialog gar nicht
 * änderbar (Critique 2026-07-30, P2). Seit sie es sind, muss die Zeile beide
 * mitziehen - und die Menge kann von „vorhanden" auf „leer" wechseln, also muss
 * das Meta-Element auch verschwinden können.
 */
function refreshItemName(container, item) {
  const card = container.querySelector(`.shopping-item[data-item-id="${item.id}"]`);
  const nameEl = card?.querySelector('.list-row__name');
  if (!nameEl) return;

  nameEl.replaceChildren(document.createTextNode(item.name));
  const metaHtml = renderItemMeta(item);
  if (metaHtml) {
    nameEl.insertAdjacentHTML('beforeend', metaHtml);
    if (window.lucide) window.lucide.createIcons({ el: nameEl });
  }

  /* Die Metazeile trägt seit dem Zeilenschnitt ZWEI Dinge, Menge und Etiketten.
   * `metaEl.textContent = …` hätte die Etiketten dabei mitgelöscht - deshalb
   * greift die Menge ihren eigenen Knoten. Die Zeile selbst verschwindet nur,
   * wenn beides fehlt. */
  const main = card.querySelector('.list-row__main');
  const metaEl = main?.querySelector('.list-row__meta');
  const hasTags = !!item.tags?.length;
  if (item.quantity || hasTags) {
    if (!metaEl) {
      main?.insertAdjacentHTML('beforeend', `<div class="list-row__meta">
        ${item.quantity ? `<span class="shopping-item__quantity">${esc(item.quantity)}</span>` : ''}
        ${renderItemTags(item.tags)}
      </div>`);
    } else {
      const qtyEl = metaEl.querySelector('.shopping-item__quantity');
      if (item.quantity && qtyEl) {
        qtyEl.textContent = item.quantity;
      } else if (item.quantity) {
        metaEl.insertAdjacentHTML('afterbegin', `<span class="shopping-item__quantity">${esc(item.quantity)}</span>`);
      } else {
        qtyEl?.remove();
      }
    }
  } else {
    metaEl?.remove();
  }
}

/**
 * Artikel bearbeiten.
 *
 * WAS HIER FALSCH WAR (Critique 2026-07-30, P2): dieser Dialog und das
 * strukturgleiche Vorrats-Modal sind dieselbe Handlung - „diesen Eintrag ändern" -
 * und waren zwei verschiedene Dinge. Der Vorrat: Titel „Artikel bearbeiten", acht
 * Felder, Löschen / Abbrechen / Speichern. Der Einkauf: der DATENWERT als Titel
 * („Cherry tomatoes"), zwei Felder (Link, Notiz), Schließen und Speichern - KEIN
 * Abbrechen, und Name und Menge waren gar nicht änderbar. Wer einen Tippfehler im
 * Artikelnamen hatte, musste die Zeile löschen und neu anlegen.
 *
 * Jetzt: derselbe Titel aus demselben Key, Name / Menge / Kategorie editierbar,
 * Abbrechen neben Speichern. Die Rich-Felder (Link, Notiz) bleiben, wo sie waren -
 * sie sind der Grund, aus dem der Dialog existiert, und der Quick-Add bleibt
 * bewusst schlank.
 *
 * KEIN LÖSCHEN im Dialog, anders als im Vorrat: die Einkaufszeile trägt es selbst
 * (× auf Zeigergeräten, Wischen auf Touch), und beide Wege haben Undo. Ein dritter
 * Weg an einer Stelle, an der man gerade einen Namen tippt, wäre eine
 * Fehlerquelle, kein Gewinn.
 */
function openItemDetails(itemId, container) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;

  const linkPreview = (value) => {
    const v = String(value ?? '').trim();
    if (!/^https?:\/\//i.test(v)) return '';
    return `
      <a class="item-details__link" href="${esc(v)}" target="_blank" rel="noopener noreferrer">
        <i data-lucide="external-link" class="icon-sm" aria-hidden="true"></i>${t('shopping.openLink')}
      </a>`;
  };

  openModal({
    title: t('common.editItem'),
    size: 'md',
    content: `
      <form id="item-details-form" class="item-details-form" novalidate autocomplete="off">
        <div class="form-group">
          <label class="form-label" for="item-details-name">${t('common.nameLabel')}</label>
          <input class="form-input" type="text" id="item-details-name" required
                 value="${esc(item.name)}">
        </div>
        <div class="pantry-form-row">
          <div class="form-group">
            <label class="form-label" for="item-details-qty">${t('shopping.itemQtyLabel')}</label>
            <input class="form-input" type="text" id="item-details-qty"
                   placeholder="${t('shopping.itemQtyPlaceholder')}" value="${esc(item.quantity || '')}">
          </div>
          <div class="form-group">
            <label class="form-label" for="item-details-cat">${t('shopping.categoryLabel')}</label>
            <select class="form-input" id="item-details-cat">
              ${state.categories.map((c) => `<option value="${esc(c.name)}" ${c.name === item.category ? 'selected' : ''}>${esc(categoryLabel(c.name))}</option>`).join('')}
            </select>
          </div>
        </div>
        ${/* PREIS UND LADEN (#1003).
            *
            * NICHT ALS ZWANGSDIALOG BEIM ABHAKEN. Das Ticket sagt "erfasst,
            * wenn man abhakt - da ist die Zahl bekannt", und das stimmt; ein
            * Dialog, der sich bei JEDEM Haken oeffnet, waere im Laden aber
            * unertraeglich: das Abhaken ist die schnellste Geste der App und
            * bleibt es. Die Felder stehen deshalb hier, wo der Artikel ohnehin
            * geoeffnet wird - nachtragen statt unterbrechen.
            *
            * Betont bei einem abgehakten Artikel: dann ist die Frage aktuell. */ ''}
        <div class="pantry-form-row">
          <div class="form-group">
            <label class="form-label" for="item-details-price">${t('shopping.priceLabel')}</label>
            <input class="form-input" type="text" id="item-details-price" inputmode="decimal"
                   placeholder="${esc(amountPlaceholder(state.currency))}"
                   value="${item.price_cents != null ? esc(centsToAmountInput(item.price_cents, state.currency)) : ''}">
          </div>
          <div class="form-group">
            <label class="form-label" for="item-details-store">${t('shopping.storeLabel')}</label>
            ${/* COMBOBOX, KEIN SELECT (#1003).
                *
                * Eine reine Auswahlliste ist bei einem frischen Haushalt leer und
                * bleibt es: der erste Laden muesste anderswo entstehen. Ein Knopf
                * daneben hilft hier nicht - das geteilte Modal kennt bewusst kein
                * Stacking (siehe modal.js), ein Manager darueber raeumte dieses
                * Formular samt getippter Eingaben weg.
                *
                * Also tippen oder waehlen: die Liste kommt als datalist dazu, und
                * ein unbekannter Name legt beim Speichern den Laden an. Umbenennen
                * und Loeschen liegen im Listenmenue, wo der Manager ein Dialog
                * erster Ebene sein darf. */ ''}
            <input class="form-input" type="text" id="item-details-store" list="item-details-store-options"
                   autocomplete="off" placeholder="${esc(t('shopping.storePlaceholder'))}"
                   value="${esc(state.stores.find((st) => st.id === item.store_id)?.name ?? '')}">
            <datalist id="item-details-store-options">
              ${state.stores.map((st) => `<option value="${esc(st.name)}"></option>`).join('')}
            </datalist>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="item-details-url">${t('shopping.urlLabel')}</label>
          <input class="form-input" type="url" id="item-details-url" inputmode="url"
                 placeholder="${t('shopping.urlPlaceholder')}" value="${esc(item.url || '')}">
          <div class="item-details__link-wrap" id="item-details-link">${linkPreview(item.url)}</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="item-details-notes">${t('shopping.notesLabel')}</label>
          <textarea class="form-input" id="item-details-notes" rows="4"
                    placeholder="${t('shopping.notesPlaceholder')}">${esc(item.notes || '')}</textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn--secondary" id="item-details-cancel">${t('common.cancel')}</button>
          <button type="submit" class="btn btn--primary">${t('common.save')}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const form    = panel.querySelector('#item-details-form');
      const nameEl  = panel.querySelector('#item-details-name');
      const qtyEl   = panel.querySelector('#item-details-qty');
      const catEl   = panel.querySelector('#item-details-cat');
      const urlEl   = panel.querySelector('#item-details-url');
      const notesEl = panel.querySelector('#item-details-notes');
      const preview = panel.querySelector('#item-details-link');

      panel.querySelector('#item-details-cancel')?.addEventListener('click', () => closeModal());

      urlEl?.addEventListener('input', () => {
        preview.replaceChildren();
        const html = linkPreview(urlEl.value);
        if (html) {
          preview.insertAdjacentHTML('beforeend', html);
          if (window.lucide) window.lucide.createIcons({ el: preview });
        }
      });

      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = nameEl.value.trim();
        if (!name) {
          reportFieldError(nameEl, t('common.nameRequired'));
          return;
        }
        const priceEl = panel.querySelector('#item-details-price');
        const storeEl = panel.querySelector('#item-details-store');
        // Der Preis kommt als Text herein und geht als ganze Cent hinaus: Geld
        // als Gleitkomma summiert sich sichtbar falsch, und die Historie, die
        // spaeter darauf aufbaut, addiert genau solche Zahlen. Ein leeres Feld
        // heisst "kein Preis", nicht "null Cent".
        const priceRoh = priceEl?.value.trim() ?? '';
        const priceCents = priceRoh === '' ? null : amountInputToCents(priceRoh, state.currency);
        if (priceRoh !== '' && priceCents === null) {
          reportFieldError(priceEl, t('budget.validAmountRequired'));
          return;
        }
        try {
          // Der Laden kommt als Name herein, die Zeile speichert eine ID. Ein
          // Name, den es noch nicht gibt, entsteht hier - der Server gibt bei
          // einem schon vorhandenen Namen dieselbe Zeile zurueck (COLLATE
          // NOCASE), zwei Schreibweisen werden also nicht zu zwei Laeden.
          const storeName = storeEl?.value.trim() ?? '';
          let storeId = null;
          if (storeName) {
            const bekannt = state.stores.find((st) => st.name.toLowerCase() === storeName.toLowerCase());
            if (bekannt) {
              storeId = bekannt.id;
            } else {
              const angelegt = await api.post('/shopping/stores', { name: storeName });
              state.stores.push(angelegt.data);
              storeId = angelegt.data.id;
            }
          }
          const payload = {
            name,
            quantity: qtyEl.value.trim() || null,
            category: catEl.value,
            notes: notesEl.value.trim() || null,
            url: urlEl.value.trim() || null,
            price_cents: priceCents,
            store_id: storeId,
          };
          const data = await api.patch(`/shopping/items/${item.id}`, payload);
          const categoryChanged = data.data.category !== item.category;
          Object.assign(item, data.data);
          // force: der Dirty-Guard vergleicht gegen den Snapshot vom Öffnen und
          // sähe die gerade gespeicherten Felder als ungespeicherte Änderungen.
          // Ohne das fragte Speichern „Änderungen verwerfen?" (Issue #625).
          closeModal({ force: true });
          // Ein Kategoriewechsel verschiebt die Zeile in eine andere Gruppe - das
          // kann keine Zeilen-Auffrischung leisten, dafür muss die Liste neu
          // gruppiert werden. Sonst genügt der schonende Weg, der die
          // Swipe-Closures und die Scroll-Position erhält (Issue #276).
          if (categoryChanged) {
            updateItemsList(container);
          } else {
            updateItemRow(container, item);
            refreshItemName(container, item);
          }
        } catch (err) {
          window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

function updateItemsList(container) {
  const listEl = container.querySelector('#items-list');
  if (listEl) {
    // mountItems() verdrahtet den CTA des Leerzustands selbst; der frühere
    // nachgelagerte #empty-cta-shopping-Listener entfällt damit.
    mountItems(listEl, container);
    if (window.lucide) window.lucide.createIcons({ el: listEl });
    stagger(listEl.querySelectorAll('.shopping-item'));
    wireSwipeGestures(container);
    wireItemReorder(container);
    maybeShowSwipeHint(container);
  }
  updateCheckedActions(container);
}

/**
 * Zerlegt den Freitext einer Einkaufsmenge in Zahl + Vorrats-Einheit.
 *
 * Bewusst nur die international geschriebenen metrischen Symbole: das Feld ist
 * Freitext in der Sprache des Haushalts, und ein deutschsprachiger Wortschatz
 * („Packung", „Dose") würde in 22 der 23 Sprachen ins Leere greifen. Zahl und
 * g/kg/ml/l sind sprachunabhängig und tragen den Großteil des Nutzens; alles
 * andere landet bei „Stück" und lässt sich im Dialog in einem Griff ändern.
 */
function parseShoppingQuantity(raw) {
  const fallback = { quantity: 1, unit: 'pcs' };
  const text = String(raw ?? '').trim();
  if (!text) return fallback;

  // Dieselbe Umschrift wie die Betragsfelder (utils/money.js): sie leitet Ziffern
  // und Dezimaltrenner aus der eingestellten Region ab. Ein eigenes
  // `replace(',', '.')` stand hier und war in beide Richtungen falsch - unter
  // en-US gruppiert das Komma Tausender, aus „1,000 g" wurde die Menge 1, und
  // unter ar oder fa kam eine Eingabe in östlichen Ziffern gar nicht erst an
  // (`\d` ist ASCII). Beides ohne Fehlermeldung: die Zeile im Übernahme-Dialog
  // stand einfach auf 1.
  //
  // `freeText`, weil hier nur der ANFANG gelesen wird: eine Gruppierung weiter
  // hinten geht diese Zerlegung nichts an. Ohne das fiel „6 × 1.000 ml" auf die
  // Menge 1 zurueck, obwohl die 6 eindeutig ist.
  //
  // Eine gruppierte Zahl weist die Umschrift ab und liefert einen leeren String.
  // Dann bleibt es beim Standard, statt zwischen 1 und 1000 zu raten - dieselbe
  // Entscheidung wie beim Preis, hier aber mit dem sanfteren Ausgang: der Dialog
  // zeigt die Menge in einem Feld, das sich korrigieren lässt.
  const decimal = toDecimalString(text, { freeText: true });
  if (!decimal) return fallback;

  // Die Einheit braucht eine Wortgrenze davor, sonst schluckt `\b` sie bei
  // Schreibweisen wie „3x" nicht und die Menge fiele auf 1 zurück.
  // Der Trenner ist hier immer der Punkt - die Umschrift oben hat den der Region
  // bereits übersetzt.
  const match = decimal.match(/^(\d+(?:\.\d+)?)\s*(?:(kg|g|ml|l)\b)?/i);
  if (!match) return fallback;

  // Bricht die Zahl mitten in einem Trennzeichen ab, ist sie nicht gelesen,
  // sondern abgeschnitten. Die Umschrift weist zwar eine erkannte Gruppierung
  // ab, aber nicht jede: „٢٬٥٠" hat nur zwei Stellen hinter dem Trenner, ist
  // also kein Gruppierungsmuster - und ein Trenner, den die Region nicht kennt,
  // steht ohnehin einfach da (unter fa trennt das ASCII-Komma nichts). Diese
  // Regex liest nur den ANFANG, sie nähme daraus wortlos die 2. Geprüft wird die
  // STELLE (ein Zeichen zwischen zwei Ziffern, das kein Leerraum ist), nicht eine
  // Liste von Trennern - welche Zeichen trennen, weiss die Region, nicht diese
  // Funktion. Dieselbe Prüfung steht in pages/meals.js.
  if (/^[^\s\d]\d/.test(decimal.slice(match[1].length))) return fallback;

  const quantity = Number(match[1]);
  if (!Number.isFinite(quantity) || quantity <= 0) return fallback;

  return { quantity, unit: match[2] ? match[2].toLowerCase() : 'pcs' };
}

/**
 * Übernahme-Dialog „Einkauf → Vorrat". Ein gemeinsamer Lagerort für alle
 * Artikel plus Menge/Einheit je Zeile: nach dem Einkauf räumt man einen Beutel
 * an einen Ort ein, nicht zwölf Artikel an zwölf Orte. Haltbarkeitsdaten bleiben
 * hier bewusst außen vor - sie sind die Ausnahme, nicht die Regel, und im
 * Vorrat einen Tap entfernt.
 */
async function openPantryTransfer(container) {
  const checked = state.items.filter((i) => i.is_checked);
  if (!checked.length) return;

  let locations = [];
  try {
    const res = await api.get('/pantry/locations');
    locations = res.data ?? [];
  } catch (err) {
    window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    return;
  }

  const { PANTRY_UNITS } = await import('/utils/pantry-units.js');
  const { locationLabel } = await import('/utils/pantry-locations.js');

  const unitOptions = (selected) => PANTRY_UNITS
    .map((u) => `<option value="${esc(u)}" ${u === selected ? 'selected' : ''}>${esc(t(`pantry.units.${u}`))}</option>`)
    .join('');

  const rows = checked.map((item) => {
    const parsed = parseShoppingQuantity(item.quantity);
    return `
      <li class="pantry-transfer__row" data-id="${item.id}">
        <span class="pantry-transfer__name">${esc(item.name)}</span>
        <input class="form-input pantry-transfer__qty" type="number" min="0" step="any" inputmode="decimal"
               value="${parsed.quantity}" aria-label="${esc(`${t('pantry.quantityLabel')}: ${item.name}`)}">
        <select class="form-input pantry-transfer__unit" aria-label="${esc(`${t('pantry.unitLabel')}: ${item.name}`)}">
          ${unitOptions(parsed.unit)}
        </select>
      </li>`;
  }).join('');

  openModal({
    title: t('shopping.toPantryTitle'),
    size: 'lg',
    content: `
      <p class="pantry-transfer__intro">${esc(t('shopping.toPantryDescription', { count: checked.length }))}</p>
      <div class="form-group">
        <label class="form-label" for="pantry-transfer-location">${esc(t('pantry.locationLabel'))}</label>
        <select id="pantry-transfer-location" class="form-input">
          <option value="">${esc(t('pantry.unlocated'))}</option>
          ${locations.map((loc) => `<option value="${loc.id}">${esc(locationLabel(loc.name))}</option>`).join('')}
        </select>
      </div>
      <ul class="pantry-transfer__list">${rows}</ul>
      <!-- Geteiltes .form-check (layout.css): 20px-Box in Modul-Akzent, Label mit
           eigener Trefferflaeche. Das war die folgenreichste Checkbox des Moduls -
           sie loescht die eingekauften Artikel von der Liste, ist standardmaessig
           aktiv, und war als nackte System-Checkbox in System-Groesse die
           unauffaelligste (Critique 2026-07-30, P2). Der Default bleibt aktiv: wer
           eingekauft und eingeraeumt hat, will nicht doppelt kaufen. -->
      <label class="form-check pantry-transfer__clear">
        <input type="checkbox" id="pantry-transfer-clear" checked>
        <span>${esc(t('shopping.toPantryClearList'))}</span>
      </label>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="pantry-transfer-confirm">${esc(t('common.apply'))}</button>
      </div>`,
    onSave(panel) {
      // Der erste Ort ist der wahrscheinlichste Standardwert; er ist zugleich
      // der, den der Haushalt in der Lagerort-Verwaltung nach oben sortiert hat.
      if (locations.length) panel.querySelector('#pantry-transfer-location').value = String(locations[0].id);

      panel.querySelector('#pantry-transfer-confirm').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const locationId = panel.querySelector('#pantry-transfer-location').value || null;
        const clearList = panel.querySelector('#pantry-transfer-clear').checked;
        const listId = state.activeListId;

        const items = [...panel.querySelectorAll('.pantry-transfer__row')].map((row) => ({
          shopping_item_id: Number(row.dataset.id),
          quantity: Number(row.querySelector('.pantry-transfer__qty').value) || 1,
          unit: row.querySelector('.pantry-transfer__unit').value,
          location_id: locationId,
        }));

        btn.disabled = true;
        try {
          const res = await api.post('/pantry/import-shopping', { list_id: listId, items });
          const stored = (res.data?.added ?? 0) + (res.data?.merged ?? 0);

          if (clearList && stored) {
            // Zweiter, getrennter Aufruf: der Vorrats-Router räumt bewusst
            // nichts im Einkauf ab, damit ein `pantry:write`-Token dort keine
            // Daten löschen kann (siehe routes/pantry.js).
            await api.delete(`/shopping/${listId}/items/checked`);
            const removed = checked.length;
            state.items = state.items.filter((i) => !i.is_checked);
            updateItemsList(container);
            updateListCounter(listId, -removed, -removed);
            renderTabs(container);
          }

          closeModal({ force: true });
          // Der Vorrat ist ein einziges Ziel, der Toast nennt ihn also schon. Was er
          // NICHT nennt, ist der Lagerort - und der ist die Wahl, die der Nutzer im
          // Dialog gerade getroffen hat.
          const locationName = locationId
            ? (locations.find((l) => String(l.id) === String(locationId))?.name ?? '')
            : '';
          window.yuvomi.showToast(
            stored
              ? (locationName
                ? t('shopping.toPantryDoneAt', { count: stored, location: locationLabel(locationName) })
                : t('shopping.toPantryDone', { count: stored }))
              : t('shopping.toPantryNothing'),
            stored ? 'success' : 'info'
          );
          // Der Vorrats-Tab zeigt jetzt eine andere Zahl.
          refreshKitchenBadges();
        } catch (err) {
          btn.disabled = false;
          window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

/**
 * Baut die Sammelaktions-Leiste neu auf, die an abgehakten Artikeln hängt.
 * Reihenfolge: erst „In den Vorrat", dann „Erledigte löschen" — ein erledigter
 * Einkauf endet im Regal, nicht im Papierkorb, und die Übernahme räumt die Liste
 * auf Wunsch gleich mit ab.
 *
 * Die Leiste trägt eine erklärende Zeile („3 Artikel abgehakt.") - genau der Teil,
 * der im Kopf fehlte: dort standen zwei Buttons, ohne dass irgendwo stand, auf
 * welche Teilmenge sie wirken. Der Vorrat hatte diese Zeile schon, und der
 * Critique nannte sie als das, was funktioniert.
 *
 * `hidden` statt eines leeren Containers: die Leiste hat eine Fläche, einen Rahmen
 * und Polsterung - leer wäre sie ein sichtbarer 42px-Streifen über der Liste. Die
 * [hidden]-Durchsetzung für `.list-bulkbar` steht in layout.css, weil
 * `display: flex` das UA-`[hidden]` sonst schlägt.
 *
 * ZEIGT SICH NUR NOCH ALS FUENF-SEKUNDEN-FENSTER EINES NEUEN BATCHES (#1039),
 * ueber `pillPhase` gesteuert: `userChecked` markiert den EINEN Aufruf, der
 * einen frischen Batch eroeffnen darf (den echten Nutzer-Abhak-Klick aus
 * `toggleShoppingItem`); jeder andere Aufruf (Laden, Listenwechsel,
 * Rueckgaengig) aktualisiert eine bereits sichtbare Pille hoechstens, zeigt
 * aber nie von sich aus eine neue.
 */
function updateCheckedActions(container, { userChecked = false } = {}) {
  const checkedCount = state.items.filter((i) => i.is_checked).length;
  if (!checkedCount) {
    clearPillTimer();
    pillPhase = 'idle';
    pillInteracting = false;
    pillOwnerContainer = null;
    clearBulkPill();
    return;
  }

  // Weder ein frischer Nutzer-Treffer aus dem Ruhezustand noch eine schon
  // sichtbare Pille: verborgen bleiben (Ladezustand, Listenwechsel, oder ein
  // Batch, der schon einmal ausgeblendet wurde und noch nicht auf 0 fiel).
  if (!((userChecked && pillPhase === 'idle') || pillPhase === 'visible' || pillPhase === 'deferred')) {
    return;
  }

  const actions = [];
  if (!window.yuvomi?.isModuleDisabled?.('pantry')) {
    actions.push({
      label: t('shopping.toPantry'),
      onClick: () => openPantryTransfer(container),
    });
  }
  // Nur das Verb, nicht „Abgehakt löschen": das Label links nennt den Bezug,
  // und der ganze Satz steht im aria-label. Das Löschen der GANZEN Liste sitzt
  // woanders (Überlaufmenü) und hat einen eigenen Bestätigungsdialog.
  actions.push({
    label: t('common.delete'),
    ariaLabel: t('shopping.clearChecked', { count: checkedCount }),
    // Die Zahl als Marke - sie wird sichtbar, wo das Subjekt links wegfällt
    // (unter 21rem Pillenbreite). Von den beiden Kapseln trägt sie diese, weil
    // ein „Löschen" ohne genanntes Objekt über einer Liste mit 23 Artikeln
    // gelesen werden kann wie „die Liste löschen".
    count: checkedCount,
    // DIE RÜCKFRAGE, UND ZWAR TROTZ DES UNDO (Critique 2026-08-13, P0). Die
    // Rücknahme war hier als Begründung geführt, sie zu lassen - sie hält
    // fünf Sekunden, sieht aus wie die Kapsel, die gerade danebenlag, und
    // steht 8px darunter. Das ist der Rettungsweg für einen Irrtum, den man
    // BEMERKT; die Frage ist der für den, den man nicht bemerkt.
    danger: true,
    confirm: { question: t('shopping.clearCheckedConfirm', { count: checkedCount }) },
    onClick: () => clearCheckedUndoable(container),
  });

  // KEINE Icons mehr. Sie kosteten je 12px Breite plus Abstand auf einer
  // Fläche, die einzeilig bleiben muss, und benannten nichts, was das Wort
  // daneben nicht schon sagt - „In den Vorrat" mit Archiv-Kiste, „Löschen" mit
  // Papierkorb. Auf dem Shell-Material trägt die Kapsel den Rang, nicht das
  // Zeichen darin (dieselbe Form wie .toast__undo).
  setBulkPill({
    label: t('shopping.checkedHint', { count: checkedCount }),
    actions,
  });

  if (pillPhase === 'idle') {
    // Nur hier moeglich, wenn userChecked die Bedingung oben erfuellt hat: ein
    // frischer Batch beginnt jetzt, mit genau EINER Fuenf-Sekunden-Frist.
    pillPhase = 'visible';
    pillOwnerContainer = container;
    wirePillInteractionGuards();
    schedulePillHide(container);
  }
  // 'visible'/'deferred': Zahl und Aktionen sind frisch, die laufende Frist
  // bzw. die Interaktions-Verlaengerung bleibt unangetastet (Anforderung: kein
  // Aufschub durch weitere Treffer).
}

/**
 * Abgehakte löschen, mit Undo-Fenster. Stand bis Etappe 5 als Zweig im
 * delegierten Klick-Handler von `container`; die Pille lebt seitdem in der
 * Shell und ist von dort aus nicht mehr erreichbar - sie ruft direkt.
 */
function clearCheckedUndoable(container) {
  const checked = state.items.filter((i) => i.is_checked);
  const count   = checked.length;
  if (!count) return;

  const snapshot = checked.map((i) => ({ ...i }));
  // DIESELBE REGEL WIE BEIM EINZELNEN ARTIKEL, hier mit schwererem Preis:
  // `commit` schlug die Liste bisher ERST beim Ausfuehren nach. Ein
  // Listenwechsel im Undo-Fenster schickte das DELETE damit an die gerade
  // geoeffnete Liste und raeumte deren abgehakte Artikel ab - waehrend der
  // Snapshot zur alten gehoerte und sie also nicht zurueckholen konnte.
  const listId = state.activeListId;

  // Optimistisch entfernen
  state.items = state.items.filter((i) => !i.is_checked);
  updateItemsList(container);
  updateListCounter(listId, -count, -count);
  renderTabs(container);

  scheduleUndoableDelete({
    message: t('shopping.itemsRemovedToast', { count }),
    commit: ({ keepalive }) => api.delete(`/shopping/${listId}/items/checked`, { keepalive }),
    restore: (err) => {
      if (state.activeListId === listId) {
        snapshot.forEach((item) => state.items.push(item));
        state.items.sort((a, b) => a.id - b.id);
        updateItemsList(container);
      }
      updateListCounter(listId, count, count);
      renderTabs(container);
      if (err) window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    },
  });
}

function updateListCounter(listId, totalDelta, checkedDelta) {
  const list = state.lists.find((l) => l.id === listId);
  if (list) {
    list.item_total   = (list.item_total   || 0) + totalDelta;
    list.item_checked = (list.item_checked || 0) + checkedDelta;
  }
}

function openMealPlanImport(container) {
  if (!state.activeListId) return;
  const today = todayKey();
  const defaultTo = addLocalDays(today, 6);

  openModal({
    title: t('shopping.importMealsTitle'),
    size: 'sm',
    content: `
      <form id="shopping-import-meals-form" class="shopping-import-meals-form" novalidate autocomplete="off">
        <div class="form-group">
          <label class="form-label" for="shopping-import-from">${t('calendar.fromLabel')}</label>
          <yuvomi-datepicker type="date" id="shopping-import-from" value="${esc(today)}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="form-label" for="shopping-import-to">${t('calendar.toLabel')}</label>
          <yuvomi-datepicker type="date" id="shopping-import-to" value="${esc(defaultTo)}"></yuvomi-datepicker>
        </div>
        <p class="form-hint" id="shopping-import-preview" role="status" aria-live="polite"></p>
        <div class="modal-actions">
          <button type="button" class="btn btn--secondary" id="shopping-import-cancel">${t('common.cancel')}</button>
          <!-- Startet deaktiviert und wird von updatePreview() freigeschaltet, sobald
               der Zeitraum Zutaten enthaelt. Die Schwesteraktion „Plan zufaellig
               fuellen" macht das seit dem Audit korrekt; hier blieb „Uebernehmen"
               bei 0 Treffern klickbar und quittierte mit einem Info-Toast, dass
               nichts passiert ist (Critique 2026-07-30, P2). -->
          <button type="submit" class="btn btn--primary" id="shopping-import-submit" disabled>${t('common.apply')}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const form = panel.querySelector('#shopping-import-meals-form');
      const cancelBtn = panel.querySelector('#shopping-import-cancel');
      cancelBtn?.addEventListener('click', () => closeModal());

      // Vorschau vor dem Import (Audit A1-22): dieselbe Route rechnet mit
      // preview:true nur, statt zu schreiben - der Dialog sagt, was passiert.
      const previewEl = panel.querySelector('#shopping-import-preview');
      const submitBtn = panel.querySelector('#shopping-import-submit');
      async function updatePreview() {
        const from = panel.querySelector('#shopping-import-from')?.value || '';
        const to = panel.querySelector('#shopping-import-to')?.value || '';
        if (!from || !to || !previewEl) return;
        try {
          const data = await api.post(`/shopping/${state.activeListId}/import-meal-plan`, { from, to, preview: true });
          const transferred = Number(data.data?.transferred) || 0;
          const meals = Number(data.data?.meals) || 0;
          // Zwei Zahlachsen, eine Pluralmechanik: t() dekliniert nur über
          // `count`. Die Mahlzeiten-Angabe kommt deshalb als eigener, selbst
          // pluralisierter Teilstring herein (Audit A2-21: "aus 1 Mahlzeiten").
          previewEl.textContent = transferred
            ? t('shopping.importMealsPreview', {
              count: transferred,
              mealsText: t('shopping.importMealsPreviewMeals', { count: meals }),
            })
            : t('shopping.importMealsEmpty');
          submitBtn.disabled = !transferred;
        } catch {
          previewEl.textContent = '';
          // Vorschau fehlgeschlagen: nicht sperren. Der Nutzer soll es versuchen
          // duerfen, statt an einem toten Knopf zu haengen, weil eine
          // Nebenanfrage scheiterte.
          submitBtn.disabled = false;
        }
      }
      updatePreview();
      panel.querySelector('#shopping-import-from')?.addEventListener('change', updatePreview);
      panel.querySelector('#shopping-import-to')?.addEventListener('change', updatePreview);
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const from = panel.querySelector('#shopping-import-from')?.value || '';
        const to = panel.querySelector('#shopping-import-to')?.value || '';
        if (!from || !to) return;
        try {
          const data = await api.post(`/shopping/${state.activeListId}/import-meal-plan`, { from, to });
          if (!data.data?.transferred) {
            window.yuvomi.showToast(t('shopping.importMealsEmpty'), 'default');
            return;
          }
          await Promise.all([loadLists(), loadItems(state.activeListId)]);
          renderTabs(container);
          renderListContent(container);
          wireListContentEvents(container);
          // force: siehe openItemDetails - ein geänderter Zeitraum ist nach dem
          // Import nichts, was noch zu verwerfen wäre.
          closeModal({ force: true });
          const count = Number(data.data.transferred) || 0;
          window.yuvomi.showToast(t('meals.transferSuccess', { count }), 'success');
        } catch (err) {
          window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

// --------------------------------------------------------
// API-Aktionen
// --------------------------------------------------------

async function loadLists() {
  try {
    const data   = await api.get('/shopping');
    state.lists  = data.data ?? [];
    state.listsError = null;
  } catch (err) {
    console.error('[Shopping] loadLists Fehler:', err);
    state.lists = [];
    // Fehler statt Toast: der Toast verging, während darunter „Keine Listen ·
    // [Neue Liste erstellen]" stehen blieb - bei 31 vorhandenen Artikeln
    // (Critique P0, 2026-07-30).
    state.listsError = err;
  }
}

async function loadCategories() {
  try {
    const data       = await api.get('/shopping/categories');
    state.categories = data.data ?? [];
  } catch {
    state.categories = [];
  }
}

/* Laeden und Waehrung fuer das Preisfeld (#1003).
 *
 * Beide Ausfaelle sind still und harmlos: ohne Laeden bleibt die Auswahl leer
 * (der Preis laesst sich trotzdem eintragen), ohne Waehrung gilt EUR. Ein
 * Einkaufszettel, der wegen eines Nebenfeldes gar nicht aufgeht, waere der
 * schlechtere Tausch. */
async function loadStores() {
  try {
    const data   = await api.get('/shopping/stores');
    state.stores = data.data ?? [];
  } catch {
    state.stores = [];
  }
  try {
    const prefs    = await api.get('/preferences');
    state.currency = prefs.data?.currency ?? 'EUR';
  } catch { /* EUR bleibt */ }
}

async function loadItems(listId) {
  const data       = await api.get(`/shopping/${listId}/items`);
  state.items      = data.data ?? [];
  state.activeList = data.list ?? null;
  // Kategorien aus API-Antwort übernehmen wenn vorhanden (immer aktuell)
  if (data.categories?.length) state.categories = data.categories;
}

async function switchList(listId, container) {
  // Die Pille gehoert zur Teilmenge EINER Liste (dieselbe Regel wie beim
  // Seitenwechsel in router.js) - eine laufende Frist der alten Liste darf die
  // neue nicht treffen (#1039).
  resetPillMachine();
  clearBulkPill();
  state.activeListId = listId;
  state.collapsedCategories = loadCollapsedCategories(state.currentUserId, listId);
  renderTabs(container);
  // Lade-Feedback beim Listenwechsel: dimmt den alten Inhalt (CSS), meldet
  // Screenreadern „busy" — bis renderListContent den neuen Inhalt setzt.
  container.querySelector('#list-content')?.setAttribute('aria-busy', 'true');
  try {
    await loadItems(listId);
    state.itemsError = null;
  } catch (err) {
    console.error('[Shopping] loadItems Fehler:', err);
    state.items = [];
    state.activeList = state.lists.find((l) => l.id === listId) ?? null;
    state.itemsError = err;
  }
  renderListContent(container);
  wireListContentEvents(container);
}

// --------------------------------------------------------
// Event-Verdrahtung
// --------------------------------------------------------

function wireTabBar(container) {
  container.querySelector('#list-tabs-bar')?.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    if (target.dataset.action === 'switch-list') {
      await switchList(Number(target.dataset.id), container);
    }

    if (target.dataset.action === 'new-list') {
      const name = await promptModal(t('shopping.newListPrompt'));
      if (!name) return;
      try {
        const data = await api.post('/shopping', { name });
        state.lists.push({ ...data.data, item_total: 0, item_checked: 0 });
        await switchList(data.data.id, container);
      } catch (err) {
        window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
      }
    }
  });
}

function wireListContentEvents(container) {
  // Delegations-Wurzel ist der Modul-Root, nicht #list-content: die Aktionen der
  // Liste (rename-list, import-meals, manage-categories, delete-list) stehen im
  // Überlaufmenü der Chip-Leiste und liegen damit außerhalb des Inhalts.
  // .shopping-page ist der nächste gemeinsame Vorfahre und wird - genau wie
  // #list-content vorher - pro render() genau einmal erzeugt, womit die
  // Einmal-Bindung unten weiter gilt.
  const root = container.querySelector('.shopping-page');
  if (!root) return;

  // Die Klick-Delegation nur EINMAL anhängen. renderListContent ersetzt lediglich
  // die Kinder (replaceChildren), nicht das Element selbst - würde der Listener
  // bei jedem switchList/rename erneut gebunden, feuerte ein Toggle-Klick
  // mehrfach und höbe sich auf (Issue #398).
  // Positionierung und Schließen der Überlaufmenüs. Idempotent, hängt an
  // derselben stabilen Wurzel wie die Klick-Delegation.
  installPopoverMenus(root);

  if (root.dataset.eventsWired) return;
  root.dataset.eventsWired = 'true';

  root.addEventListener('click', async (e) => {
    // ---- Kategorie auf-/zuklappen (#1039) ----
    // Eigener, frueher Zweig statt eines weiteren [data-action]-Falls: die
    // uebrigen Aktionen loesen serverseitige Aenderungen aus, dieser hier
    // toggelt nur lokal sichtbares DOM - kein `await`, kein try/catch noetig.
    const catToggle = e.target.closest('[data-category-toggle]');
    if (catToggle) {
      toggleCategoryCollapse(catToggle);
      return;
    }

    const target = e.target.closest('[data-action]');
    if (!target) {
      if (shouldIgnoreShoppingRowToggle(e.target)) return;
      const row = e.target.closest('.shopping-item');
      if (!row) return;
      const toggle = row.querySelector('[data-action="toggle-item"]');
      if (!toggle) return;
      await toggleShoppingItem(Number(row.dataset.itemId), Number(toggle.dataset.checked), container);
      return;
    }
    const action = target.dataset.action;

    // ---- Artikel abhaken ----
    if (action === 'toggle-item') {
      const id      = Number(target.dataset.id);
      const checked = Number(target.dataset.checked);
      await toggleShoppingItem(id, checked, container);
    }

    // ---- Artikel-Details (URL/Notiz) bearbeiten ----
    if (action === 'item-details') {
      openItemDetails(Number(target.dataset.id), container);
    }

    // ---- Artikel löschen (mit Undo, 5s Fenster) ----
    if (action === 'delete-item') {
      deleteItemUndoable(Number(target.dataset.id), container);
    }

    // ---- Kategorien verwalten ----
    if (action === 'manage-categories') {
      openCategoryManager(container);
    }

    // ---- Laeden verwalten (#1003) ----
    if (action === 'manage-stores') {
      openStoreManager(container);
    }

    if (action === 'import-meals') {
      openMealPlanImport(container);
    }

    if (action === 'send-list') {
      await openSendListDialog(container);
    }

    // ---- Liste umbenennen ----
    if (action === 'rename-list') {
      const newName = await promptModal(t('shopping.renameListPrompt'), state.activeList?.name ?? '');
      if (!newName || newName === state.activeList?.name) return;
      try {
        const data = await api.put(`/shopping/${state.activeListId}`, { name: newName });
        const idx  = state.lists.findIndex((l) => l.id === state.activeListId);
        if (idx >= 0) state.lists[idx].name = data.data.name;
        state.activeList = data.data;
        renderTabs(container);
        renderListContent(container);
        wireListContentEvents(container);
      } catch (err) {
        window.yuvomi.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
      }
    }

    // ---- Liste löschen ----
    //
    // Der Sicherheitsgradient war invertiert (Critique 2026-07-30, P2): ein
    // einzelner Artikel hatte Undo und keine Rückfrage, die ganze Liste des
    // Haushalts hatte eine Rückfrage und kein Undo - und die Rückfrage nannte nicht
    // einmal, wie viel sie vernichtet („Liste \"Weekly Shop\" und alle Artikel
    // löschen?" - wie viele?).
    //
    // Jetzt BEIDES, und in dieser Reihenfolge: die Rückfrage nennt die Artikelzahl,
    // danach läuft der Commit über dieselbe 5s-Rücknahme wie jede andere Löschung im
    // Modul. Redundant ist das nicht - eine Rückfrage schützt vor dem Fehlgriff, ein
    // Undo vor dem falschen Entschluss, und hier hängen die Artikel eines ganzen
    // Haushalts dran.
    if (action === 'delete-list') {
      const deletedListId = state.activeListId;
      const snapshot = {
        list: state.activeList ? { ...state.activeList } : null,
        listEntry: state.lists.find((l) => l.id === deletedListId),
        items: state.items.map((i) => ({ ...i })),
        index: state.lists.findIndex((l) => l.id === deletedListId),
      };
      // Bei 0 Artikeln eine eigene Fassung: „und 0 Artikel löschen?" ist zwar
      // richtig, liest sich aber wie ein Fehler.
      const confirmed = await confirmModal(
        state.items.length
          ? t('shopping.deleteListConfirm', { name: state.activeList?.name ?? '', count: state.items.length })
          : t('shopping.deleteListConfirmEmpty', { name: state.activeList?.name ?? '' }),
        { danger: true, confirmLabel: t('common.delete'), detail: t('shopping.deleteListConfirmDetail') },
      );
      if (!confirmed) return;

      // Optimistisch aus der Leiste nehmen und auf die Nachbarliste wechseln.
      state.lists = state.lists.filter((l) => l.id !== deletedListId);
      state.activeListId = state.lists[0]?.id ?? null;
      if (state.activeListId) {
        await switchList(state.activeListId, container);
      } else {
        state.items = [];
        state.activeList = null;
        renderTabs(container);
        renderListContent(container);
        wireListContentEvents(container);
      }

      scheduleUndoableDelete({
        message: t('shopping.deletedListToast'),
        commit: async ({ keepalive }) => {
          await api.delete(`/shopping/${deletedListId}`, { keepalive });
          // Erst wenn das Loeschen wirklich feststeht (Undo-Fenster verstrichen):
          // ein rueckgaengig gemachtes Loeschen soll den Klapp-Zustand behalten.
          try {
            localStorage.removeItem(collapsedCategoriesStorageKey(state.currentUserId, deletedListId));
          } catch { /* Privatmodus/Quota - unschaedlich, die Zeile war ohnehin verwaist */ }
        },
        restore: async (err) => {
          // Der Server hat nichts gelöscht (der Commit war aufgeschoben) - die Liste
          // muss also nur zurück in den State und an ihren alten Platz in der Leiste.
          if (snapshot.listEntry) {
            state.lists.splice(Math.max(0, snapshot.index), 0, snapshot.listEntry);
          }
          state.activeListId = deletedListId;
          state.activeList = snapshot.list;
          state.items = snapshot.items;
          renderTabs(container);
          renderListContent(container);
          wireListContentEvents(container);
          if (err) window.yuvomi.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
        },
      });
    }
  });
}

// Hier stand `wireRenameKeydown`: eine Bindung, die „Enter" auf dem Listen-Titel
// in einen Klick übersetzte. Sie war nötig, weil der Titel ein `<span
// role="button" tabindex="0">` war - ein nachgebauter Knopf, dem der Browser
// keine Tastaturbedienung schenkt. Umbenennen ist jetzt ein echter `<button>` im
// Überlaufmenü und braucht dafür keine Zeile JS.

// --------------------------------------------------------
// Kategorie-Verwaltung (kanonischer Ort, früher in Settings)
// --------------------------------------------------------

/**
 * Öffnet den Kategorie-Manager in einem Modal. Reagiert auf
 * `category-manager-changed`, um den lokalen State und die aktive Liste
 * zu aktualisieren. Schließen navigiert zurück nach /shopping (Query entfernen).
 * @param {Element} container Seiten-Container
 * @param {object}  [opts]
 * @param {boolean} [opts.fromDeepLink] true, wenn via ?manage=categories geöffnet
 */
/**
 * Laeden verwalten (#1003) - derselbe Manager wie fuer die Kategorien.
 *
 * Eine eigene Komponente waere die zweite Bauart fuer dieselbe Sache: eine
 * kurze, benannte Liste anlegen, umbenennen, loeschen. Der Manager kann das
 * bereits und braucht nur einen anderen `basePath`; deshalb hat der Server oben
 * ein PUT bekommen, das die Form spricht, die diese Komponente erwartet.
 *
 * Er haengt im Listenmenue und nicht im Artikel-Dialog: das geteilte Modal
 * kennt kein Stacking, ein Manager ueber dem Formular raeumte es weg. Angelegt
 * wird ein Laden deshalb beim Speichern des Artikels (siehe Combobox oben),
 * umbenannt und geloescht hier.
 * @param {Element} container Seiten-Container
 */
function openStoreManager(container) {
  // Die Arbeit haengt am Ereignis, nicht am Schliessen: `confirmOverModal`
  // raeumt beim Loeschen das Modal darunter gleich mit ab, das
  // `category-manager-changed` kommt also erst DANACH. Ein in onClose
  // ausgewerteter Merker stuende hier auf false, und `state.stores` boete
  // weiter einen Laden an, den es nicht mehr gibt - die naechste Speicherung
  // liefe in die 400-Antwort des Servers (gemessen 08.09.).
  const onChanged = async () => {
    await Promise.all([loadStores(), loadItems(state.activeListId)]);
    updateItemsList(container);
  };

  openModal({
    title: t('shopping.manageStores'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      if (!manager) return;
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/shopping/stores',
        titleKey: 'shopping.manageStores',
        hintKey: 'shopping.storesHint',
        // Der Standard liest "Neue Kategorie" - in einem Dialog mit dem Titel
        // "Laeden verwalten" waere das derselbe Bruch wie beim Vorrat.
        addPlaceholderKey: 'shopping.addStore',
        // Frage UND Folgentext: der Standard fragte "Kategorie ... loeschen?"
        // in einem Dialog, der "Laeden verwalten" heisst. Der Fremdschluessel
        // steht ausserdem auf SET NULL, nicht auf einer Ersatzzuordnung wie bei
        // den Kategorien dieses Moduls.
        deleteConfirmKey: 'shopping.storeDeleteConfirm',
        deleteDetailKey: 'shopping.storeDeleteConfirmDetail',
      });
    },
    // Bewusst KEIN onClose, das den Listener abmeldet: gemessen kommt das
    // Ereignis des Loeschens erst, wenn das Element schon aus dem Dokument ist
    // (confirmOverModal raeumt das Modal darunter mit ab, api.delete laeuft
    // danach weiter). Wer beim Schliessen abmeldet, verpasst genau die
    // Aenderung, die state.stores veralten laesst - und der Artikel-Dialog boete
    // danach einen Laden an, den der Server nicht mehr kennt (400 beim
    // Speichern). Das Element entsteht je Oeffnen neu und wird mit dem Overlay
    // verworfen; der Listener geht mit ihm.
  });
}

async function openCategoryManager(container, { fromDeepLink = false } = {}) {
  const { openModal } = await import('/components/modal.js');

  let changed = false;
  // Die geteilte Komponente (Audit F-15) dispatcht ohne Detail — der lokale
  // State wird nach jeder Mutation frisch vom Server geladen.
  const onCategoriesChanged = async () => {
    changed = true;
    await loadCategories();
  };

  let manager = null;
  openModal({
    title: t('shopping.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-category-manager');
      if (!manager) return;
      manager.addEventListener('category-manager-changed', onCategoriesChanged);
      manager.configure({
        basePath: '/shopping/categories',
        labelResolver: (item) => categoryLabel(item.name),
        titleKey: 'shopping.manageCategories',
        hintKey: 'settings.shoppingCategoriesHint',
        // Anders als Budget/Tasks/Kontakte loescht der Einkauf auch belegte
        // Kategorien und schiebt die Artikel auf die naechste Kategorie.
        deleteDetailKey: 'shopping.categoryDeleteConfirmDetail',
      });
    },
    onClose: () => {
      // Listener-Cleanup, damit beim Modal-Reuse kein Leak entsteht.
      manager?.removeEventListener('category-manager-changed', onCategoriesChanged);
      manager = null;
      // Bei Mutationen die sichtbare Liste neu aufbauen (Gruppierung/Quick-Add-Select).
      if (changed && state.activeList) {
        renderListContent(container);
        wireListContentEvents(container);
      }
      // Deep-Link-Query entfernen, wenn der Manager über die URL geöffnet wurde.
      if (fromDeepLink && new URLSearchParams(window.location.search).has('manage')) {
        window.yuvomi?.navigate?.('/shopping');
      }
    },
  });
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

export async function render(container, { user }) {
  state.currentUserId = user?.id ?? null;
  // Ein Seitenaufbau ist immer ein neuer Batch fuer die Sammelaktions-Pille -
  // eine Frist der vorherigen Seite darf diese hier nicht treffen (#1039).
  resetPillMachine();
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="shopping-page page-measure--narrow">
      <div class="list-tabs-bar" id="list-tabs-bar">
        <div class="skeleton skeleton-line skeleton-line--medium" style="height:36px;width:120px;border-radius:var(--radius-full)"></div>
        <div class="skeleton skeleton-line skeleton-line--short"  style="height:36px;width:80px; border-radius:var(--radius-full)"></div>
      </div>
      <div id="list-content" style="flex:1;display:flex;flex-direction:column">
        <div style="padding:var(--space-6)">
          ${[1,2,3].map(() => `
            <div class="skeleton skeleton-line skeleton-line--full" style="height:48px;margin-bottom:var(--space-2);border-radius:var(--radius-sm)"></div>
          `).join('')}
        </div>
      </div>
    </div>
  `);
  state.itemsError = null;
  try {
    // loadCategories() und loadLists() fangen selbst; der äußere catch ist das
    // Netz für alles Unerwartete und bildet es auf denselben Fehlerzustand ab,
    // statt die Ausnahme in den globalen Fehlerbildschirm laufen zu lassen.
    await Promise.all([loadCategories(), loadStores(), loadLists()]);
    if (!state.listsError && state.lists.length) {
      const listParam = parseInt(new URLSearchParams(window.location.search).get('list'), 10) || null;
      const target = listParam && state.lists.find((l) => l.id === listParam);
      state.activeListId = target ? target.id : state.lists[0].id;
      state.collapsedCategories = loadCollapsedCategories(state.currentUserId, state.activeListId);
      try {
        await loadItems(state.activeListId);
      } catch (err) {
        console.error('[Shopping] loadItems Fehler:', err);
        state.items = [];
        state.activeList = state.lists.find((l) => l.id === state.activeListId) ?? null;
        state.itemsError = err;
      }
    }
  } catch (err) {
    console.error('[Shopping] Ladefehler:', err);
    state.listsError = err;
  }

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="shopping-page page-measure--narrow">
      <h1 class="sr-only">${t('nav.shopping')}</h1>
      <!-- Die Listenwahl ist zugleich der Titel der Seite: der aktive Chip nennt
           die Liste, sein Nachbar am hinteren Ende traegt ihre Aktionen. Hier
           stand bis 2026-08-11 zusaetzlich ein page-toolbar-Kopf, der denselben
           Namen ein zweites Mal zeigte (Keine-sichtbare-Titelwiederholung-Regel,
           DESIGN.md) und mobil rund 64px kostete: /shopping lag bei 53 %
           Contentflaeche, waehrend /tasks und /budget nach ihrer Kopf-Diaet bei
           62-63 % standen.
           KEINE BACKTICKS IN DIESEM KOMMENTAR: er steht INNERHALB des
           Template-Literals, ein Backtick-Paar schliesst es und macht aus dem
           Rest ein Tagged Template ("TypeError: toolbar is not a function"). -->
      <div class="list-tabs-bar" id="list-tabs-bar"></div>
      <div id="list-content" style="flex:1;display:flex;flex-direction:column;overflow:hidden"></div>
      <button class="page-fab" id="fab-new-item" aria-label="${t('shopping.addItemLabel')}" data-dock-label="${t('newLabel.shopping')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>
    </div>
  `);

  renderKitchenTabsBar(container, '/shopping');
  renderTabs(container);
  wireTabBar(container);
  renderListContent(container);
  wireListContentEvents(container);

  findPageFab('fab-new-item')?.addEventListener('click', (e) => {
    const input = container.querySelector('#item-name-input');
    if (!input) {
      // Keine Liste aktiv → neue Liste erstellen
      container.querySelector('[data-action="new-list"]')?.click();
      return;
    }

    // Auf Touch ist das Quick-Add eingeklappt: der FAB schaltet es um, statt nur
    // ein sichtbares Feld zu fokussieren (siehe syncQuickAddDisclosure).
    if (e.currentTarget.getAttribute('aria-expanded') === 'true') {
      syncQuickAddDisclosure(container, false);
      return;
    }
    syncQuickAddDisclosure(container, true);

    // FAB = Erstell-Flow (wie Meals/Recipes): die Quick-Add-Fläche sichtbar
    // aktivieren — Scroll + Fokus + kurzer Puls als „hier entsteht das Neue".
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus();
    input.classList.add('quick-add__input--flash');
    input.addEventListener('animationend', () => input.classList.remove('quick-add__input--flash'), { once: true });
  });

  // Deep-Link: ?highlight=<id> scrollt zum Artikel
  const highlightId = parseInt(new URLSearchParams(window.location.search).get('highlight'), 10) || null;
  if (highlightId) {
    const el = container.querySelector(`[data-action="toggle-item"][data-id="${highlightId}"]`);
    if (el) {
      // Steht der Treffer in einer eingeklappten Kategorie, bleibt er bei
      // [hidden] unsichtbar, obwohl der Selektor ihn findet - ein globaler
      // Suchtreffer darf nie hinter persistiertem Zustand verschwinden.
      const rowsEl = el.closest('.list-rows');
      if (rowsEl?.hidden) {
        const toggleBtn = rowsEl.closest('.list-group')?.querySelector('[data-category-toggle]');
        if (toggleBtn) toggleCategoryCollapse(toggleBtn);
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Deep-Link: ?manage=categories öffnet den Kategorie-Manager sofort.
  if (new URLSearchParams(window.location.search).get('manage') === 'categories') {
    openCategoryManager(container, { fromDeepLink: true });
  }
}

export const __test = {
  shouldIgnoreShoppingRowToggle,
  // Mengen-Zerlegung fuer den Vorrats-Uebertrag: haengt an der Format-Locale,
  // ist also nur verhaltensgetrieben pruefbar (siehe test-shopping-ux.js).
  parseShoppingQuantity,
  // Kategorie-Einklappen (#1039): reine Schluessel-/Speicherfunktionen, ohne
  // DOM. `state` bleibt bewusst ERREICHBAR, nicht ERSETZBAR - Tests lesen und
  // schreiben ihre Felder direkt, wie beim Muster in test-health-meds.js.
  state,
  categoryStorageKey,
  collapsedCategoriesStorageKey,
  loadCollapsedCategories,
  saveCollapsedCategories,
  pruneCollapsedCategories,
  toggleCategoryCollapse,
  // Sammelaktions-Automat (#1039): eine echte, aber knapp bemessene Frist statt
  // eines Uhr-Objekts - dasselbe Muster wie beim Undo-Fenster in
  // test-ux-utils.js (dort ein `duration`-Parameter), hier als Setter, weil
  // die Frist an keiner Aufrufstelle durchgereicht wird.
  updateCheckedActions,
  resetPillMachine,
  getPillPhaseForTest: () => pillPhase,
  setPillInteractingForTest: (value) => { pillInteracting = value; },
  setBulkPillHoldMsForTest: (ms) => { BULK_PILL_HOLD_MS_OVERRIDE = ms; },
};
