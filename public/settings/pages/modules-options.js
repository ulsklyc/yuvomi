import { t } from '/i18n.js';
import { settingSwitchRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';

/**
 * Modul-Schalter, die vor dem IA-Umbau je ein eigenes Blatt hatten: Budget,
 * Gesundheit und Haushaltshilfe trugen zusammen drei Checkboxen, kosteten aber
 * drei Sidebar-Einträge, drei Navigationsschritte und drei Requests
 * (Critique 2026-07-27). Ein Schalter je Karte, ein Blatt. Aufgaben kam später
 * nach demselben Muster dazu.
 */
const APPEARANCE_PATH = '/settings/personal/appearance';

const TOGGLES = [
  {
    id: 'budget-mode-personal',
    key: 'budget_mode',
    // Der einzige Nicht-Boolean: die Route erwartet den Modus als String.
    read: (preferences) => preferences.budget_mode === 'personal',
    payload: (checked) => ({ budget_mode: checked ? 'personal' : 'shared' }),
    savedKey: 'settings.budgetModeSaved',
  },
  {
    id: 'health-cycle-enabled',
    key: 'health_cycle_enabled',
    read: (preferences) => preferences.health_cycle_enabled !== false,
    payload: (checked) => ({ health_cycle_enabled: checked }),
    savedKey: 'settings.healthCycleSaved',
  },
  {
    id: 'housekeeping-payment-tasks',
    key: 'housekeeping_payment_tasks',
    read: (preferences) => Boolean(preferences.housekeeping_payment_tasks),
    payload: (checked) => ({ housekeeping_payment_tasks: checked }),
    savedKey: 'settings.housekeepingPaymentTasksSaved',
  },
  {
    id: 'tasks-subtasks-expanded',
    key: 'tasks_subtasks_expanded',
    read: (preferences) => Boolean(preferences.tasks_subtasks_expanded),
    payload: (checked) => ({ tasks_subtasks_expanded: checked }),
    savedKey: 'settings.tasksSubtasksExpandedSaved',
  },
];

// Nicht Teil von TOGGLES: das sind DREI Kontrollkästchen ueber EINEM
// Praeferenz-Schluessel (ein Array von Vorlagen-Schluesseln, die AUSGEBLENDET
// sind), nicht ein Schluessel je Schalter. Angehakt heisst sichtbar - die
// gespeicherte Form ist die Ausblendliste, dieselbe Umkehrung wie bei
// disabled_modules/hidden_modules anderswo in diesem Baum.
const SCHEDULE_TEMPLATES = [
  ['work', 'schedule.templateWork'],
  ['school', 'schedule.templateSchool'],
  ['university', 'schedule.templateUniversity'],
];

function checkedState(preferences) {
  return new Map(TOGGLES.map((toggle) => [toggle.id, toggle.read(preferences)]));
}

/**
 * SEIT R10 KEIN EIGENES BLATT MEHR (Re-Critique 2026-09-27, A7 P1-3): die
 * "Modul-Optionen" waren eine Sammelschublade fuer fuenf Module. Jeder Teil
 * steht jetzt als Abschnitt "Fuer den Haushalt" im Blatt SEINES Moduls
 * (registry.js, `part`). Die Ueberschrift mit dem Modulnamen entfaellt deshalb:
 * das Blatt heisst schon so, und darueber steht die Reichweite.
 */
const PARTS = ['budget', 'health', 'housekeeping', 'tasks', 'schedule'];

/**
 * EIN TRAEGER JE TEIL, ZEILEN DARIN (R17, E9). Bis dahin stand jeder Schalter
 * in einer eigenen Karte mit Kartentitel und Hinweis darueber - 154 bis 225px
 * fuer eine Ja/Nein-Frage. Der Hinweis ist jetzt der Fuss der Gruppe.
 *
 * EINE ZEILE BRAUCHT KEINE UEBERSCHRIFT: der Kartentitel ueber einem einzelnen
 * Schalter ("Zyklus" ueber "Zyklus-Tab anzeigen", "Unteraufgaben" ueber
 * "Unteraufgaben in Aufgaben aufgeklappt lassen") sagte in einem Wort, was die
 * Zeile ausschreibt - und als Abschnittsueberschrift stuende "Zyklus" im Blatt
 * Gesundheit zweimal, wie vorher "Termine" im Kalender. Einen Titel traegt nur
 * die Gruppe mit mehreren Zeilen (Schichtplan-Vorlagen); er ist dort der
 * Suchtreffer.
 */
function groupHtml({ titleKey = null, rows, footer }) {
  return `
      ${titleKey ? `<h2 class="settings-section__title">${t(titleKey)}</h2>` : ''}
      <div class="row-carrier settings-group">${rows}</div>
      ${footer}`;
}

function partHtml(part, preferences, checked) {
  switch (part) {
    case 'budget':
      return groupHtml({
        rows: settingSwitchRowHtml({
          label: t('settings.budgetModePersonalLabel'),
          checked: checked.get('budget-mode-personal'),
          attrs: { id: 'budget-mode-personal', 'aria-describedby': 'budget-mode-hint' },
        }),
        footer: `
      <p class="form-hint settings-group__footer" id="budget-mode-hint">${t('settings.budgetModeHint')}</p>
      <p class="form-hint settings-group__footer">
        ${t('settings.currencyMovedHint')}
        <a href="${APPEARANCE_PATH}" id="budget-region-link">${t('settings.regionTitle')}</a>
      </p>`,
      });
    case 'health':
      return groupHtml({
        rows: settingSwitchRowHtml({
          label: t('settings.healthCycleEnableLabel'),
          checked: checked.get('health-cycle-enabled'),
          attrs: { id: 'health-cycle-enabled', 'aria-describedby': 'health-cycle-hint' },
        }),
        footer: `
      <p class="form-hint settings-group__footer" id="health-cycle-hint">${t('settings.healthCycleHint')}</p>`,
      });
    case 'housekeeping':
      return groupHtml({
        rows: settingSwitchRowHtml({
          label: t('settings.housekeepingPaymentTasksLabel'),
          checked: checked.get('housekeeping-payment-tasks'),
          attrs: { id: 'housekeeping-payment-tasks', 'aria-describedby': 'housekeeping-payment-tasks-hint' },
        }),
        footer: `
      <p class="form-hint settings-group__footer" id="housekeeping-payment-tasks-hint">${t('settings.housekeepingPaymentTasksHint')}</p>`,
      });
    case 'tasks':
      return groupHtml({
        rows: settingSwitchRowHtml({
          label: t('settings.tasksSubtasksExpandedLabel'),
          checked: checked.get('tasks-subtasks-expanded'),
          attrs: { id: 'tasks-subtasks-expanded', 'aria-describedby': 'tasks-subtasks-expanded-hint' },
        }),
        footer: `
      <p class="form-hint settings-group__footer" id="tasks-subtasks-expanded-hint">${t('settings.tasksSubtasksExpandedHint')}</p>`,
      });
    case 'schedule':
      return groupHtml({
        titleKey: 'settings.scheduleTemplatesTitle',
        rows: SCHEDULE_TEMPLATES.map(([key, labelKey]) => settingSwitchRowHtml({
          label: t(labelKey),
          checked: !(preferences.schedule_hidden_templates ?? []).includes(key),
          attrs: { id: `schedule-template-${key}`, 'data-template': key },
        })).join(''),
        footer: `
      <p class="form-hint settings-group__footer">${t('settings.scheduleTemplatesHint')}</p>`,
      });
    default:
      return '';
  }
}

function renderPage(container, preferences, part) {
  const checked = checkedState(preferences);
  const parts = PARTS.includes(part) ? [part] : PARTS;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', parts
    .map((entry) => `<section class="settings-section">${partHtml(entry, preferences, checked)}</section>`)
    .join(''));
}

