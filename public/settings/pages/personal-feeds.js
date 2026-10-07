/**
 * Modul: Feed-Abos (persoenlich)
 * Zweck: Die vier schreibgeschuetzten ICS-Feeds, mit denen eine Person
 *        Yuvomi-Daten in ihrem eigenen Kalenderprogramm abonniert - der
 *        Haushaltskalender, die Inventar-Fristen, der Zyklus und der eigene
 *        Schichtplan.
 *
 * Warum ein eigenes Blatt und warum unter `personal`: alle vier Tokens haengen
 * an der eigenen users-Zeile (calendar_feed_token, Migration 61;
 * inventory_deadlines_feed_token, Migration 144; cycle_feed_token,
 * Migration 180; schedule_feed_token, Migration 183), und alle vier Routen
 * tragen serverseitig bewusst keinen
 * Admin-Check. Die ersten beiden lagen trotzdem auf `sync-calendar`, das
 * adminOnly ist - in einem Haushalt mit fuenf Mitgliedern konnte also genau
 * eine Person ihr eigenes Abo einrichten oder zurueckziehen. Was in den Feed
 * HINEIN kommt (CalDAV-Konten, ICS-Abos, Kalenderimport), bleibt eine
 * Haushaltsfrage und damit auf dem gegateten Blatt; was aus ihm HERAUS geht,
 * ist persoenlich. Vierter Fall desselben Musters, siehe die Kommentare an
 * `personal-calendar`, `personal-tasks` und `modules-navigation` in
 * ../registry.js.
 *
 * Der Zyklus-Feed unterscheidet sich vom Inventar-Feed genau an der Stelle,
 * die server/services/cycle-ics.js dokumentiert: der FEED-INHALT ist
 * personengebunden (nicht nur das Token), keine Haushalts-Aggregation - das
 * haelt Zyklusdaten aus dem Betreuungs-Freigabe-System heraus (#584). Der
 * Schichtplan-Feed liegt genauso: gefeedet werden nur die eigenen aufgeloesten
 * Eintraege des Token-Besitzers, siehe server/services/schedule-ics.js.
 *
 * EIN FEED, EIN SCHALTER, IM BLATT SEINES MODULS (R14, A7 P2-3). Das
 * Kalender-Blatt war 4703px lang und trug fuenf "Feed aktivieren" als
 * Primaerknoepfe, darunter die Exporte fremder Module (Fristen = Inventar,
 * Zyklus = Gesundheit, Schichtplan, Abholungen = Entsorgung). Jetzt rendert
 * diese Datei EINEN Feed je Abschnitt (`props.part` in ../registry.js, als
 * `data-part` am Traeger), und der Abschnitt steht im Blatt des Moduls, dessen
 * Daten er exportiert. An/Aus ist ein Schalter wie in Apples Einstellungen;
 * Adresse, Kopieren, Abonnieren und Neuer Link stehen darunter, solange er an
 * ist. Ausschalten fragt wie vorher nach.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal } from '/components/modal.js';
import { createInlineError, settingSwitchRowHtml, toggleRowHtml } from '/settings/components.js';

function showToast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

/**
 * Die fuenf Feeds, jeder mit seinen Texten. Die Schluessel stehen hier
 * ausgeschrieben statt aus einem Praefix gebaut: die Wachen (test:settings-copy,
 * test:frontend-audit) lesen die t()-Aufrufe im Quelltext, und eine gebaute Adresse
 * saehen sie nicht. `path` ist die Route: GET liest, DELETE schaltet ab, POST
 * `<path>/regenerate` erzeugt die Adresse - beim ersten Mal heisst das "an".
 */
