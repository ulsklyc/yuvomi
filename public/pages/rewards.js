/**
 * Modul: Belohnungen (Rewards)
 * Zweck: Punkte-Übersicht je Mitglied, Prämien-Katalog mit Eltern-Freigabe und
 *        nachvollziehbarer Punkte-Verlauf. Punkte werden beim Erledigen von
 *        Aufgaben verdient (siehe Aufgaben-Modul, Feld „Punkte").
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js, /components/modal.js
 */

import { api } from '/api.js';
import { t, formatDate, getLocale, getNumberFormat } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { initials } from '/utils/initials.js';
import { getReadableTextColor, AVATAR_FALLBACK_COLOR } from '/utils/color.js';
import { openModal, closeModal, confirmModal, confirmOverModal, refocusAfterRender } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { rowActionHtml } from '/utils/row-action.js';
import { wireTablist } from '/utils/tablist.js';
import { attachSegmentIndicator } from '/utils/segment-indicator.js';
import { wireScrollFade, stagger } from '/utils/ux.js';
import { swapContent } from '/utils/content-swap.js';
import { collapseRow } from '/utils/list-motion.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateHTML, mountLoadError } from '/utils/empty-state.js';
import { renderPageColumns } from '/utils/page-layout.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { isRedeemable, nextRewardGoal } from '/utils/reward-goal.js';
import {
  formatMoney, amountPlaceholder, amountExample, amountInputProblem,
  amountToInput, currencyFractionDigits, toDecimalString,
} from '/utils/money.js';

const TABS = ['overview', 'catalog', 'ledger'];

let state = {
  tab: 'overview',
  user: null,
  overview: null,      // { balances, catalog, pendingCount, isAdmin, me }
  catalog: [],
  ledger: [],
  recentLedger: null,  // letzte Buchungen fuer die Seitenspalte der Uebersicht; null = unbekannt
  redemptions: [],     // pending requests (admin) or own requests
  participants: [],    // admin only
  ledgerFilter: null,  // user_id | null
  prevBalances: new Map(), // für Count-up: Salden vor dem letzten Neuladen
  /** Fuer wen dieses Wandtablett einloesen darf (#1209) - leer fuer jeden Menschen. */
  displayPeople: [],
  /** Taschengeld (#1734): { currency, minor_unit, accounts, candidates }; null = unbekannt. */
  money: null,
};

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Kurzer Status-Toast (nutzt das globale, per role="alert" angekündigte System). */
function toast(message, type = 'success') {
  window.yuvomi?.showToast?.(message, type);
}

/** Zahl von→zu hochzählen; bei reduced-motion sofort setzen. */
function animateCount(el, from, to) {
  if (from === to) { el.textContent = fmtPoints(to); return; }
  if (prefersReducedMotion()) { el.textContent = fmtPoints(to); return; }
  const start = performance.now();
  const dur = Math.min(900, 250 + Math.abs(to - from) * 6);
  el.classList.add('rw-countup--active');
  function frame(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - p) ** 3; // ease-out-cubic
    el.textContent = fmtPoints(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(frame);
    else el.classList.remove('rw-countup--active');
  }
  requestAnimationFrame(frame);
}

function runCountUps(scope) {
  scope.querySelectorAll('[data-countup]').forEach((el) => {
    const to = Number(el.dataset.countup);
    const from = Number(el.dataset.from);
    if (Number.isFinite(from) && Number.isFinite(to)) animateCount(el, from, to);
  });
}

// --------------------------------------------------------
// Formatierung & kleine Bausteine
// --------------------------------------------------------

function isAdmin() {
  return state.user?.role === 'admin';
}

/**
 * Handelt gerade ein Wandtablett (#1209)?
 *
 * Die Einloese-Knoepfe dieser Seite haengen an einem IDENTITAETS-Gate: „bin ich
 * das, oder bin ich Elternteil". Am Display trifft weder das eine noch das
 * andere zu - das Konto ist kein Mitglied, nimmt an Belohnungen nicht teil und
 * steht in keiner Liste. Ohne eine eigene Antwort verschwaende die Seite dort
 * jeden Knopf, obwohl der Server die Handlung erlaubt.
 */
function actingAsDisplay() {
  return state.user?.access_scope === 'display';
}

/**
 * Darf an diesem Tablett fuer diese Person eingeloest werden?
 *
 * DIE ANTWORT KOMMT VOM SERVER, nicht aus einer zweiten Regel hier.
 * `/displays/people` liefert `can_redeem` aus derselben Rechteaufloesung, die
 * auch die Absage der Route stellt - eine eigene Bedingung an dieser Stelle
 * waere die zweite Wahrheit, und sie liefe genau dann auseinander, wenn jemand
 * die Rechte aendert.
 */
function displayMayRedeemFor(memberId) {
  return (state.displayPeople ?? []).some((p) => p.id === memberId && p.can_redeem);
}

/**
 * Darf dieser Nutzer in Belohnungen schreiben? (#467)
 *
 * Nicht dasselbe wie `isAdmin()`: das trennt Eltern von Kindern (wer darf
 * freigeben, wer darf nur anfragen), dies trennt Schreiben von Lesen. Beide
 * gelten nebeneinander - ein Elternteil mit `rewards: read` sieht die offenen
 * Anfragen, entscheidet sie aber nicht.
 *
 * EIN DISPLAY FAELLT HIER EBENFALLS AUF `true`, und das ist richtig: seine
 * Scope-Liste ist `rewards:read` (server/display-scopes.js), und alles auf
 * dieser Seite ausser dem Einloesen ist ihm verwehrt. Die EINE Ausnahme traegt
 * der Server als benannte Schreibroute (`DISPLAY_WRITE_ROUTES`), und in der
 * Oberflaeche traegt sie `displayMayRedeemFor()` - deshalb fragt jede
 * Einloese-Stelle ZUERST `actingAsDisplay()` und erst im anderen Zweig hier.
 * Eine Ausnahme ohne diese Reihenfolge haette dem Tablett genau die zwei
 * Handlungen genommen, fuer die es aufgehaengt wurde.
 *
 * DAS EINLOESEN DER EIGENEN PUNKTE FAELLT FUER EINEN MENSCHEN MIT. Es liegt
 * nahe, es wie die eigene Erinnerungsvorlaufzeit im Schichtplan zu behandeln
 * (S-12) und stehen zu lassen - aber dort senkt der Server das noetige Niveau
 * ausdruecklich (sessionModuleAccessRequirement), und fuer
 * `/rewards/redemptions` tut er das nur fuer ein gekoppeltes Geraet. Ein
 * Knopf, der das nicht weiss, ist die teurere Auskunft.
 *
 * Selbes Muster wie readOnly() in public/pages/waste.js und schedule.js.
 */
function readOnly() {
  return isNavModuleReadOnly('rewards');
}

function fmtPoints(n) {
  return getNumberFormat().format(Number(n || 0));
}

function pointsLabel(n) {
  return `${fmtPoints(n)} ${t('rewards.pointsUnit')}`;
}

function avatar(member, size = 40) {
  const dim = `width:${size}px;height:${size}px`;
  if (member?.avatar_data || member?.user_avatar) {
    const src = member.avatar_data || member.user_avatar;
    return `<span class="rw-avatar" style="${dim}"><img src="${esc(src)}" alt="" loading="lazy"></span>`;
  }
  // Nutzerfarben kommen aus der DB und können beliebig hell sein: fest weißer
  // Text erreichte auf hellen Tönen nur 2.8:1 (gemessen: Orange #F97316).
  // getReadableTextColor wählt den kontraststärkeren Ton — dasselbe Muster wie
  // in dashboard.js, calendar.js, notes.js und user-multi-select.js.
  const color = member?.avatar_color || member?.user_color || AVATAR_FALLBACK_COLOR;
  const name = member?.display_name || member?.user_name || '';
  return `<span class="rw-avatar rw-avatar--initials" style="${dim};--rw-avatar-bg:${esc(color)};color:${getReadableTextColor(color)}">${esc(initials(name, '?'))}</span>`;
}

/**
 * Leerzustand der Belohnungen. `action` ist hier ein Objekt der geteilten
 * Grammatik ({ label, icon, className }), kein fertiges Button-Markup mehr:
 * frei mitgegebenes HTML war die Luecke, durch die der CTA an der Reihenfolge
 * und am Tonwert des Renderers vorbeikam.
 */
function emptyState(icon, title, body, action = null) {
  return emptyStateHTML({ icon, title, description: body, action: action ?? undefined });
}

function icons(scope) {
  if (window.lucide) window.lucide.createIcons({ el: scope });
}

// --------------------------------------------------------
// Datenladen
// --------------------------------------------------------

async function loadOverview() {
  // Alte Salden für den Count-up merken, bevor sie überschrieben werden.
  state.prevBalances = new Map((state.overview?.balances || []).map((b) => [b.id, b.balance]));
  const res = await api.get('/rewards/overview');
  state.overview = res.data;
  state.catalog = res.data.catalog || [];
  // WER AN DIESEM TABLETT EINLOESEN DARF (#1209). Die Uebersicht selbst
  // beantwortet das nicht: sie kennt Punktestaende, nicht Rechte, und `me` ist
  // hier das Geraet. Der Fallback ist eine LEERE Liste - ohne Antwort weiss
  // diese Seite nicht, fuer wen sie fragen darf, und kein Knopf ist die
  // richtige Richtung fuer einen Irrtum.
  if (actingAsDisplay()) {
    const people = await api.get('/displays/people').catch(() => ({ data: [] }));
    state.displayPeople = people.data ?? [];
  }
  if (isAdmin()) {
    // `kind=all`: ohne die Angabe liefert die Route nur Praemien-Anfragen (#1734).
    const r = await api.get('/rewards/redemptions?status=pending&kind=all');
    state.redemptions = r.data || [];
  } else {
    const r = await api.get('/rewards/redemptions?kind=all');
    state.redemptions = (r.data || []).filter((x) => x.user_id === state.overview.me && x.status === 'pending');
  }
}

/* TASCHENGELD (#1734). Die Antwort ist schon gefiltert: ein Kind bekommt
 * hoechstens sein eigenes Konto, Eltern alle, ein Wandtablett keins. Die Seite
 * zeigt, was ankommt, und filtert nichts nach - was ein Geschwisterkind nicht
 * sehen soll, geht gar nicht erst ueber die Leitung. Am Tablett wird nicht
 * einmal gefragt. Scheitert die Abfrage, bleibt `null` und der Abschnitt
 * entfaellt: eine leere Liste hiesse "es gibt kein Taschengeld". */
async function loadMoney() {
  if (actingAsDisplay()) { state.money = null; return; }
  try {
    state.money = (await api.get('/rewards/money')).data;
  } catch {
    state.money = null;
  }
}

async function loadCatalog() {
  const res = await api.get(`/rewards/catalog${isAdmin() ? '?all=1' : ''}`);
  state.catalog = res.data || [];
}

async function loadLedger() {
  const q = state.ledgerFilter ? `?user_id=${encodeURIComponent(state.ledgerFilter)}` : '';
  const res = await api.get(`/rewards/ledger${q}`);
  state.ledger = res.data || [];
}

/* Die letzten Buchungen fuer die Seitenspalte der Uebersicht - ungefiltert,
 * unabhaengig vom Filter des Verlaufs-Reiters. Scheitert die Abfrage, bleibt
 * der Wert `null` und die Spalte entfaellt: eine leere Liste hiesse "es gibt
 * keine Buchungen", und das weiss die Seite dann gerade nicht. */
const RECENT_LEDGER_ROWS = 6;

async function loadRecentLedger() {
  try {
    const res = await api.get(`/rewards/ledger?limit=${RECENT_LEDGER_ROWS}`);
    state.recentLedger = (res.data || []).slice(0, RECENT_LEDGER_ROWS);
  } catch {
    state.recentLedger = null;
  }
}

function balances() {
  return state.overview?.balances || [];
}

function balanceOf(userId) {
  return balances().find((b) => b.id === userId)?.balance ?? 0;
}

// --------------------------------------------------------
// Shell + Tabs
// --------------------------------------------------------

function tabButton(tab, icon, label) {
  const on = state.tab === tab;
  return `
    <button class="rw-tab sub-tab${on ? ' sub-tab--active' : ''}" type="button" role="tab"
            data-tab-id="${esc(tab)}" aria-controls="rewards-content"
            aria-selected="${on ? 'true' : 'false'}"${on ? ' aria-current="page"' : ''} tabindex="${on ? '0' : '-1'}">
      <i class="sub-tab__icon" data-lucide="${esc(icon)}" aria-hidden="true"></i>
      <span class="sub-tab__label">${esc(label)}</span>
    </button>`;
}

