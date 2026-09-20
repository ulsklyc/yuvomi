/**
 * Modul: Einstellungen - Gesundheit (Modul) - Vorsorge-Typregister
 * Zweck: Admin-Verwaltung von health_prevention_types - Impfungen/Vorsorge-
 *        untersuchungen, die der HAUSHALT selbst benennt (D2). Nichts ist
 *        vorbefuellt (docs/SCOPE.md schliesst mitgelieferte Kataloge aus, die
 *        veralten) - diese Seite ist der einzige Weg, einen Typ anzulegen.
 * Abhängigkeiten: /api.js, /i18n.js, /components/modal.js
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmOverModal, refocusAfterRender } from '/components/modal.js';
import { intervalMonthsToInput, intervalInputToMonths } from '/utils/health-prevention.js';

const KINDS = ['vaccination', 'checkup'];
const MAX_INTERVAL_MONTHS = 600;

/** Starthilfe fuer den Symbol-Dialog (#873) - der volle Vorrat bleibt ueber
 *  die Suche erreichbar, das hier ist nur, was ohne Suchbegriff im Raster
 *  steht (siehe components/icon-picker.js#SUGGESTIONS). */
const ICON_SUGGESTIONS = [
  'syringe', 'shield-check', 'stethoscope', 'calendar-clock', 'heart-pulse',
  'activity', 'pill', 'thermometer', 'clipboard-list', 'droplet',
];

/** Monate/Jahre-Auswahl fuer das Intervall-Feld - Beschriftungen aus dem
 *  bestehenden Wiederholungs-Editor (rrule.unitMonths/unitYears), damit "alle
 *  10 Jahre" nicht ein zweites Vokabular fuer denselben Begriff bekommt. */
function intervalUnitOptions(selectedUnit) {
  return [
    ['months', t('rrule.unitMonths')],
    ['years', t('rrule.unitYears')],
  ].map(([value, label]) => `<option value="${value}" ${selectedUnit === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

let _container = null;
let _types = [];

async function loadTypes() {
  const res = await api.get('/health/prevention/types');
  _types = res.data || [];
}

function typeIntervalLabel(type) {
  if (!type.default_interval_months) return t('settings.healthPreventionOneOff');
  // Ein Typ alle 10 Jahre eingetragen soll auch "alle 10 Jahre" lesen, nicht
  // "alle 120 Monate" - dieselbe Monate/Jahre-Umrechnung wie das Formular
  // direkt darueber, das Monate ODER Jahre entgegennimmt (Review #1256).
  const { value, unit } = intervalMonthsToInput(type.default_interval_months);
  return unit === 'years'
    ? t('settings.healthPreventionIntervalYears', { count: value })
    : t('settings.healthPreventionIntervalMonths', { count: value });
}

function typesListMarkup() {
  if (!_types.length) {
    return `<p class="settings-card-description">${esc(t('settings.healthPreventionTypesEmpty'))}</p>`;
  }
  return `
    <div class="list-rows">
      ${_types.map((type) => `
        <div class="list-row" data-type-id="${esc(type.id)}">
          <div class="list-row__main">
            <div class="list-row__name">
              <i data-lucide="${esc(type.icon || 'syringe')}" class="icon-sm" aria-hidden="true"></i>
              ${esc(type.name)}
            </div>
            <div class="list-row__meta">${esc(t(`settings.healthPreventionKind.${type.kind}`))} · ${esc(typeIntervalLabel(type))}</div>
          </div>
          <div class="list-row__actions">
            <button type="button" class="btn btn--icon btn--sm" data-edit-type="${esc(type.id)}"
                    aria-label="${esc(t('common.edit'))}">
              <i data-lucide="pencil" aria-hidden="true"></i>
            </button>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <h2 class="settings-card__title">${esc(t('settings.healthPreventionTypesTitle'))}</h2>
        <p class="form-hint">${esc(t('settings.healthPreventionTypesHint'))}</p>
        <div id="health-prevention-types-list">${typesListMarkup()}</div>
        <div class="settings-form-actions">
          <button type="button" class="btn btn--secondary" id="health-prevention-add-type">
            <i data-lucide="plus" aria-hidden="true"></i>
            ${esc(t('settings.healthPreventionAddType'))}
          </button>
        </div>
      </div>
    </section>
  `);
  if (window.lucide) window.lucide.createIcons({ el: container });
}

function wire(container) {
  container.querySelector('#health-prevention-add-type')?.addEventListener('click', () => openTypeModal(null));
  container.querySelectorAll('[data-edit-type]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.editType);
      const type = _types.find((x) => x.id === id);
      if (type) openTypeModal(type);
    }));
}

async function reload() {
  await loadTypes();
  renderPage(_container);
  wire(_container);
}

