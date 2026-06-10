import { api } from '/api.js';
import { t } from '/i18n.js';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

function renderPage(container, preferences) {
  const visibleMealTypes = Array.isArray(preferences.visible_meal_types)
    ? preferences.visible_meal_types
    : MEAL_TYPES;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <header class="settings-leaf-header">
      <h1 class="settings-leaf-header__title">${t('settings.pageKitchen')}</h1>
      <p class="settings-leaf-header__description">${t('settings.pageKitchenDescription')}</p>
    </header>

    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.sectionMeals')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.mealTypesLabel')}</h3>
        <p class="form-hint">${t('settings.mealTypesHint')}</p>
        <div class="meal-type-toggles" id="meal-type-toggles">
          ${MEAL_TYPES.map((mealType) => `
            <label class="toggle-row">
              <input type="checkbox" value="${mealType}"${visibleMealTypes.includes(mealType) ? ' checked' : ''}>
              <span>${t(`meals.type${mealType[0].toUpperCase()}${mealType.slice(1)}`)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    </section>
  `);
}

function bindEvents(container) {
  const mealToggles = container.querySelector('#meal-type-toggles');
  mealToggles?.addEventListener('change', async () => {
    const checkedMealTypes = [...mealToggles.querySelectorAll('input:checked')]
      .map((checkbox) => checkbox.value);

    if (checkedMealTypes.length === 0) {
      mealToggles.querySelectorAll('input').forEach((checkbox) => {
        checkbox.checked = true;
      });
      window.oikos?.showToast(t('settings.mealTypesMinOne'), 'danger');
      return;
    }

    try {
      await api.put('/preferences', { visible_meal_types: checkedMealTypes });
      window.oikos?.showToast(t('settings.mealTypesSaved'), 'success');
    } catch (error) {
      window.oikos?.showToast(error.message || t('common.errorGeneric'), 'danger');
    }
  });
}

export async function render(container, { user }) {
  void user;
  const response = await api.get('/preferences');
  const preferences = response?.data ?? {};
  renderPage(container, preferences);
  bindEvents(container);
}