export const FEEDS = Object.freeze({
  calendar: {
    path: '/calendar/feed',
    text: {
      title: () => t('settings.feedExportTitle'),
      description: () => t('settings.feedExportDescription'),
      urlLabel: () => t('settings.feedExportUrlLabel'),
      hint: () => t('settings.feedExportHint'),
      copy: () => t('settings.feedExportCopy'),
      copied: () => t('settings.feedExportCopied'),
      subscribe: () => t('settings.feedExportSubscribe'),
      regenerate: () => t('settings.feedExportRegenerate'),
    },
    confirmDisable: () => confirmModal(t('settings.feedExportDisableConfirm'),
      { danger: true, confirmLabel: t('settings.feedExportDisable'), detail: t('settings.feedExportDisableConfirmDetail') }),
    confirmRegenerate: () => confirmModal(t('settings.feedExportRegenerateConfirm'),
      { danger: true, confirmLabel: t('settings.feedExportRegenerate'), detail: t('settings.feedExportRegenerateConfirmDetail') }),
  },
  inventory: {
    path: '/inventory/deadlines-feed',
    text: {
      title: () => t('settings.inventoryFeedTitle'),
      description: () => t('settings.inventoryFeedDescription'),
      urlLabel: () => t('settings.inventoryFeedUrlLabel'),
      hint: () => t('settings.inventoryFeedHint'),
      copy: () => t('settings.inventoryFeedCopy'),
      copied: () => t('settings.inventoryFeedCopied'),
      subscribe: () => t('settings.inventoryFeedSubscribe'),
      regenerate: () => t('settings.inventoryFeedRegenerate'),
    },
    confirmDisable: () => confirmModal(t('settings.inventoryFeedDisableConfirm'),
      { danger: true, confirmLabel: t('settings.inventoryFeedDisable'), detail: t('settings.inventoryFeedDisableConfirmDetail') }),
    confirmRegenerate: () => confirmModal(t('settings.inventoryFeedRegenerateConfirm'),
      { danger: true, confirmLabel: t('settings.inventoryFeedRegenerate'), detail: t('settings.inventoryFeedRegenerateConfirmDetail') }),
  },
  cycle: {
    path: '/health/cycle/feed',
    text: {
      title: () => t('settings.cycleFeedTitle'),
      description: () => t('settings.cycleFeedDescription'),
      urlLabel: () => t('settings.cycleFeedUrlLabel'),
      hint: () => t('settings.cycleFeedHint'),
      copy: () => t('settings.cycleFeedCopy'),
      copied: () => t('settings.cycleFeedCopied'),
      subscribe: () => t('settings.cycleFeedSubscribe'),
      regenerate: () => t('settings.cycleFeedRegenerate'),
    },
    confirmDisable: () => confirmModal(t('settings.cycleFeedDisableConfirm'),
      { danger: true, confirmLabel: t('settings.cycleFeedDisable'), detail: t('settings.cycleFeedDisableConfirmDetail') }),
    confirmRegenerate: () => confirmModal(t('settings.cycleFeedRegenerateConfirm'),
      { danger: true, confirmLabel: t('settings.cycleFeedRegenerate'), detail: t('settings.cycleFeedRegenerateConfirmDetail') }),
  },
  schedule: {
    path: '/schedule/feed',
    text: {
      title: () => t('settings.scheduleFeedTitle'),
      description: () => t('settings.scheduleFeedDescription'),
      urlLabel: () => t('settings.scheduleFeedUrlLabel'),
      hint: () => t('settings.scheduleFeedHint'),
      copy: () => t('settings.scheduleFeedCopy'),
      copied: () => t('settings.scheduleFeedCopied'),
      subscribe: () => t('settings.scheduleFeedSubscribe'),
      regenerate: () => t('settings.scheduleFeedRegenerate'),
    },
    confirmDisable: () => confirmModal(t('settings.scheduleFeedDisableConfirm'),
      { danger: true, confirmLabel: t('settings.scheduleFeedDisable'), detail: t('settings.scheduleFeedDisableConfirmDetail') }),
    confirmRegenerate: () => confirmModal(t('settings.scheduleFeedRegenerateConfirm'),
      { danger: true, confirmLabel: t('settings.scheduleFeedRegenerate'), detail: t('settings.scheduleFeedRegenerateConfirmDetail') }),
  },
  waste: {
    path: '/waste/feed',
    text: {
      title: () => t('settings.wasteFeedTitle'),
      description: () => t('settings.wasteFeedDescription'),
      urlLabel: () => t('settings.wasteFeedUrlLabel'),
      hint: () => t('settings.wasteFeedHint'),
      copy: () => t('settings.wasteFeedCopy'),
      copied: () => t('settings.wasteFeedCopied'),
      subscribe: () => t('settings.wasteFeedSubscribe'),
      regenerate: () => t('settings.wasteFeedRegenerate'),
    },
    confirmDisable: () => confirmModal(t('settings.wasteFeedDisableConfirm'),
      { danger: true, confirmLabel: t('settings.wasteFeedDisable'), detail: t('settings.wasteFeedDisableConfirmDetail') }),
    confirmRegenerate: () => confirmModal(t('settings.wasteFeedRegenerateConfirm'),
      { danger: true, confirmLabel: t('settings.wasteFeedRegenerate'), detail: t('settings.wasteFeedRegenerateConfirmDetail') }),
  },
});