function openTypeModal(type) {
  const isEdit = !!type;
  const val = (v) => (v == null ? '' : String(v));
  const interval = intervalMonthsToInput(type?.default_interval_months ?? null);

  openModal({
    title: isEdit ? t('settings.healthPreventionEditType') : t('settings.healthPreventionAddType'),
    size: 'sm',
    content: `
      <form id="health-prevention-type-form" class="form-stack">
        <div class="form-field">
          <label class="label" for="hpt-name">${esc(t('settings.healthPreventionTypeName'))}</label>
          <input class="input" id="hpt-name" type="text" maxlength="200" required value="${esc(val(type?.name))}">
        </div>
        <div class="form-field">
          <label class="label" for="hpt-kind">${esc(t('settings.healthPreventionTypeKind'))}</label>
          <select class="input" id="hpt-kind">
            ${KINDS.map((k) => `<option value="${esc(k)}" ${type?.kind === k ? 'selected' : ''}>${esc(t(`settings.healthPreventionKind.${k}`))}</option>`).join('')}
          </select>
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="label" for="hpt-interval">${esc(t('settings.healthPreventionTypeInterval'))}</label>
            <input class="input" id="hpt-interval" type="number" inputmode="numeric" min="1" step="1"
                   value="${esc(val(interval.value))}" placeholder="${esc(t('settings.healthPreventionTypeIntervalPlaceholder'))}">
          </div>
          <div class="form-field">
            <label class="label" for="hpt-interval-unit">${esc(t('common.unit'))}</label>
            <select class="input" id="hpt-interval-unit">${intervalUnitOptions(interval.unit)}</select>
          </div>
        </div>
        <p class="form-hint">${esc(t('settings.healthPreventionTypeIntervalHint'))}</p>
        <div class="form-field">
          <label class="label" id="hpt-icon-label">${esc(t('settings.healthPreventionTypeIcon'))}</label>
          <button type="button" class="btn btn--secondary settings-icon-trigger" id="hpt-icon-trigger" aria-labelledby="hpt-icon-label">
            <i data-lucide="${esc(type?.icon || 'syringe')}" aria-hidden="true"></i>
            <span>${esc(t('iconPicker.title'))}</span>
          </button>
          <input type="hidden" id="hpt-icon" value="${esc(type?.icon || 'syringe')}">
        </div>
        <div class="modal-actions">
          ${isEdit ? `<button type="button" class="btn btn--danger btn--ghost" data-action="delete">${esc(t('common.delete'))}</button>` : ''}
          <button type="button" class="btn btn--ghost" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      panel.querySelector('#hpt-icon-trigger').addEventListener('click', async () => {
        const { openIconPicker } = await import('/components/icon-picker.js');
        const hidden = panel.querySelector('#hpt-icon');
        const chosen = await openIconPicker(hidden.value || null, { suggestions: ICON_SUGGESTIONS });
        if (chosen === undefined) return; // Abbruch - nichts aendern
        hidden.value = chosen || 'syringe'; // "kein Symbol" ergibt hier keinen Sinn - der Typ behaelt sein Zeichen
        const btn = panel.querySelector('#hpt-icon-trigger');
        btn.querySelectorAll('i[data-lucide], svg.lucide').forEach((el) => el.remove());
        btn.insertAdjacentHTML('afterbegin', `<i data-lucide="${esc(hidden.value)}" aria-hidden="true"></i>`);
        window.lucide?.createIcons({ el: btn });
      });

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
        const confirmed = await confirmOverModal(t('settings.healthPreventionDeleteTypeConfirm'), {
          danger: true,
          confirmLabel: t('common.delete'),
          detail: t('settings.healthPreventionDeleteTypeDetail'),
        });
        if (!confirmed) return;
        try {
          await api.delete(`/health/prevention/types/${type.id}`);
          closeModal({ force: true });
          window.yuvomi?.showToast(t('settings.healthPreventionTypeDeleted'), 'success');
          await reload();
          refocusAfterRender();
        } catch (err) {
          window.yuvomi?.showToast(err?.data?.error || t('common.errorGeneric'), 'danger');
        }
      });

      panel.querySelector('#health-prevention-type-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = panel.querySelector('[type="submit"]');
        const name = panel.querySelector('#hpt-name').value.trim();
        const kind = panel.querySelector('#hpt-kind').value;
        const intervalRaw = panel.querySelector('#hpt-interval').value.trim();
        const intervalUnit = panel.querySelector('#hpt-interval-unit').value;
        const icon = panel.querySelector('#hpt-icon').value.trim() || 'syringe';
        if (!name) {
          window.yuvomi?.showToast(t('settings.healthPreventionTypeNameRequired'), 'danger');
          return;
        }
        const intervalMonths = intervalInputToMonths(intervalRaw, intervalUnit);
        if (Number.isNaN(intervalMonths) || (intervalMonths != null && (intervalMonths < 1 || intervalMonths > MAX_INTERVAL_MONTHS))) {
          window.yuvomi?.showToast(t('settings.healthPreventionTypeIntervalInvalid'), 'danger');
          return;
        }
        const body = { name, kind, icon };
        if (intervalMonths != null) body.default_interval_months = intervalMonths;
        else if (isEdit) body.default_interval_months = null;

        submitBtn.disabled = true;
        try {
          if (isEdit) {
            await api.patch(`/health/prevention/types/${type.id}`, body);
          } else {
            await api.post('/health/prevention/types', body);
          }
          closeModal({ force: true });
          window.yuvomi?.showToast(t('settings.healthPreventionTypeSaved'), 'success');
          await reload();
          refocusAfterRender();
        } catch (err) {
          submitBtn.disabled = false;
          window.yuvomi?.showToast(err?.data?.error || t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

export async function render(container) {
  _container = container;
  await loadTypes();
  renderPage(container);
  wire(container);
}
