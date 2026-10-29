/**
 * Modul: Install-Hinweis - wann er zaehlt (R24, Critique G6 P2-1)
 * Zweck: Der Hinweis "Yuvomi installieren" wartet auf zwei Klicks
 *        (INTERACTION_THRESHOLD). Die zwei "Weiter" des Rundgangs waren genau
 *        diese zwei, und der Hinweis sprang mitten in Schritt 3 ueber die
 *        Kapsel, die der Schritt erklaert. Klicks im Rundgang
 *        (`.onboarding-overlay`) zaehlen nicht mehr. Gemessen am echten
 *        Bauteil: der Klickzaehler, den `_waitForInteractions()` an `document`
 *        haengt, mit Klicks aus dem Rundgang und aus der App.
 * Ausfuehren: npm run test:install-prompt
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const listeners = [];
globalThis.document = {
  addEventListener: (type, fn, capture) => { listeners.push({ type, fn, capture: capture === true || capture?.capture === true }); },
  removeEventListener: (type, fn, capture) => { const c = capture === true || capture?.capture === true; const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === c); if (i >= 0) listeners.splice(i, 1); },
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  querySelector: () => null,
};
globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

let Prompt = null;
globalThis.HTMLElement = class {};
globalThis.customElements = { define: (_name, cls) => { Prompt = cls; }, get: () => undefined };

await import('../public/components/yuvomi-install-prompt.js');

/** Ein Klick an einem Ziel, das in (oder nicht in) einem Rundgang liegt. */
const clickAt = (insideTour) => ({ target: { closest: (sel) => (insideTour && sel === '.onboarding-overlay' ? {} : null) } });
const fire = (event) => { for (const l of [...listeners]) if (l.type === 'click') l.fn(event); };

test('Klicks im Rundgang zaehlen nicht, Klicks in der App schon', () => {
  assert.ok(Prompt, 'das Bauteil registriert sich');
  store.clear();
  const prompt = Object.create(Prompt.prototype);
  let shown = 0;
  prompt._isIOS = () => false;
  prompt._listenForInstallPrompt = () => { shown += 1; };
  prompt._waitForInteractions();
  assert.equal(listeners.filter((l) => l.type === 'click').length, 1, 'der Zaehler haengt an document');
  // Capture, nicht Bubble: der Rundgang baut seinen Schritt im Klick neu auf,
  // und beim Aufsteigen haengt der "Weiter"-Knopf nicht mehr im Dokument.
  assert.equal(listeners.find((l) => l.type === 'click').capture, true, 'der Zaehler sieht den Klick erst nach dem Umbau des Rundgangs');

  fire(clickAt(true)); fire(clickAt(true)); fire(clickAt(true));
  assert.equal(store.get('yuvomi-install-interactions') ?? null, null, 'die drei "Weiter" des Rundgangs zaehlten');
  assert.equal(shown, 0, 'der Hinweis kam mitten im Rundgang');

  fire(clickAt(false));
  assert.equal(store.get('yuvomi-install-interactions'), '1');
  assert.equal(shown, 0);
  fire(clickAt(false));
  assert.equal(shown, 1, 'nach zwei Klicks in der App kommt der Hinweis');
  assert.equal(listeners.filter((l) => l.type === 'click').length, 0, 'danach haengt kein Zaehler mehr');
});

/* EIN SATZ FUER DIE INSTALLATION AUF iOS (Critique R24, G6-Rand-P3-2). Der
 * Hinweis sagte 'Tippe auf ⇧ → "Zum Home-Bildschirm"' mit geraden
 * Anfuehrungszeichen und Pfeil, die Einstellungen "Teilen-Menue oeffnen und Zum
 * Home-Bildschirm auswaehlen" - zwei Formulierungen fuer denselben Weg. Jetzt
 * EIN Satz (tippen, waehlen) mit dem Menuepunkt in den Anfuehrungszeichen der
 * Sprache, in jeder Locale Hinweis, Einstellungen und Toast mit demselben Namen. */
test('R24: Install-Hinweis, Einstellungen und Toast sagen auf iOS denselben Satz', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../public/locales/', import.meta.url);
  const de = JSON.parse(readFileSync(new URL('de.json', dir), 'utf8'));
  assert.equal(`${de.install.iosTip1}⇧${de.install.iosTip2}`, 'Tippe auf ⇧ und wähle „Zum Home-Bildschirm“.');
  assert.equal(de.settings.pwaInstallIosToast, 'Tippe auf Teilen und wähle „Zum Home-Bildschirm“.');
  assert.ok(de.settings.pwaInstallIosHint.endsWith(`: ${de.settings.pwaInstallIosToast}`),
    'der Hinweis der Einstellungen ist derselbe Satz mit Geraet davor');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const { install, settings } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    assert.doesNotMatch(install.iosTip2, /[→←]/, `${file}: kein Pfeil statt Verb`);
    // Der Name des Menuepunkts steht im Hinweis UND in Einstellungen und Toast.
    const label = install.iosTip2.match(/[“„«‘'"”「]\s?([^“”„«»‘’'"「」]+?)\s?[”“»’'"」]/)?.[1];
    assert.ok(label, `${file}: der Menuepunkt steht in Anfuehrungszeichen`);
    assert.ok(settings.pwaInstallIosHint.includes(label) && settings.pwaInstallIosToast.includes(label),
      `${file}: "${label}" steht auch in Einstellungen und Toast`);
  }
});
