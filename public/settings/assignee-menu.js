/**
 * Modul: Standard-Personen einer Sync-Quelle in einer Listenzeile (#1897, #1221)
 * Zweck: Ein Kalender (Google, CalDAV) und eine Erinnerungsliste tragen eine
 *        MENGE Standard-Personen. In ihrer Zeile stand ein Auswahlfeld fuer
 *        eine Person; eine Chip-Auswahl haette jede Zeile auf zwei bis drei
 *        Zeilen gestreckt, und eine Liste mit zehn Kalendern waere nicht mehr
 *        ueberschaubar.
 *
 * DIE ZEILE BLEIBT EINE ZEILE. Der Knopf steht, wo das Auswahlfeld stand, sieht
 * aus wie es und nennt die Personen ("Anna, Ben"). Er oeffnet das geteilte
 * Popover-Menue (popover-menu.js: Top-Layer, Light-Dismiss, Esc,
 * Pfeiltasten, Position am Knopf) mit einem Schalter je Person
 * (`menuitemcheckbox`, Haken am Ende) - dasselbe Vokabular wie die
 * Ansichts-Schalter der Werkzeugmenues.
 *
 * JEDER HAKEN SPEICHERT SOFORT, wie vorher die Auswahl im Feld: ein Klick ist
 * eine Person dazu oder weg, das Menue schliesst wie jedes Menue. Die
 * Reihenfolge ist die der Wahl, die erste Person wird die primaere Zuweisung
 * eines neuen Termins (ihre Farbe); wer dazukommt, steht hinten.
 *
 * DAS PANEL STEHT NEBEN DER ZEILE, NICHT IN IHR: die Kalenderzeile ist ein
 * `<label>` um den Sync-Haken. Ein Klick auf die Polsterung eines Panels darin
 * schaltete den Kalender um.
 *
 * Abhängigkeiten: /i18n.js, /utils/popover-menu.js, /settings/family-users.js
 */

import { t } from '/i18n.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { loadFamilyUsers } from '/settings/family-users.js';
import { sharedSurname } from '/components/user-multi-select.js';

let menuSeq = 0;

function icon(name, extraClass = '', size = 'icon-md') {
  const i = document.createElement('i');
  i.dataset.lucide = name;
  i.className = `${size}${extraClass ? ` ${extraClass}` : ''}`;
  i.setAttribute('aria-hidden', 'true');
  return i;
}

/**
 * Die Menge, die ein Knopf gerade traegt.
 * @param {HTMLElement|null} trigger
 * @returns {number[]}
 */
export function assigneeIdsOf(trigger) {
  const raw = trigger?.dataset?.assigneeIds ?? '';
  return raw ? raw.split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
}

/**
 * Die Personen als kurzer Text fuer den Knopf: niemand, oder die Namen in der
 * Reihenfolge der Wahl.
 * @param {number[]} ids
 * @param {Map<number, string>} names
 * @returns {string}
 */
export function assigneeSummary(ids, names) {
  if (!ids.length) return t('settings.sync.defaultAssigneeNone');
  return ids.map((id) => names.get(id) ?? '?').join(', ');
}

/**
 * Die neue Menge nach einem Klick auf eine Person: dazu (hinten) oder weg.
 * @param {number[]} ids
 * @param {number} id
 * @returns {number[]}
 */
