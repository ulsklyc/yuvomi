/**
 * Modul: Notification-Kanal-Formular (#944)
 * Zweck: Die Sichtbarkeitslogik der Kanal-Karte. Sie traegt zwei Fehler, die
 *        ein Textguard nicht sieht, weil beide erst aus dem ZUSAMMENSPIEL von
 *        Rendern und Anbieterwechsel entstehen:
 *
 *        1. Ein verstecktes Feld bleibt geprueft. `display:none` nimmt einem
 *           Eingabefeld nicht seine Bedingungen - nur `disabled` tut das. Bei
 *           `type="email"` greift `typeMismatch` sogar ohne `required`. Wer
 *           `oma@` tippt und dann den Anbieter wechselt, hinterlaesst ein
 *           unsichtbares ungueltiges Feld, und der Speichern-Knopf tut
 *           scheinbar nichts: der Browser kann den Fokus nicht dorthin setzen.
 *
 *        2. Der Wechsel des Anbieters rendert die Karte NICHT neu. Ein Hinweis,
 *           der nur beim Rendern erzeugt wird, erscheint deshalb nie - ein
 *           neuer Kanal startet immer als Gotify.
 *
 *        Geprueft wird das Verhalten an einem DOM-Ausschnitt, nicht die
 *        Schreibweise im Quelltext.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-notification-channel-form.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('../public/settings/pages/notifications.js');
const { updateProviderVisibility, setBlockActive, providerNotReady, usesBaseUrl, channelDefaults } = __test;

/* ------------------------------------------------------------------ *
 * Ein DOM-Ausschnitt, gerade gross genug fuer die geprueften Aufrufe:
 * classList.toggle, querySelector(All) und form.elements.
 * ------------------------------------------------------------------ */
function makeElement(className = '', props = {}) {
  const classes = new Set(className.split(' ').filter(Boolean));
  return {
    tagName: props.tagName || 'div',
    disabled: false,
    required: false,
    value: '',
    ...props,
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    get hidden() { return classes.has('settings-card--hidden'); },
    children: [],
    querySelectorAll() { return this.children; },
  };
}

function makeBlock(className, fields = []) {
  const block = makeElement(className);
  block.children = fields;
  return block;
}

/**
 * Baut die Karte so, wie renderChannelList() sie erzeugt: die Bloecke aller
 * vier Anbieter liegen gleichzeitig im DOM, nur verschieden versteckt.
 */
function makeForm(provider = 'gotify') {
  const fields = {
    provider: makeElement('', { tagName: 'select', value: provider }),
    name: makeElement('', { tagName: 'input' }),
    enabled: makeElement('', { tagName: 'input', checked: false }),
    baseUrl: makeElement('', { tagName: 'input' }),
    emailTo: makeElement('', { tagName: 'input', type: 'email' }),
    gotifyToken: makeElement('', { tagName: 'input' }),
    ntfyTopic: makeElement('', { tagName: 'input' }),
    ntfyAuth: makeElement('', { tagName: 'select', value: 'none' }),
    ntfyToken: makeElement('', { tagName: 'input' }),
    ntfyUsername: makeElement('', { tagName: 'input' }),
    ntfyPassword: makeElement('', { tagName: 'input' }),
    webhookToken: makeElement('', { tagName: 'input' }),
    webhookTemplate: makeElement('', { tagName: 'textarea' }),
  };
  const ntfyToken = makeBlock('form-field notification-ntfy-token-field', [fields.ntfyToken]);
  const ntfyBasic = [
    makeBlock('form-field notification-ntfy-basic-field', [fields.ntfyUsername]),
    makeBlock('form-field notification-ntfy-basic-field', [fields.ntfyPassword]),
  ];
  const blocks = {
    '.notification-base-url-field': makeBlock('form-field notification-base-url-field', [fields.baseUrl]),
    '.notification-provider-fields--gotify': makeBlock('notification-provider-fields--gotify', [fields.gotifyToken]),
    '.notification-provider-fields--ntfy': makeBlock('notification-provider-fields--ntfy',
      [fields.ntfyTopic, fields.ntfyAuth, fields.ntfyToken, fields.ntfyUsername, fields.ntfyPassword]),
    '.notification-provider-fields--webhook': makeBlock('notification-provider-fields--webhook', [fields.webhookToken, fields.webhookTemplate]),
    '.notification-provider-fields--email': makeBlock('notification-provider-fields--email', [fields.emailTo]),
    '.notification-ntfy-token-field': ntfyToken,
    '.notification-email-not-ready': makeElement('form-hint notification-email-not-ready'),
  };
  return {
    elements: fields,
    blocks,
    querySelector: (sel) => blocks[sel] ?? null,
    querySelectorAll: (sel) => (sel === '.notification-ntfy-basic-field' ? ntfyBasic : []),
  };
}

