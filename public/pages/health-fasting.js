// Delegated panel composition: dashboard (the owning Health page provides the shell).
// data-composition="dashboard"
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { installPopoverMenus, popoverMenuHtml } from '/utils/popover-menu.js';
import { personSwitcherMarkup, wireWhoSees } from '/utils/health-person-switcher.js';
import { readHealthPerson, writeHealthPerson } from '/utils/health-person.js';
import { fastingHistoryQuery, fastingSections, fastingStatsQuery, formatFastingDuration, shouldLoadFastingStats } from '/utils/health-fasting.js';
import { rowActionHtml } from '/utils/row-action.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { openModal, refocusAfterRender } from '/components/modal.js';
import { moduleAccess } from '/permissions.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { fastingEducationMarkup } from '/components/fasting-dial.js';
import { renderFastingStats } from '/components/health-fasting-insights.js';
import { fastingPreferencesHtml, fastingGoalHtml, wireFastingPreferences, startFasting, finishFasting, openFastingCreator, openFastingEditor, startFastingClock, fastingClockSwitchHtml, fastingStamp, fastingError, requireFastingWrite } from '/components/fasting-controls.js';

const panels = new WeakMap();
// Undo timers outlive page roots. Suppression follows the signed-in owner.
const pendingDeletes = new Map();
const currentOwners = new Map();
const deleteKey = (owner, id) => `${owner}:${id}`;

export async function mountFasting(root, { userId, onIntent = null } = {}) {
  if (!root) return;
  let view = panels.get(root);
  if (view && onIntent) view.onIntent = onIntent;
  // DIE PERSON DER SITZUNG (R23, D4): das Fasten startet bei der Person, die
  // zuletzt irgendwo in der Gesundheit gewaehlt wurde. Sie ist ein Vorschlag -
  // laesst sich ihr Fasten nicht lesen, faellt die Ansicht auf mich zurueck
  // (refresh).
  const wanted = readHealthPerson(userId) ?? userId;
  if (!view) {
    view = { root, self: userId, subject: wanted, subjectFromSession: wanted !== userId, members: [], from: '', to: '', generation: 0, stop: null, state: null, stats: undefined, statsError: false, displayTzid: '', onIntent };
    panels.set(root, view);
    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', `<div class="fasting-container"><div data-fasting-shell></div><p role="alert" data-fasting-load-error></p><div class="fasting-panel" data-fasting-body><p role="status">${esc(t('common.loading'))}</p></div></div>`);
  } else if (wanted != null && wanted !== view.subject) {
    view.subject = wanted;
    view.subjectFromSession = wanted !== view.self;
    view.state = null; view.stats = undefined; view.statsError = false; view.stop?.(); view.stop = null;
  }
  await refresh(view, { refreshStats: true });
}

/**
 * Kopf des Fasten-Panels: die Personen-Pille wie auf jedem Gesundheits-Tab
 * (utils/health-person-switcher.js) statt des nativen Vollbreit-Selects mit
 * eigenem Label (Re-Critique 2026-09-27, A6 P2-5; Kanon D6). Ein Haushalt mit
 * nur einer Person bekommt - wie ueberall - keinen Umschalter.
 *
 * Die Wahl haengt am Umschalter (je Neubau neu), nicht je Menuepunkt:
 * shell() baut den Kopf bei jedem Laden neu.
 */
function shell(view) {
  const el = view.root.querySelector('[data-fasting-shell]');
  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', personSwitcherMarkup(view.members, view.subject, view.self,
    { menuId: 'health-person-menu-fasting', label: t('health.fasting.person') }));
  // Fremde Person: derselbe Hinweis wie in jedem Bereich der Gesundheit (D4) -
  // das Fasten anderer liest man nur.
  if (view.subject != null && view.self != null && view.subject !== view.self) {
    const name = view.members.find((m) => m.id === view.subject)?.display_name || '';
    el.insertAdjacentHTML('beforeend', `
      <div class="health-readonly-banner" role="status">
        <i data-lucide="eye" aria-hidden="true"></i>
        <span>${esc(t('health.readOnlyBanner', { name }))}</span>
      </div>`);
  }
  if (!view.state) {
    el.insertAdjacentHTML('beforeend', filtersMarkup(view));
    wireFilters(view, el);
  }
  window.lucide?.createIcons({ el });
  // Am Umschalter selbst, nicht am Kopf-Knoten: die Gesundheit haengt die
  // Pille in ihren Seiten- oder Detailkopf um (health-hoist.js), und ein am
  // Kopf delegierter Klick kaeme dort nie an.
  el.querySelector('.health-person-switcher')?.addEventListener('click', (event) => onPersonPick(view, el, event));
  wireWhoSees(el);
  if (view.shellWired) return;
  view.shellWired = true;
  installPopoverMenus(el);
}

