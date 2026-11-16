/**
 * Webhook payload templates: placeholders, rendering and the check for unknown ones.
 *
 * Its own module, apart from the webhook provider: the channel store validates a
 * template when it is saved (notification-channels.js) and must not import the
 * provider that sends, which only server/services/channel-delivery.js may
 * (dependency-cruiser rule `providers-only-in-channel-delivery`).
 */

export const WEBHOOK_TEMPLATE_PLACEHOLDERS = Object.freeze(['title', 'body', 'url', 'tag']);

// ZWEI Muster, absichtlich verschieden weit: ersetzt wird nur, was wir fuellen
// koennen, geprueft wird ALLES, was wie ein Platzhalter aussieht. Mit einem
// gemeinsamen `\w+` war `{{task-title}}` fuer beide unsichtbar - die Pruefung
// meldete nichts und die Zustellung schickte den Token woertlich mit, obwohl
// beim Speichern zugesagt wird, Unbekanntes abzulehnen.
const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;
const PLACEHOLDER_SHAPED_PATTERN = /\{\{([^{}]*)\}\}/g;

/**
 * Setzt die Platzhalter einer Vorlage JSON-sicher ein.
 *
 * Der Wert wird als JSON-String kodiert und OHNE die aeusseren Anfuehrungszeichen
 * eingesetzt, weil die in der Vorlage stehen: `{"content": "{{title}}"}`. Ein
 * Titel mit Anfuehrungszeichen, Backslash oder Zeilenumbruch zerrisse sonst das
 * JSON des Nutzers - und zwar erst bei der Zustellung, nicht beim Speichern.
 *
 * @param {unknown} template
 * @param {Record<string, unknown> | null} [payload]
 * @returns {string}
 */
export function renderPayloadTemplate(template, payload = {}) {
  return String(template).replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!WEBHOOK_TEMPLATE_PLACEHOLDERS.includes(key)) return match;
    const value = payload?.[key];
    if (value === null || value === undefined) return '';
    return JSON.stringify(String(value)).slice(1, -1);
  });
}

/**
 * Platzhalter, die die Vorlage benutzt, aber niemand fuellen kann.
 *
 * Prueft gegen das WEITE Muster: ein Tippfehler mit Bindestrich, Punkt oder
 * Leerzeichen (`{{task-title}}`, `{{ title }}`) ist genau der Fall, den der
 * Nutzer gemeldet bekommen muss - er wuerde sonst unersetzt im Body landen.
 *
 * @param {unknown} template
 * @returns {string[]}
 */
export function unknownTemplatePlaceholders(template) {
  const unknown = new Set();
  for (const [, key] of String(template).matchAll(PLACEHOLDER_SHAPED_PATTERN)) {
    if (!WEBHOOK_TEMPLATE_PLACEHOLDERS.includes(key)) unknown.add(key);
  }
  return [...unknown];
}