// Kontext-FAB: eine Primäraktion unten rechts, die dem aktiven Tab folgt.
let fab = null;

// FAB-Aktion je Tab setzen (nur Admins erstellen; sonst ausgeblendet).
function updateRewardsFab() {
  if (!fab) return;
  // Ausgeblendet behaelt der Knopf sein Nomen: der Router dockt ihn am Desktop
  // nur beim Seitenaufbau und nur mit `data-dock-label` an (siehe health.js).
  const keepNoun = () => fab.dataset?.dockLabel || t('newLabel.rewards');
  if (readOnly()) { setPageFabAction(fab, { hidden: true, dockLabel: keepNoun() }); return; }
  if (state.tab === 'catalog' && isAdmin()) {
    setPageFabAction(fab, { label: t('rewards.addReward'), dockLabel: t('newLabel.rewards'), onClick: () => openRewardModal(null) });
  } else if (state.tab === 'ledger' && isAdmin()) {
    setPageFabAction(fab, { label: t('rewards.grantBonus'), dockLabel: t('newLabel.rewardsBonus'), onClick: () => openBonusModal() });
  } else {
    setPageFabAction(fab, { hidden: true, dockLabel: keepNoun() });
  }
}

function renderShell(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="rewards-page app-page app-page--dashboard app-page--columns" data-composition="dashboard">
      <header class="page-toolbar page-toolbar--narrow rewards-toolbar">
        <h1 class="page-toolbar__title" id="rewards-title">${esc(t('rewards.title'))}</h1>
        <div class="page-toolbar__actions"></div>
        <nav class="rewards-tabs page-toolbar__bar" role="tablist" aria-label="${esc(t('rewards.title'))}">
          ${tabButton('overview', 'trophy', t('rewards.tabOverview'))}
          ${tabButton('catalog', 'gift', t('rewards.tabCatalog'))}
          ${tabButton('ledger', 'history', t('rewards.tabLedger'))}
        </nav>
      </header>
      <div class="rewards-content" id="rewards-content"></div>
    </div>`);

  wireTablist(container.querySelector('.rewards-tabs'), {
    activeId: state.tab,
    onChange: (id, { direction = 0 } = {}) => { state.tab = id; renderCurrentTab(container, { direction }); },
  });
  // Geteilte gleitende Kapsel (Re-Critique 2026-09-27, D8); `key`, weil die
  // Seite den Kopf bei jedem Aufruf neu baut.
  attachSegmentIndicator(container.querySelector('.rewards-tabs'), { key: 'rewards-tabs' });
  // Scroll-Affordanz der Bar-Zeile (geteilter Peek-Fade, .page-toolbar__bar).
  wireScrollFade(container.querySelector('.rewards-tabs'));
  fab = createPageFab({ id: 'rewards-fab', dockLabel: t('newLabel.rewards') });
  container.querySelector('.rewards-page').appendChild(fab);
  updateRewardsFab();
  icons(container);
}

function content() {
  return document.getElementById('rewards-content');
}

/* EINE KANTE FUER ALLE DREI REITER (Critique R16, 2026-10-05). Der Kopf
 * folgte hier dem Reiter (`--wide` nur im Katalog): die angedockte Pille stand
 * im Katalog bei 1408 und im Verlauf bei 972 (1440er Fenster), sie sprang beim
 * Reiterwechsel um 431px. Die Seite fuehrt jetzt das breite Mass (`dashboard`),
 * der Kopf endet in jedem Reiter an der Modulkante, und Uebersicht und Verlauf
 * fuellen die Flaeche mit einer Seitenspalte (`.page-columns`, layout.css)
 * statt den Kopf zu sich zu ziehen. */

/* DAS SKELETT GEHOERT ZUM ERSTEN LADEN, NICHT ZU JEDEM WECHSEL (Critique R16,
 * P2 Bewegung). Hier wurde der Traeger bei JEDEM Aufruf geleert und ein
 * Skelett gezeigt - beim Reiterwechsel und nach jeder Buchung, Freigabe oder
 * Ablehnung. Die Seite blitzte dreimal je Handlung: Inhalt, Skelett, Inhalt.
 * Jetzt bleibt stehen, was da ist, bis die Antwort kommt:
 *   - erster Aufbau der Seite: Skelett, dann gestaffelt einblenden;
 *   - Reiterwechsel (`direction`): der neue Reiter blendet in Schrittrichtung
 *     ein (utils/content-swap.js);
 *   - Auffrischen nach einer Handlung: Tausch ohne Blende - die Bewegung traegt
 *     dort die betroffene Zeile selbst (`collapseRow` in decideRedemption).
 * `renderSeq` verwirft eine Antwort, die ein spaeterer Wechsel ueberholt hat. */
let renderSeq = 0;
/** Traeger, die schon einmal Inhalt gezeigt haben (ueberlebt keinen Seitenneubau). */
const filledHosts = new WeakSet();

async function renderCurrentTab(container, { direction = null } = {}) {
  const el = content();
  if (!el) return;
  const seq = ++renderSeq;
  const first = !filledHosts.has(el);
  if (first) {
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 3 }));
  }
  const tab = state.tab;
  try {
    if (tab === 'overview') await Promise.all([loadOverview(), loadRecentLedger(), loadMoney()]);
    else if (tab === 'catalog') await Promise.all([loadCatalog(), loadOverview()]);
    else await Promise.all([loadLedger(), loadOverview()]);
    if (seq !== renderSeq) return;
    const draw = () => {
      if (tab === 'overview') renderOverview(el);
      else if (tab === 'catalog') renderCatalog(el);
      else renderLedger(el);
    };
    swapContent(el, draw, { direction: direction ?? 0, animate: !first && direction !== null });
    filledHosts.add(el);
    if (first) stagger(el.querySelectorAll('.rw-pending, .rw-standing, .rw-reward-card, .rw-ledger-row'), { host: el });
  } catch (err) {
    if (seq !== renderSeq) return;
    // War ein Leerzustand ohne Rolle und ohne Ausweg - der gefangene Fehler
    // wurde nicht einmal gelesen. Jetzt traegt er den Statuscode und einen
    // Wiederholen-CTA auf denselben Tab.
    mountLoadError(el, {
      title: t('rewards.loadError'),
      description: t('common.loadErrorDescription'),
      error: err,
      retryLabel: t('common.retry'),
      onRetry: () => renderCurrentTab(container),
    });
  }
  updateRewardsFab();
}

// --------------------------------------------------------
// Tab: Übersicht
// --------------------------------------------------------

// Vergriffen-Regel und Zielwahl stehen in /utils/reward-goal.js - das
// Dashboard-Widget zeichnet denselben Balken und darf kein anderes Ziel nennen.
function nextRewardHint(balance) {
  // EIN MINUS STEHT NIE OHNE SATZ DA (#1607). Der Saldo kann unter null
  // fallen, wenn eine Aufgabe wieder geoeffnet wird, deren Punkte schon in
  // einer Praemie stecken. "Noch 110 bis Kinoabend" waere dann zwar richtig
  // gerechnet, erklaerte aber die Zahl daneben nicht. Der Satz sagt, was sie
  // bedeutet und dass sie von selbst wieder verschwindet - auch ohne Katalog,
  // deshalb steht er vor der Zielsuche. Der Balken bleibt bei 0.
  if (Number(balance) < 0) return { pct: 0, label: t('rewards.balanceBelowZero') };
  const goal = nextRewardGoal(balance, state.catalog);
  if (!goal) return null;
  if (goal.reached) return { pct: 100, label: t('rewards.canRedeemNow') };
  return {
    pct: goal.pct,
    label: t('rewards.remainingToReward', { points: fmtPoints(goal.missing), reward: goal.target.name }),
  };
}

// Label für die einlöse-auslösende Aktion: Nicht-Admins stellen eine Anfrage
// (Eltern-Freigabe nötig), Admins lösen direkt ein.
function redeemVerb() {
  return isAdmin() ? t('rewards.redeem') : t('rewards.request');
}

// Punktestände als gleichwertige Zeilenliste (bewusst flach, keine Rangliste-
// Hierarchie) — klar unterscheidbar vom Prämien-Kartengitter. Der Öffner ist ein
// echter Button (Tastatur/Screenreader), die Einlöse-Aktion separat daneben.
// Reicht der Saldo fuer IRGENDEINE aktive Praemie? Die Frage, die der
// Einloese-Knopf in der Punktestandzeile beantworten muss - `affordabilityFor`
// beantwortet sie fuer eine EINZELNE Praemie im Katalog.
function canAffordAny(balance) {
  return (state.catalog || []).some((c) => isRedeemable(c) && c.cost <= balance);
}

function renderStandingRow(member) {
  const hint = nextRewardHint(member.balance);
  const canRedeem = actingAsDisplay()
    ? displayMayRedeemFor(member.id)
    : (!readOnly() && (isAdmin() || member.id === state.overview.me));
  /* DIE DECKUNG WAR NIE GEPRUEFT. `canRedeem` oben ist ein IDENTITAETS-Gate
   * (bin ich das, oder bin ich Elternteil), kein Kontostand. Emma sah mit 30
   * Punkten einen aktiven "Einloesen"-Knopf, waehrend die billigste Praemie 40
   * kostet - sie tippt und findet einen Katalog, in dem nichts geht, ohne einen
   * Satz, der das erklaert (Critique 2026-08-13). Die Pruefung gab es 150
   * Zeilen weiter im Katalog laengst; sie war hier nur nie angewandt.
   * Den Grund sagt die Zeile selbst schon: "Noch 10 bis 'Eine Stunde zocken'"
   * steht daneben und wandert in das aria-label des gesperrten Knopfes. */
  const affordable = isAdmin() || canAffordAny(member.balance);
  const prev = state.prevBalances?.get(member.id);
  const startVal = typeof prev === 'number' ? prev : member.balance;
  return `
    <li class="list-row rw-standing">
      <button class="rw-standing__id" type="button" data-member="${member.id}"
              aria-label="${esc(`${member.display_name}, ${pointsLabel(member.balance)}. ${t('rewards.openDetails')}`)}">
        ${avatar(member, 40)}
        <span class="rw-standing__idtext">
          <span class="rw-standing__name">${esc(member.display_name)}</span>
          <span class="rw-standing__points"><strong data-countup="${member.balance}" data-from="${startVal}">${fmtPoints(startVal)}</strong> ${esc(t('rewards.pointsUnit'))}</span>
        </span>
      </button>
      <div class="rw-standing__progress">
        ${hint ? `
          <!-- DER BALKEN IST EIN PROGRESSBAR (Critique 2026-08-10). Er hatte
               weder Rolle noch Wert: die Textzeile darunter rettete die
               Information, der Balken selbst existierte fuer Screenreader
               nicht. aria-valuetext traegt dieselbe Zeile, damit die Ansage
               "37 von 60 Punkten" lautet und nicht "62 Prozent" - der Prozent-
               wert ist hier die Ableitung, nicht die Aussage. -->
          <div class="rw-progress__track" role="progressbar"
               aria-label="${esc(t('rewards.progressLabel'))}"
               aria-valuenow="${Math.round(Math.max(0, Math.min(100, hint.pct)))}"
               aria-valuemin="0" aria-valuemax="100"
               aria-valuetext="${esc(hint.label)}"><div class="rw-progress__fill" style="--rw-progress:${Math.max(0, Math.min(1, hint.pct / 100))}"></div></div>
          <p class="rw-progress__label" aria-hidden="true">${esc(hint.label)}</p>`
        : `<p class="rw-progress__label rw-progress__label--muted">${esc(t('rewards.noRewardsYet'))}</p>`}
      </div>
      ${canRedeem ? `
        <div class="rw-standing__actions">
          <button class="btn btn--secondary btn--sm rw-redeem-open" type="button" data-member="${member.id}"
                  ${affordable ? '' : `disabled aria-label="${esc(`${redeemVerb()}. ${hint?.label ?? ''}`)}"`}>
            <i data-lucide="gift" aria-hidden="true"></i>${esc(redeemVerb())}
          </button>
        </div>` : ''}
    </li>`;
}

// Eltern-Ersteinrichtung: drei Schritte an einem Ort, bis alle erledigt sind.
function renderSetupHints() {
  // Drei Schritte, die alle etwas ANLEGEN. Eine Aufforderung einzurichten,
  // ohne einrichten zu duerfen, ist die leere Zusage aus #700.
  if (!isAdmin() || readOnly()) return '';
  const s = state.overview?.setup;
  if (!s) return '';
  const steps = [
    { done: s.participantCount > 0, label: t('rewards.setupStep1'), action: 'participants' },
    { done: s.pointedTaskCount > 0, label: t('rewards.setupStep2'), action: 'tasks' },
    { done: s.catalogCount > 0, label: t('rewards.setupStep3'), action: 'catalog' },
  ];
  if (steps.every((step) => step.done)) return '';
  const items = steps.map((step) => `
    <li class="rw-setup-step${step.done ? ' rw-setup-step--done' : ''}">
      <i class="rw-setup-step__mark" data-lucide="${step.done ? 'check-circle-2' : 'circle'}" aria-hidden="true"></i>
      <span class="rw-setup-step__label">${esc(step.label)}</span>
      ${step.done ? '' : `<button class="rw-setup-step__go" type="button" data-setup="${step.action}">${esc(t('rewards.setupGo'))}</button>`}
    </li>`).join('');
  return `
    <section class="rw-section rw-setup" aria-labelledby="rw-setup-title">
      <h2 class="rw-section__title u-section-title" id="rw-setup-title">${esc(t('rewards.setupTitle'))}</h2>
      <ol class="rw-setup-list">${items}</ol>
    </section>`;
}

function renderPendingPanel() {
  if (!state.redemptions.length) return '';
  const heading = isAdmin() ? t('rewards.pendingApprovals') : t('rewards.yourPending');
  /* EIN HINWEIS, KEINE SPERRE (#1607). Faellt der Saldo nach dem Stellen der
   * Anfrage unter null (die Aufgabe dahinter wurde wieder geoeffnet), bleibt
   * die Anfrage offen und die Entscheidung bei den Eltern - aber sie sollen
   * sie nicht blind treffen. Der Satz steht nur bei wem er zutrifft und nur
   * fuer die, die entscheiden; das Kind liest denselben Stand in seiner
   * eigenen Zeile darunter. */
  /* DER SALDO KOMMT MIT DER ANFRAGE (#1623). `overview.balances` fuehrt nur,
   * wer gerade teilnimmt; wer mit offener Anfrage ausgetragen wurde, fiel dort
   * heraus, `balanceOf()` sagte 0 und der Hinweis fehlte genau dann. Der
   * Rueckgriff bleibt fuer eine Antwort ohne das Feld (aelterer Server hinter
   * einer frischen Oberflaeche). */
  const belowZero = (r) => {
    const bal = r.user_balance != null && Number.isFinite(Number(r.user_balance))
      ? Number(r.user_balance) : balanceOf(r.user_id);
    return isAdmin() && bal < 0
      ? `<p class="rw-pending__meta">${esc(t('rewards.pendingBalanceBelowZero', { points: fmtPoints(bal) }))}</p>`
      : '';
  };
  /* EINE GELD-ANFRAGE STEHT IN DERSELBEN LISTE (#1734): Abhebung oder
   * Einzahlung, mit Betrag statt Punkten. Wer entscheidet, liest daneben das
   * Guthaben - die Freigabe ist der Moment, in dem das Bargeld den Besitzer
   * wechselt. */
  const title = (r) => (isMoneyRequest(r)
    ? esc(t(r.kind === 'deposit' ? 'rewards.money.ledgerDeposit' : 'rewards.money.ledgerWithdrawal'))
    : `${esc(r.reward_icon ? `${r.reward_icon} ` : '')}${esc(r.reward_name)}`);
  const amount = (r) => (isMoneyRequest(r) ? fmtMoney(r.cost, r) : pointsLabel(r.cost));
  const moneyBalance = (r) => (isMoneyRequest(r) && isAdmin() && r.user_balance != null
    ? `<p class="rw-pending__meta">${esc(t('rewards.money.title'))}: ${esc(fmtMoney(r.user_balance, r))}</p>`
    : '');
  const rows = state.redemptions.map((r) => `
    <li class="rw-pending" data-redemption="${r.id}">
      ${avatar(r, 32)}
      <div class="rw-pending__text">
        <p class="rw-pending__title">${title(r)}</p>
        <p class="rw-pending__meta">${esc(isAdmin() ? r.user_name : '')}${isAdmin() ? ' · ' : ''}${esc(amount(r))}${r.note ? ` · „${esc(r.note)}“` : ''}</p>
        ${isMoneyRequest(r) ? moneyBalance(r) : belowZero(r)}
      </div>
      ${/* DIE LISTE BLEIBT, DIE KNOEPFE GEHEN. Dass eine Anfrage offen ist, ist
            eine Auskunft und gehoert auch dem, der sie nicht entscheiden darf -
            "Genehmigen"/"Ablehnen"/"Abbrechen" sind reine Handlungen. Der
            Behaelter geht MIT: `.rw-pending__actions` ist eine Flex-Box mit
            `gap`, und eine leere waere eine Spalte fuer nichts. */ ''}
      ${readOnly() ? '' : `
      <div class="rw-pending__actions">
        ${isAdmin() ? `
          <button class="btn btn--primary btn--sm" type="button" data-decide="fulfill" data-id="${r.id}">${esc(t('rewards.approve'))}</button>
          <button class="btn btn--ghost btn--sm" type="button" data-decide="reject" data-id="${r.id}">${esc(t('rewards.reject'))}</button>
        ` : `
          <button class="btn btn--secondary btn--sm" type="button" data-decide="cancel" data-id="${r.id}">${esc(t('common.cancel'))}</button>
        `}
      </div>`}
    </li>`).join('');
  /* DER KOPF STEHT AUF DEM GRUND, NICHT IM TRAEGER (Zeilenlisten-Regel), und
   * die Dringlichkeit steht als ZAHL daneben statt als Farbfeld darunter.
   * `.rw-pending-panel` war die vollflaechig getoente Karte der Seite: der
   * lauteste Kanal der App fuer die Aussage "eine Anfrage wartet", und sie
   * zwang den violetten Primaerknopf auf einen gruenen Grund. Der Zaehler ist
   * dasselbe Vokabular, das die Zeilengruppen schon fuehren. */
  return `
    <section class="rw-section">
      <h2 class="rw-section__title u-section-title">${esc(heading)}<span class="list-group__count">${state.redemptions.length}</span></h2>
      <ul class="rw-pending-list rw-pending-panel">${rows}</ul>
    </section>`;
}

function renderOverview(el) {
  el.replaceChildren();
  const list = balances();
  if (!list.length) {
    const action = isAdmin() && !readOnly()
      ? { label: t('rewards.manageParticipants'), icon: 'user-plus', className: 'rw-manage-participants' }
      : null;
    /* DAS ANFRAGEN-PANEL HAENGT NICHT AN DEN PUNKTESTAENDEN (#1623). Wird die
     * letzte Teilnehmende mit offener Anfrage ausgetragen, ist `balances` leer -
     * und die Anfrage trotzdem da. Ohne das Panel hier konnte niemand sie
     * sehen oder entscheiden. Es steht VOR dem Leerzustand: das Dringende
     * zuerst, wie in der gefuellten Uebersicht. Nur-lesen regelt das Panel
     * selbst (Liste bleibt, Knoepfe gehen). */
    el.insertAdjacentHTML('beforeend',
      `<div class="rewards-content__inner">${renderPageColumns({
        main: `${renderPendingPanel()}${renderMoneySection()}${emptyState('trophy', t('rewards.emptyOverviewTitle'), isAdmin() ? t('rewards.emptyOverviewAdmin') : t('rewards.emptyOverviewMember'), action)}`,
        rail: renderRecentLedger(),
      })}</div>`);
    wireOverview(el);
    icons(el);
    return;
  }
  const adminBar = isAdmin() && !readOnly() ? `
    <button class="btn btn--ghost btn--sm rw-manage-participants" type="button"><i data-lucide="users-round" aria-hidden="true"></i>${esc(t('rewards.manageParticipants'))}</button>` : '';
  // Anfragen und Punktestaende links, die letzten Buchungen ab der
  // Split-Schwelle rechts daneben (mobil darunter) - `.page-columns`.
  el.insertAdjacentHTML('beforeend', `
    <div class="rewards-content__inner">
      ${renderPageColumns({
        main: `
      ${renderSetupHints()}
      ${renderPendingPanel()}
      ${renderMoneySection()}
      <section class="rw-section">
        <div class="rw-section__head">
          <h2 class="rw-section__title u-section-title">${esc(t('rewards.standings'))}</h2>
          ${adminBar}
        </div>
        <ul class="row-carrier rw-standings">${list.map(renderStandingRow).join('')}</ul>
      </section>`,
        rail: renderRecentLedger(),
      })}
    </div>`);
  wireOverview(el);
  icons(el);
  runCountUps(el);
}

function wireOverview(el) {
  el.querySelector('.rw-section__more')?.addEventListener('click', () => {
    document.querySelector('.rewards-tabs [data-tab-id="ledger"]')?.click();
  });
  el.querySelector('.rw-manage-participants')?.addEventListener('click', openParticipantsModal);
  el.querySelectorAll('.rw-redeem-open').forEach((btn) => {
    btn.addEventListener('click', () => openRedeemModal(Number(btn.dataset.member)));
  });
  el.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.addEventListener('click', () => decideRedemption(Number(btn.dataset.id), btn.dataset.decide, btn));
  });
  el.querySelectorAll('.rw-standing__id').forEach((btn) => {
    btn.addEventListener('click', () => openMemberDetail(Number(btn.dataset.member)));
  });
  el.querySelectorAll('[data-setup]').forEach((btn) => {
    btn.addEventListener('click', () => handleSetupStep(btn.dataset.setup));
  });
  wireMoney(el);
}

function handleSetupStep(action) {
  if (action === 'participants') openParticipantsModal();
  else if (action === 'tasks') location.href = '/tasks';
  // `data-tab-id` ist das Attribut der Reiter (tabButton); hier stand
  // `data-rw-tab`, das es nie gab - der Schritt „Praemien anlegen" tat nichts.
  else if (action === 'catalog') document.querySelector('.rewards-tabs [data-tab-id="catalog"]')?.click();
}

// --------------------------------------------------------
// Tab: Prämien
// --------------------------------------------------------

function affordabilityFor(cost) {
  // Für Nicht-Admin (eigener Saldo): kann ich einlösen?
  const me = state.overview?.me;
  const enrolledMe = balances().find((b) => b.id === me);
  if (isAdmin()) return { canRedeem: true, short: 0 };
  if (!enrolledMe) return { canRedeem: false, short: null };
  return { canRedeem: enrolledMe.balance >= cost, short: Math.max(0, cost - enrolledMe.balance) };
}

function renderRewardCard(item) {
  const inactive = item.is_active === 0;
  const aff = affordabilityFor(item.cost);
  // AM TABLETT TRAEGT DER KATALOG KEINEN EINLOESE-KNOPF. Er ruft die Auswahl
  // ohne Person auf - fuer einen Menschen ist das richtig, weil „ich" die
  // Antwort ist. Am Display ist es niemand, und ein Knopf, der erst nach einer
  // Person fragen muesste, waere ein zweiter Weg zu derselben Handlung. Der
  // eine Weg steht in der Personenliste, wo die Person schon feststeht.
  //
  // `readOnly()` daneben schliesst denselben Knopf aus einem anderen Grund aus:
  // ein MENSCH mit `rewards: read` darf gar nicht einloesen. Zwei Gruende, eine
  // Wirkung - deshalb stehen sie als getrennte Bedingungen und nicht als eine.
  // Vergriffen schliesst den Knopf aus demselben Grund aus wie „inaktiv": es
  // gibt nichts mehr herzugeben. Der Zustand bleibt als Etikett stehen.
  const soldOut = item.remaining === 0;
  const canRedeemBtn = !actingAsDisplay() && !readOnly()
    && !inactive && !soldOut && (isAdmin() || aff.canRedeem !== false) && (isAdmin() || balances().some((b) => b.id === state.overview?.me));
  const shortHint = !isAdmin() && aff.short != null && aff.short > 0
    ? `<span class="rw-reward-card__short">${esc(t('rewards.pointsShort', { points: fmtPoints(aff.short) }))}</span>` : '';
  const unitsLine = item.remaining > 0
    ? `<p class="rw-reward-card__units">${esc(t('rewards.unitsLeft', { n: fmtPoints(item.remaining) }))}</p>` : '';
  return `
    <article class="rw-reward-card${inactive ? ' rw-reward-card--inactive' : ''}">
      <div class="rw-reward-card__icon" aria-hidden="true">${item.icon ? esc(item.icon) : '<i data-lucide=\"gift\"></i>'}</div>
      <div class="rw-reward-card__body">
        <p class="rw-reward-card__name">${esc(item.name)}${inactive ? ` <span class="rw-tag">${esc(t('rewards.inactive'))}</span>` : ''}${soldOut ? ` <span class="rw-tag">${esc(t('rewards.soldOut'))}</span>` : ''}</p>
        ${item.description ? `<p class="rw-reward-card__desc">${esc(item.description)}</p>` : ''}
        ${unitsLine}
      </div>
      <div class="rw-reward-card__foot">
        <span class="rw-cost"><i data-lucide="coins" class="icon-md" aria-hidden="true"></i>${esc(pointsLabel(item.cost))}</span>
        <div class="rw-reward-card__actions">
          ${isAdmin() && !readOnly() ? rowActionHtml({ icon: 'pencil', label: t('common.editNamed', { name: item.name }), attrs: { 'data-edit': item.id } }) : ''}
          ${canRedeemBtn ? `<button class="btn btn--secondary btn--sm" type="button" data-redeem-item="${item.id}"><i data-lucide="gift" class="icon-md" aria-hidden="true"></i>${esc(redeemVerb())}</button>` : shortHint}
        </div>
      </div>
    </article>`;
}

function renderCatalog(el) {
  el.replaceChildren();
  const items = state.catalog || [];
  // „Praemien" unter dem Reiter „Praemien" nennt die Ebene ein zweites Mal:
  // die Ueberschrift haelt die Gliederung, sie steht nicht da (`.sr-only`,
  // test-typography.js). Bis R16 trug sie ein Icon vor dem Wort - genau das
  // machte den Guard blind, und am Desktop stand der Titel sichtbar da.
  const header = isAdmin() ? `
      <h2 class="sr-only">${esc(t('rewards.tabCatalog'))}</h2>` : '';
  if (!items.length) {
    const action = isAdmin() && !readOnly()
      ? { label: t('rewards.addReward'), icon: 'plus', className: 'rw-add-reward' }
      : null;
    el.insertAdjacentHTML('beforeend',
      `<div class="rewards-content__inner">${emptyState('gift', t('rewards.emptyCatalogTitle'), isAdmin() ? t('rewards.emptyCatalogAdmin') : t('rewards.emptyCatalogMember'), action)}</div>`);
  } else {
    el.insertAdjacentHTML('beforeend', `
      <div class="rewards-content__inner">
        <section class="rw-section rw-section--wide">
          ${header}
          <div class="rw-reward-grid">${items.map(renderRewardCard).join('')}</div>
        </section>
      </div>`);
  }
  el.querySelector('.rw-add-reward')?.addEventListener('click', () => openRewardModal(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    openRewardModal(items.find((x) => x.id === Number(b.dataset.edit)));
  }));
  el.querySelectorAll('[data-redeem-item]').forEach((b) => b.addEventListener('click', () => {
    openRedeemModal(null, Number(b.dataset.redeemItem));
  }));
  icons(el);
}

// --------------------------------------------------------
// Tab: Verlauf
// --------------------------------------------------------

const LEDGER_ICON = {
  earn: 'check-circle', bonus: 'sparkles', redeem: 'gift', adjust: 'sliders-horizontal', reversal: 'undo-2',
};

/* EINE GEGENBUCHUNG TRAEGT DENSELBEN TITEL WIE IHRE GUTSCHRIFT (#1607) - und
 * ohne eigenen Satz staenden im Verlauf zwei Zeilen "Zimmer aufraeumen", eine
 * mit Plus und eine mit Minus, ohne dass eine sagt, was geschehen ist.
 * `reversal` allein unterscheidet sie nicht: die Rueckbuchung einer
 * abgelehnten Einloesung ist derselbe Typ, gibt aber Punkte ZURUECK. Das
 * Vorzeichen ist die Unterscheidung, die auch dann haelt, wenn die Aufgabe
 * laengst geloescht ist und `task_id` leer zurueckkommt. */
function isTaskReopened(row) {
  return row.type === 'reversal' && row.delta < 0;
}

function ledgerReason(row) {
  if (isTaskReopened(row)) {
    return row.reason
      ? t('rewards.ledgerTaskReopenedNamed', { task: row.reason })
      : t('rewards.ledgerTaskReopened');
  }
  if (row.reason) return row.reason;
  return t(`rewards.ledgerType.${row.type}`);
}

/** Eine Buchungszeile - der Verlauf und die Seitenspalte der Uebersicht teilen sie.
 * Sie ist eine `.list-row` im `.row-carrier` (list-row.css): Zeichen | Grund +
 * Meta | Punkte. Bis R16 baute rewards.css Traeger, Zeile, Trennlinie und
 * Schnitt als `.rw-ledger*` ein zweites Mal nach. */
function ledgerRowHtml(row) {
  const positive = row.delta > 0;
  return `
      <li class="list-row rw-ledger-row">
        <span class="rw-ledger-row__icon rw-ledger-row__icon--${esc(row.type)}"><i data-lucide="${LEDGER_ICON[row.type] || 'circle'}" aria-hidden="true"></i></span>
        <div class="list-row__main">
          <p class="list-row__name rw-ledger-row__reason">${esc(ledgerReason(row))}</p>
          <p class="list-row__meta rw-ledger-row__meta">${esc(row.user_name)} · ${esc(formatDate(row.created_at))}</p>
        </div>
        <span class="rw-delta ${positive ? 'rw-delta--pos' : 'rw-delta--neg'}">${positive ? '+' : '−'}${fmtPoints(Math.abs(row.delta))}</span>
      </li>`;
}

/* Seitenspalte der Uebersicht: die letzten Buchungen, derselbe Baustein wie im
 * Reiter Verlauf, gekappt. Der Abschnittstitel ist der Weg dorthin (der Name
 * des Reiters, mit Pfeil) - kein zweiter Knopf, kein neuer Text. Ohne Buchung
 * oder ohne Antwort entfaellt die Spalte. */
function renderRecentLedger() {
  const rows = state.recentLedger;
  if (!rows?.length) return '';
  return `
      <section class="rw-section rw-recent">
        <h2 class="rw-section__title u-section-title">
          <button class="section-title-link rw-section__more" type="button">${esc(t('rewards.tabLedger'))}<i data-lucide="chevron-right" aria-hidden="true"></i></button>
        </h2>
        <ul class="rw-ledger row-carrier">${rows.map(ledgerRowHtml).join('')}</ul>
      </section>`;
}

/* Seitenspalte des Verlaufs: die Punktestaende in Kurzform (Person, Punkte) -
 * dieselbe Zeile wie in der Uebersicht ohne Fortschritt und Einloesen; der
 * Tipp oeffnet dasselbe Mitglieds-Detail. */
function renderBalancesRail() {
  const list = balances();
  if (!list.length) return '';
  const rows = list.map((member) => `
          <li class="list-row rw-standing rw-standing--compact">
            <button class="rw-standing__id" type="button" data-member="${member.id}"
                    aria-label="${esc(`${member.display_name}, ${pointsLabel(member.balance)}. ${t('rewards.openDetails')}`)}">
              ${avatar(member, 40)}
              <span class="rw-standing__idtext">
                <span class="rw-standing__name">${esc(member.display_name)}</span>
                <span class="rw-standing__points"><strong>${fmtPoints(member.balance)}</strong> ${esc(t('rewards.pointsUnit'))}</span>
              </span>
            </button>
          </li>`).join('');
  return `
      <section class="rw-section">
        <h2 class="rw-section__title u-section-title">${esc(t('rewards.standings'))}</h2>
        <ul class="row-carrier rw-standings">${rows}</ul>
      </section>`;
}

function renderLedger(el) {
  el.replaceChildren();
  const filterChips = [{ id: null, label: t('rewards.all') }]
    .concat(balances().map((b) => ({ id: b.id, label: b.display_name })))
    // Kanon-Filterchip (Re-Critique 2026-09-28 P2-6): vorher `.rw-chip`, 31px
    // hoch und ohne aria-pressed - der Screenreader hoerte nicht, wer gefiltert ist.
    .map((c) => {
      const on = (state.ledgerFilter ?? null) === c.id;
      return `<button class="filter-chip filter-chip--sm${on ? ' filter-chip--active' : ''}" type="button" data-filter="${c.id ?? ''}" aria-pressed="${on}">${esc(c.label)}</button>`;
    })
    .join('');
  // Bonus vergeben läuft über den Kontext-FAB (Ledger-Tab, Admin); kein Inline-Button.
  const adminBar = '';

  const rows = state.ledger.map(ledgerRowHtml).join('');

  // Die Buchungen links, die Punktestaende als Seitenspalte: neben der Liste
  // der Bewegungen steht, worauf sie sich summieren.
  el.insertAdjacentHTML('beforeend', `
    <div class="rewards-content__inner">
      ${renderPageColumns({
        main: `
      <section class="rw-section">
        <div class="rw-section__head">
          <div class="rw-chips">${filterChips}</div>
          ${adminBar}
        </div>
        ${state.ledger.length
          ? `<ul class="rw-ledger row-carrier">${rows}</ul>`
          : emptyState('history', t('rewards.emptyLedgerTitle'), t('rewards.emptyLedgerBody'))}
      </section>`,
        rail: renderBalancesRail(),
      })}
    </div>`);
  el.querySelectorAll('.rw-standing__id').forEach((btn) => {
    btn.addEventListener('click', () => openMemberDetail(Number(btn.dataset.member)));
  });

  el.querySelectorAll('[data-filter]').forEach((chip) => chip.addEventListener('click', async () => {
    const val = chip.dataset.filter;
    state.ledgerFilter = val === '' ? null : Number(val);
    await loadLedger();
    renderLedger(el);
  }));
  icons(el);
}

// --------------------------------------------------------
// Aktionen: Einlösen, Entscheiden, Bonus, Prämie, Teilnehmer
// --------------------------------------------------------

function enrolledMembers() {
  return balances();
}

async function openRedeemModal(memberId, presetItemId = null) {
  // AM TABLETT NICHT: dort ist dies der eine erlaubte Schreibweg, und ob er
  // fuer DIESE Person offen steht, hat `displayMayRedeemFor()` am Knopf schon
  // beantwortet - mit der Antwort des Servers, nicht mit einer zweiten Regel.
  if (!actingAsDisplay() && readOnly()) return;
  const members = enrolledMembers();
  const me = state.overview?.me;
  const defaultMember = memberId ?? (members.some((m) => m.id === me) ? me : members[0]?.id) ?? null;
  const affordable = (state.overview?.catalog || []).filter(isRedeemable);
  if (!affordable.length) { await confirmModal(t('rewards.emptyCatalogMember'), { confirmLabel: t('rewards.gotIt') }); return; }

  const memberSelect = (isAdmin() && members.length > 1)
    ? `<div class="form-group">
         <label class="label" for="rw-redeem-member">${esc(t('rewards.member'))}</label>
         <select class="input" id="rw-redeem-member">
           ${members.map((m) => `<option value="${m.id}" ${m.id === defaultMember ? 'selected' : ''}>${esc(m.display_name)} · ${esc(pointsLabel(m.balance))}</option>`).join('')}
         </select>
       </div>` : `<input type="hidden" id="rw-redeem-member" value="${defaultMember ?? ''}">`;

  const rewardSelect = `
    <div class="form-group">
      <label class="label" for="rw-redeem-item">${esc(t('rewards.reward'))}</label>
      <select class="input" id="rw-redeem-item">
        ${affordable.map((c) => `<option value="${c.id}" data-cost="${c.cost}" ${c.id === presetItemId ? 'selected' : ''}>${esc(c.icon ? `${c.icon} ` : '')}${esc(c.name)} - ${esc(pointsLabel(c.cost))}</option>`).join('')}
      </select>
    </div>`;

  // AM TABLETT STEHT DIE PERSON IM TITEL (#1209). Fuer einen Menschen ist „ich"
  // die Antwort und der Name waere Laerm; am Display sahen der Dialog fuer die
  // eine und der fuer die andere Person identisch aus, und beide oeffnen sich
  // aus derselben Liste heraus (im Browser gesehen). Kein neuer Locale-
  // Schluessel: der Name traegt sich selbst, das Verb steht schon da.
  const titelPerson = actingAsDisplay()
    ? (state.displayPeople ?? []).find((p) => p.id === defaultMember)?.display_name
    : null;
  openModal({
    title: titelPerson ? `${redeemVerb()} · ${titelPerson}` : redeemVerb(),
    content: `
      <form id="rw-redeem-form" novalidate>
        ${memberSelect}
        ${rewardSelect}
        <div class="rw-redeem-summary" id="rw-redeem-summary"></div>
        <div class="form-group">
          <label class="label" for="rw-redeem-note">${esc(t('rewards.noteOptional'))}</label>
          <input class="input" id="rw-redeem-note" maxlength="500" placeholder="${esc(t('rewards.notePlaceholder'))}">
        </div>
        <div id="rw-redeem-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="rw-redeem-submit">${esc(isAdmin() ? t('rewards.confirmRedeem') : t('rewards.requestAction'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const memberEl = panel.querySelector('#rw-redeem-member');
      const itemEl = panel.querySelector('#rw-redeem-item');
      const summary = panel.querySelector('#rw-redeem-summary');
      const errEl = panel.querySelector('#rw-redeem-error');
      const submit = panel.querySelector('#rw-redeem-submit');

      const refresh = () => {
        const cost = Number(itemEl.selectedOptions[0]?.dataset.cost || 0);
        const mid = Number(memberEl.value);
        const bal = balanceOf(mid);
        const after = bal - cost;
        const ok = after >= 0;
        summary.replaceChildren();
        summary.insertAdjacentHTML('beforeend', `
          <div class="rw-redeem-summary__row"><span>${esc(t('rewards.balance'))}</span><strong>${fmtPoints(bal)}</strong></div>
          <div class="rw-redeem-summary__row"><span>${esc(t('rewards.cost'))}</span><strong>−${fmtPoints(cost)}</strong></div>
          <div class="rw-redeem-summary__row rw-redeem-summary__row--total ${ok ? '' : 'rw-redeem-summary__row--neg'}"><span>${esc(t('rewards.remaining'))}</span><strong>${fmtPoints(after)}</strong></div>`);
        submit.disabled = !ok;
      };
      memberEl.addEventListener('change', refresh);
      itemEl.addEventListener('change', refresh);
      refresh();

      panel.querySelector('#rw-redeem-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        submit.disabled = true;
        try {
          await api.post('/rewards/redemptions', {
            catalog_id: Number(itemEl.value),
            user_id: Number(memberEl.value),
            note: panel.querySelector('#rw-redeem-note').value.trim() || undefined,
          });
          await closeModal({ force: true });
          toast(isAdmin() ? t('rewards.toastRedeemed') : t('rewards.toastRequested'));
          await refreshActiveTab();
          refocusAfterRender();
        } catch (err) {
          // Zwischen Dialog-Aufbau und Absenden kann die letzte Einheit weg
          // sein - ein anderes Kind war schneller. Der Server sagt das mit
          // einem Code, nicht mit einem uebersetzten Satz.
          errEl.textContent = err?.data?.reason === 'out_of_stock'
            ? t('rewards.soldOutHint')
            : (err?.message || t('rewards.redeemError'));
          errEl.hidden = false;
          submit.disabled = false;
        }
      });
    },
  });
}