async function onPersonPick(view, el, event) {
  const item = event.target.closest('.health-person-switcher [data-person-id]');
  if (!item) return;
  const id = Number(item.dataset.personId);
  if (id === view.subject) return;
  view.subject = id;
  view.subjectFromSession = false;
  writeHealthPerson(view.self, id);
  view.state = null; view.stats = undefined; view.statsError = false; view.generation++; view.stop?.(); view.stop = null;
  // Der FAB startet nur mein Fasten: solange die neue Person laedt, bietet er
  // nichts an (renderBody meldet danach, was gilt).
  view.onIntent?.({ canStart: false, start: null });
  const body = view.root.querySelector('[data-fasting-body]');
  body.replaceChildren();
  body.insertAdjacentHTML('beforeend', `<p role="status">${esc(t('common.loading'))}</p>`);
  shell(view);
  // Der Rueckweg: der alte Knopf ist mit dem Kopf verschwunden, der Fokus
  // fiele auf <body> (dieselbe Regel wie wirePersonSwitcher in health.js).
  const refocus = () => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      (el.querySelector('.health-person-switcher__trigger')
        ?? document.querySelector('[popovertarget="health-person-menu-fasting"]'))?.focus({ preventScroll: true });
    }
  };
  refocus();
  await refresh(view, { refreshStats: true });
  refocus();
}

/* DER ZEITRAUM IM KANON (R14 P3, A6 P2-1/P2-5): zwei Kanon-Datumsfelder
 * (yuvomi-datepicker) statt nativer `type=date`, die Wahl wirkt beim Aendern -
 * kein „Zeitraum anwenden" mehr - und ohne den Satz „Zeitzone des Haushalts -
 * Europe/Berlin": die Tage sind die des Haushalts wie ueberall in der App. */
function filtersMarkup(view) {
  return `<form class="fasting-history-filters" data-fasting-filters><label class="form-label">${esc(t('health.fasting.completedFrom'))}<yuvomi-datepicker type="date" data-fasting-from value="${esc(view.from)}"></yuvomi-datepicker></label><label class="form-label">${esc(t('health.fasting.completedTo'))}<yuvomi-datepicker type="date" data-fasting-to value="${esc(view.to)}"></yuvomi-datepicker></label><p class="form-hint" role="alert" data-fasting-filter-error></p></form>`;
}

function wireFilters(view, container) {
  const form = container.querySelector('[data-fasting-filters]');
  if (!form) return;
  const apply = () => {
    const from = form.querySelector('[data-fasting-from]').value, to = form.querySelector('[data-fasting-to]').value;
    const error = form.querySelector('[data-fasting-filter-error]');
    if (from && to && from > to) { error.textContent = t('health.fasting.rangeError'); return; }
    error.textContent = '';
    if (from === view.from && to === view.to) return;
    view.from = from; view.to = to; void refresh(view);
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); apply(); });
  form.addEventListener('change', apply);
}

/* DIE EINSTELLUNGEN STEHEN IN IHREM BLATT (R14 P3, A6 P2-1): zwei Schalter und
 * zwei Wahlfelder standen mitten im Inhalt zwischen Timer und Statistik. Sie
 * gelten fuer das eigene Fasten und aendern sich selten - ein Knopf oeffnet
 * sie als Blatt, die Seite zeigt, was man tut. */
function openFastingSettings(view, reload) {
  openModal({
    title: `${t('health.fasting.title')} - ${t('nav.settings')}`,
    content: `<div data-fasting-preferences>${fastingPreferencesHtml(view.state?.settings || {})}</div>`,
    dirtyGuard: false,
    initialFocus: 'none',
    onSave: (panel) => {
      const host = panel.querySelector('[data-fasting-preferences]');
      wireFastingPreferences(host, view.state?.settings || {}, async () => { await reload(); return host; }, () => view.state?.active ?? null);
    },
  });
}

