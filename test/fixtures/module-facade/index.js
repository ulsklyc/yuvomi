// @ts-nocheck - laeuft im Browser gegen die Fassaden des Servers, nicht gegen public/.
// Beispiel-Drittmodul fuer test:built-app-browser (Phase 1a, Abschnitt D):
// importiert genau die Fassaden, die docs/SPEC.md ("Third-Party Modules") und
// MODULES.md zusagen, und gibt zurueck, was es dort vorfindet. Die Suite laedt
// es im Browser gegen den gebauten Server und prueft, dass es dieselben
// Instanzen sieht wie die App.
import { api } from '/api.js';
import { t, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';

export function probe() {
  return { api, translated: t('nav.tasks'), locale: getLocale(), escaped: esc('<b>&</b>') };
}
