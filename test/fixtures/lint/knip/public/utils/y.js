/** @param {string} s */
export function escapeText(s) {
  return String(s);
}

// Findings 3 and 4: the same function exported a second time (knip/duplicates), and
// nothing imports the default (knip/exports).
export default escapeText;
