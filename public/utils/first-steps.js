/**
 * Modul: Erste Schritte auf der Uebersicht (R23 D14, Critique G6 P2)
 * Zweck: Nach dem Rundgang stand eine leere Uebersicht da - kein Weg zu den
 *        Mitgliedern, zu den Modulen, zu Region und Zeitzone ("Nach Tour
 *        Sackgasse"). Eine Karte mit drei Haken fuehrt dorthin und
 *        verschwindet, sobald alles erledigt ist oder jemand sie wegklickt.
 * Abhaengigkeiten: ./html.js. `t` kommt herein, damit Modell und Bauform ohne
 *        Loader pruefbar sind (test/test-first-steps.js).
 *
 * NUR FUER WEN SIE GEDACHT IST. Ein Admin, der den Rundgang gerade beendet hat
 * (`startFirstSteps()` aus dashboard.js). Bestandshaushalte sehen sie nie:
 * ohne diesen Start bleibt sie aus, auch nach einem Update.
 *
 * WOHER "ERLEDIGT" KOMMT. Mitglieder: der Haushalt hat zwei oder mehr
 * Mitglieder (die Uebersicht kennt sie). Module und Region: der Weg dorthin
 * wurde einmal genommen - beides sind Entscheidungen, die man pruefen, nicht
 * an einem Wert ablesen kann (die Einrichtung setzt die Zone schon selbst).
 * Der Stand liegt im Browser (`localStorage`), nicht am Konto: die Karte ist
 * eine Anleitung fuer diesen ersten Abend, kein Datensatz - ein zweites Geraet
 * zeigt sie nicht, und das ist gewollt.
 */

import { esc } from './html.js';

const STORAGE_KEY = 'yuvomi-first-steps';

/** Die drei Schritte, in der Reihenfolge, in der ein neuer Haushalt sie braucht. */
export const FIRST_STEPS = Object.freeze([
  { id: 'family', labelKey: 'firstSteps.family', href: '/settings/admin/family', icon: 'users' },
  { id: 'modules', labelKey: 'firstSteps.modules', href: '/settings/modules/active', icon: 'layout-grid' },
  { id: 'region', labelKey: 'firstSteps.region', href: '/settings/personal/appearance', icon: 'globe' },
]);

function readState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(state, storage = globalThis.localStorage) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* privates Fenster: dann eben nicht */ }
}

/** Nach dem Rundgang: die Karte beginnt (dashboard.js, finish des Rundgangs). */
export function startFirstSteps(storage) {
  const state = readState(storage);
  if (state?.active || state?.dismissed) return;
  writeState({ active: true, dismissed: false, done: {} }, storage);
}

/**
 * Laeuft die Karte noch? Fuer die Uebersicht, die einem neuen Haushalt nicht
 * "Heute frei" sagen soll (R24, Critique G6 P2-2) - er ist nicht frei, er ist
 * leer.
 */
export function firstStepsActive(storage) {
  const state = readState(storage);
  return Boolean(state?.active && !state.dismissed);
}

/** Ein Schritt wurde gegangen. */
export function markFirstStep(id, storage) {
  const state = readState(storage);
  if (!state?.active) return;
  writeState({ ...state, done: { ...state.done, [id]: true } }, storage);
}

/** Weggeklickt: die Karte kommt nicht wieder. */
export function dismissFirstSteps(storage) {
  writeState({ active: false, dismissed: true, done: readState(storage)?.done ?? {} }, storage);
}

/**
 * Was die Karte zeigt - oder `null`, wenn sie nicht steht.
 *
 * @param {{ user?: object|null, wall?: boolean, memberCount?: number|null, storage?: Storage }} opts
 * @returns {{ steps: Array<{id:string,labelKey:string,href:string,icon:string,done:boolean}>, doneCount: number }|null}
 */
export function firstStepsModel({ user, wall = false, memberCount = null, storage } = {}) {
  if (wall || user?.role !== 'admin' || user?.access_scope === 'display') return null;
  const state = readState(storage);
  if (!state?.active || state.dismissed) return null;
  const done = { ...state.done };
  if (Number(memberCount) >= 2) done.family = true;
  const steps = FIRST_STEPS.map((step) => ({ ...step, done: Boolean(done[step.id]) }));
  const doneCount = steps.filter((step) => step.done).length;
  if (doneCount === steps.length) {
    // Alles erledigt: die Karte endet hier, auch fuer das naechste Laden.
    writeState({ ...state, active: false, done }, storage);
    return null;
  }
  return { steps, doneCount };
}

/** Das Markup der Karte (schon uebersetzt ueber `t`). */
export function firstStepsHtml(model, t) {
  if (!model) return '';
  const rows = model.steps.map((step) => `
      <li>
        <a class="first-steps__step${step.done ? ' first-steps__step--done' : ''}" href="${esc(step.href)}" data-first-step="${esc(step.id)}">
          <span class="check-ring check-ring--static first-steps__ring${step.done ? ' check-ring--done' : ''}" aria-hidden="true">
            <i data-lucide="check" class="check-ring__check"></i>
          </span>
          <span class="first-steps__label">${esc(t(step.labelKey))}${step.done ? `<span class="sr-only">, ${esc(t('firstSteps.stepDone'))}</span>` : ''}</span>
          <i data-lucide="chevron-right" class="first-steps__chevron" aria-hidden="true"></i>
        </a>
      </li>`).join('');
  return `
    <section class="first-steps" aria-labelledby="first-steps-title">
      <div class="first-steps__head">
        <h2 class="first-steps__title" id="first-steps-title">${esc(t('firstSteps.title'))}</h2>
        <span class="first-steps__count">${esc(`${model.doneCount}/${model.steps.length}`)}</span>
        <button type="button" class="btn btn--icon btn--ghost first-steps__close" data-first-steps-dismiss aria-label="${esc(t('firstSteps.dismiss'))}">
          <i data-lucide="x" aria-hidden="true"></i>
        </button>
      </div>
      <ul class="first-steps__list">${rows}
      </ul>
    </section>`;
}

/**
 * Haengt die Karte VOR `before` in `host` (wie den Zonen-Hinweis: neben die
 * Shell, nicht hinein - die wird mit den Daten neu gefuellt). Sie steht vom
 * ersten Bild an, damit nichts nachrutscht; `update(memberCount)` setzt nach
 * dem Laden nur den Haken der Mitglieder.
 *
 * @returns {{ update: (memberCount: number|null) => void }}
 */
export function mountFirstSteps(host, { user, wall = false, before = null, t, navigate } = {}) {
  host?.querySelector?.(':scope > .first-steps')?.remove();
  let el = null;
  const draw = (memberCount) => {
    const model = firstStepsModel({ user, wall, memberCount });
    if (!model) { el?.remove(); el = null; return; }
    const html = firstStepsHtml(model, t);
    const next = document.createElement('div');
    next.insertAdjacentHTML('beforeend', html);
    const card = next.firstElementChild;
    if (el) el.replaceWith(card);
    else if (before?.parentNode === host) host.insertBefore(card, before);
    else host?.prepend?.(card);
    el = card;
    window.lucide?.createIcons({ el: card });
    card.querySelector('[data-first-steps-dismiss]')?.addEventListener('click', () => {
      dismissFirstSteps();
      card.remove();
      el = null;
      document.getElementById('main-content')?.focus?.();
    });
    card.querySelectorAll('[data-first-step]').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault();
      markFirstStep(link.dataset.firstStep);
      navigate?.(link.getAttribute('href'));
    }));
  };
  if (host) draw(null);
  return { update: (memberCount) => { if (host && (el || memberCount != null)) draw(memberCount); } };
}
