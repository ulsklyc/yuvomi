// Lint fixture (phase 1b, section D): eight findings the rule set must report,
// one per marked line, and the cases it must leave alone. test:lint-baseline
// lints this file with the real .oxlintrc.json and expects exactly these lines.
// The five HTML lines cover every AST form the old text guard in
// test-frontend-audit.js tested (dot access, bracket access with a quoted or a
// backtick name, innerHTML and outerHTML, the operators =, +=, ||= and ??=);
// single and double quotes are the same Literal node, and whitespace does not
// matter to an AST, so `el.innerHTML=""` is the same node as line "html-1".
const root = document.body; const el = root; const html = '<p></p>'; const row = '<li></li>';
root.innerHTML = `<div>`;                 // html-1
el['outerHTML'] = html;                   // html-2
el[`innerHTML`] += row;                   // html-3
el.outerHTML ||= html;                    // html-4
el.innerHTML ??= html;                    // html-5
const read = el['outerHTML'];             // reading is allowed
const same = el.innerHTML === html;       // comparing is allowed
const differs = el.innerHTML !== html;    // so is inequality
const outer = root.outerHTML;             // and a plain read
Object.assign(el, { innerHTML: html });   // blind spot: no assignment node
const d = new Date().toISOString().slice(0, 10);     // utc-1
const e = new Date().toISOString().substring(0, 10); // utc-2
const f = new Date().toISOString().split('T')[0];    // blind spot: other spelling
export async function h(/** @type {any} */ req, /** @type {any} */ res) {
  try { await req.body; } catch (err) { console.error(err); res.status(500).json({ error: 'x' }); } // catch-500
}
export { read, same, differs, outer, d, e, f };
