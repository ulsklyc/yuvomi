/**
 * Das Ueberlappungszeichen: wer ∩ was.
 *
 * Der dritte Teil der Formfamilie aus dem Block-2-Brief, neben dem Siegel und
 * seiner Herkunfts-Regel. Ein Avatar ueberlappt das Markensiegel - das
 * Familien-Zeichen der Drei-Kreise-Bildmarke, auf zwei Kreise gebracht: einer
 * sagt, aus welchem Raum das Objekt kommt, der andere, wen es angeht.
 *
 * SEIN EINSATZGESETZ IST DAS DES SIEGELS PLUS ZWEI BEDINGUNGEN. Es erscheint
 * dort, wo ohnehin ein Siegel steht (also an Mischstellen), UND das Objekt
 * traegt eine Person, UND es gibt mehr als einen moeglichen Beteiligten. Im
 * Solo-Haushalt entfaellt es still (utils/household.js) - der Brief sagt das
 * woertlich, und es ist derselbe Satz, aus dem der Solo-Schalter entstanden
 * ist: was nur eine sinnvolle Belegung hat, wird nicht gezeigt.
 *
 * NIE PFLICHTELEMENT. Wer keine Person hat, bekommt sein Siegel wie bisher.
 * Das ist keine Bequemlichkeit, sondern der Sinn: ein Zeichen, das immer da
 * ist, sagt nichts. Der Avatar erscheint genau dann, wenn die Frage „von wem?"
 * ueberhaupt eine Antwort hat.
 *
 * WAS ES LOEST: das „Wer" eines Monatstermins stand im `title`-Attribut und war
 * auf Touch damit unerreichbar (Critique 2026-08-10, Heuristik 6). Ein
 * Erinnerungs-Toast nannte seit `a137e78b` sein Modul, aber nicht, wessen
 * Termin er meint. Beides ist dieselbe Luecke von zwei Seiten.
 */

import { esc } from '/utils/html.js';
import { compactInitials } from '/utils/initials.js';
import { isSoloHousehold } from '/utils/household.js';
import { getReadableTextColor, AVATAR_FALLBACK_COLOR } from '/utils/color.js';

/**
 * Haengt einem fertigen Siegel den Avatar seines Beteiligten an.
 *
 * Nimmt das Siegel als Element entgegen statt es selbst zu bauen: die
 * Aufrufer haben je eigene Gruende fuer ihre Siegel-Variante (`--vivid` auf dem
 * Toast, `--sm` in der Zeile), und die gehoeren nicht hierher dupliziert.
 *
 * @param {HTMLElement} sealEl  Ein `.module-seal`-Element.
 * @param {{display_name?: string, avatar_color?: string, avatar_data?: string}|null} user
 * @returns {HTMLElement}  Das Paar, oder das Siegel unveraendert.
 */
export function withWho(sealEl, user) {
  if (!sealEl || !user || isSoloHousehold()) return sealEl;

  const pair = document.createElement('span');
  pair.className = 'seal-pair';
  pair.appendChild(sealEl);
  pair.insertAdjacentHTML('beforeend', whoMarkHtml(user));
  return pair;
}

/**
 * Nur der Avatar-Teil, als Markup - fuer Aufrufer, die ihr Siegel als String
 * bauen. Leerer String, wenn das Zeichen nicht erscheinen darf.
 *
 * @param {{display_name?: string, avatar_color?: string, avatar_data?: string}|null} user
 * @returns {string}
 */
export function whoMark(user) {
  if (!user || isSoloHousehold()) return '';
  return whoMarkHtml(user);
}

/**
 * Der Name ist NICHT `aria-hidden`: das Zeichen ist der einzige Ort, an dem
 * „von wem" steht, seit es nicht mehr im `title`-Attribut haengt. Ein `title`
 * allein waere derselbe Fehler noch einmal - auf Touch gibt es keinen Hover.
 */
function whoMarkHtml(user) {
  const name = user.display_name ?? '';
  // `compactInitials`, nicht `initials`: das Zeichen ist 20px breit, neben dem
  // kleinen Siegel 16px, bei 10px Schrift. Zwei Hangul- oder Han-Zeichen
  // brauchen 20px und stiessen an den Rand oder liefen darueber.
  const color = user.avatar_color ?? user.color ?? AVATAR_FALLBACK_COLOR;
  const inner = user.avatar_data
    ? `<img src="${esc(user.avatar_data)}" alt="" loading="lazy">`
    : esc(compactInitials(name));
  return `<span class="seal-pair__who"
    style="background-color:${esc(color)};color:${getReadableTextColor(color)}">
    <span class="sr-only">${esc(name)}</span><span aria-hidden="true">${inner}</span>
  </span>`;
}