function wasteFeedTypeRowsHtml(types, selectedIds) {
  return types.map((type) => toggleRowHtml({
    control: 'switch',
    label: type.name,
    checked: selectedIds === null || selectedIds.includes(type.id),
    swatchColor: type.color,
    attrs: { 'data-waste-feed-type': String(type.id) },
  })).join('');
}

/** Was nur ein Feed kennt: Personen im Titel (Kalender), Arten (Entsorgung). */
function extrasHtml(part, data, types) {
  if (part === 'calendar') {
    return `
    ${settingSwitchRowHtml({
      label: t('settings.feedExportShowAssignees'),
      checked: !!data.showAssignees,
      description: t('settings.feedExportShowAssigneesHint'),
      descriptionId: 'feed-show-assignees-hint',
      attrs: { id: 'feed-show-assignees', 'aria-describedby': 'feed-show-assignees-hint' },
    })}`;
  }
  if (part === 'waste' && types.length) {
    return `
    <div class="settings-setting-row settings-setting-row--stacked">
      <div class="settings-setting-row__copy">
        <span class="settings-setting-row__label">${t('settings.wasteFeedTypesLabel')}</span>
        <p class="settings-setting-row__description">${t('settings.wasteFeedTypesHint')}</p>
      </div>
      <div class="settings-setting-row__control" id="waste-feed-types">${wasteFeedTypeRowsHtml(types, data.type_ids)}</div>
    </div>`;
  }
  return '';
}

function renderFeed(host, part, feed, data, types) {
  const on = Boolean(data);
  const urlId = `${part}-feed-url`;
  host.replaceChildren();
  host.insertAdjacentHTML('beforeend', `
    <!-- EIN TRAEGER, ZEILEN STATT KARTE (R17, E9): abgeschaltet ist der Feed
         genau ein Schalter - dafuer stand eine ganze Karte. Eingeschaltet
         kommen Adresse, Zusaetze und Handlungen als weitere Zeilen dazu. -->
    <div class="row-carrier settings-group">
      ${settingSwitchRowHtml({
        label: feed.text.title(),
        checked: on,
        description: feed.text.description(),
        descriptionId: `${part}-feed-description`,
        attrs: { 'data-feed-switch': part, 'aria-describedby': `${part}-feed-description` },
      })}
      ${on ? `
      <div class="settings-setting-row settings-setting-row--stacked">
        <div class="settings-setting-row__copy">
          <label class="settings-setting-row__label" for="${urlId}">${feed.text.urlLabel()}</label>
        </div>
        <div class="settings-setting-row__control">
          <input id="${urlId}" class="form-input" type="text" readonly value="${esc(data.url)}" aria-describedby="${urlId}-hint">
          <p class="form-hint" id="${urlId}-hint">${feed.text.hint()}</p>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--secondary" data-feed-copy>${feed.text.copy()}</button>
            <a class="btn btn--secondary" href="${esc(data.url.replace(/^https?:\/\//i, 'webcal://'))}">${feed.text.subscribe()}</a>
            <button type="button" class="btn btn--secondary" data-feed-regen>${feed.text.regenerate()}</button>
          </div>
        </div>
      </div>
      ${extrasHtml(part, data, types)}` : ''}
    </div>
  `);
}