export function toggleAssignee(ids, id) {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * Baut Knopf und Menue. Der Aufrufer setzt den Knopf in die Zeile und das
 * Panel neben sie (`host`).
 *
 * IM FORMULAR (Abo anlegen und bearbeiten, Import) ist es derselbe Knopf in
 * der Feldzeile; `save` merkt sich dort nur die Wahl, gespeichert wird mit dem
 * Formular. Die aktuelle Menge steht immer in `data-assignee-ids` am Knopf.
 *
 * @param {object} opts
 * @param {number[]} opts.currentIds  die gespeicherten Personen
 * @param {(ids: number[]) => Promise<void>} [opts.save]  speichert die neue Menge; wirft bei Fehler
 * @param {string} [opts.id]           id des Knopfs (fuer `<label for>` im Formular)
 * @param {string} [opts.triggerClass] Klasse des Knopfs; Standard: das Feld der Kalenderzeile
 * @param {HTMLElement} opts.host      wohin das Panel kommt (ausserhalb eines `<label>`)
 * @param {(err: unknown) => void} [opts.onError]
 * @param {() => void} [opts.onSaved]
 * @returns {HTMLButtonElement} der Knopf
 */
export function buildAssigneeMenu({
  currentIds, save = async () => {}, host, onError, onSaved, id: triggerId, triggerClass = 'caldav-calendar-assignee',
}) {
  let ids = (currentIds ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  // Kurz im Knopf, voll im zugaenglichen Namen: tragen alle denselben
  // Nachnamen, steht im Knopf nur der Vorname - wie in den Chips der
  // Personenauswahl (R19, sharedSurname).
  const names = new Map();
  const fullNames = new Map();
  const id = `assignee-menu-${++menuSeq}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = `${triggerClass} assignee-menu__trigger popover-menu__trigger`;
  if (triggerId) trigger.id = triggerId;
  trigger.setAttribute('popovertarget', id);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.className = 'assignee-menu__text';
  text.textContent = t('common.loading');
  // Das Personen-Zeichen vorn sagt, wovon "Keine" spricht - in der Zeile einer
  // Erinnerungsliste steht der Knopf neben der Modulwahl, nicht unter einem Etikett.
  trigger.append(
    icon('users', 'assignee-menu__glyph', 'icon-sm'),
    text,
    icon('chevron-down', 'assignee-menu__chevron', 'icon-sm'),
  );
  trigger.disabled = true;
  trigger.dataset.assigneeIds = ids.join(',');

  const panel = document.createElement('div');
  panel.className = 'popover-menu';
  panel.id = id;
  panel.setAttribute('popover', '');
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', t('settings.sync.defaultAssignees'));
  host.appendChild(panel);
  installPopoverMenus(host);

  // Der Knopf sagt, wer gilt; sein zugaenglicher Name nennt dazu die Frage.
  const render = () => {
    trigger.dataset.assigneeIds = ids.join(',');
    text.textContent = assigneeSummary(ids, names);
    trigger.title = `${t('settings.sync.defaultAssignees')}: ${assigneeSummary(ids, fullNames)}`;
    trigger.setAttribute('aria-label', trigger.title);
    for (const item of panel.querySelectorAll('[data-user-id]')) {
      const on = ids.includes(Number(item.dataset.userId));
      item.setAttribute('aria-checked', String(on));
      item.querySelector('.popover-menu__item-check')?.classList.toggle('popover-menu__item-check--hidden', !on);
    }
  };

  // Klicks am Knopf gehoeren nicht dem umschliessenden Label (Sync-Haken).
  ['click', 'mousedown'].forEach((ev) => trigger.addEventListener(ev, (e) => e.stopPropagation()));

  loadFamilyUsers(...ids).then((users) => {
    const surname = sharedSurname(users);
    for (const user of users) {
      const full = String(user.display_name ?? '').trim();
      fullNames.set(Number(user.id), full);
      names.set(Number(user.id), surname && full.endsWith(` ${surname}`) ? full.slice(0, -(surname.length + 1)) : full);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'popover-menu__item';
      item.setAttribute('role', 'menuitemcheckbox');
      item.dataset.userId = String(user.id);
      const label = document.createElement('span');
      label.textContent = user.display_name;
      item.append(icon('user'), label, icon('check', 'popover-menu__item-trail popover-menu__item-check'));
      panel.appendChild(item);
    }
    window.lucide?.createIcons({ el: panel });
    window.lucide?.createIcons({ el: trigger });
    trigger.disabled = false;
    render();
  });

  let saving = false;
  panel.addEventListener('click', async (event) => {
    const item = event.target?.closest?.('[data-user-id]');
    if (!item || saving) return;
    const before = ids;
    ids = toggleAssignee(ids, Number(item.dataset.userId));
    render();
    // NICHT `disabled`: das Menue schliesst und gibt den Fokus an den Knopf
    // zurueck - ein abgeschalteter Knopf nimmt ihn nicht, und die Tastatur
    // stuende danach am Seitenanfang. Ein zweiter Haken wartet stattdessen.
    saving = true;
    trigger.setAttribute('aria-busy', 'true');
    try {
      await save(ids);
      onSaved?.();
    } catch (err) {
      ids = before;
      render();
      onError?.(err);
    } finally {
      saving = false;
      trigger.removeAttribute('aria-busy');
    }
  });

  return trigger;
}