async function decideRedemption(id, action, btn) {
  if (readOnly()) return;
  const gefragt = action === 'reject' || action === 'cancel';
  // Eine Geld-Anfrage hat nichts reserviert (#1734): der Satz "die Punkte
  // werden zurueckgebucht" waere bei ihr falsch.
  const geld = isMoneyRequest(state.redemptions.find((r) => r.id === id));
  if (gefragt && geld) {
    const ok = await confirmModal(
      action === 'reject' ? t('rewards.money.confirmReject') : t('rewards.money.confirmCancel'),
      { confirmLabel: action === 'reject' ? t('rewards.reject') : t('common.cancel') },
    );
    if (!ok) return;
  } else if (gefragt) {
    // Kein `danger`: der Server bucht die reservierten Punkte per `reversal`
    // zurück (routes/rewards.js), es geht also kein Guthaben verloren. Die
    // Anfrage bleibt als entschieden stehen und lässt sich neu stellen, solange
    // die Belohnung aktiv im Katalog steht - `POST /redemptions` verlangt
    // `is_active = 1`. Ist sie inzwischen gelöscht, war das Löschen der
    // Belohnung die endgültige Handlung, und die trägt ihr eigenes `danger`.
    // Rot faerben wuerde hier eine Endgueltigkeit behaupten, die die
    // Entscheidung selbst nicht hat.
    const ok = await confirmModal(
      action === 'reject' ? t('rewards.confirmReject') : t('rewards.confirmCancel'),
      { confirmLabel: action === 'reject' ? t('rewards.reject') : t('common.cancel') },
    );
    if (!ok) return;
  }
  if (btn) btn.disabled = true;
  try {
    await api.patch(`/rewards/redemptions/${id}`, { action });
    const msg = action === 'fulfill' ? t('rewards.toastApproved')
      : action === 'reject' ? t('rewards.toastRejected') : t('rewards.toastCancelled');
    toast(msg, action === 'fulfill' ? 'success' : 'default');
    // Die entschiedene Anfrage klappt aus, bevor die Liste ohne sie neu steht;
    // mit der letzten geht der ganze Abschnitt (Titel + Traeger).
    const row = btn?.closest?.('.rw-pending');
    await collapseRow(row, { group: row?.closest?.('.rw-section'), selector: '.rw-pending' });
    await refreshActiveTab();
    // Nur nach der Rueckfrage: "Einloesen" fragt nicht, schliesst also keinen
    // Dialog, und das Nachfassen griffe auf den Merker eines frueheren zurueck (#1083).
    if (gefragt) refocusAfterRender();
  } catch (err) {
    if (btn) btn.disabled = false;
    // VERGRIFFEN IST KEIN FEHLSCHLAG, SONDERN EINE ENTSCHIEDENE ANFRAGE (#1310).
    // Der Server hat sie abgelehnt und die Punkte zurueckgebucht; die Antwort
    // traegt den Grund als Code, weil sie die Sprache dieses Browsers nicht
    // kennt. Die Liste muss danach neu geladen werden - sonst stuende die
    // Anfrage hier weiter als offen, obwohl sie es nicht mehr ist.
    const vergriffen = err?.data?.reason === 'out_of_stock';
    // Reicht das Guthaben bei der Freigabe nicht mehr, bleibt die Anfrage
    // offen (#1734) - gebucht ist nichts, neu zu laden gibt es nichts.
    const ohneDeckung = err?.data?.reason === 'insufficient_funds';
    await confirmModal(vergriffen ? t('rewards.outOfStock')
      : ohneDeckung ? t('rewards.money.insufficientOnApprove') : (err?.message || t('common.error')),
    { confirmLabel: t('rewards.gotIt') });
    // Auch ohne Deckung neu laden: das Guthaben neben der Anfrage ist der
    // Stand von vor der Absage - also genau der, der sie nicht mehr erklaert.
    if (vergriffen || ohneDeckung) {
      await refreshActiveTab();
      refocusAfterRender();
    }
  }
}

