/**
 * Modul: Test-Infrastruktur - die ECHTE public/i18n.js mit getrennter
 *        UI-Sprache und Region fahren.
 * Zweck: UI-Sprache (pro Geraet, `setLocale()`) und Region (pro Haushalt,
 *        localStorage `yuvomi-number-locale`) sind zwei Einstellungen. Eine
 *        Suite, die beide auf `de` laesst, sieht nicht, welche von beiden eine
 *        Ausgabe steuert: `formatFastingDuration()` zeigte unter UI `en` und
 *        Region `de-DE` „1 Tg. 1 Std. 7 Min.", und test:health-fasting blieb
 *        gruen, weil dort beide `de` waren (#1365).
 * Ausfuehren: keine eigene Suite - Helfer, importiert von den Suiten.
 *
 * Gefahren wird das Original, kein Nachbau: `setLocale()` setzt die Sprache,
 * `getFormatLocale()` liest die Region aus demselben localStorage wie im
 * Browser. Dafuer braucht i18n.js vier Browser-Globals (localStorage, fetch
 * fuer die Locale-Datei, document fuer `lang`/`dir`, window fuer
 * 'locale-changed'). Sie stehen nur fuer die Dauer von `fn` und werden danach
 * zurueckgestellt; die Sprache geht auf `de` zurueck, den Ausgangszustand des
 * Moduls. Unter test-browser-loader.mjs gilt dasselbe: der Loader stubt nur
 * `/i18n.js` (browser-absolut), dieser Import ist relativ und trifft die Datei.
 */
import { setLocale } from '../public/i18n.js';

const NUMBER_LOCALE_KEY = 'yuvomi-number-locale';
const GLOBALS = ['localStorage', 'fetch', 'document', 'window'];

/**
 * Fuehrt `fn` mit UI-Sprache `language` und Region `region` aus.
 * `fn` bekommt `setRegion(tag)`, um die Region mitten im Lauf zu wechseln -
 * so wie die Einstellungen es tun, ohne `setLocale()`.
 * @param {{ language: string, region?: string|null }} locales
 * @param {(env: { setRegion: (tag: string|null) => void }) => unknown} fn
 */
export async function withLocales({ language, region = null }, fn) {
  const saved = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const store = new Map();
  const define = (name, value) => Object.defineProperty(globalThis, name, {
    value, configurable: true, writable: true,
  });
  define('localStorage', {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  });
  define('fetch', async () => ({ ok: true, json: async () => ({}) }));
  define('document', { documentElement: { lang: '', dir: '' } });
  define('window', { dispatchEvent: () => true });
  const setRegion = (tag) => {
    if (tag) store.set(NUMBER_LOCALE_KEY, tag);
    else store.delete(NUMBER_LOCALE_KEY);
  };
  try {
    await setLocale(language);
    setRegion(region);
    return await fn({ setRegion });
  } finally {
    setRegion(null);
    await setLocale('de');
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}
