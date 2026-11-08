/**
 * Generic JSON webhook notification provider.
 *
 * Ohne Vorlage sendet der Kanal einen Yuvomi-geformten Body. Der passt fuer
 * Empfaenger, die beliebiges JSON annehmen (Home Assistant, n8n), aber nicht
 * fuer Dienste mit eigenem Pflichtschema: ein Discord-Webhook verlangt `content`
 * oder `embeds` und antwortet auf alles andere mit 400. Statt pro Dienst einen
 * Adapter zu bauen, formt eine Vorlage den Body - damit bleibt EIN generischer
 * Anbieter fuer Discord, Slack und alles Weitere zustaendig (#692, #660).
 */

import { guardedFetch } from './guarded-fetch.js';
import { NotificationProviderError } from './provider-error.js';

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
 */
export function unknownTemplatePlaceholders(template) {
  const unknown = new Set();
  for (const [, key] of String(template).matchAll(PLACEHOLDER_SHAPED_PATTERN)) {
    if (!WEBHOOK_TEMPLATE_PLACEHOLDERS.includes(key)) unknown.add(key);
  }
  return [...unknown];
}

function httpError(status) {
  if (status === 401 || status === 403) return new NotificationProviderError('Webhook authentication failed.');
  if (status === 404) return new NotificationProviderError('Webhook endpoint was not found.');
  return new NotificationProviderError(`Webhook returned HTTP ${status}`);
}

export const webhookProvider = {
  id: 'webhook',

  async send({ channel, payload, fetchImpl = guardedFetch, signal } = {}) {
    const headers = { 'content-type': 'application/json' };
    const token = String(channel?.secrets?.token ?? '');
    if (token) headers.authorization = `Bearer ${token}`;

    const template = String(channel?.config?.payloadTemplate ?? '').trim();
    const body = template
      ? renderPayloadTemplate(template, payload)
      : JSON.stringify({
        event: 'notification',
        notification: payload,
        sentAt: new Date().toISOString(),
      });

    const response = await fetchImpl(channel.config.baseUrl, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    if (!response.ok) throw httpError(response.status);
    return { ok: true, status: response.status };
  },
};

export default webhookProvider;
