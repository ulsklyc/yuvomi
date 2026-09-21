import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { toggleRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { VITAL_METRICS } from '/utils/health-vitals.js';
import { canUseFasting } from '/permissions.js';

/**
 * Die Bereiche, deren Standard-Sichtbarkeit hier gewaehlt wird (#958).
 *
 * Die Vitalwerte stehen JE METRIK, die drei anderen je Bereich. Wer den
 * Blutdruck mit der Familie teilen will, teilt damit nicht die Stimmung - beide
 * sind Vitalwerte, aber nicht dieselbe Art Auskunft. Medikamente, Laborbefunde
 * und Aktivitaeten sind dagegen je EINE Sorte Eintrag.
 *
 * Der Zyklus fehlt hier bewusst: er hat seinen Schalter an seinen eigenen
 * Einstellungen, und zwei Orte fuer dieselbe Wahl waeren einer zu viel.
 */
function visibilityScopes() {
  return [
    {
      titleKey: 'health.tabs.vitals',
      rows: VITAL_METRICS.map((m) => ({ key: `vital:${m.type}`, label: t(m.labelKey) })),
    },
    {
      titleKey: 'settings.healthVisibilityOther',
      rows: [
        { key: 'meds', label: t('health.tabs.meds') },
        { key: 'labs', label: t('health.tabs.labs') },
        { key: 'activities', label: t('health.tabs.activity') },
        { key: 'prevention', label: t('health.tabs.prevention') },
        // Ohne diese Zeile kennt der Server den Bereich (FLAT_SCOPES), aber
        // niemand koennte ihn je auf 'family' stellen - die Voreinstellung
        // bliebe fuer immer 'private'. Genau die Luecke hatte 'prevention'
        // eine Weile; ein Guard in test:health-visibility-defaults haelt sie
        // seither zu.
        { key: 'nutrition', label: t('health.tabs.nutrition') },
        ...(canUseFasting() ? [{ key: 'fasting', label: t('health.fasting.title') }] : []),
      ],
    },
  ];
}

function scopeRowHtml(row, current) {
  const isFamily = current === 'family';
  return `
    <div class="form-group">
      <label class="form-label" for="hv-${esc(row.key)}">${esc(row.label)}</label>
      <select class="form-input" id="hv-${esc(row.key)}" data-scope="${esc(row.key)}">
        <option value="private"${isFamily ? '' : ' selected'}>${esc(t('health.vitals.visibility.private'))}</option>
        <option value="family"${isFamily ? ' selected' : ''}>${esc(t('health.vitals.visibility.family'))}</option>
      </select>
    </div>`;
}

/**
 * Gesundheits-Ansichten, die nur für mich gelten (#760).
 *
 * Eigenes Blatt und nicht in `modules-options`: ob der Haushalt den Zyklus
 * überhaupt führt, ist eine Admin-Entscheidung und steht dort. Ob ich ihn sehen
 * will, ist meine - und nicht jede Person im Haushalt hat einen Zyklus. Das
 * adminOnly-`modules-options` könnten fünf von sechs Familienmitgliedern gar
 * nicht öffnen; derselbe Fehler steckte schon einmal in `modules-calendar`
 * (Critique 2026-07-27) und in `sync-reminders` (#695).
 *
 * Die beiden Schalter verrechnet der Server zu `health_cycle_effective`; hier
 * wird nur gezeigt, welcher von beiden gerade das Sagen hat.
 */

function renderPage(container, preferences, defaults) {
  // Der Haushalt hat den Zyklus abgeschaltet: dann ändert der persönliche
  // Schalter nichts mehr. Ihn trotzdem bedienbar zu lassen wäre eine Lüge über
  // die eigene Wirkung, also wird er gesperrt und der Grund benannt.
  const householdEnabled = preferences.health_cycle_enabled !== false;
  const personalEnabled = preferences.health_cycle_enabled_user !== false;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <!-- Bewusst NICHT der Blatt-Titel "Gesundheit": die Shell zeigt ihn bereits
           darüber, und ein h2, das ihn wiederholt, ist eine Überschrift ohne
           Aussage (Guard in test-typography.js). -->
      <h2 class="settings-section__title">${t('health.tabs.cycle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.healthCyclePersonalHint')}</p>
        ${toggleRowHtml({
          label: t('settings.healthCyclePersonalLabel'),
          checked: personalEnabled,
          disabled: !householdEnabled,
          attrs: { id: 'health-cycle-personal' },
        })}
        ${householdEnabled ? '' : `<p class="form-hint">${t('settings.healthCyclePersonalHouseholdOff')}</p>`}
      </div>
    </section>
    <section class="settings-section">
      <h2 class="settings-section__title">${t('health.tabs.prevention')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.healthPreventionNotifyCaregiversHint')}</p>
        ${toggleRowHtml({
          label: t('settings.healthPreventionNotifyCaregiversLabel'),
          checked: preferences.health_prevention_notify_caregivers === true,
          attrs: { id: 'health-prevention-notify-caregivers' },
        })}
      </div>
    </section>
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.healthVisibilityTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.healthVisibilityHint')}</p>
        ${visibilityScopes().map((group) => `
          <h3 class="settings-card__title">${esc(t(group.titleKey))}</h3>
          ${group.rows.map((row) => scopeRowHtml(row, defaults[row.key])).join('')}
        `).join('')}
        <div class="form-group" id="hv-apply" hidden>
          <p class="form-hint" id="hv-apply-text"></p>
          <button type="button" class="btn btn--secondary btn--sm" id="hv-apply-btn"></button>
        </div>
      </div>
    </section>
  `);
}

function bindEvents(container) {
  const input = container.querySelector('#health-cycle-personal');
  input?.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await savePreferences({ health_cycle_enabled_user: input.checked });
      window.yuvomi?.showToast(t('settings.healthCyclePersonalSaved'), 'success');
    } catch (error) {
      input.checked = !input.checked; // Rollback nur bei Save-Fehler
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (input.isConnected) input.disabled = false;
    }
  });

  // Opt-in fuer den Betreuungs-Fan-out der Vorsorge-Erinnerungen (Review
  // #1256) - Standard aus, wirkt sofort (der Server stoesst den Sync bei
  // dieser Aenderung selbst an).
  const notifyInput = container.querySelector('#health-prevention-notify-caregivers');
  notifyInput?.addEventListener('change', async () => {
    notifyInput.disabled = true;
    try {
      await savePreferences({ health_prevention_notify_caregivers: notifyInput.checked });
      window.yuvomi?.showToast(t('settings.healthPreventionNotifyCaregiversSaved'), 'success');
    } catch (error) {
      notifyInput.checked = !notifyInput.checked;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (notifyInput.isConnected) notifyInput.disabled = false;
    }
  });
}

/**
 * Die Standard-Sichtbarkeit eines Bereichs speichern (#958).
 *
 * Gespeichert wird sofort bei der Aenderung, nicht ueber einen Speichern-Knopf:
 * das Blatt hat keinen, und ein einzelner Schalter, der auf einen Knopf wartet,
 * waere die einzige Stelle hier mit dieser Regel.
 *
 * DANACH steht die Frage nach den BESTEHENDEN Eintraegen - und zwar nur dann,
 * gezielt fuer den eben geaenderten Bereich. Ein Knopf je Zeile waere ein
 * Dutzend Knoepfe fuer eine Handlung, die man selten braucht; ein Knopf fuer
 * alles zusammen waere zu grob, weil er auch die Bereiche mitnaehme, die man
 * gerade nicht gemeint hat.
 */
function bindVisibilityEvents(container) {
  const applyBox = container.querySelector('#hv-apply');
  const applyText = container.querySelector('#hv-apply-text');
  const applyBtn = container.querySelector('#hv-apply-btn');
  if (!applyBox || !applyText || !applyBtn) return;
  let pending = null;

  const hideApply = () => {
    applyBox.hidden = true;
    pending = null;
  };

  for (const select of container.querySelectorAll('[data-scope]')) {
    select.addEventListener('change', async () => {
      const scope = select.dataset.scope;
      const visibility = select.value;
      const label = container.querySelector(`label[for="hv-${CSS.escape(scope)}"]`)?.textContent || scope;
      select.disabled = true;
      try {
        await api.put('/health/visibility-defaults', { defaults: { [scope]: visibility } });
        pending = { scope, visibility };
        applyText.textContent = t('settings.healthVisibilityApplyHint', { area: label });
        applyBtn.textContent = t('settings.healthVisibilityApply');
        applyBox.hidden = false;
      } catch (error) {
        hideApply();
        window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
      } finally {
        if (select.isConnected) select.disabled = false;
      }
    });
  }

  applyBtn.addEventListener('click', async () => {
    if (!pending) return;
    applyBtn.disabled = true;
    try {
      const res = await api.patch('/health/visibility-defaults/apply', pending);
      const updated = Number(res?.data?.updated || 0);
      window.yuvomi?.showToast(t('settings.healthVisibilityApplied', { count: updated }), 'success');
      hideApply();
    } catch (error) {
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      applyBtn.disabled = false;
    }
  });
}

export async function render(container, { user }) {
  void user;
  // Ein Ausfall der Voreinstellungen darf das Blatt nicht kosten: ohne Antwort
  // stehen alle Bereiche auf 'privat', dem ausgelieferten Wert.
  const [preferences, defaults] = await Promise.all([
    getPreferences(),
    api.get('/health/visibility-defaults')
      .then((res) => res?.data?.defaults || {})
      .catch(() => ({})),
  ]);
  renderPage(container, preferences, defaults);
  bindEvents(container);
  bindVisibilityEvents(container);
}
