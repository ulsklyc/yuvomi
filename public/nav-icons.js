/**
 * Modul: Nav Icons
 * Zweck: Eigener monoliniger Icon-Set für die Yuvomi-Navigation (1.6px Strich, 24×24).
 * Jedes Icon ist eine Fabrikfunktion, die ein fertig konfiguriertes SVG-Element via
 * createElementNS zurückgibt — kein innerHTML, kein insertAdjacentHTML.
 *
 * Schlüssel = Lucide-Icon-Name der navItems()-Definition.
 * Aufruf: NAV_ICONS['calendar']?.()  → SVGElement
 */

const NS = 'http://www.w3.org/2000/svg';

function makeSvg(...children) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  for (const child of children) s.appendChild(child);
  return s;
}

function e(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export const NAV_ICONS = {
  'layout-dashboard': () => makeSvg(
    e('rect', { x: '3.5', y: '3.5', width: '7.5', height: '7.5', rx: '2.2' }),
    e('rect', { x: '13',  y: '3.5', width: '7.5', height: '5',   rx: '2'   }),
    e('rect', { x: '13',  y: '10.5', width: '7.5', height: '10', rx: '2.2' }),
    e('rect', { x: '3.5', y: '12.5', width: '7.5', height: '8',  rx: '2'   }),
  ),

  'calendar': () => {
    const s = makeSvg(
      e('rect', { x: '3.5', y: '5.5', width: '17', height: '15', rx: '3' }),
      e('path', { d: 'M3.5 10h17' }),
      e('path', { d: 'M8 3.2v4.6M16 3.2v4.6' }),
    );
    for (const [cx, cy] of [['8.5','14.5'],['12','14.5'],['15.5','14.5']]) {
      const c = e('circle', { cx, cy, r: '.9' });
      c.setAttribute('fill', 'currentColor');
      c.setAttribute('stroke', 'none');
      s.appendChild(c);
    }
    return s;
  },

  'check-square': () => makeSvg(
    e('rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '4.5' }),
    e('path', { d: 'm8 12.3 2.8 2.8 5.6-5.6' }),
  ),

  'sticky-note': () => makeSvg(
    e('path', { d: 'M5.5 4.5h9.5L18.5 8v11a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V6a1.5 1.5 0 0 1 1.5-1.5z' }),
    e('path', { d: 'M15 4.5V7a1.5 1.5 0 0 0 1.5 1.5H19' }),
    e('path', { d: 'M8 13h7M8 16.5h5' }),
  ),

  'cake': () => {
    const s = makeSvg(
      e('path', { d: 'M4 19.5h16' }),
      e('path', { d: 'M5.5 19.5v-6.2a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.2' }),
      e('path', { d: 'M5.5 15c1.2.8 1.8.8 3 0s1.8-.8 3 0 1.8.8 3 0 1.8-.8 3 0' }),
      e('path', { d: 'M12 7.5v3.8' }),
    );
    const flame = e('path', { d: 'M12 4.5c.8.6.8 1.4 0 2-.8-.6-.8-1.4 0-2z' });
    flame.setAttribute('fill', 'currentColor');
    s.appendChild(flame);
    return s;
  },

  'book-user': () => makeSvg(
    e('rect', { x: '3.5', y: '4', width: '17', height: '16', rx: '3' }),
    e('circle', { cx: '10', cy: '11', r: '2.4' }),
    e('path', { d: 'M6.5 17.5c.6-2 2-3 3.5-3s2.9 1 3.5 3' }),
    e('path', { d: 'M16 9h2.5M16 12h2M16 15h2.5' }),
  ),

  'wallet': () => makeSvg(
    e('path', { d: 'M4 8.5a2.5 2.5 0 0 1 2.5-2.5H17l1 2.5' }),
    e('rect', { x: '3.5', y: '7.5', width: '17', height: '12', rx: '2.5' }),
    e('circle', { cx: '16.5', cy: '13.5', r: '1.3' }),
  ),

  'folder-lock': () => makeSvg(
    e('path', { d: 'M3.5 7.5a2 2 0 0 1 2-2h3.4l2 2.2H18a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z' }),
    e('path', { d: 'M8 13.5h8M8 16.5h5' }),
  ),

  'paintbrush': () => makeSvg(
    e('path', { d: 'm4.5 19.5 7-7' }),
    e('path', { d: 'm14 6 4 4-3.5 3.5L10.5 9.5z' }),
    e('path', { d: 'M14 6 17 3l4 4-3 3' }),
    e('path', { d: 'M5 17.5c-.5 1-.5 1.8 0 2.5 1 .6 1.9.5 2.5 0' }),
  ),

  'utensils': () => makeSvg(
    e('path', { d: 'M7.5 3.5v8a2 2 0 0 1-2 2h-.5v7' }),
    e('path', { d: 'M5.5 3.5v6M7.5 3.5v6M9.5 3.5v6' }),
    e('path', { d: 'M17 3.5c-1.8 0-3 1.5-3 3.5v5h2.2v8.5h1.6V3.5z' }),
  ),

  'settings': () => makeSvg(
    e('path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }),
    e('circle', { cx: '12', cy: '12', r: '3' }),
  ),

  'grid-2x2': () => {
    const s = makeSvg();
    for (const [cx, cy] of [
      ['6.5','6.5'],['12','6.5'],['17.5','6.5'],
      ['6.5','12'], ['12','12'], ['17.5','12'],
      ['6.5','17.5'],['12','17.5'],['17.5','17.5'],
    ]) {
      s.appendChild(e('circle', { cx, cy, r: '1.6' }));
    }
    return s;
  },

  'shopping-cart': () => makeSvg(
    e('path', { d: 'M3 4.5h2.4L7.5 16h10.2l2-7H7' }),
    e('circle', { cx: '9',  cy: '19.2', r: '1.4' }),
    e('circle', { cx: '17', cy: '19.2', r: '1.4' }),
  ),

  'book-text': () => makeSvg(
    e('path', { d: 'M4 4.5A1.5 1.5 0 0 1 5.5 3H18a1.5 1.5 0 0 1 1.5 1.5v15a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19.5z' }),
    e('path', { d: 'M8 8h8M8 12h8M8 16h5' }),
  ),

  'receipt-text': () => makeSvg(
    e('path', { d: 'M4 3.5v17l2.5-2 2.5 2 2.5-2 2.5 2 2.5-2 2.5 2V3.5z' }),
    e('path', { d: 'M8 9h8M8 13h8M8 17h4' }),
  ),

  'box': () => makeSvg(
    e('path', { d: 'M21 8L12 13 3 8' }),
    e('path', { d: 'M3 8l9-5 9 5v8l-9 5-9-5z' }),
    e('path', { d: 'M12 13v9' }),
  ),
};