function openBonusModal() {
  if (readOnly()) return;
  const members = enrolledMembers();
  if (!members.length) { confirmModal(t('rewards.emptyOverviewAdmin'), { confirmLabel: t('rewards.gotIt') }); return; }
  openModal({
    title: t('rewards.grantBonus'),
    content: `
      <form id="rw-bonus-form" novalidate>
        <div class="form-group">
          <label class="label" for="rw-bonus-member">${esc(t('rewards.member'))}</label>
          <select class="input" id="rw-bonus-member">
            ${members.map((m) => `<option value="${m.id}">${esc(m.display_name)} · ${esc(pointsLabel(m.balance))}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="label" for="rw-bonus-points">${esc(t('rewards.pointsSigned'))}</label>
          <input class="input" id="rw-bonus-points" type="number" inputmode="numeric" step="1" placeholder="10" required>
          <p class="rw-hint">${esc(t('rewards.pointsSignedHint'))}</p>
        </div>
        <div class="form-group">
          <label class="label" for="rw-bonus-reason">${esc(t('rewards.reasonOptional'))}</label>
          <input class="input" id="rw-bonus-reason" maxlength="200" placeholder="${esc(t('rewards.reasonPlaceholder'))}">
        </div>
        <div id="rw-bonus-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="rw-bonus-submit">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      panel.querySelector('#rw-bonus-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = panel.querySelector('#rw-bonus-error');
        const submit = panel.querySelector('#rw-bonus-submit');
        const delta = Math.trunc(Number(panel.querySelector('#rw-bonus-points').value));
        if (!Number.isFinite(delta) || delta === 0) {
          errEl.textContent = t('rewards.pointsSignedHint'); errEl.hidden = false; return;
        }
        submit.disabled = true; errEl.hidden = true;
        try {
          await api.post('/rewards/bonus', {
            user_id: Number(panel.querySelector('#rw-bonus-member').value),
            delta,
            reason: panel.querySelector('#rw-bonus-reason').value.trim() || undefined,
          });
          await closeModal({ force: true });
          toast(t('rewards.toastBonus'));
          await refreshActiveTab();
          refocusAfterRender();
        } catch (err) {
          errEl.textContent = err?.message || t('common.error'); errEl.hidden = false; submit.disabled = false;
        }
      });
    },
  });
}

