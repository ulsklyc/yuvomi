/**
 * Modul: Lucide-Scope-Patch
 * Zweck: `lucide.createIcons({ el })` bekommt echtes Scoping.
 *
 * Rund 230 Aufrufstellen der App übergeben `{ el }` und nehmen an, nur unter
 * diesem Knoten werde gerendert. Die gebündelte Lucide-Fassung kennt den
 * Parameter nicht (`createIcons({icons, nameAttr, attrs})`) - jeder Aufruf
 * scannte das GANZE Dokument per `querySelectorAll('[data-lucide]')`, und
 * jede Teil-Renderung zahlte einen Volldokument-Scan (Audit 2026-08-31, P2).
 *
 * Statt 230 Stellen umzubauen, biegt DIESE Datei die eine Funktion um: mit
 * `el` wird nur noch unter `el` ersetzt, ohne `el` läuft das Original. Die
 * Ersetzung spiegelt die interne Bundle-Semantik (E0): Platzhalter-Attribute
 * gewinnen über Icon-Defaults, Klassen werden zusammengeführt
 * (`lucide lucide-<name>` + Platzhalterklassen), `data-lucide` bleibt am SVG,
 * ein unbekannter Name warnt nur und bricht nichts (der Knopf bleibt leer -
 * bewusste Parität zum Bundle).
 *
 * Lädt als eigene Datei DIREKT NACH lucide.min.js (beide `defer`, Reihenfolge
 * garantiert); ein Inline-Script scheitert an der CSP (`script-src 'self'`).
 */
(() => {
  const lucide = window.lucide;
  if (!lucide?.createIcons || !lucide.createElement || !lucide.icons) return;

  const orig = lucide.createIcons;
  // Dieselbe Zeile wie pascalize() in utils/lucide-icons.js (und im
  // Vendor-Build): was dort auflöst, löst hier auch auf.
  const toPascal = (name) => String(name)
    .replace(/(\w)(\w*)(_|-|\s*)/g, (_all, head, tail) => head.toUpperCase() + tail.toLowerCase());

  // EIN BAUPLAN JE ZEICHEN (R20): eine Liste mit 200 Aufgaben setzte jedes
  // Zeichen einzeln aus seinen Pfaden zusammen (`createElement`, ~80 ms bei
  // 4x CPU). Jetzt einmal je Name gebaut und danach geklont - der Klon ist
  // derselbe Baum, die Attribute des Platzhalters kommen wie bisher darauf.
  const templates = new Map();
  const iconFor = (key, icon) => {
    let tpl = templates.get(key);
    if (!tpl) { tpl = lucide.createElement(icon); templates.set(key, tpl); }
    return tpl.cloneNode(true);
  };

  const replaceScoped = (node) => {
    const name = node.getAttribute('data-lucide');
    if (name == null) return;
    const key = toPascal(name);
    const icon = lucide.icons[key];
    if (!icon) {
      console.warn(`${node.outerHTML} icon name was not found in the provided icons object.`);
      return;
    }
    const svg = iconFor(key, icon);
    for (const attr of node.attributes) {
      if (attr.name === 'class') continue;
      svg.setAttribute(attr.name, attr.value);
    }
    svg.setAttribute('data-lucide', name);
    const classes = ['lucide', `lucide-${name}`, ...node.classList];
    svg.setAttribute('class', [...new Set(classes)].join(' '));
    node.replaceWith(svg);
  };

  lucide.createIcons = (opts = {}) => {
    const { el, ...rest } = opts;
    const canScope = el && typeof el.querySelectorAll === 'function';
    if (!canScope) return orig(rest);
    if (typeof el.getAttribute === 'function' && el.getAttribute('data-lucide') != null) replaceScoped(el);
    for (const node of el.querySelectorAll('[data-lucide]')) replaceScoped(node);
  };
})();