function bindEvents(container) {
  const link = container.querySelector('#budget-region-link');
  link?.addEventListener('click', (event) => {
    if (!window.yuvomi?.navigate) return;
    event.preventDefault();
    window.yuvomi.navigate(APPEARANCE_PATH);
  });

  for (const toggle of TOGGLES) {
    const input = container.querySelector(`#${toggle.id}`);
    input?.addEventListener('change', async () => {
      input.disabled = true;
      try {
        await savePreferences(toggle.payload(input.checked));
        window.yuvomi?.showToast(t(toggle.savedKey), 'success');
      } catch (error) {
        input.checked = !input.checked; // Rollback nur bei Save-Fehler
        window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
      } finally {
        if (input.isConnected) input.disabled = false;
      }
    });
  }

  // Kein Eintrag in TOGGLES: die drei Kontrollkaestchen teilen sich EINEN
  // Praeferenz-Schluessel (die Ausblendliste), ein Klick muss also alle drei
  // aktuellen Zustaende einsammeln, nicht nur den eigenen.
  const templateInputs = SCHEDULE_TEMPLATES.map(([key]) => container.querySelector(`#schedule-template-${key}`));
  for (const input of templateInputs) {
    input?.addEventListener('change', async () => {
      templateInputs.forEach((el) => { if (el) el.disabled = true; });
      try {
        const hidden = templateInputs.filter((el) => el && !el.checked).map((el) => el.dataset.template);
        await savePreferences({ schedule_hidden_templates: hidden });
        window.yuvomi?.showToast(t('settings.scheduleTemplatesSaved'), 'success');
      } catch (error) {
        input.checked = !input.checked;
        window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
      } finally {
        templateInputs.forEach((el) => { if (el?.isConnected) el.disabled = false; });
      }
    });
  }
}

// Welcher Teil, sagt der Abschnitt (registry.js `props.part`): die Shell
// schreibt ihn an den Traeger, die Signatur bleibt die aller Blaetter.
export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences, container.dataset.part);
  bindEvents(container);
}