const PROVIDERS_SMTP_MISSING = [
  { id: 'gotify', name: 'Gotify' },
  { id: 'ntfy', name: 'ntfy' },
  { id: 'webhook', name: 'Webhook' },
  { id: 'email', name: 'Email', ready: false },
];
const PROVIDERS_SMTP_READY = PROVIDERS_SMTP_MISSING.map((p) => (p.id === 'email' ? { ...p, ready: true } : p));

test('ein verstecktes Feld wird abgeschaltet, nicht nur ausgeblendet (#944)', () => {
  const form = makeForm('email');
  updateProviderVisibility(form, PROVIDERS_SMTP_READY);
  assert.equal(form.elements.emailTo.disabled, false, 'sichtbar heisst aktiv');

  // DER FEHLERFALL: halbe Adresse eingetippt, dann den Anbieter gewechselt.
  form.elements.emailTo.value = 'oma@';
  form.elements.provider.value = 'gotify';
  updateProviderVisibility(form, PROVIDERS_SMTP_READY);

  assert.equal(form.blocks['.notification-provider-fields--email'].hidden, true, 'der Block ist versteckt');
  // Und das ist der Punkt: `type="email"` prueft auch ohne `required` weiter.
  // Nur `disabled` nimmt das Feld aus der Pruefung UND aus dem Versand.
  assert.equal(form.elements.emailTo.disabled, true,
    'ein unsichtbares type=email mit Altwert blockiert sonst das Absenden, ohne sich zu zeigen');
});

test('die Regel gilt fuer jeden Anbieterblock, nicht nur fuer E-Mail (#944)', () => {
  // Als Regel ueber den Block formuliert, damit der naechste Anbieter mit
  // eigenem Feld von selbst gedeckt ist.
  for (const provider of ['gotify', 'ntfy', 'webhook', 'email']) {
    const form = makeForm(provider);
    updateProviderVisibility(form, PROVIDERS_SMTP_READY);
    const active = {
      gotify: ['gotifyToken'],
      ntfy: ['ntfyTopic', 'ntfyAuth'],
      webhook: ['webhookToken', 'webhookTemplate'],
      email: ['emailTo'],
    }[provider];
    for (const [name, field] of Object.entries(form.elements)) {
      if (['provider', 'name', 'enabled', 'baseUrl'].includes(name)) continue;
      // ntfy-Auth-Felder haengen zusaetzlich an der Auth-Art (hier 'none').
      if (['ntfyToken', 'ntfyUsername', 'ntfyPassword'].includes(name)) {
        assert.equal(field.disabled, true, `${name} ist bei authType=none abgeschaltet`);
        continue;
      }
      assert.equal(field.disabled, !active.includes(name),
        `${name} muss bei Anbieter ${provider} ${active.includes(name) ? 'aktiv' : 'abgeschaltet'} sein`);
    }
  }
});

test('die Basis-URL ist bei E-Mail weder Pflicht noch aktiv (#944)', () => {
  const form = makeForm('gotify');
  updateProviderVisibility(form, PROVIDERS_SMTP_READY);
  assert.equal(form.elements.baseUrl.required, true);
  assert.equal(form.elements.baseUrl.disabled, false);

  form.elements.provider.value = 'email';
  updateProviderVisibility(form, PROVIDERS_SMTP_READY);
  // Beides noetig: `required` allein weggenommen, bliebe ein leeres Feld
  // harmlos - aber ein bereits eingetippter Wert ginge mit ans Backend, das
  // fuer email gar kein baseUrl kennt.
  assert.equal(form.elements.baseUrl.required, false, 'kein Pflichtfeld ohne Endpunkt');
  assert.equal(form.elements.baseUrl.disabled, true, 'und abgeschaltet');
  assert.equal(usesBaseUrl('email'), false, 'die Quelle dafuer sind die Defaults, keine zweite Liste');
});