function openRewardModal(item) {
  if (readOnly()) return;
  const isEdit = !!item;
  openModal({
    title: isEdit ? t('rewards.editReward') : t('rewards.addReward'),
    content: `
      <form id="rw-reward-form" novalidate>
        <div class="modal-grid modal-grid--2">
          <div class="form-group" style="flex:0 0 88px">
            <label class="label" for="rw-reward-icon">${esc(t('rewards.iconLabel'))}</label>
            <input class="input rw-emoji-input" id="rw-reward-icon" maxlength="4" value="${esc(item?.icon ?? '')}" placeholder="🎁">
          </div>
          <div class="form-group">
            <label class="label" for="rw-reward-name">${esc(t('rewards.nameLabel'))}${REQUIRED_MARK}</label>
            <input class="input" id="rw-reward-name" required maxlength="120" value="${esc(item?.name ?? '')}" placeholder="${esc(t('rewards.namePlaceholder'))}">
          </div>
        </div>
        <div class="form-group">
          <label class="label" for="rw-reward-cost">${esc(t('rewards.costLabel'))}${REQUIRED_MARK}</label>
          <input class="input" id="rw-reward-cost" type="number" inputmode="numeric" min="1" step="1" required value="${esc(item?.cost ?? '')}" placeholder="100">
        </div>
        <div class="form-group">
          <label class="label" for="rw-reward-quantity">${esc(t('rewards.quantityLabel'))}</label>
          <input class="input" id="rw-reward-quantity" type="number" inputmode="numeric" min="1" step="1" value="${esc(item?.quantity ?? '')}">
          <p class="rw-hint">${esc(t('rewards.quantityHint'))}</p>
        </div>
        <div class="form-group">
          <label class="label" for="rw-reward-desc">${esc(t('rewards.descLabel'))}</label>
          <textarea class="input" id="rw-reward-desc" rows="2" maxlength="500" placeholder="${esc(t('rewards.descPlaceholder'))}">${esc(item?.description ?? '')}</textarea>
        </div>
        ${isEdit ? `
          <label class="rw-switch">
            <input type="checkbox" id="rw-reward-active" ${item.is_active !== 0 ? 'checked' : ''}>
            <span>${esc(t('rewards.activeLabel'))}</span>
          </label>` : ''}
        <div id="rw-reward-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          ${isEdit ? `<button type="button" class="btn btn--danger-outline" id="rw-reward-delete">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="rw-reward-submit">${isEdit ? esc(t('common.save')) : esc(t('common.add'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      panel.querySelector('#rw-reward-delete')?.addEventListener('click', async () => {
        // confirmOverModal statt confirmModal: „Abbrechen" gibt das Belohnungs-
        // Formular unverändert zurück; bestätigt schliesst es die Frage selbst.
        const ok = await confirmOverModal(t('rewards.confirmDeleteReward', { reward: item.name }),
          { confirmLabel: t('common.delete'), danger: true, detail: t('rewards.confirmDeleteRewardDetail') });
        if (!ok) return;
        await api.delete(`/rewards/catalog/${item.id}`);
        toast(t('rewards.toastRewardDeleted'), 'default');
        await refreshActiveTab();
        refocusAfterRender();
      });
      panel.querySelector('#rw-reward-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = panel.querySelector('#rw-reward-error');
        const submit = panel.querySelector('#rw-reward-submit');
        const name = panel.querySelector('#rw-reward-name').value.trim();
        const cost = Math.trunc(Number(panel.querySelector('#rw-reward-cost').value));
        if (!name) { errEl.textContent = t('rewards.nameRequired'); errEl.hidden = false; return; }
        if (!Number.isFinite(cost) || cost < 1) { errEl.textContent = t('rewards.costRequired'); errEl.hidden = false; return; }
        // Leeres Feld heisst „unbegrenzt" und geht als `null` hinaus - dieselbe
        // Lesart, die der Server fuer Icon und Beschreibung fuehrt: das
        // Formular schickt immer alle Felder, und `null` ist dort das Leeren.
        const quantityRaw = panel.querySelector('#rw-reward-quantity').value.trim();
        const quantity = quantityRaw === '' ? null : Math.trunc(Number(quantityRaw));
        if (quantity !== null && (!Number.isFinite(quantity) || quantity < 1)) {
          errEl.textContent = t('rewards.quantityInvalid'); errEl.hidden = false; return;
        }
        const body = {
          name,
          cost,
          quantity,
          icon: panel.querySelector('#rw-reward-icon').value.trim() || null,
          description: panel.querySelector('#rw-reward-desc').value.trim() || null,
        };
        if (isEdit) body.is_active = panel.querySelector('#rw-reward-active').checked;
        submit.disabled = true; errEl.hidden = true;
        try {
          if (isEdit) await api.patch(`/rewards/catalog/${item.id}`, body);
          else await api.post('/rewards/catalog', body);
          await closeModal({ force: true });
          toast(t('rewards.toastSaved'));
          await refreshActiveTab();
          refocusAfterRender();
        } catch (err) {
          errEl.textContent = err?.message || t('common.error'); errEl.hidden = false; submit.disabled = false;
        }
      });
    },
  });
}

async function openParticipantsModal() {
  if (readOnly()) return;
  let members = [];
  try {
    const res = await api.get('/rewards/participants');
    members = res.data || [];
  } catch (err) {
    await confirmModal(err?.message || t('common.error'), { confirmLabel: t('rewards.gotIt') });
    return;
  }
  openModal({
    title: t('rewards.manageParticipants'),
    // Ein ANSICHTSBLATT: jeder Haken speichert sofort (PUT je Person), es gibt
    // nichts zu verwerfen. Seit der Verwerfen-Schutz Haken mitliest (#1775),
    // fragte das Schliessen sonst nach einem Verlust, den es nicht gibt.
    dirtyGuard: false,
    content: `
      <p class="rw-modal-intro">${esc(t('rewards.participantsIntro'))}</p>
      <ul class="rw-participant-list">
        ${members.map((m) => `
          <li class="rw-participant">
            ${avatar(m, 36)}
            <span class="rw-participant__name">${esc(m.display_name)}</span>
            <label class="rw-switch rw-switch--compact">
              <input type="checkbox" data-participant="${m.id}" ${m.enabled ? 'checked' : ''}>
              <span class="rw-switch__track" aria-hidden="true"></span>
            </label>
          </li>`).join('')}
      </ul>
      <div id="rw-participants-error" class="form-error" role="alert" hidden></div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--primary" id="rw-participants-done">${esc(t('rewards.done'))}</button>
      </div>`,
    onSave: (panel) => {
      panel.querySelectorAll('[data-participant]').forEach((cb) => {
        cb.addEventListener('change', async () => {
          cb.disabled = true;
          try {
            await api.put(`/rewards/participants/${cb.dataset.participant}`, { enabled: cb.checked });
          } catch (err) {
            cb.checked = !cb.checked;
            const errEl = panel.querySelector('#rw-participants-error');
            errEl.textContent = err?.message || t('common.error'); errEl.hidden = false;
          } finally {
            cb.disabled = false;
          }
        });
      });
      panel.querySelector('#rw-participants-done').addEventListener('click', async () => {
        await closeModal({ force: true });
        await refreshActiveTab();
        refocusAfterRender();
      });
    },
  });
}

async function openMemberDetail(memberId) {
  const member = balances().find((b) => b.id === memberId);
  if (!member) return;
  let ledger = [];
  try {
    const res = await api.get(`/rewards/ledger?user_id=${memberId}&limit=12`);
    ledger = res.data || [];
  } catch { /* Historie optional */ }
  const hint = nextRewardHint(member.balance);
  const rows = ledger.length ? ledger.map((row) => {
    const positive = row.delta > 0;
    return `<li class="list-row rw-ledger-row rw-ledger-row--compact">
      <span class="rw-ledger-row__icon rw-ledger-row__icon--${esc(row.type)}"><i data-lucide="${LEDGER_ICON[row.type] || 'circle'}" aria-hidden="true"></i></span>
      <div class="list-row__main"><p class="list-row__name rw-ledger-row__reason">${esc(ledgerReason(row))}</p><p class="list-row__meta rw-ledger-row__meta">${esc(formatDate(row.created_at))}</p></div>
      <span class="rw-delta ${positive ? 'rw-delta--pos' : 'rw-delta--neg'}">${positive ? '+' : '−'}${fmtPoints(Math.abs(row.delta))}</span>
    </li>`;
  }).join('') : `<li class="list-row rw-ledger-row rw-ledger-row--compact"><p class="list-row__meta rw-ledger-row__meta">${esc(t('rewards.emptyLedgerBody'))}</p></li>`;
  const canRedeem = actingAsDisplay()
    ? displayMayRedeemFor(member.id)
    : (!readOnly() && (isAdmin() || member.id === state.overview?.me));
  openModal({
    title: member.display_name,
    content: `
      <div class="rw-detail-head">
        ${avatar(member, 52)}
        <div>
          <p class="rw-detail-points"><strong>${fmtPoints(member.balance)}</strong> ${esc(t('rewards.pointsUnit'))}</p>
          ${hint ? `<p class="rw-detail-hint">${esc(hint.label)}</p>` : ''}
        </div>
      </div>
      <ul class="rw-ledger rw-ledger--compact row-divided">${rows}</ul>
      ${canRedeem ? `<div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.close'))}</button>
        <button type="button" class="btn btn--primary" id="rw-detail-redeem"><i data-lucide="gift" aria-hidden="true"></i>${esc(redeemVerb())}</button>
      </div>` : ''}`,
    onSave: (panel) => {
      icons(panel);
      panel.querySelector('#rw-detail-redeem')?.addEventListener('click', async () => {
        await closeModal({ force: true });
        openRedeemModal(memberId);
      });
    },
  });
}

// --------------------------------------------------------
// Taschengeld (#1734)
// --------------------------------------------------------

/*
 * EIN GELD-SALDO JE KIND, GETRENNT VON DEN PUNKTEN. Es gibt keinen Umtausch,
 * und der Abschnitt steht deshalb als eigener ueber den Punktestaenden: zwei
 * Zahlen, die nichts miteinander zu tun haben, in zwei Listen.
 *
 * WER HIER WAS SIEHT, ENTSCHEIDET DER SERVER (`moneyVisibleSql()` in
 * server/services/reward-money.js): das Kind sein Konto, Eltern alle. Diese
 * Seite haelt nur die HANDLUNGEN zurueck - bei `rewards: read` bleibt der Stand
 * stehen und die Knoepfe gehen, wie ueberall im Modul.
 */

function isMoneyRequest(row) {
  return !!row && row.kind != null && row.kind !== 'reward';
}

/*
 * JEDES GELDOBJEKT NENNT SEINE WAEHRUNG SELBST (#1734). Ein Konto rechnet in
 * der Waehrung, in der es eroeffnet wurde - nicht in der, die der Haushalt
 * heute fuehrt. Konto, Plan, Anfrage und Buchung kommen deshalb mit `currency`
 * und `minor_unit` vom Server, und jeder Helfer darunter nimmt das Objekt als
 * `ctx`. Ohne `ctx` (ein Konto, das es noch nicht gibt) gilt die Waehrung des
 * Haushalts aus `state.money` - darin wird ein neues eroeffnet.
 */
function moneyCtx(ctx) {
  return ctx?.currency ? ctx : state.money;
}

function moneyCurrencyCode(ctx) {
  return moneyCtx(ctx)?.currency || 'EUR';
}

/*
 * DIE NACHKOMMASTELLEN KOMMEN VOM SERVER, NIE AUS `Intl` (Review zu #1745).
 *
 * Der Server speichert Geld in den Stellen nach ISO 4217 und sagt sie in
 * `minor_unit` an. `Intl` (und damit `currencyFractionDigits()` und
 * `centsToAmountInput()`) liefert die ANZEIGE-Konvention des CLDR, und die
 * weicht ab: COP, HUF, IDR, IRR und PYG zeigt der CLDR ohne Nachkommastellen,
 * ISO gibt ihnen zwei. Die Vorbelegung des Plan-Dialogs rechnete mit `Intl` -
 * ein Plan ueber 5000 Ft (gespeichert 500000) stand als "500000" im Feld, und
 * jedes Speichern, auch nur zum Pausieren, verhundertfachte das Taschengeld.
 * Jede Rechnung zwischen kleinsten Einheiten und einem Feld geht deshalb durch
 * `moneyDigits()`; `Intl` waehlt nur noch Trenner und Ziffern.
 */
function moneyDigits(ctx) {
  const unit = moneyCtx(ctx)?.minor_unit;
  return Number.isInteger(unit) ? unit : currencyFractionDigits(moneyCurrencyCode(ctx));
}

/** Kleinste Einheiten als Betrag in der Waehrung des Geldobjekts `ctx` ("77,31 EUR"). */
function fmtMoney(minor, ctx) {
  return formatMoney(Number(minor || 0) / 10 ** moneyDigits(ctx), moneyCurrencyCode(ctx));
}

/**
 * Kleinste Einheiten als Punkt-Dezimaltext ("500000" bei zwei Stellen ->
 * "5000.00"), ueber den Text gerechnet und nicht ueber eine Division.
 */
function minorToDecimal(minor, ctx) {
  const digits = moneyDigits(ctx);
  const text = String(Math.abs(Math.trunc(Number(minor) || 0))).padStart(digits + 1, '0');
  return digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
}

/**
 * Kleinste Einheiten als Wert fuer das Betragsfeld, in der Schreibweise der
 * Region. Glatte Betraege einer Waehrung, die die Region ohne Nachkommastellen
 * schreibt, stehen ohne da ("5000" Ft, nicht "5000,00"); alles andere behaelt
 * seine Stellen, damit kein Betrag beim Oeffnen ein anderer wird.
 */
function minorToAmountInput(minor, ctx) {
  const currency = moneyCurrencyCode(ctx);
  let decimal = minorToDecimal(minor, ctx);
  if (currencyFractionDigits(currency) === 0 && /\.0+$/.test(decimal)) decimal = decimal.replace(/\.0+$/, '');
  return amountToInput(decimal, currency);
}

function moneyAccounts() {
  return state.money?.accounts || [];
}

function moneyAccount(userId) {
  return moneyAccounts().find((a) => a.id === userId) || null;
}

/** Der Plan in einem Satz - oder dass es keinen gibt. */
function moneyPlanLine(plan) {
  if (!plan) return t('rewards.money.noPlan');
  const amount = fmtMoney(plan.amount_minor, plan);
  const rhythm = t(plan.frequency === 'weekly' ? 'rewards.money.planWeekly' : 'rewards.money.planMonthly', { amount });
  if (plan.paused) return `${rhythm} · ${t('rewards.money.planPaused')}`;
  return `${rhythm} · ${t('rewards.money.nextCredit', { date: formatDate(plan.next_run_date) })}`;
}

function renderMoneyRow(account) {
  const mine = account.id === state.overview?.me;
  const manage = isAdmin() && !readOnly();
  // Eltern buchen direkt und pflegen den Plan; das Kind stellt Anfragen. Wer
  // beides waere (ein Elternteil mit eigenem Konto), bucht.
  // EIN EHEMALIGES KONTO (deaktiviert, mit Restguthaben) wird nur noch
  // ausgezahlt: eine Handlung, kein Plan. Der Server schickt es nur Eltern.
  const actions = manage && account.former ? `
        <div class="rw-standing__actions">
          <button class="btn btn--secondary btn--sm" type="button" data-money-book="${account.id}">
            <i data-lucide="banknote" aria-hidden="true"></i>${esc(t('rewards.money.debit'))}
          </button>
        </div>`
    : manage ? `
        <div class="rw-standing__actions">
          <button class="btn btn--secondary btn--sm" type="button" data-money-book="${account.id}">
            <i data-lucide="banknote" aria-hidden="true"></i>${esc(t('rewards.money.book'))}
          </button>
          ${rowActionHtml({ icon: 'calendar-clock', label: `${t('rewards.money.planTitle')}: ${account.display_name}`, attrs: { 'data-money-plan': account.id } })}
          ${/* Schliessen nur, wo der Server sagt, dass nichts mehr daran haengt
                (kein Plan, Saldo null, nichts offen) - sonst wiese er es ab. */ ''}
          ${account.closable ? rowActionHtml({ icon: 'x', label: `${t('rewards.money.closeAccount')}: ${account.display_name}`, attrs: { 'data-money-close': account.id } }) : ''}
        </div>`
    : (mine && !account.former && !readOnly()) ? `
        <div class="rw-standing__actions">
          <button class="btn btn--secondary btn--sm" type="button" data-money-request="withdrawal" data-member="${account.id}"
                  ${account.balance_minor > 0 ? '' : 'disabled'}>
            <i data-lucide="arrow-up-from-line" aria-hidden="true"></i>${esc(t('rewards.money.withdraw'))}
          </button>
          <button class="btn btn--ghost btn--sm" type="button" data-money-request="deposit" data-member="${account.id}">
            <i data-lucide="arrow-down-to-line" aria-hidden="true"></i>${esc(t('rewards.money.deposit'))}
          </button>
        </div>` : '';
  return `
    <li class="list-row rw-standing rw-money">
      <button class="rw-standing__id" type="button" data-money-member="${account.id}"
              aria-label="${esc(`${account.display_name}, ${fmtMoney(account.balance_minor, account)}. ${t('rewards.openDetails')}`)}">
        ${avatar(account, 40)}
        <span class="rw-standing__idtext">
          <span class="rw-standing__name">${esc(account.display_name)}${account.former ? ` <span class="rw-tag">${esc(t('settings.memberFormerBadge'))}</span>` : ''}</span>
          <span class="rw-standing__points"><strong>${esc(fmtMoney(account.balance_minor, account))}</strong></span>
        </span>
      </button>
      <div class="rw-standing__progress">
        <p class="rw-progress__label${account.plan && !account.plan.paused ? '' : ' rw-progress__label--muted'}">${esc(moneyPlanLine(account.plan))}</p>
      </div>
      ${actions}
    </li>`;
}

function renderMoneySection() {
  if (!state.money) return '';
  const accounts = moneyAccounts();
  const manage = isAdmin() && !readOnly();
  const canOpen = manage && (state.money.candidates || []).length > 0;
  // Ohne Konto und ohne die Moeglichkeit, eines zu eroeffnen, gibt es nichts
  // zu zeigen - auch keine Ueberschrift ueber einer leeren Liste.
  if (!accounts.length && !canOpen) return '';
  const setUp = canOpen ? `
          <button class="btn btn--ghost btn--sm rw-money-setup" type="button"><i data-lucide="piggy-bank" aria-hidden="true"></i>${esc(t('rewards.money.setUp'))}</button>` : '';
  return `
      <section class="rw-section rw-money-section">
        <div class="rw-section__head">
          <h2 class="rw-section__title u-section-title">${esc(t('rewards.money.title'))}</h2>
          ${setUp}
        </div>
        ${accounts.length ? `<ul class="row-carrier rw-standings">${accounts.map(renderMoneyRow).join('')}</ul>` : ''}
      </section>`;
}

function wireMoney(el) {
  el.querySelector('.rw-money-setup')?.addEventListener('click', () => openMoneyAccountModal());
  el.querySelectorAll('[data-money-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeMoneyAccount(moneyAccount(Number(btn.dataset.moneyClose))));
  });
  el.querySelectorAll('[data-money-member]').forEach((btn) => {
    btn.addEventListener('click', () => openMoneyDetail(Number(btn.dataset.moneyMember)));
  });
  el.querySelectorAll('[data-money-request]').forEach((btn) => {
    btn.addEventListener('click', () => openMoneyRequestModal(btn.dataset.moneyRequest, Number(btn.dataset.member)));
  });
  el.querySelectorAll('[data-money-book]').forEach((btn) => {
    btn.addEventListener('click', () => openMoneyBookModal(Number(btn.dataset.moneyBook)));
  });
  el.querySelectorAll('[data-money-plan]').forEach((btn) => {
    btn.addEventListener('click', () => openMoneyPlanModal(Number(btn.dataset.moneyPlan)));
  });
}

