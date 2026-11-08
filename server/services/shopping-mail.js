/**
 * Modul: Einkaufsliste als Mail
 * Zweck: Die offenen Artikel einer Liste zu Text und HTML rendern (#944).
 * Abhaengigkeiten: public/utils/html-escape.js
 *
 * EINE MOMENTAUFNAHME, UND SIE SAGT DAS AUCH. Wer diese Mail bekommt, geht
 * damit einkaufen - waehrenddessen haken andere zu Hause weiter ab. Die Mail
 * kann davon nichts wissen, also traegt sie ihren Zeitpunkt sichtbar mit,
 * statt sich den Anschein zu geben, aktuell zu sein.
 *
 * NUR DIE OFFENEN ARTIKEL. Ein bereits abgehakter steht auf einem Einkaufszettel
 * nicht mehr zur Debatte; ihn mitzuschicken hiesse, den Empfaenger im Laden
 * entscheiden zu lassen, was schon erledigt ist.
 */
import { esc } from '../../public/utils/html-escape.js';

/**
 * Gruppiert die offenen Artikel in der Reihenfolge, in der die Liste sie auch
 * anzeigt: die Kategorien tragen einen eigenen Rang (`sort_order`), der den
 * Weg durch den Laden abbildet. Eine Mail, die alphabetisch sortiert, schickt
 * den Empfaenger dreimal durch denselben Gang.
 */
export function groupOpenItems(items = [], categories = []) {
  const rank = new Map(categories.map((c, index) => [c.name, index]));
  const groups = new Map();
  for (const item of items) {
    if (item.is_checked) continue;
    const name = item.category || '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups.entries()]
    .sort((a, b) => (rank.get(a[0]) ?? categories.length) - (rank.get(b[0]) ?? categories.length))
    .map(([category, entries]) => ({ category, items: entries }));
}

function itemLabel(item) {
  const name = String(item?.name ?? '').trim();
  const quantity = String(item?.quantity ?? '').trim();
  return quantity ? `${name} (${quantity})` : name;
}

export function countOpenItems(items = []) {
  return items.filter((item) => !item.is_checked).length;
}

/**
 * Der Betreff nennt die Liste, weil ein Haushalt mehrere fuehrt ("Wocheneinkauf"
 * gegen "Baumarkt") und im Posteingang nur er sichtbar ist. Der Listenname ist
 * damit Nutzertext in einem Header - Zeilenumbrueche muessen raus, sonst wird
 * daraus ein zweiter Header.
 */
export function subjectFor({ listName, openCount }) {
  const name = String(listName ?? '').replace(/[\r\n]+/g, ' ').trim();
  return name ? `Shopping list: ${name} (${openCount})` : `Shopping list (${openCount})`;
}

export function renderText({ listName, senderName, groups, sentAt }) {
  const lines = [];
  lines.push(senderName ? `${senderName} sent you this shopping list.` : 'Shopping list');
  if (listName) lines.push(listName);
  lines.push('');
  for (const group of groups) {
    if (group.category) lines.push(`${group.category}:`);
    for (const item of group.items) lines.push(`  - ${itemLabel(item)}`);
    lines.push('');
  }
  // Der Zeitpunkt gehoert dazu, nicht als Fussnote: er ist die einzige Angabe,
  // an der sich ablesen laesst, wie alt diese Abschrift ist.
  lines.push(`This is a snapshot taken on ${sentAt}. Items ticked off afterwards are not reflected here.`);
  return lines.join('\n');
}

export function renderHtml({ listName, senderName, groups, sentAt }) {
  const parts = [];
  parts.push(`<p>${esc(senderName ? `${senderName} sent you this shopping list.` : 'Shopping list')}</p>`);
  if (listName) parts.push(`<p><strong>${esc(listName)}</strong></p>`);
  for (const group of groups) {
    if (group.category) parts.push(`<p><strong>${esc(group.category)}</strong></p>`);
    parts.push(`<ul>${group.items.map((item) => `<li>${esc(itemLabel(item))}</li>`).join('')}</ul>`);
  }
  parts.push(`<p><small>${esc(`This is a snapshot taken on ${sentAt}. Items ticked off afterwards are not reflected here.`)}</small></p>`);
  return parts.join('');
}

/**
 * Baut die vollstaendige Nachricht. Wirft, wenn nichts zu senden ist: eine
 * leere Einkaufsliste zu verschicken ist nie die Absicht, und ein stiller
 * Erfolg liesse den Absender glauben, er haette geholfen.
 */
export function buildShoppingListMail({ list, items, categories, senderName, sentAt }) {
  const openCount = countOpenItems(items);
  // `code`: the route answers this own case with its sentence (Phase 0 H).
  if (openCount === 0) throw Object.assign(new Error('This shopping list has no open items to send.'), { code: 'nothing_open' });
  const groups = groupOpenItems(items, categories);
  const context = { listName: list?.name ?? '', senderName, groups, sentAt };
  return {
    subject: subjectFor({ listName: context.listName, openCount }),
    text: renderText(context),
    html: renderHtml(context),
    openCount,
  };
}
