/**
 * Modul: Test-Infrastruktur - die Dialog-Grammatik aus dem Quelltext lesen.
 * Zweck: Fuss, Primaerknopf und Verb eines Dialogs finden, damit die Guards in
 *        `test-frontend-audit.js` die REGEL pruefen (R17, E6) und nicht eine
 *        Schreibweise.
 * Ausfuehren: keine eigene Suite - Helfer, importiert von `test:frontend-audit`.
 *
 * WAS HIER GELESEN WIRD: das Markup, das ein Dialog rendert, steht als
 * Template-Literal (oder als String-Kette, Schichtplan) in der Funktion, die
 * `openModal({ ... })` ruft. Ein Lauf im Browser je Dialog waere die genauere
 * Probe, aber keine Suite oeffnet achtzig Dialoge. Also lesen die Scanner den
 * Text - mit drei Vorkehrungen gegen die bekannten Fallen:
 *  - Kommentare sind vorher geschnitten (der Aufrufer reicht
 *    `withoutCommentsKeepingLines(src)`), ein Kommentar macht nichts gruen;
 *  - eine Beschriftung wird ueber ihren Locale-WERT beurteilt (`t('a.b')` ->
 *    "Erstellen"), nicht ueber den Namen des Keys;
 *  - jeder Scanner hat in der Suite einen Gegenfall, der ihn rot zeigt.
 */