/** Der Satz zu einem Grund aus amountInputProblem() - dieselben Texte wie in den geteilten Ausgaben. */
function moneyAmountProblemText(problem, ctx) {
  const currency = moneyCurrencyCode(ctx);
  if (problem === 'grouped') return t('common.amountGrouped', { example: amountExample(currency) });
  if (problem === 'invalid') return t('common.amountInvalid', { example: amountExample(currency) });
  if (problem === 'notPositive') return t('common.amountNotPositive');
  // Der kleinste Schritt nach den Stellen des SERVERS, nicht nach `Intl`.
  const digits = moneyDigits(ctx);
  const step = getNumberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(1 / 10 ** digits);
  return t('common.amountPrecisionRequired', { currency, step });
}

/**
 * Warum der Text im Betragsfeld nicht gesendet werden kann - oder `null`.
 * Gruppierung, Schreibweise und Vorzeichen prueft `amountInputProblem()`; wie
 * viele Nachkommastellen erlaubt sind, sagt der Server (`moneyDigits()`).
 */
function moneyAmountProblem(text, ctx) {
  const problem = amountInputProblem(text, moneyCurrencyCode(ctx), { required: true });
  if (problem && problem !== 'precision') return problem;
  const fraction = toDecimalString(text).split('.')[1] || '';
  return fraction.length > moneyDigits(ctx) ? 'precision' : null;
}