async function refresh(view, { refreshStats = false } = {}) {
  if (!view.root.isConnected) return;
  if (refreshStats) {
    view.stats = undefined;
    view.statsError = false;
  }
  const generation = ++view.generation, subject = view.subject;
  const current = () => view.root.isConnected && view.generation === generation && view.subject === subject;
  const historyQuery = fastingHistoryQuery(view);
  const statsQuery = fastingStatsQuery(view);
  try {
    const loadStats = shouldLoadFastingStats(view.stats, view.statsError);
    const [stateResult, statsResult, membersResult, filtered] = await Promise.all([
      api.get(`/health/fasting/state${historyQuery}`),
      loadStats ? api.get(`/health/fasting/stats${statsQuery}`).catch(() => ({ data: null, error: true })) : null,
      view.members.length ? null : api.get('/family/members'),
      view.from || view.to ? api.get(`/health/fasting/history${historyQuery}`) : null,
    ]);
    if (!current()) return;
    const state = stateResult.data;
    view.self ??= state.settings?.user_id;
    view.subject ??= view.self;
    if (membersResult) view.members = membersResult.data || [];
    // Die Person der Sitzung steht nicht (mehr) in der Liste: zurueck zu mir.
    if (view.subjectFromSession && view.subject !== view.self && !view.members.some((m) => m.id === view.subject)) {
      view.subject = view.self; view.subjectFromSession = false; view.state = null;
      void refresh(view, { refreshStats: true });
      return;
    }
    currentOwners.set(view.self, view);
    view.state = state;
    view.displayTzid = state.display_tzid || '';
    if (statsResult) {
      view.stats = statsResult.data;
      view.statsError = statsResult.error === true;
    }
    view.rows = filtered ? filtered.data : state.history || [];
    view.cursor = filtered ? filtered.next_cursor : state.history_next_cursor;
    view.more = filtered ? filtered.has_more : state.history_has_more;
    view.stop?.();
    shell(view);
    view.root.querySelector('[data-fasting-load-error]').replaceChildren();
    renderBody(view, view.stats, view.statsError);
  } catch {
    if (!current()) return;
    // Ein Vorschlag aus der Sitzung, dessen Fasten ich nicht lesen darf: kein
    // Ladefehler, sondern meine eigene Ansicht.
    if (view.subjectFromSession && view.subject !== view.self && view.self != null) {
      view.subject = view.self; view.subjectFromSession = false;
      void refresh(view, { refreshStats: true });
      return;
    }
    if (!view.members.length) {
      try { view.members = (await api.get('/family/members')).data || []; } catch { /* retry remains available */ }
      if (!current()) return;
    }
    // Kein Start ueber den FAB ohne gezeichnete Ansicht: er hielte sonst den
    // Start der vorigen (eigenen) Ansicht, waehrend ein fremdes, verweigertes
    // Fasten mit Ladefehler dasteht.
    view.onIntent?.({ canStart: false, start: null });
    shell(view);
    const error = view.root.querySelector('[data-fasting-load-error]');
    error.replaceChildren();
    error.insertAdjacentHTML('beforeend', `${esc(t('health.fasting.loadError'))} <button class="btn btn--secondary" data-fasting-retry>${esc(t('common.retry'))}</button>`);
    error.querySelector('button').addEventListener('click', () => void refresh(view, { refreshStats: true }));
  }
}

/**
 * Das „..." im Ring (R23 D14): Nachtragen und Einstellungen. Bis R23 stand das
 * Zahnrad als dritter Knopf in der Aktionszeile (Critique G5 P3) und das
 * Nachtragen als Geisterknopf ueber dem Verlauf.
 */
function fastingMoreMenuHtml({ backfill = true } = {}) {
  // EIN WEG ZUM NACHTRAGEN JE DATENLAGE (R24, Critique G5 P2-5; R22 D12):
  // ohne Verlauf traegt ihn der Leerzustand direkt unter der Karte - das „..."
  // bot denselben Eintrag ein zweites Mal. Mit Verlauf steht er hier (R23 D14).
  return popoverMenuHtml({
    id: 'fasting-more-menu',
    label: t('common.moreActionsNamed', { name: t('health.fasting.title') }),
    items: [
      ...(backfill ? [{ action: 'fasting-backfill', label: t('health.fasting.backfill'), icon: 'history', attrs: { 'data-fasting-backfill': '' } }] : []),
      { action: 'fasting-settings', label: t('nav.settings'), icon: 'settings', attrs: { 'data-fasting-settings': '' } },
    ],
  });
}