test('der SMTP-Hinweis erscheint beim ANLEGEN, nicht erst nach dem Speichern (#944)', () => {
  // Ein neuer Kanal startet als Gotify - der Hinweis darf also nicht davon
  // abhaengen, was beim Rendern der Anbieter war.
  const form = makeForm('gotify');
  updateProviderVisibility(form, PROVIDERS_SMTP_MISSING);
  assert.equal(form.blocks['.notification-email-not-ready'].hidden, true, 'bei Gotify kein SMTP-Hinweis');

  form.elements.provider.value = 'email';
  updateProviderVisibility(form, PROVIDERS_SMTP_MISSING);
  assert.equal(form.blocks['.notification-email-not-ready'].hidden, false,
    'nach dem Wechsel auf E-Mail muss der Hinweis da sein - der Wechsel rendert die Karte nicht neu');

  // Und er verschwindet wieder, sobald SMTP eingerichtet ist.
  const ready = makeForm('email');
  updateProviderVisibility(ready, PROVIDERS_SMTP_READY);
  assert.equal(ready.blocks['.notification-email-not-ready'].hidden, true, 'mit SMTP kein Hinweis');
});

test('ready gilt nur fuer Anbieter, die es meldet (#944)', () => {
  assert.equal(providerNotReady(PROVIDERS_SMTP_MISSING, 'email'), true);
  assert.equal(providerNotReady(PROVIDERS_SMTP_READY, 'email'), false);
  // Wer kein `ready` mitschickt, gilt unveraendert als einsatzbereit - sonst
  // truege jeder Anbieter ploetzlich einen Hinweis.
  assert.equal(providerNotReady(PROVIDERS_SMTP_MISSING, 'gotify'), false);
  assert.equal(providerNotReady(PROVIDERS_SMTP_MISSING, 'unbekannt'), false);
});

test('setBlockActive schaltet den ganzen Block, nicht ein benanntes Feld (#944)', () => {
  const a = makeElement('', { tagName: 'input' });
  const b = makeElement('', { tagName: 'select' });
  const block = makeBlock('x', [a, b]);
  setBlockActive(block, false);
  assert.deepEqual([block.hidden, a.disabled, b.disabled], [true, true, true]);
  setBlockActive(block, true);
  assert.deepEqual([block.hidden, a.disabled, b.disabled], [false, false, false]);
  assert.doesNotThrow(() => setBlockActive(null, false), 'ein fehlender Block ist kein Fehler');
});

test('ein Mail-Kanal startet ohne Basis-URL und ohne Geheimnisfeld (#944)', () => {
  const defaults = channelDefaults('email');
  assert.deepEqual(defaults.config, { toAddress: '' });
  assert.equal(Object.hasOwn(defaults.config, 'baseUrl'), false,
    'die Defaults sind die eine Quelle dafuer, ob ein Anbieter einen Endpunkt hat');
});

// R23 S11 (Critique G6 P2 "Leerzustand nackter Satz"): ohne Kanal stand ein
// Hinweissatz, wo jede andere leere Liste den Leerzustand zeigt.
test('R23: ohne Kanal zeigt die Liste den kompakten Leerzustand', async () => {
  const { installMiniDom } = await import('./mini-dom.js');
  let html = '';
  const list = { replaceChildren: () => { html = ''; }, insertAdjacentHTML: (_pos, chunk) => { html += chunk; } };
  const restore = installMiniDom();
  try {
    __test.renderChannelList({ querySelector: (sel) => (sel === '#notification-channel-list' ? list : null) }, []);
  } finally {
    restore();
  }
  assert.match(html, /class="[^"]*empty-state[^"]*empty-state--compact/, html);
  assert.match(html, /settings\.notificationChannelEmpty/);
  assert.doesNotMatch(html, /^<p class="form-hint">/);
});