/**
 * Liest das Betragsfeld. Gibt den Dezimaltext zurueck, den der Server
 * erwartet ("12.50"), oder `null` - dann steht der Grund schon im Fehlerfeld.
 */
function readMoneyAmount(input, errEl, ctx) {
  const problem = moneyAmountProblem(input.value, ctx);
  if (problem) {
    errEl.textContent = moneyAmountProblemText(problem, ctx);
    errEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    return null;
  }
  input.removeAttribute('aria-invalid');
  return toDecimalString(input.value);
}

function moneyAmountField(id, value = '', ctx = undefined) {
  return `
        <div class="form-group">
          <label class="label" for="${id}">${esc(t('rewards.money.amount'))} (${esc(moneyCurrencyCode(ctx))})${REQUIRED_MARK}</label>
          <input class="input" id="${id}" inputmode="decimal" autocomplete="off" required
                 value="${esc(value)}" placeholder="${esc(amountPlaceholder(moneyCurrencyCode(ctx)))}">
        </div>`;
}

/** Der Betrag eines Dezimaltexts in kleinsten Einheiten - nur fuer den Vergleich mit dem Guthaben. */
function decimalToMinor(decimal, ctx) {
  return Math.round(Number(decimal) * 10 ** moneyDigits(ctx));
}

/* ABHEBEN ODER EINZAHLEN: EINE ANFRAGE, KEINE BUCHUNG. Sie geht ueber
 * denselben Weg wie das Einloesen einer Praemie (`POST /rewards/redemptions`)
 * und wartet immer auf die Eltern. Der Dialog sagt das, bevor das Kind tippt -
 * sonst sieht ein unveraendertes Guthaben nach dem Absenden wie ein Fehler aus. */
function openMoneyRequestModal(kind, memberId) {
  if (readOnly()) return;
  const account = moneyAccount(memberId);
  if (!account) return;
  const withdrawal = kind === 'withdrawal';
  openModal({
    title: t(withdrawal ? 'rewards.money.withdraw' : 'rewards.money.deposit'),
    content: `
      <form id="rw-money-request-form" novalidate>
        <div class="rw-redeem-summary">
          <div class="rw-redeem-summary__row"><span>${esc(t('rewards.money.title'))}</span><strong>${esc(fmtMoney(account.balance_minor, account))}</strong></div>
        </div>
        ${moneyAmountField('rw-money-amount', '', account)}
        <div class="form-group">
          <label class="label" for="rw-money-note">${esc(t('rewards.noteOptional'))}</label>
          <input class="input" id="rw-money-note" maxlength="500">
        </div>
        <p class="rw-hint">${esc(t('rewards.money.requestHint'))}</p>
        <div id="rw-money-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="rw-money-submit">${esc(t('rewards.requestAction'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const errEl = panel.querySelector('#rw-money-error');
      const submit = panel.querySelector('#rw-money-submit');
      const input = panel.querySelector('#rw-money-amount');
      panel.querySelector('#rw-money-request-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        const amount = readMoneyAmount(input, errEl, account);
        if (amount == null) return;
        // Der Server prueft die Deckung (zweimal); hier steht nur der fruehe Satz.
        if (withdrawal && decimalToMinor(amount, account) > account.balance_minor) {
          errEl.textContent = t('rewards.money.insufficient'); errEl.hidden = false; return;
        }
        submit.disabled = true;
        try {
          await api.post('/rewards/redemptions', {
            kind, amount, note: panel.querySelector('#rw-money-note').value.trim() || undefined,
          });
          await closeModal({ force: true });
          toast(t('rewards.toastRequested'));
          await refreshActiveTab();
          refocusAfterRender();
        } catch (err) {
          errEl.textContent = err?.data?.reason === 'insufficient_funds'
            ? t('rewards.money.insufficient') : (err?.message || t('common.error'));
          errEl.hidden = false;
          submit.disabled = false;
        }
      });
    },
  });
}

/* ELTERN BUCHEN DIREKT, in beide Richtungen - ohne Anfrage. */
function openMoneyBookModal(memberId) {
  if (readOnly() || !isAdmin()) return;
  const account = moneyAccount(memberId);
  if (!account) return;
  openModal({
    // Ein ehemaliges Konto wird nur noch ausgezahlt: der Dialog bietet die
    // Gutschrift gar nicht erst an (der Server wiese sie ab).
    title: `${t(account.former ? 'rewards.money.debit' : 'rewards.money.book')} · ${account.display_name}`,
    content: `
      <form id="rw-money-book-form" novalidate>
        <div class="rw-redeem-summary">
          <div class="rw-redeem-summary__row"><span>${esc(t('rewards.money.title'))}</span><strong>${esc(fmtMoney(account.balance_minor, account))}</strong></div>
        </div>
        ${account.former ? '<input type="hidden" id="rw-money-direction" value="debit">' : `
        <div class="form-group">
          <label class="label" for="rw-money-direction">${esc(t('rewards.money.book'))}</label>
          <select class="input" id="rw-money-direction">
            <option value="credit">${esc(t('rewards.money.credit'))}</option>
            <option value="debit">${esc(t('rewards.money.debit'))}</option>
          </select>
        </div>`}
        ${moneyAmountField('rw-money-amount', '', account)}
        <div class="form-group">
          <label class="label" for="rw-money-reason">${esc(t('rewards.reasonOptional'))}</label>
          <input class="input" id="rw-money-reason" maxlength="200">
        </div>
        <div id="rw-money-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="rw-money-submit">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const errEl = panel.querySelector('#rw-money-error');
      const submit = panel.querySelector('#rw-money-submit');
      const input = panel.querySelector('#rw-money-amount');
      panel.querySelector('#rw-money-book-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        const amount = readMoneyAmount(input, errEl, account);
        if (amount == null) return;
        submit.disabled = true;
        try {
          await api.post('/rewards/money/entries', {
            user_id: account.id, amount,
            direction: panel.querySelector('#rw-money-direction').value,
            reason: panel.querySelector('#rw-money-reason').value.trim() || undefined,
          });
          await closeModal({ force: true });
          toast(t('rewards.toastSaved'));
          await refreshActiveTab();
          refocusAfterRender();
        } catch (err) {
          errEl.textContent = err?.data?.reason === 'insufficient_funds'
            ? t('rewards.money.insufficient') : (err?.message || t('common.error'));
          errEl.hidden = false;
          submit.disabled = false;
        }
      });
    },
  });
}