/** Ende des Aufrufs, dessen oeffnende Klammer bei `open` steht. */
function callEnd(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

const FUNCTION_START = /^(?:export )?(?:async )?function \w+|^(?:export )?const \w+ = (?:async )?\(/gm;

/**
 * Je `openModal({`-Aufruf der Text, in dem sein Markup steht: vom Anfang der
 * umgebenden Funktion (oder vom Ende des vorigen Aufrufs) bis zur schliessenden
 * Klammer.
 *
 * @returns {{ line: number, segment: string, call: string }[]}
 */
export function dialogSegments(src) {
  const starts = [...src.matchAll(FUNCTION_START)].map((m) => m.index);
  const out = [];
  let prevEnd = 0;
  // `openSharedModal` ist derselbe Oeffner unter dem Namen, den Seiten mit
  // einem eigenen `openModal` ihm beim Import geben.
  for (const m of src.matchAll(/\bopen(?:Shared)?Modal\(\{/g)) {
    const end = callEnd(src, m.index + m[0].length - 2);
    const fnStart = starts.filter((s) => s < m.index).pop() ?? 0;
    const from = Math.max(fnStart, prevEnd);
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      segment: src.slice(from, end),
      call: src.slice(m.index, end),
    });
    prevEnd = end;
  }
  return out;
}

/** Die `t('...')`-Keys in einem Ausdruck, in Lesereihenfolge. */
export function keysIn(expr) {
  const out = [];
  for (const m of expr.matchAll(/\bt\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const head = m[1].split('{')[0];
    for (const k of head.matchAll(/'([A-Za-z]\w*(?:\.\w+)+)'/g)) out.push(k[1]);
  }
  return out;
}

/**
 * Die Knoepfe eines Markup-Abschnitts: Klassen, Typ, Beschriftungs-Keys und ob
 * sie in einer `.modal-panel__footer` stehen. Die Fuss-Zugehoerigkeit zaehlt
 * `<div`/`</div>` ab dem oeffnenden Fuss - kein Fuss, der vorher zugeht, gilt.
 */
export function buttonsIn(segment) {
  const footers = [...segment.matchAll(/<div[^>]*\bmodal-panel__footer\b[^>]*>/g)].map((m) => {
    let depth = 1;
    const re = /<div\b|<\/div>/g;
    re.lastIndex = m.index + m[0].length;
    let end = segment.length;
    for (let t = re.exec(segment); t; t = re.exec(segment)) {
      depth += t[0] === '</div>' ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    return { start: m.index, end };
  });
  return [...segment.matchAll(/<button\b([^>]*)>/g)].map((m) => {
    const close = segment.indexOf('</button>', m.index);
    const inner = segment.slice(m.index + m[0].length, close < 0 ? m.index + 300 : close);
    const attrs = m[1];
    return {
      index: m.index,
      attrs,
      primary: /\bbtn--primary\b/.test(attrs),
      submit: /\btype="submit"/.test(attrs),
      closes: /data-action="close-modal"|data-create-cancel|-cancel"|data-action="cancel/.test(attrs)
        || /common\.(cancel|close)'/.test(inner),
      keys: keysIn(inner),
      inFooter: footers.some((f) => m.index > f.start && m.index < f.end),
      footer: footers.findIndex((f) => m.index > f.start && m.index < f.end),
    };
  });
}

/**
 * REGEL 1 - ein Absende-Knopf steht im Fuss, nie im scrollenden Koerper.
 * @returns {number[]} Zeilen der Dialoge, die dagegen verstossen
 */
export function submitOutsideFooter(src) {
  return dialogSegments(src)
    .filter(({ segment }) => /<form\b/.test(segment)
      && buttonsIn(segment).some((b) => b.submit && b.primary && !b.inFooter))
    .map(({ line }) => line);
}

/**
 * REGEL 2 - neben dem absendenden Primaerknopf steht ein Abbrechen.
 * @returns {number[]}
 */
export function footerWithoutCancel(src) {
  return dialogSegments(src)
    .filter(({ segment }) => {
      const buttons = buttonsIn(segment);
      return buttons.some((b) => b.submit && b.primary && b.inFooter
        && !buttons.some((o) => o.footer === b.footer && o.closes));
    })
    .map(({ line }) => line);
}

const SAVE = new Set(['common.save', 'schedule.save']);

/**
 * REGEL 3 - wo ein Dialog Anlegen und Bearbeiten unterscheidet, heisst der
 * Knopf "Hinzufuegen" bzw. "Speichern". Gelesen wird jede Verzweigung, deren
 * eine Seite ein Speichern-Key ist; die andere Seite muss der Anlegen-Key sein
 * (oder eine benannte Handlung, die kein Anlegen ist: `allowed`).
 * @returns {string[]} die abweichenden Keys
 */
export function saveBranchPartners(src, allowed = []) {
  const ok = new Set(['common.add', ...SAVE, ...allowed]);
  const out = [];
  const key = String.raw`(?:esc\()?t\('([^']+)'\)\)?`;
  for (const m of src.matchAll(new RegExp(String.raw`\?\s*\(?${key}\s*:\s*\(?${key}`, 'g'))) {
    const [a, b] = [m[1], m[2]];
    if (SAVE.has(a) && !ok.has(b)) out.push(b);
    if (SAVE.has(b) && !ok.has(a)) out.push(a);
  }
  for (const m of src.matchAll(/\?\s*'([\w.]+)'\s*:\s*'([\w.]+)'/g)) {
    const [a, b] = [m[1], m[2]];
    if (SAVE.has(a) && !ok.has(b)) out.push(b);
    if (SAVE.has(b) && !ok.has(a)) out.push(a);
  }
  return out;
}

/**
 * REGEL 4 - traegt der Titel beide Faelle ("... bearbeiten" | "... hinzufuegen"),
 * darf der absendende Knopf nicht starr "Speichern" heissen.
 * @param {(key: string) => string|undefined} valueOf Locale-Wert (Referenz de)
 * @returns {number[]}
 */
export function fixedSaveOnTwoCaseDialog(src, valueOf) {
  const EDIT = /bearbeiten|korrigieren/i;
  return dialogSegments(src)
    .filter(({ segment, call }) => {
      let title = call.match(/\btitle:\s*([^\n]+)/)?.[1] ?? '';
      const ident = title.trim().replace(/,$/, '');
      if (/^\w+$/.test(ident)) {
        title = segment.match(new RegExp(`(?:const|let) ${ident}\\s*=\\s*([^;]+);`))?.[1] ?? '';
      }
      const values = keysIn(title).map((k) => valueOf(k) ?? '');
      if (values.length < 2 || !values.some((v) => EDIT.test(v)) || values.every((v) => EDIT.test(v))) return false;
      const submit = buttonsIn(segment).filter((b) => b.primary && (b.submit || b.inFooter)).pop();
      return Boolean(submit) && submit.keys.length === 1 && SAVE.has(submit.keys[0]);
    })
    .map(({ line }) => line);
}

/**
 * REGEL 5 - kein Primaerknopf im Dialogfuss nennt das Anlegen mit einem anderen
 * Verb ("Erstellen", "Anlegen"). Beurteilt wird der Locale-WERT.
 * @returns {string[]} "key=Wert"
 */
export function foreignCreateVerbs(src, valueOf, allowed = []) {
  const skip = new Set(allowed);
  const out = [];
  for (const { segment } of dialogSegments(src)) {
    for (const b of buttonsIn(segment)) {
      if (!b.primary || !b.inFooter) continue;
      for (const k of b.keys) {
        const v = valueOf(k) ?? '';
        if (!skip.has(k) && /erstellen|anlegen|erzeugen/i.test(v)) out.push(`${k}=${v}`);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * REGEL 6 - Dialog-Markup traegt den Kanon-Feldsatz `.form-label`/`.form-input`,
 * nicht die Alias-Klassen `.label`/`.input`.
 * @returns {string[]} die gefundenen class-Attribute
 */
export function aliasFieldClasses(markup) {
  return [...markup.matchAll(/class="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((cls) => cls.split(/\s+/).some((c) => c === 'input' || c === 'label'));
}
