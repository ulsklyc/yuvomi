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
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal, closeModal, captureModalContext, confirmOverModal, refocusAfterRender, reportFieldErrors, constraintErrors, dialogInitialFocus } from '/components/modal.js';
import { intervalMonthsToInput, intervalInputToMonths } from '/utils/health-prevention.js';
import { rowActionHtml } from '/utils/row-action.js';
import { errorSentence, isGone, isAlreadyDeleted } from '/utils/friendly-error.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';

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
    <div class="row-divided">
      ${_types.map((type) => `
        <div class="list-row" data-type-id="${esc(type.id)}">
          <div class="list-row__main">
            <div class="list-row__name settings-prevention-type__name">
              <i data-lucide="${esc(type.icon || 'syringe')}" class="icon-sm" aria-hidden="true"></i>
              ${esc(type.name)}
            </div>
            <div class="list-row__meta">${esc(t(`settings.healthPreventionKind.${type.kind}`))} · ${esc(typeIntervalLabel(type))}</div>
          </div>
          <div class="list-row__actions">
            ${rowActionHtml({ icon: 'pencil', label: t('common.editNamed', { name: type.name }), attrs: { 'data-edit-type': type.id } })}
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

/**
 * Fehler-Toast der Seite (#1909): der Satz der App, nie der des Servers. Gibt
 * es die bearbeitete Art nicht mehr, geht der Dialog zu und die Liste kommt
 * frisch vom Server.
 *
 * Geschlossen wird nur der Dialog, aus dem die Anfrage kam (`modalContext`
 * von VOR der Anfrage): kommt die Antwort, nachdem der Nutzer einen anderen
 * geoeffnet hat, bleibt der stehen (#1997).
 */
function reportError(err, modalContext) {
  window.yuvomi?.showToast(errorSentence(err), 'danger');
  if (!isGone(err)) return;
  closeModal({ force: true, context: modalContext }).then(() => reload()).then(() => refocusAfterRender()).catch(() => {});
}

function openTypeModal(type) {
  const isEdit = !!type;
  const val = (v) => (v == null ? '' : String(v));
  const interval = intervalMonthsToInput(type?.default_interval_months ?? null);

  openModal({
    title: isEdit ? t('settings.healthPreventionEditType') : t('settings.healthPreventionAddType'),
    initialFocus: dialogInitialFocus(isEdit),
    size: 'sm',
    content: `
      <form id="health-prevention-type-form" class="form-stack" novalidate>
        <div class="form-field">
          <label class="form-label" for="hpt-name">${esc(t('settings.healthPreventionTypeName'))}${REQUIRED_MARK}</label>
          <input class="form-input" id="hpt-name" type="text" maxlength="200" required value="${esc(val(type?.name))}">
        </div>
        <div class="form-field">
          <label class="form-label" for="hpt-kind">${esc(t('settings.healthPreventionTypeKind'))}</label>
          <select class="form-input" id="hpt-kind">
            ${KINDS.map((k) => `<option value="${esc(k)}" ${type?.kind === k ? 'selected' : ''}>${esc(t(`settings.healthPreventionKind.${k}`))}</option>`).join('')}
          </select>
        </div>
        <div class="modal-grid modal-grid--2">
          <div class="form-field">
            <label class="form-label" for="hpt-interval">${esc(t('settings.healthPreventionTypeInterval'))}</label>
            <input class="form-input" id="hpt-interval" type="number" inputmode="numeric" min="1" step="1"
                   value="${esc(val(interval.value))}" placeholder="${esc(t('settings.healthPreventionTypeIntervalPlaceholder'))}">
          </div>
          <div class="form-field">
            <label class="form-label" for="hpt-interval-unit">${esc(t('common.unit'))}</label>
            <select class="form-input" id="hpt-interval-unit">${intervalUnitOptions(interval.unit)}</select>
          </div>
        </div>
        <p class="form-hint">${esc(t('settings.healthPreventionTypeIntervalHint'))}</p>
        <div class="form-field">
          <label class="form-label" id="hpt-icon-label">${esc(t('settings.healthPreventionTypeIcon'))}</label>
          <button type="button" class="btn btn--secondary settings-icon-trigger" id="hpt-icon-trigger" aria-labelledby="hpt-icon-label">
            <i data-lucide="${esc(type?.icon || 'syringe')}" aria-hidden="true"></i>
            <span>${esc(t('iconPicker.title'))}</span>
          </button>
          <input type="hidden" id="hpt-icon" value="${esc(type?.icon || 'syringe')}">
        </div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          ${isEdit ? `<button type="button" class="btn btn--danger-outline" data-action="delete">
            <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}
          </button>` : ''}
          <button type="button" class="btn btn--secondary" data-action="cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
        </div>
      </form>`,
    onSave(panel) {
      panel.querySelector('#hpt-icon-trigger').addEventListener('click', async (event) => {
        const trigger = event.currentTarget;
        const { openIconPicker } = await import('/components/icon-picker.js');
        const hidden = panel.querySelector('#hpt-icon');
        const chosen = await openIconPicker(hidden.value || null, { suggestions: ICON_SUGGESTIONS, owner: trigger });
        if (chosen === undefined) return; // Abbruch - nichts aendern
        hidden.value = chosen || 'syringe'; // "kein Symbol" ergibt hier keinen Sinn - der Typ behaelt sein Zeichen
        const btn = panel.querySelector('#hpt-icon-trigger');
        btn.querySelectorAll('i[data-lucide], svg.lucide').forEach((el) => el.remove());
        btn.insertAdjacentHTML('afterbegin', `<i data-lucide="${esc(hidden.value)}" aria-hidden="true"></i>`);
        window.lucide?.createIcons({ el: btn });
      });

      panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
        // VOR der Rueckfrage: geschlossen wird nur dieser Dialog, nicht einer,
        // der waehrend der Anfrage aufgegangen ist (#1997).
        const modalContext = captureModalContext();
        const confirmed = await confirmOverModal(t('settings.healthPreventionDeleteTypeConfirm'), {
          danger: true,
          confirmLabel: t('common.delete'),
          detail: t('settings.healthPreventionDeleteTypeDetail'),
        });
        if (!confirmed) return;
        try {
          // Schon geloescht (ein anderer Admin war schneller): erledigt (#1909).
          try {
            await api.delete(`/health/prevention/types/${type.id}`);
          } catch (err) {
            if (!isAlreadyDeleted(err, 'health_prevention_type_not_found')) throw err;
          }
          closeModal({ force: true, context: modalContext });
          window.yuvomi?.showToast(t('settings.healthPreventionTypeDeleted'), 'success');
          await reload();
          refocusAfterRender();
        } catch (err) {
          reportError(err, modalContext);
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
        // KEINE BROWSER-BLASEN UND KEIN TOAST OHNE ORT (Critique R21, Muster
        // der Gesundheitsformulare): `novalidate`, die Regeln des Markups und
        // die zwei eigenen Pruefungen stehen am Feld, nicht als Meldung oben.
        const intervalMonths = intervalInputToMonths(intervalRaw, intervalUnit);
        const errors = constraintErrors(e.currentTarget);
        const flagged = (el) => errors.some(([field]) => field === el);
        const nameEl = panel.querySelector('#hpt-name');
        const intervalEl = panel.querySelector('#hpt-interval');
        if (!name && !flagged(nameEl)) errors.push([nameEl, t('settings.healthPreventionTypeNameRequired')]);
        if ((Number.isNaN(intervalMonths) || (intervalMonths != null && (intervalMonths < 1 || intervalMonths > MAX_INTERVAL_MONTHS)))
          && !flagged(intervalEl)) {
          errors.push([intervalEl, t('settings.healthPreventionTypeIntervalInvalid')]);
        }
        if (reportFieldErrors(errors)) return;
        const body = { name, kind, icon };
        if (intervalMonths != null) body.default_interval_months = intervalMonths;
        else if (isEdit) body.default_interval_months = null;

        const modalContext = captureModalContext();
        submitBtn.disabled = true;
        try {
          if (isEdit) {
            await api.patch(`/health/prevention/types/${type.id}`, body);
          } else {
            await api.post('/health/prevention/types', body);
          }
          closeModal({ force: true, context: modalContext });
          window.yuvomi?.showToast(t('settings.healthPreventionTypeSaved'), 'success');
          await reloadAfterSave(() => reload());
          refocusAfterRender();
        } catch (err) {
          submitBtn.disabled = false;
          reportError(err, modalContext);
        }
      });
    },
  });
}

export const __test = { openTypeModal };

export async function render(container) {
  _container = container;
  await loadTypes();
  renderPage(container);
  wire(container);
}