function renderBody(view, stats, statsError = false) {
  const { root, state } = view;
  const writable = view.subject === view.self && state.canWrite && moduleAccess('health') === 'write';
  const active = state.active, last = state.history?.[0];
  const sections = fastingSections({ active, stats, statsError, rows: view.rows, filtered: Boolean(view.from || view.to) });
  const body = root.querySelector('[data-fasting-body]');
  body.replaceChildren();
  // OHNE FASTEN KEIN LEERER RING ALS HELD (Critique 2026-10-16). Vor dem
  // ersten Fasten stand ein 254px-Ring ohne Wert ueber allem, und der
  // Leerzustand des Verlaufs lag unter der Tab-Leiste. Ohne laufendes UND ohne
  // letztes Fasten hat der Ring nichts zu zeigen: die Karte traegt dann nur
  // Satz und Knoepfe (`fasting-hero--idle`, health.css).
  const idle = !active && !last;
  body.insertAdjacentHTML('beforeend', `<section class="metric-card fasting-hero${idle ? ' fasting-hero--idle' : ''}">
    <h3 class="u-section-title" data-fasting-clock-label></h3>${fastingClockSwitchHtml()}
    <div class="fasting-dial fasting-dial--segmented" data-fasting-progress><div data-fasting-segments></div><div class="fasting-dial__content"><div class="fasting-hero__timer" data-fasting-timer>00:00:00</div><span class="fasting-dial__days" data-fasting-days></span></div></div>
    <p class="sr-only" role="status" aria-live="polite" data-fasting-announcement></p>
    ${active ? `<p class="fasting-hero__remaining" data-fasting-remaining></p><p class="fasting-hero__meta">${esc(t('health.fasting.startedAt', { date: fastingStamp(active.start_at, active.start_tzid) }))}</p>${active.goal_minutes ? `<p class="fasting-hero__meta" data-fasting-target>${esc(t('health.fasting.targetAt', { date: fastingStamp(new Date(Date.parse(active.start_at) + active.goal_minutes * 60000).toISOString(), active.start_tzid) }))}</p>` : ''}` : ''}
    ${/* DAS ZIEL STEHT VOR DEM START (R24, Critique G5 P2-5): es lag nur im
         Einstellungsblatt hinter „...", gestartet lief man „Ohne Ziel" mit
         leerem Ring. Ohne laufendes Fasten traegt die Bereit-Karte die
         Ziel-Leiste; die Wahl gilt sofort fuer den naechsten Start (der FAB
         „Fasten starten" nimmt sie, R23 D14). */ ''}
    ${writable && !active ? `<div class="fasting-hero__goal" data-fasting-goal-host>${fastingGoalHtml(state.settings || {}, { compact: true })}<p class="form-hint" role="status" data-fasting-preferences-status></p></div>` : ''}
    ${writable ? `<div class="fasting-hero__actions">${active ? `<button class="btn btn--primary" type="button" data-fasting-action>${esc(t('health.fasting.finish'))}</button>` : ''}<button class="btn btn--secondary" type="button" ${active ? 'data-fasting-edit-start' : 'data-fasting-earlier'}>${esc(t(active ? 'health.fasting.editStart' : 'health.fasting.earlier'))}</button>${fastingMoreMenuHtml({ backfill: !sections.empty })}</div>` : `<p class="form-hint">${esc(t('health.fasting.readOnly'))}</p>`}
    <p class="form-hint" role="alert" data-fasting-error></p>
    ${state.settings?.zone_mode === 'educational' ? fastingEducationMarkup() : ''}
  </section>
  ${sections.stats ? renderFastingStats(stats, { error: statsError }) : ''}
  ${/* DER NACHTRAG STEHT AM VERLAUF (R22, D12; Critique a5 P2). Als FAB
        (D5) stand er als "+ Fasten" neben "Fasten starten" - zwei Wege, die
        beide nach Anlegen aussahen. Jetzt traegt der Inhalt die Hauptaktion
        (Timer), das Nachtragen ist die Aktion des Leerzustands bzw. ein
        Knopf im Kopf des Verlaufs - eine Stelle je Datenlage, kein Kopf. */ ''}
  ${sections.empty ? `<section id="history">${emptyStateHTML({
    icon: 'timer',
    title: t('health.fasting.noHistory'),
    description: t('health.fasting.emptyDesc'),
    action: writable ? { label: t('health.fasting.backfill'), icon: 'plus', tone: 'secondary', attrs: { 'data-fasting-backfill': '' } } : undefined,
  })}</section>` : `<section id="history"><div class="fasting-card__heading"><h3 class="u-section-title">${esc(t('health.fasting.history'))}</h3><a href="/api/v1/health/export/fasting${esc(fastingHistoryQuery(view))}" class="btn btn--secondary btn--sm" download>${esc(t('health.fasting.export'))}</a></div>
    ${filtersMarkup(view)}
    <div class="fasting-card" data-fasting-history></div><div class="fasting-history-more"><button class="btn btn--secondary" type="button" data-fasting-more ${view.more ? '' : 'hidden'}>${esc(t('health.fasting.loadMore'))}</button><p class="form-hint" role="alert" data-fasting-history-error></p></div>
  </section>`}`);
  installPopoverMenus(body);
  const reload = () => refresh(view);
  const reloadStats = () => refresh(view, { refreshStats: true });
  if (writable) {
    root.querySelector('[data-fasting-settings]')?.addEventListener('click', () => openFastingSettings(view, reload));
    const goalHost = root.querySelector('[data-fasting-goal-host]');
    if (goalHost) {
      // Dieselbe Verdrahtung wie im Blatt: jede Wahl speichert sofort, danach
      // zeichnet die Karte neu und der Fokus kehrt an die Wahl zurueck.
      wireFastingPreferences(goalHost, state.settings || {}, async () => {
        await reload();
        return root.querySelector('[data-fasting-goal-host]');
      }, () => view.state?.active ?? null);
    }
    const toggleFasting = async (button) => {
      if (button) button.disabled = true;
      try {
        if (active) await finishFasting(active, reloadStats, () => root.isConnected && view.subject === view.self);
        else if (await startFasting()) { await reload(); refocusAfterRender(); }
      } catch (error) {
        const message = root.isConnected && view.subject === view.self && root.querySelector('[data-fasting-error]');
        if (message) message.textContent = fastingError(error);
      } finally { if (button?.isConnected) button.disabled = false; }
    };
    root.querySelector('[data-fasting-action]')?.addEventListener('click', (event) => void toggleFasting(event.currentTarget));
    // „FASTEN STARTEN" IST DER FAB (R23 D14, Critique G5 P3). Der Start stand
    // als Primaerknopf im Ring, waehrend die Gesundheit sonst ueberall ueber
    // den FAB anlegt; das Nachtragen stand als dritter Knopf am Verlauf. Jetzt
    // fuehrt der FAB den Start (nur ohne laufendes Fasten und nur bei mir), der
    // Ring traegt das Beenden, Nachtragen und Einstellungen stehen im „...".
    view.onIntent?.({ canStart: !active, start: () => toggleFasting(null) });
    root.querySelector('[data-fasting-edit-start]')?.addEventListener('click', () => openFastingEditor(active, reload));
    const creator = async (completed) => { try { await openFastingCreator(completed ? reloadStats : reload, completed); } catch (error) { window.yuvomi?.showToast(fastingError(error), 'danger'); } };
    root.querySelector('[data-fasting-earlier]')?.addEventListener('click', () => void creator(false));
    root.querySelectorAll('[data-fasting-backfill]').forEach((button) => button.addEventListener('click', () => void creator(true)));
  } else {
    view.onIntent?.({ canStart: false, start: null });
  }
  root.querySelector('[data-fasting-education]')?.addEventListener('click', () => openModal({ title: t('health.fasting.zoneDetails'), content: `<p>${esc(t('health.fasting.zoneVariability'))}</p><ul>${['zoneMeal', 'zoneStored', 'zoneKetones', 'zoneLater'].map((key) => `<li>${esc(t(`health.fasting.${key}`))}</li>`).join('')}</ul><p>${esc(t('health.fasting.safetyDialog'))}</p>`, size: 'lg' }));
  wireFilters(view, body);
  renderHistory(view, writable);
  root.querySelector('[data-fasting-more]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget, generation = view.generation;
    if (!view.cursor || button.disabled) return;
    button.disabled = true;
    try {
      const response = await api.get(`/health/fasting/history${fastingHistoryQuery(view, view.cursor)}`);
      if (!root.isConnected || generation !== view.generation) return;
      const seen = new Set(view.rows.map((row) => row.id));
      view.rows.push(...response.data.filter((row) => !seen.has(row.id)));
      view.cursor = response.next_cursor; view.more = response.has_more;
      renderHistory(view, writable); button.hidden = !view.more;
    } catch { if (button.isConnected) root.querySelector('[data-fasting-history-error]').textContent = t('health.fasting.loadError'); }
    finally { button.disabled = false; }
  });
  view.stop = startFastingClock(root, active, last, state.settings || {}, { refresh: reloadStats, writable });
  window.lucide?.createIcons({ el: body });
  if (location.hash === '#history') root.querySelector('#history').scrollIntoView();
}

