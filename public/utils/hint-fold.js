/**
 * DIE ERKLAERUNG VOR DEM ERSTEN FELD IST EIN BIS ZWEI SAETZE (R22, D13).
 * Wandtabletts und API-Zugriff begannen mit sieben bis neun Zeilen Fussnote,
 * bevor das erste Feld kam. Der Kern steht als Hinweis da, der Rest hinter
 * "Mehr dazu" - ein natives `<details>` (Tastatur und Ansage ohne Skript),
 * der Pfeil zeigt die Richtung. `moreHtml` ist fertiges, escaptes Markup
 * (Absaetze, auch leere Halter, die der Aufrufer spaeter fuellt).
 *
 * Seit R24 (Critique G4-Dokumente-P3-2) ein geteilter Baustein: auch der
 * Upload-Dialog der Dokumente faltet seine Hilfen so, statt unter jedem Feld
 * einen Satz zu tragen. Die Regeln stehen in layout.css (`.settings-hint-fold`,
 * der Name bleibt fuer die Einstellungen, die ihn zuerst trugen). Ohne `lead`
 * steht nur der Aufklapper.
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

export function hintFoldHtml({ lead = '', moreHtml, className = '' }) {
  return `
    <div class="settings-hint-fold${className ? ` ${esc(className)}` : ''}">
      ${lead ? `<p class="form-hint">${esc(lead)}</p>` : ''}
      <details class="settings-hint-fold__more">
        <summary class="settings-hint-fold__summary">${esc(t('settings.hintMore'))}<i data-lucide="chevron-down" class="settings-hint-fold__icon" aria-hidden="true"></i></summary>
        <div class="settings-hint-fold__body">${moreHtml}</div>
      </details>
    </div>`;
}
