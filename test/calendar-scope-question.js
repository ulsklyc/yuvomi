/**
 * Die Frage nach der Reichweite eines Serientermins (#1284) im Test beantworten.
 *
 * Fuer Suiten, die den Kalender ueber test-browser-loader.mjs fahren. Der Stub
 * von openModal reicht seine Optionen an globalThis.__openModal weiter; hier
 * entsteht daraus der Dialog, den der Kalender WIRKLICH gebaut hat: die Knoepfe
 * kommen aus dem Markup (`options.content`), verdrahtet werden sie von
 * `options.onSave` - also von der Seite, nicht von dieser Datei. Beantwortet
 * wird mit einem Klick auf den Knopf, den das Markup fuer die Wahl traegt.
 *
 * Antworten: 'this' | 'following' | 'series' (der Knopf mit diesem
 * data-scope), 'cancel' (der Abbrechen-Knopf), 'dismiss' (Escape, X oder
 * Overlay - im Original laufen alle drei ueber closeModal in onClose). Ohne
 * Antwort bleibt der Dialog offen, bis der Test `dialog.respond(...)` ruft.
 *
 * Kein test-*.js: das ist eine Hilfsdatei, keine Suite (test:suite-chain).
 */
import assert from 'node:assert/strict';

const BUTTON = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
const ATTR = /([\w-]+)="([^"]*)"/g;

function fakeButton(attrs, label) {
  const listeners = [];
  const dataset = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('data-')) {
      dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    }
  }
  return {
    id: attrs.id ?? null,
    attrs,
    label,
    dataset,
    addEventListener(type, fn) { if (type === 'click') listeners.push(fn); },
    click() { for (const fn of [...listeners]) fn({ type: 'click', target: this }); },
  };
}

function respond(dialog, choice) {
  dialog.answered = choice;
  if (choice === 'dismiss') {
    dialog.options.onClose?.();
    return;
  }
  if (choice === 'cancel') {
    const cancel = dialog.panel.querySelector('#recurring-scope-cancel');
    assert.ok(cancel, 'der Dialog hat keinen Abbrechen-Knopf');
    cancel.click();
    return;
  }
  const button = dialog.buttons.find((b) => b.attrs['data-scope'] === choice);
  assert.ok(button, `der Dialog hat keinen Knopf fuer "${choice}"`);
  button.click();
}

/**
 * Wartet auf das Speichern oder Loeschen, aber nicht ewig. Nimmt der Dialog
 * eine Antwort nicht an (ein Knopf ohne Listener), bliebe der Aufruf offen und
 * mit ihm die ganze Suite; so wird daraus ein Fehlschlag mit Namen.
 */
export async function settles(promise, what) {
  let timer;
  const hang = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} kam nicht zurueck - der Dialog hat die Antwort nicht angenommen`)), 3000);
  });
  try {
    return await Promise.race([promise, hang]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Setzt globalThis.__openModal. `answer` wie oben; jeder weitere Dialog in
 * derselben Zeit bekommt dieselbe Antwort.
 */
export function scopeQuestion(answer) {
  const dialogs = [];
  globalThis.__openModal = (options) => {
    // Die Knoepfe tragen reinen Text. Traegt einer doch Markup, steht es im
    // Label und faellt in der Zusicherung auf - kein Tag-Entfernen hier.
    const buttons = [...String(options.content ?? '').matchAll(BUTTON)].map(([, attrText, label]) => fakeButton(
      Object.fromEntries([...attrText.matchAll(ATTR)].map(([, name, value]) => [name, value])),
      label.trim(),
    ));
    const panel = {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-scope]', `unerwarteter Selektor im Dialog: ${selector}`);
        return buttons.filter((b) => 'data-scope' in b.attrs);
      },
      querySelector(selector) {
        assert.ok(selector.startsWith('#'), `unerwarteter Selektor im Dialog: ${selector}`);
        return buttons.find((b) => b.id === selector.slice(1)) ?? null;
      },
    };
    const dialog = { options, buttons, panel, answered: undefined };
    dialog.respond = (choice) => respond(dialog, choice);
    dialogs.push(dialog);
    options.onSave?.(panel);
    if (answer !== undefined) dialog.respond(answer);
  };
  return {
    dialogs,
    uninstall() { delete globalThis.__openModal; },
  };
}