function renderHistory(view, writable) {
  const list = view.root.querySelector('[data-fasting-history]');
  if (!list) return;
  const rows = view.rows.filter((row) => !pendingDeletes.has(deleteKey(view.self, row.id)));
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', rows.length ? `<ul class="fasting-history">${rows.map((row) => `<li class="fasting-history__row"><div class="fasting-history__dates"><strong>${esc(fastingStamp(row.start_at, row.start_tzid))}</strong><span>${esc(fastingStamp(row.end_at, row.start_tzid))}</span>${row.note ? `<p>${esc(row.note)}</p>` : ''}</div><div class="fasting-history__summary"><strong>${esc(formatFastingDuration((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000))}</strong>${row.rating ? `<span aria-label="${esc(t('health.fasting.ratingValue', { value: row.rating }))}">${'★'.repeat(row.rating)}${'☆'.repeat(5 - row.rating)}</span>` : ''}</div>${writable ? `<div class="fasting-history__actions">${historyActionsHtml(row)}</div>` : ''}</li>`).join('')}</ul>` : `<p class="empty-hint">${esc(t('health.fasting.noHistory'))}</p>`);
  window.lucide?.createIcons({ el: list });
  list.querySelectorAll('[data-fast-edit]').forEach((button) => button.addEventListener('click', () => openFastingEditor(view.rows.find((row) => row.id === Number(button.dataset.fastEdit)), () => refresh(view, { refreshStats: true }))));
  list.querySelectorAll('[data-fast-delete]').forEach((button) => button.addEventListener('click', () => {
    try { requireFastingWrite(); } catch (error) { window.yuvomi?.showToast(fastingError(error), 'danger'); return; }
    const row = view.rows.find((entry) => entry.id === Number(button.dataset.fastDelete));
    const owner = view.self, key = deleteKey(owner, row.id);
    pendingDeletes.set(key, true); renderHistory(view, writable);
    const settled = (error) => {
      pendingDeletes.delete(key);
      if (error) window.yuvomi?.showToast(fastingError(error), 'danger');
      const current = currentOwners.get(owner);
      if (current?.root.isConnected) void refresh(current, { refreshStats: true });
    };
    scheduleUndoableDelete({ message: t('health.fasting.deleted'), restoreOnKeepaliveError: true,
      commit: async ({ keepalive }) => { await api.delete(`/health/fasting/${row.id}?expected_revision=${row.revision}`, { keepalive }); settled(); },
      restore: settled,
    });
  }));
}

/* ZEILENAKTIONEN IM KANON (R14 P3, A6 P2-1): Textknoepfe „Bearbeiten" und
 * „Loeschen" ohne Objekt wurden zu `row-action` mit Objektnamen - dieselbe
 * Bedienung wie jede Verlaufszeile der Gesundheit. */
function historyActionsHtml(row) {
  const name = `${t('health.fasting.title')} ${fastingStamp(row.start_at, row.start_tzid)}`;
  return rowActionHtml({ icon: 'pencil', label: t('common.editNamed', { name }), attrs: { 'data-fast-edit': row.id } })
    + rowActionHtml({ icon: 'trash-2', label: t('common.deleteNamed', { name }), tone: 'danger', attrs: { 'data-fast-delete': row.id } });
}
