/**
 * applyModuleColorOverrides — shared between router.js (on login/session-start)
 * and the personal-appearance settings page (immediate preview on colour change).
 *
 * Injects or updates a <style id="module-color-overrides"> block in <head>
 * that sets per-theme --module-* custom property overrides. Calling with null,
 * undefined, or an empty object removes the block.
 */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function applyModuleColorOverrides(colors) {
  const existing = document.getElementById('module-color-overrides');
  if (!colors || typeof colors !== 'object' || !Object.keys(colors).length) {
    if (existing) existing.remove();
    return;
  }
  const entries = Object.entries(colors).filter(
    ([, v]) => v && typeof v === 'object' && HEX_RE.test(v.light) && HEX_RE.test(v.dark)
  );
  if (!entries.length) { if (existing) existing.remove(); return; }
  const lightDecls = entries.map(([id, v]) => `  --module-${id}: ${v.light};`).join('\n');
  const darkDecls  = entries.map(([id, v]) => `  --module-${id}: ${v.dark};`).join('\n');
  const style = existing ?? document.createElement('style');
  style.id = 'module-color-overrides';
  style.textContent = [
    `:root {\n${lightDecls}\n}`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {\n${darkDecls}\n} }`,
    `:root[data-theme="dark"] {\n${darkDecls}\n}`,
  ].join('\n');
  if (!existing) document.head.appendChild(style);
}