/** Wochentagsnamen in der Sprache der Oberflaeche, 1 = Montag bis 7 = Sonntag. */
function weekdayOptions(selected) {
  const names = new Intl.DateTimeFormat(getLocale(), { weekday: 'long', timeZone: 'UTC' });
  // Der 1. Januar 2024 war ein Montag.
  return [1, 2, 3, 4, 5, 6, 7].map((day) => {
    const label = names.format(new Date(Date.UTC(2024, 0, day)));
    return `<option value="${day}" ${day === selected ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

/* DER PLAN: Betrag, Rhythmus und der Tag, den die Eltern waehlen. Ohne
 * `memberId` eroeffnet der Dialog ein Konto - dann steht die Person zur Wahl,
 * aus den Mitgliedern, die noch keins haben. */
function openMoneyPlanModal(memberId) {
  if (readOnly() || !isAdmin()) return;
  // Ein Plan gehoert zu einem Konto, das es gibt: eroeffnet wird es ueber
  // "Konto eroeffnen" (`openMoneyAccountModal`), nicht mehr ueber diesen Dialog.
  const account = moneyAccount(memberId);
  // Ein ehemaliges Konto behaelt seinen Plan pausiert - kein Dialog dafuer.
  if (!account || account.former) return;
  const plan = account.plan || null;
  // In welcher Waehrung dieser Plan rechnet: in seiner eigenen, sonst in der
  // des Kontos.
  const planCtx = plan || account;
  const frequency = plan?.frequency || 'weekly';
  const weekday = plan?.frequency === 'weekly' ? plan.anchor_day : 1;
  const monthDay = plan?.frequency === 'monthly' ? plan.anchor_day : 1;
  const days = Array.from({ length: 31 }, (_, i) => i + 1)
    .map((day) => `<option value="${day}" ${day === monthDay ? 'selected' : ''}>${day}</option>`).join('');
  openModal({
    title: `${t('rewards.money.planTitle')} · ${account.display_name}`,
    content: `
      <form id="rw-plan-form" novalidate>
        ${moneyAmountField('rw-money-amount', plan ? minorToAmountInput(plan.amount_minor, plan) : '', planCtx)}
        <div class="form-group">
          <label class="label" for="rw-plan-frequency">${esc(t('rewards.money.frequency'))}</label>
          <select class="input" id="rw-plan-frequency">
            <option value="weekly" ${frequency === 'weekly' ? 'selected' : ''}>${esc(t('rewards.money.weekly'))}</option>
            <option value="monthly" ${frequency === 'monthly' ? 'selected' : ''}>${esc(t('rewards.money.monthly'))}</option>
          </select>
        </div>
        <div class="form-group" id="rw-plan-weekday-group">
          <label class="label" for="rw-plan-weekday">${esc(t('rewards.money.weekday'))}</label>
          <select class="input" id="rw-plan-weekday">${weekdayOptions(weekday)}</select>
        </div>
        <div class="form-group" id="rw-plan-monthday-group">
          <label class="label" for="rw-plan-monthday">${esc(t('rewards.money.dayOfMonth'))}</label>
          <select class="input" id="rw-plan-monthday">${days}</select>
          <p class="rw-hint">${esc(t('rewards.money.dayOfMonthHint'))}</p>
        </div>
        <label class="rw-switch">
          <input type="checkbox" id="rw-plan-paused" ${plan?.paused ? 'checked' : ''}>
          <span>${esc(t('rewards.money.pausePlan'))}</span>
        </label>
        <div id="rw-money-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          ${plan ? `<button type="button" class="btn btn--danger-outline" id="rw-plan-remove">${esc(t('rewards.money.removePlan'))}</button>` : ''}
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="rw-money-submit">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const errEl = panel.querySelector('#rw-money-error');
      const submit = panel.querySelector('#rw-money-submit');
      const freqEl = panel.querySelector('#rw-plan-frequency');
      const syncAnchor = () => {
        const weekly = freqEl.value === 'weekly';
        panel.querySelector('#rw-plan-weekday-group').hidden = !weekly;
        panel.querySelector('#rw-plan-monthday-group').hidden = weekly;
      };
      freqEl.addEventListener('change', syncAnchor);
      syncAnchor();

      // Kein `danger`: der Plan laesst sich neu anlegen, Guthaben und Verlauf
      // bleiben. Rot behauptete eine Endgueltigkeit, die das Beenden nicht hat.
      panel.querySelector('#rw-plan-remove')?.addEventListener('click', async () => {
        const ok = await confirmOverModal(t('rewards.money.confirmRemovePlan', { name: account.display_name }),
          { confirmLabel: t('rewards.money.removePlan'), detail: t('rewards.money.removePlanDetail') });
        if (!ok) return;
        await removeMoneyPlan(account);
      });

      panel.querySelector('#rw-plan-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        const amount = readMoneyAmount(panel.querySelector('#rw-money-amount'), errEl, planCtx);
        if (amount == null) return;
        const weekly = freqEl.value === 'weekly';
        submit.disabled = true;
        try {
          await api.put(`/rewards/money/plans/${account.id}`, {
            amount,
            frequency: freqEl.value,
            anchor_day: Number(panel.querySelector(weekly ? '#rw-plan-weekday' : '#rw-plan-monthday').value),
            paused: panel.querySelector('#rw-plan-paused').checked,
          });
          await closeModal({ force: true });
          toast(t('rewards.toastSaved'));
          await refreshActiveTab();
          refocusAfterRender();
        } catch (err) {
          errEl.textContent = err?.message || t('common.error'); errEl.hidden = false; submit.disabled = false;
        }
      });
    },
  });
}

/* KONTO EROEFFNEN - ohne Plan und ohne Buchung. Bis hierher entstand ein Konto
 * in der Oberflaeche nur ueber einen Plan (notfalls einen pausierten). Jetzt
 * waehlen die Eltern ein Mitglied, das noch keines hat; das Kind sieht sein
 * Konto danach mit Saldo null und kann eine Einzahlung anfragen. Plan und
 * Buchung haengen danach an der Zeile. */
function openMoneyAccountModal() {
  if (readOnly() || !isAdmin()) return;
  const candidates = state.money?.candidates || [];
  if (!candidates.length) return;
  openModal({
    title: t('rewards.money.setUp'),
    content: `
      <form id="rw-account-form" novalidate>
        <div class="form-group">
          <label class="label" for="rw-account-member">${esc(t('rewards.member'))}</label>
          <select class="input" id="rw-account-member">
            ${candidates.map((m) => `<option value="${m.id}">${esc(m.display_name)}</option>`).join('')}
          </select>
        </div>
        <div id="rw-money-error" class="form-error" role="alert" hidden></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary" id="rw-money-submit">${esc(t('rewards.money.openAccount'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const errEl = panel.querySelector('#rw-money-error');
      const submit = panel.querySelector('#rw-money-submit');
      panel.querySelector('#rw-account-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        submit.disabled = true;
        try {
          await api.post('/rewards/money/accounts', { user_id: Number(panel.querySelector('#rw-account-member').value) });
          await closeModal({ force: true });
          toast(t('rewards.toastSaved'));
          await refreshActiveTab();
          refocusAfterRender();
        } catch (err) {
          errEl.textContent = err?.message || t('common.error'); errEl.hidden = false; submit.disabled = false;
        }
      });
    },
  });
}

/* KONTO SCHLIESSEN. Nur ein leeres Konto traegt den Knopf; ob es leer ist, hat
 * der Server gesagt (`closable`) und prueft er beim Schliessen noch einmal -
 * dazwischen kann eine Anfrage eingegangen sein. Kein `danger`: der Verlauf
 * bleibt, und das Konto laesst sich neu eroeffnen. */
async function closeMoneyAccount(account) {
  if (readOnly() || !isAdmin() || !account) return;
  const ok = await confirmModal(t('rewards.money.confirmCloseAccount', { name: account.display_name }),
    { confirmLabel: t('rewards.money.closeAccount'), detail: t('rewards.money.closeAccountDetail') });
  if (!ok) return;
  try {
    await api.delete(`/rewards/money/accounts/${account.id}`);
    toast(t('rewards.toastSaved'), 'default');
  } catch (err) {
    await confirmModal(err?.data?.reason === 'money_account_not_empty'
      ? t('rewards.money.accountNotEmpty') : (err?.message || t('common.error')),
    { confirmLabel: t('rewards.gotIt') });
  }
  await refreshActiveTab();
  refocusAfterRender();
}

/* PLAN BEENDEN. Die Rueckfrage hat das Formular schon geschlossen, wenn dieser
 * Aufruf laeuft: scheitert das Loeschen, gibt es kein Fehlerfeld mehr, in dem
 * es stehen koennte. Ohne `catch` war das eine unbehandelte Rejection - der
 * Plan stand weiter da, und niemand erfuhr, warum (Review zu #1745). Die
 * Meldung kommt als Dialog wie bei den Nachbarn, und die Liste wird in beiden
 * Faellen neu geladen: sie zeigt, was jetzt gilt. */
async function removeMoneyPlan(account) {
  try {
    await api.delete(`/rewards/money/plans/${account.id}`);
    toast(t('rewards.toastSaved'), 'default');
  } catch (err) {
    await confirmModal(err?.message || t('common.error'), { confirmLabel: t('rewards.gotIt') });
  }
  await refreshActiveTab();
  refocusAfterRender();
}

const MONEY_LEDGER_ICON = {
  allowance: 'calendar-clock', deposit: 'arrow-down-to-line', withdrawal: 'arrow-up-from-line',
  credit: 'banknote', debit: 'sliders-horizontal',
};

/** Was eine Geldbuchung war - aus ihren Feldern gelesen, nicht aus einem Freitext. */
function moneyRowKind(row) {
  if (row.allowance_date) return 'allowance';
  if (row.request_kind === 'deposit') return 'deposit';
  if (row.request_kind === 'withdrawal' || row.type === 'redeem') return 'withdrawal';
  return row.delta >= 0 ? 'credit' : 'debit';
}

function moneyRowLabel(kind) {
  if (kind === 'allowance') return t('rewards.money.title');
  if (kind === 'deposit') return t('rewards.money.ledgerDeposit');
  if (kind === 'withdrawal') return t('rewards.money.ledgerWithdrawal');
  return t(kind === 'credit' ? 'rewards.money.ledgerCredit' : 'rewards.money.ledgerDebit');
}

function moneyLedgerRowHtml(row) {
  const kind = moneyRowKind(row);
  const positive = row.delta > 0;
  // Eine Gutschrift nach Plan nennt den Termin, fuer den sie gilt - nachgebucht
  // traegt sie sonst nur den Tag, an dem der Server wieder lief.
  const when = formatDate(kind === 'allowance' ? row.allowance_date : row.created_at);
  return `<li class="list-row rw-ledger-row rw-ledger-row--compact">
      <span class="rw-ledger-row__icon rw-ledger-row__icon--${positive ? 'bonus' : 'redeem'}"><i data-lucide="${MONEY_LEDGER_ICON[kind]}" aria-hidden="true"></i></span>
      <div class="list-row__main">
        <p class="list-row__name rw-ledger-row__reason">${esc(moneyRowLabel(kind))}</p>
        <p class="list-row__meta rw-ledger-row__meta">${esc(when)}${row.reason ? ` · ${esc(row.reason)}` : ''}</p>
      </div>
      <span class="rw-delta ${positive ? 'rw-delta--pos' : 'rw-delta--neg'}">${positive ? '+' : '−'}${esc(fmtMoney(Math.abs(row.delta), row))}</span>
    </li>`;
}

async function openMoneyDetail(memberId) {
  const account = moneyAccount(memberId);
  if (!account) return;
  let ledger = [];
  try {
    ledger = (await api.get(`/rewards/money/ledger?user_id=${memberId}&limit=20`)).data || [];
  } catch { /* Historie optional */ }
  const rows = ledger.length
    ? ledger.map(moneyLedgerRowHtml).join('')
    : `<li class="list-row rw-ledger-row rw-ledger-row--compact"><p class="list-row__meta rw-ledger-row__meta">${esc(t('rewards.emptyLedgerTitle'))}</p></li>`;
  openModal({
    title: `${t('rewards.money.title')} · ${account.display_name}`,
    content: `
      <div class="rw-detail-head">
        ${avatar(account, 52)}
        <div>
          <p class="rw-detail-points"><strong>${esc(fmtMoney(account.balance_minor, account))}</strong></p>
          <p class="rw-detail-hint">${esc(moneyPlanLine(account.plan))}</p>
        </div>
      </div>
      <ul class="rw-ledger rw-ledger--compact row-divided">${rows}</ul>`,
    onSave: (panel) => icons(panel),
  });
}

// --------------------------------------------------------
// Refresh + Entry
// --------------------------------------------------------

async function refreshActiveTab() {
  const container = document.querySelector('.rewards-page')?.parentElement;
  await renderCurrentTab(container || document.body);
}

/**
 * Reine Markup-Funktionen fuer die Tests. Sie brauchen `state`, also steht er
 * mit darin: eine Punktestandzeile ohne Katalog und ohne `overview.me` liesse
 * sich sonst nicht stellen.
 */
export const __test = {
  renderStandingRow, renderRewardCard, renderPendingPanel, renderSetupHints,
  readOnly, state,
  // R10 L7: Kopf und Inhalt teilen je Reiter eine Kante (test-dashboard-rewards.js).
  renderCatalog, renderLedger, renderOverview, handleSetupStep,
  // #1607: der Verlaufssatz einer Gegenbuchung.
  ledgerReason,
  // #1734: Taschengeld.
  renderMoneySection, renderMoneyRow, moneyLedgerRowHtml, moneyRowKind, moneyPlanLine, fmtMoney,
  minorToAmountInput, moneyAmountProblem, decimalToMinor, removeMoneyPlan, decideRedemption, openMoneyPlanModal, openMoneyBookModal,
  openMoneyAccountModal, closeMoneyAccount,
};

export async function render(container, { user } = {}) {
  state.user = user || null;
  if (!TABS.includes(state.tab)) state.tab = 'overview';
  renderShell(container);
  await renderCurrentTab(container);
}