async function loadFeed(host, part) {
  const feed = FEEDS[part];
  const reload = () => loadFeed(host, part);
  let data;
  let types = [];
  try {
    const [res, typesRes] = await Promise.all([
      api.get(feed.path),
      part === 'waste' ? api.get('/waste/types') : null,
    ]);
    data = res?.data ?? null;
    types = typesRes?.data ?? [];
  } catch (err) {
    host.replaceChildren();
    host.appendChild(createInlineError(err.message || t('common.errorGeneric')));
    return;
  }

  renderFeed(host, part, feed, data, types);

  host.querySelector('[data-feed-switch]')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const next = input.checked;
    // Aus heisst: der Link liefert sofort nichts mehr, und ein spaeteres An
    // erzeugt eine neue Adresse - dieselbe Rueckfrage wie der fruehere Knopf.
    if (!next && !await feed.confirmDisable()) {
      input.checked = true;
      return;
    }
    input.disabled = true;
    try {
      if (next) {
        await api.post(`${feed.path}/regenerate`);
        showToast(feed.text.title(), 'success');
      } else {
        await api.delete(feed.path);
      }
      await reload();
    } catch (err) {
      input.checked = !next;
      input.disabled = false;
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });

  if (!data) return;

  host.querySelector('[data-feed-copy]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(data.url);
      showToast(feed.text.copied(), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  host.querySelector('[data-feed-regen]')?.addEventListener('click', async () => {
    if (!await feed.confirmRegenerate()) return;
    try {
      await api.post(`${feed.path}/regenerate`);
      await reload();
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    }
  });
  host.querySelector('#feed-show-assignees')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const next = input.checked;
    input.disabled = true;
    try {
      await api.put('/calendar/feed', { showAssignees: next });
      showToast(t('settings.feedExportSaved'), 'success');
    } catch (err) {
      input.checked = !next; // Fehlschlag → visuellen Zustand zurücksetzen
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      input.disabled = false;
    }
  });
  // Leeres Ergebnis (alle abgewaehlt) oder alle angehakt heisst wieder "kein
  // Filter" - derselbe "leeres Set = alle"-Vertrag wie ueberall sonst in
  // dieser Codebase (state.people in calendar.js), server-seitig als null
  // statt eines leeren Arrays gespeichert (siehe waste-ics.js).
  host.querySelector('#waste-feed-types')?.addEventListener('change', async (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.wasteFeedType) return;
    const checked = [...host.querySelectorAll('[data-waste-feed-type]')]
      .filter((el) => el.checked)
      .map((el) => Number(el.dataset.wasteFeedType));
    const typeIds = (checked.length === 0 || checked.length === types.length) ? null : checked;
    input.disabled = true;
    try {
      await api.put('/waste/feed/types', { type_ids: typeIds });
      showToast(t('settings.wasteFeedSaved'), 'success');
    } catch (err) {
      input.checked = !input.checked;
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      input.disabled = false;
    }
  });
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

/** Ein Abschnitt, ein Feed: welcher, sagt `data-part` (registry.js `props.part`). */
export async function render(container) {
  const part = FEEDS[container.dataset?.part] ? container.dataset.part : 'calendar';
  container.replaceChildren();
  await loadFeed(container, part);
  window.lucide?.createIcons({ el: container });
}
