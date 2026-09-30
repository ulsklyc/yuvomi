/**
 * Test: Wiederholungsfelder der Oberfläche (public/rrule-ui.js, #756)
 *
 * Der Anlassfall: Ein per CalDAV eingelesener Serientermin verlor seine
 * Wiederholung, sobald man in Yuvomi irgendein anderes Feld änderte - und der
 * Verlust wanderte über den Sync zurück in den Fremdkalender. Zwei Ursachen,
 * beide hier abgedeckt:
 *
 *  1. Eingelesene Regeln stehen mit „RRULE:"-Präfix in der Datenbank
 *     (ics-parser.js). parseRRule kannte das Präfix nicht, las FREQ nicht und
 *     lieferte „keine Wiederholung" - das Formular zeigte ein leeres Feld und
 *     schrieb diese Leere beim Speichern fest.
 *  2. Dieses Formular kennt nur einen Ausschnitt von RFC 5545. Alles darüber
 *     hinaus (WKST, BYMONTHDAY, BYSETPOS) ginge beim Neubau aus den Feldern
 *     verloren, obwohl der Nutzer die Wiederholung gar nicht angefasst hat.
 *
 * Die Prüfungen laufen gegen den echten Regelaufbau, nicht gegen Schreibweisen:
 * gerendertes Formular -> DOM-Stub -> getRRuleValues, also derselbe Weg, den
 * ein Klick auf „Speichern" nimmt.
 *
 * Ausführen: node --loader ./test/test-browser-loader.mjs test/test-rrule-ui.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedLocales } from '../public/i18n.js';

const {
  parseRRule, buildRRule, describeRRule, renderRRuleFields, getRRuleValues,
  bindRRuleEvents, monthEndHintText,
} =
  await import('../public/rrule-ui.js');

// --------------------------------------------------------
// Ein DOM-Ersatz, klein genug zum Lesen: getRRuleValues fragt ausschließlich per
// querySelector nach `#id` und `#id .klasse` und liest `value` bzw. `checked`.
// Die Werte kommen aus dem gerenderten Formular-HTML, damit Render- und
// Lesepfad zusammen geprüft werden und nicht zwei getrennte Annahmen.
// --------------------------------------------------------
function formRoot(html) {
  const attr = (tag, name) => {
    const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
    return m ? m[1] : null;
  };
  const decode = (s) => String(s).replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // Feldwerte einmal aus dem Markup ziehen: id -> value.
  const values = new Map();
  for (const tag of html.match(/<(input|select|yuvomi-datepicker)\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'id');
    if (id) values.set(`#${id}`, decode(attr(tag, 'value') ?? ''));
  }
  // <select> trägt seinen Wert an der markierten <option>, nicht am Element.
  for (const [, id, body] of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const selected = /<option value="([^"]*)"[^>]*\bselected\b/.exec(body);
    values.set(`#${id}`, selected ? selected[1] : (/<option value="([^"]*)"/.exec(body)?.[1] ?? ''));
  }

  // Aktive Wochentagsknöpfe, die einzige Sammelabfrage.
  const activeDays = [...html.matchAll(/<button[^>]*class="rrule-day rrule-day--active"[^>]*data-day="([A-Z]{2})"/g)]
    .map((m) => ({ dataset: { day: m[1] } }));

  return {
    querySelector(selector) {
      if (!values.has(selector)) return null;
      return { value: values.get(selector), checked: false };
    },
    querySelectorAll(selector) {
      return selector.includes('rrule-day--active') ? activeDays : [];
    },
    _set(selector, value) { values.set(selector, value); },
  };
}

/** Das Formular so lesen, wie „Speichern" es liest. */
function roundTrip(rule, mutate) {
  const root = formRoot(renderRRuleFields('event', rule, { allowCount: true }));
  mutate?.(root);
  return getRRuleValues(root, 'event');
}

// --------------------------------------------------------
// 1. Das Präfix
// --------------------------------------------------------

test('parseRRule liest eine Regel mit RRULE:-Präfix (#756)', () => {
  const parsed = parseRRule('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE');
  assert.equal(parsed.freq, 'WEEKLY', 'ohne FREQ hält das Formular die Serie für keine Serie');
  assert.deepEqual(parsed.byday, ['WE']);
  assert.equal(parsed.interval, 1);
});

test('parseRRule bleibt bei der präfixlosen Schreibweise gleich', () => {
  assert.deepEqual(
    parseRRule('RRULE:FREQ=WEEKLY;BYDAY=WE'),
    parseRRule('FREQ=WEEKLY;BYDAY=WE'),
    'beide Schreibweisen stehen nebeneinander in der Datenbank'
  );
});

test('describeRRule beschreibt auch die eingelesene Schreibweise', () => {
  // Die Detailansicht zeigte hier eine leere Zeile - das erste sichtbare
  // Symptom, noch vor dem Datenverlust.
  assert.notEqual(describeRRule('RRULE:FREQ=WEEKLY;BYDAY=WE'), '');
});

test('das Formular zeigt eine eingelesene Serie als Wiederholung an', () => {
  const html = renderRRuleFields('event', 'RRULE:FREQ=WEEKLY;BYDAY=WE', { allowCount: true });
  assert.match(html, /<option value="WEEKLY" selected>/, 'die Frequenz muss vorausgewählt sein');
  assert.doesNotMatch(html, /id="event-rrule-details"[^>]*hidden/, 'die Detailfelder dürfen nicht verborgen sein');
});

// --------------------------------------------------------
// 1b. Der Takt ist einstellbar, und das Formular sagt es (#862)
//
// Die vier Frequenzen lasen sich wie feste Werte: das Intervallfeld liegt im
// Detailbereich, und der traegt "hidden", solange nichts gewaehlt ist. Ein
// Melder hat deshalb einen Thread fuer eine Funktion aufgemacht, die es gibt -
// gefunden hat er sie erst, nachdem er auf gut Glueck "woechentlich" waehlte.
// --------------------------------------------------------

/** Mini-DOM fuer bindRRuleEvents: nur hidden, value und addEventListener. */
function eventRoot(html) {
  const nodes = new Map();
  const decode = (s) => String(s)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  for (const [, tag, id] of html.matchAll(/<(\w[\w-]*)[^>]*\bid="([^"]+)"/g)) {
    const chunk = new RegExp(`<${tag}[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    const attrs = new Map();
    for (const [, name, val] of chunk.matchAll(/([a-z-]+)="([^"]*)"/g)) attrs.set(name, val);
    nodes.set(`#${id}`, {
      tagName: tag, id, hidden: /\shidden(?=[\s>])/.test(chunk),
      checked: /\schecked(?=[\s>])/.test(chunk), value: decode(attrs.get('value') ?? ''),
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      fire(type) { for (const fn of this.listeners[type] ?? []) fn(); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      setAttribute(name, val) { attrs.set(name, String(val)); },
      removeAttribute(name) { attrs.delete(name); },
    });
  }
  for (const [, id, body] of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const selected = /<option value="([^"]*)"[^>]*\bselected\b/.exec(body);
    const fallback = /<option value="([^"]*)"/.exec(body);
    const node = nodes.get(`#${id}`);
    if (node) node.value = decode(selected?.[1] ?? fallback?.[1] ?? '');
  }
  return {
    querySelector: (sel) => nodes.get(sel) ?? null,
    querySelectorAll: () => [],
    get: (sel) => nodes.get(sel),
  };
}

test('ohne gewaehlte Wiederholung sagt das Formular, dass der Takt einstellbar ist', () => {
  const html = renderRRuleFields('event', null, { allowCount: true });
  assert.match(html, /id="event-rrule-hint"/, 'der Hinweis fehlt ganz');
  assert.doesNotMatch(html, /id="event-rrule-hint"[^>]*hidden/,
    'genau hier ist der Irrtum moeglich - der Hinweis muss sichtbar sein');
  assert.match(html, /rrule\.intervalHint/, 'der Text kommt aus der Uebersetzung, nicht aus dem Markup');
});

test('Hinweis und Detailbereich sind komplementaer, nie beide da und nie beide weg', () => {
  // Das ist die Regel, nicht die Beobachtung: der Hinweis beantwortet die Frage
  // "sind das die einzigen vier Takte?", und sobald der Takt sichtbar
  // danebensteht, hat sie sich erledigt. Zwei Zustaende, nie ein dritter.
  for (const [label, rule] of [['ohne Regel', null], ['mit Regel', 'RRULE:FREQ=WEEKLY;INTERVAL=2']]) {
    const html = renderRRuleFields('event', rule, { allowCount: true });
    const hintHidden    = /id="event-rrule-hint"[^>]*hidden/.test(html);
    const detailsHidden = /id="event-rrule-details"[^>]*hidden/.test(html);
    assert.notEqual(hintHidden, detailsHidden, `${label}: beide ${hintHidden ? 'verborgen' : 'sichtbar'}`);
  }
});

test('die Beschreibung des Auswahlfelds folgt dem Hinweis, nicht nur sein hidden', () => {
  // Ein per aria-describedby DIREKT referenzierter Knoten zaehlt zur Beschreibung,
  // auch wenn er verborgen ist (accname 1.2 §4.3.1 nimmt genau die direkt
  // Referenzierten von der Verborgen-Regel aus). Bliebe die Referenz stehen,
  // hoerte ein Screenreader-Nutzer den Hinweis weiter, den Sehende nicht mehr
  // sehen - beide Modalitaeten muessen denselben Zustand zeigen.
  // GEPRUEFT WIRD DAS AUSWAHLFELD, NICHT DIE GANZE AUSGABE. Die erste Fassung
  // suchte `aria-describedby` im gesamten Markup und wurde rot, als der
  // Monatsletzten-Schalter seinen EIGENEN, dauerhaft gueltigen Hinweis bekam
  // (#960) - ein anderer Knoten mit einer anderen Aussage. Die Regel gilt dem
  // Frequenz-Feld: seine Erklaerung ist beantwortet, sobald eine Wiederholung
  // gewaehlt ist.
  const freqTag = (html) => html.slice(html.indexOf('id="task-rrule-freq"') - 200,
    html.indexOf('id="task-rrule-freq"') + 200);
  assert.match(freqTag(renderRRuleFields('task', null, {})), /aria-describedby="task-rrule-hint"/,
    'ohne Wiederholung: ohne die Zuordnung liest ein Screenreader die Auswahl ohne ihre Erklaerung vor');
  assert.doesNotMatch(freqTag(renderRRuleFields('task', 'FREQ=WEEKLY', {})), /aria-describedby/,
    'mit Wiederholung: der Hinweis ist beantwortet und darf auch nicht mehr vorgelesen werden');
});

test('die Referenz wird beim Umschalten mitgefuehrt, nicht nur beim Rendern', () => {
  const root = eventRoot(renderRRuleFields('event', null, { allowCount: true }));
  const freq = root.get('#event-rrule-freq');

  bindRRuleEvents(root, 'event');
  assert.equal(freq.getAttribute('aria-describedby'), 'event-rrule-hint', 'Ausgangslage');

  freq.value = 'MONTHLY'; freq.fire('change');
  assert.equal(freq.getAttribute('aria-describedby'), null, 'gewaehlt: Beschreibung weg');

  freq.value = ''; freq.fire('change');
  assert.equal(freq.getAttribute('aria-describedby'), 'event-rrule-hint', 'abgewaehlt: wieder da');
});

test('die Auswahl einer Frequenz nimmt den Hinweis weg und holt den Takt hervor', () => {
  const html = renderRRuleFields('event', null, { allowCount: true });
  const root = eventRoot(html);
  const freq = root.get('#event-rrule-freq');
  const hint = root.get('#event-rrule-hint');
  const details = root.get('#event-rrule-details');

  assert.equal(hint.hidden, false, 'Ausgangslage');
  assert.equal(details.hidden, true, 'Ausgangslage');

  bindRRuleEvents(root, 'event');
  freq.value = 'MONTHLY';
  freq.fire('change');

  assert.equal(hint.hidden, true, 'beantwortet, also weg');
  assert.equal(details.hidden, false, 'und der Takt steht jetzt da');

  // Und zurueck: wer die Wiederholung wieder abwaehlt, bekommt den Hinweis wieder.
  freq.value = '';
  freq.fire('change');
  assert.equal(hint.hidden, false);
  assert.equal(details.hidden, true);
});

// --------------------------------------------------------
// 2. Wer nichts ändert, ändert nichts
// --------------------------------------------------------

test('eine unangetastete Serie geht im Wortlaut zurück (#756)', () => {
  const rule = 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE';
  const values = roundTrip(rule);
  assert.equal(values.recurrence_rule, rule, 'sonst schreibt jedes Speichern eine andere Regel als die gelesene');
  assert.equal(values.is_recurring, true);
});

test('Regelteile außerhalb des Formular-Vokabulars überleben eine Änderung am Termin', () => {
  // BYSETPOS/BYMONTHDAY kennt dieses Formular nicht. Aus den Feldern neu gebaut
  // würde aus „jeder dritte Donnerstag" ein schlichtes „jeden Monat" - eine
  // stille Verschiebung der ganzen Serie.
  const rule = 'RRULE:FREQ=MONTHLY;BYSETPOS=3;BYDAY=TH';
  assert.equal(roundTrip(rule).recurrence_rule, rule);
});

test('eine echte Änderung an der Wiederholung schlägt durch', () => {
  const values = roundTrip('RRULE:FREQ=WEEKLY;BYDAY=WE', (root) => {
    root._set('#event-rrule-freq', 'DAILY');
  });
  assert.equal(values.recurrence_rule, 'FREQ=DAILY', 'die Ausgangsregel darf die Eingabe nicht überstimmen');
});

test('eine bewusst entfernte Wiederholung bleibt entfernt', () => {
  // Die Gegenrichtung: Der Unverändert-Rückgriff darf das Leeren nicht
  // rückgängig machen, sonst ließe sich keine Serie mehr auflösen.
  const values = roundTrip('RRULE:FREQ=WEEKLY;BYDAY=WE', (root) => {
    root._set('#event-rrule-freq', '');
  });
  assert.equal(values.recurrence_rule, null);
  assert.equal(values.is_recurring, false);
});

test('ohne Ausgangsregel entsteht die Regel wie bisher aus den Feldern', () => {
  const values = roundTrip(null, (root) => {
    root._set('#event-rrule-freq', 'WEEKLY');
  });
  assert.equal(values.recurrence_rule, 'FREQ=WEEKLY');
});

// --------------------------------------------------------
// 3. Was der Server annehmen muss
// --------------------------------------------------------

test('eine neu gebaute Regel besteht weiterhin den Server-Validator', async () => {
  // DER ECHTE AUSDRUCK, NICHT SEINE KOPIE. Hier stand bis #960 ein
  // handabgeschriebenes Duplikat von `server/middleware/validate.js` - und als
  // der Validator um BYMONTHDAY erweitert wurde, prüfte der Test weiter gegen
  // die alte Fassung, ohne rot zu werden. Ein Guard, der eine Kopie der Regel
  // hält, prüft ab dem ersten Auseinanderlaufen sich selbst.
  const { RRULE_RE } = await import('../server/middleware/validate.js');
  const gebaut = [
    buildRRule({ freq: 'WEEKLY', interval: 2, byday: ['MO', 'TH'], until: '', count: 5 }),
    buildRRule({ freq: 'MONTHLY', interval: 1, byday: [], until: '', lastDay: true }),
    buildRRule({ freq: 'MONTHLY', interval: 3, byday: [], until: '2027-01-31', lastDay: true }),
  ];
  assert.equal(gebaut.filter(Boolean).length, 3, 'Reichweite: drei Regeln gebaut');
  for (const rule of gebaut) assert.match(rule, RRULE_RE, `Server lehnt ab: ${rule}`);
});

// --------------------------------------------------------
// "Am letzten Tag des Monats" (#960)
// --------------------------------------------------------

test('die Wahl wird als BYMONTHDAY=-1 geschrieben, und nur bei MONTHLY', () => {
  assert.equal(buildRRule({ freq: 'MONTHLY', interval: 1, byday: [], until: '', lastDay: true }),
    'FREQ=MONTHLY;BYMONTHDAY=-1');
  // Bei YEARLY waere "letzter Tag" jeder 31. Dezember - ein fester Tag, den das
  // Startdatum schon traegt.
  assert.equal(buildRRule({ freq: 'YEARLY', interval: 1, byday: [], until: '', lastDay: true }),
    'FREQ=YEARLY');
  assert.equal(buildRRule({ freq: 'MONTHLY', interval: 1, byday: [], until: '' }),
    'FREQ=MONTHLY', 'ohne die Wahl bleibt die Regel wie bisher');
});

test('gelesen wird nur -1; jeder andere BYMONTHDAY bleibt eine fremde Angabe', () => {
  assert.equal(parseRRule('FREQ=MONTHLY;BYMONTHDAY=-1').lastDay, true);
  assert.equal(parseRRule('FREQ=MONTHLY;BYMONTHDAY=15').lastDay, false,
    '"am 15." ist kein Haken in diesem Formular');
  assert.equal(parseRRule('FREQ=MONTHLY').lastDay, false);
});

test('eine fremde BYMONTHDAY-Regel kommt im Wortlaut zurueck, statt zu verschwinden', () => {
  // Die Wortlaut-Regel aus #756: was dieses Formular nicht liest, baut es auch
  // nicht neu - sonst wuerde aus "am 15." beim Aendern des Titels stillschweigend
  // "jeden Monat". Genau deshalb wird `15` nicht gelesen.
  const fremd = 'FREQ=MONTHLY;BYMONTHDAY=15';
  assert.notEqual(buildRRule(parseRRule(fremd)), fremd,
    'die Uebersetzung trifft die fremde Regel NICHT - damit greift der Wortlaut-Rueckgriff');

  // Die eigene dagegen uebersetzt sich stabil, sonst schluege der Vergleich bei
  // jedem Speichern an und die Regel gaelte faelschlich als veraendert.
  const eigen = 'FREQ=MONTHLY;BYMONTHDAY=-1';
  assert.equal(buildRRule(parseRRule(eigen)), eigen);
});

// --------------------------------------------------------
// Was der Review zu #960 gefunden hat
// --------------------------------------------------------

test('der Schalter traegt die Spur der geteilten Toggle-Komponente', () => {
  // `.toggle` blendet das native Kaestchen aus und zeigt Zustand UND Fokus
  // ausschliesslich ueber `.toggle__track`. Ohne die Spur stand da nur Text:
  // kein sichtbares An/Aus, kein Fokusring. Der Nachbar-Schalter in derselben
  // Datei hat sie, meiner nicht - eine Komponente halb zu benutzen ist
  // schlimmer, als sie gar nicht zu benutzen.
  const html = renderRRuleFields('probe', 'FREQ=MONTHLY', {});
  const block = html.slice(html.indexOf('probe-rrule-monthday'));
  const label = block.slice(0, block.indexOf('</label>'));
  assert.match(label, /class="toggle__track"/,
    'ohne Spur ist der Schalter zustands- und fokuslos');
  assert.match(label, /id="probe-rrule-last-day"/, 'Reichweite: es ist der richtige Schalter');
});

test('die Zusammenfassung nennt den letzten Tag', () => {
  // Sonst liest sich eine am 15. begonnene Serie wie "monatlich" und sieht aus
  // wie eine, die auch am 15. wiederkommt - waehrend ihr naechstes Vorkommen
  // der 28. Februar ist.
  const mit  = describeRRule('FREQ=MONTHLY;BYMONTHDAY=-1');
  const ohne = describeRRule('FREQ=MONTHLY');
  assert.notEqual(mit, ohne, 'die beiden Serien duerfen sich nicht gleich lesen');
  assert.match(mit, /\(/, 'die Angabe steht in der Klammer, wie die Wochentage bei WEEKLY');
  // Und nur dort, wo sie etwas bedeutet.
  assert.equal(describeRRule('FREQ=YEARLY;BYMONTHDAY=-1'), describeRRule('FREQ=YEARLY'));
});

test('der Server nimmt nur BYMONTHDAY=-1 an, nichts Weiteres (#960)', async () => {
  // WAS DIE ENGINE NICHT BEDIENT, DARF DER VALIDATOR NICHT ANNEHMEN. Die erste
  // Fassung liess den vollen RFC-Bereich durch: `FREQ=WEEKLY;BYMONTHDAY=15`
  // liess sich speichern und lief danach woechentlich, ohne den angenommenen
  // Monatstag je anzuwenden - eine Regel, die etwas anderes tut, als sie sagt.
  const { RRULE_RE } = await import('../server/middleware/validate.js');
  assert.ok(RRULE_RE.test('FREQ=MONTHLY;BYMONTHDAY=-1'), 'die eine unterstuetzte Form');
  assert.ok(RRULE_RE.test('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1;COUNT=5'));
  for (const wert of ['15', '31', '-2', '-31', '0', '1,15']) {
    assert.ok(!RRULE_RE.test(`FREQ=MONTHLY;BYMONTHDAY=${wert}`),
      `BYMONTHDAY=${wert} darf nicht angenommen werden - die Engine bedient es nicht`);
  }

  // UND NUR UNTER MONTHLY. Die erste Fassung dieses Tests prueste nur
  // MONTHLY-Regeln und war damit blind fuer den eigentlichen Fehler: die
  // optionale Gruppe stand NEBEN der Frequenz-Alternation, also nahm der
  // Ausdruck auch `FREQ=WEEKLY;BYMONTHDAY=-1` an - eine Regel, die parseRRule
  // danach ignoriert. Genau das "angenommen, aber nie beachtet", gegen das die
  // Verengung gebaut ist, nur eine Ebene hoeher.
  for (const freq of ['DAILY', 'WEEKLY', 'YEARLY']) {
    assert.ok(!RRULE_RE.test(`FREQ=${freq};BYMONTHDAY=-1`),
      `${freq} kennt die Angabe nicht und darf sie nicht annehmen`);
    // Gegenprobe, dass die Frequenz selbst weiterhin gilt.
    assert.ok(RRULE_RE.test(`FREQ=${freq}`), `${freq} bleibt gueltig`);
  }
  assert.ok(RRULE_RE.test('FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-1'),
    'unter MONTHLY bleibt sie erlaubt, auch neben BYDAY');
});

test('der Hinweis nennt in jeder Sprache dieselbe Richtung (#960)', async () => {
  // Die hindi-Fassung sagte "vor dem Startdatum" und beschrieb damit das
  // Gegenteil dessen, was passiert - unmittelbar bevor jemand ein Datum
  // aendernd speichert. Eine Uebersetzung, die in die falsche Richtung zeigt,
  // ist schlechter als gar keine.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../public/locales/', import.meta.url);
  const sprachen = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(sprachen.length >= 20, `Reichweite: ${sprachen.length} Sprachen gelesen`);

  // Geprueft wird die Sache, nicht der Wortlaut: die deutsche Referenz und die
  // englische Fassung nennen beide "ab"/"on or after". Ein Marker fuer die
  // Gegenrichtung darf in keiner Fassung stehen.
  //
  // BEIDE HINWEISE, nicht nur der erste: sie stehen an derselben Stelle im
  // Formular und unterscheiden sich nur nach Modul. Ein Guard, der einen von
  // ihnen nicht kennt, deckt die Haelfte der Nutzer nicht ab.
  const gegenrichtung = /\bbefore\b|\bvor dem\b|से पहले|antes de|avant la/i;
  for (const datei of sprachen) {
    const rrule = JSON.parse(readFileSync(new URL(datei, dir), 'utf8')).rrule;
    for (const key of ['lastDayOfMonthHint', 'lastDayOfMonthHintNext']) {
      const wert = rrule?.[key];
      assert.ok(wert, `${datei}: ${key} fehlt`);
      assert.ok(!gegenrichtung.test(wert), `${datei}/${key} zeigt in die falsche Richtung: ${wert}`);
    }
  }
});

test('Vorschau und Serienmarke sind in allen unterstützten Sprachen vollständig (#975)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../public/locales/', import.meta.url);
  const sprachen = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(sprachen.length, getSupportedLocales().length, 'der Test muss die vollständige unterstützte Sprachliste sehen');

  for (const datei of sprachen) {
    const locale = JSON.parse(readFileSync(new URL(datei, dir), 'utf8'));
    assert.ok(locale.calendar?.recurringEvent, `${datei}: calendar.recurringEvent fehlt`);
    assert.ok(locale.rrule?.lastDayOfMonthHintOverride, `${datei}: Override-Vorschau fehlt`);
    assert.ok(locale.rrule?.lastDayOfMonthHintSame, `${datei}: Bestätigung fehlt`);
    assert.deepEqual(
      [...locale.rrule.lastDayOfMonthHintOverride.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort(),
      ['firstDate', 'startDate'],
      `${datei}: die Datums-Platzhalter der Override-Vorschau stimmen nicht`
    );
    assert.deepEqual(
      [...locale.rrule.lastDayOfMonthHintSame.matchAll(/{{(\w+)}}/g)].map((m) => m[1]),
      ['date'],
      `${datei}: der Datums-Platzhalter der Bestätigung stimmt nicht`
    );
  }
});

test('der Monatsletzten-Hinweis sagt in jedem Modul, was dort passiert (#960)', () => {
  // Die beiden Module verarbeiten die Regel VERSCHIEDEN: der Kalender rechnet
  // sie vom Startdatum aus aus, die Aufgabe schreibt ein einzelnes Datum fort.
  // Ein gemeinsamer Hinweis verspricht deshalb der einen Haelfte der Nutzer das
  // Gegenteil dessen, was sie danach sehen - die Aufgabe bleibt am eingetragenen
  // Tag faellig, Liste und Countdown lesen `due_date` direkt.
  //
  // GEPRUEFT UEBER DIE AUFRUFER-SIGNATUR, nicht ueber den Prefix: dass die
  // Funktion zwei Texte KENNT, sagt nichts darueber, ob der Kalender die Option
  // auch setzt.
  const kalender = renderRRuleFields('event', 'FREQ=MONTHLY', { allowCount: true, expandsFromStart: true });
  const aufgabe  = renderRRuleFields('task', 'FREQ=MONTHLY', { allowFromCompletion: true });

  // MIT DEN SPITZEN KLAMMERN, sonst prueft der Test sich selbst weg: unter dem
  // Loader liefert `t()` den Schluessel, und `rrule.lastDayOfMonthHint` ist ein
  // Praefix von `rrule.lastDayOfMonthHintNext` - ein blosses includes() waere
  // fuer beide wahr und der Test immer gruen.
  const KAL  = '>rrule.lastDayOfMonthHint<';
  const AUFG = '>rrule.lastDayOfMonthHintNext<';

  assert.ok(kalender.includes(KAL), 'der Kalender rechnet vom Startdatum aus und sagt das auch');
  assert.ok(!kalender.includes(AUFG), 'und nicht beides');
  assert.ok(aufgabe.includes(AUFG), 'die Aufgabe verspricht keinen Termin, den sie nicht liefert');
  assert.ok(!aufgabe.includes(KAL), 'und nicht beides');
});

test('der Kalender nennt den eingegebenen Tag und den ersten echten Monatsletzten (#975)', () => {
  assert.equal(
    monthEndHintText('2026-09-15', { expandsFromStart: true }),
    'rrule.lastDayOfMonthHintOverride{"startDate":"2026-09-15","firstDate":"2026-09-30"}',
    'der Hinweis muss seine Daten vom expliziten Kalenderwert ableiten'
  );

  const html = renderRRuleFields('event', 'FREQ=MONTHLY;BYMONTHDAY=-1', {
    allowCount: true,
    expandsFromStart: true,
    startDate: '2026-09-15',
  });
  assert.match(html, /rrule\.lastDayOfMonthHintOverride/, 'die Vorschau muss schon beim Öffnen stimmen');
  assert.match(html, /2026-09-15/, 'das eingegebene Datum fehlt');
  assert.match(html, /2026-09-30/, 'der erste tatsächliche Termin fehlt');
});

test('ein bereits passender Monatsletzter wird neutral bestätigt (#975)', () => {
  assert.equal(
    monthEndHintText('2028-02-29', { expandsFromStart: true }),
    'rrule.lastDayOfMonthHintSame{"date":"2028-02-29"}',
    'Schaltjahre müssen über echte Kalendermathematik laufen'
  );
  assert.equal(
    monthEndHintText('2026-02-28', { expandsFromStart: true }),
    'rrule.lastDayOfMonthHintSame{"date":"2026-02-28"}'
  );
});

test('ohne gültiges Kalenderdatum bleibt der ehrliche generische Hinweis stehen (#975)', () => {
  assert.equal(monthEndHintText('', { expandsFromStart: true }), 'rrule.lastDayOfMonthHint');
  assert.equal(monthEndHintText('2026-02-31', { expandsFromStart: true }), 'rrule.lastDayOfMonthHint');
  assert.equal(
    monthEndHintText('2026-09-15', { expandsFromStart: false }),
    'rrule.lastDayOfMonthHintNext',
    'Aufgaben behalten ihre abschlussgetriebene Semantik'
  );
});

test('eine komplexere importierte Monatsregel bekommt keine erfundene konkrete Vorschau (#975)', async () => {
  const { seriesStartFor, hasAnyOccurrence } = await import('../server/services/recurrence.js');
  const filteredRule = 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-1';

  assert.equal(seriesStartFor('2026-09-15', filteredRule), '2026-11-30',
    'die Referenzrechnung muss belegen, dass der 30. September kein Vorkommen ist');
  assert.equal(
    monthEndHintText('2026-09-15', { expandsFromStart: true, rule: filteredRule }),
    'rrule.lastDayOfMonthHint',
    'bei zusätzlichen Filtern ist der generische Hinweis ehrlicher als ein falsches Datum'
  );

  const endedRule = 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260920T235959Z';
  assert.equal(hasAnyOccurrence('2026-09-15', endedRule), false,
    'die Referenzrechnung muss die vor dem ersten Monatsletzten beendete Serie als leer erkennen');
  assert.equal(
    monthEndHintText('2026-09-15', { expandsFromStart: true, rule: endedRule }),
    'rrule.lastDayOfMonthHint',
    'eine beendete Regel darf keinen nicht existierenden ersten Termin versprechen'
  );
});

test('der Kalender kann die Monatsletzten-Vorschau nach einer Datumsänderung aktualisieren (#975)', () => {
  const root = eventRoot(renderRRuleFields('event', 'FREQ=MONTHLY;BYMONTHDAY=-1', {
    expandsFromStart: true,
    startDate: '2026-09-15',
  }));
  let startDate = '2026-09-15';
  const binding = bindRRuleEvents(root, 'event', {
    expandsFromStart: true,
    getStartDate: () => startDate,
  });

  const hint = root.get('#event-rrule-monthday-hint');
  binding.refreshMonthdayHint();
  assert.match(hint.textContent, /2026-09-30/);

  startDate = '2026-10-31';
  binding.refreshMonthdayHint();
  assert.equal(hint.textContent, 'rrule.lastDayOfMonthHintSame{"date":"2026-10-31"}');
});

test('die Live-Vorschau erfindet auch nach Datumsänderung keinen Termin für eine komplexe Regel (#975)', () => {
  const rule = 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=-1';
  const root = eventRoot(renderRRuleFields('event', rule, {
    expandsFromStart: true,
    startDate: '2026-09-15',
  }));
  let startDate = '2026-09-15';
  const binding = bindRRuleEvents(root, 'event', {
    expandsFromStart: true,
    getStartDate: () => startDate,
  });

  startDate = '2026-10-20';
  binding.refreshMonthdayHint();
  assert.equal(root.get('#event-rrule-monthday-hint').textContent, 'rrule.lastDayOfMonthHint');
});

test('ein live gesetztes Serienende vor dem ersten Monatsletzten nimmt das Versprechen zurück (#975)', () => {
  const root = eventRoot(renderRRuleFields('event', null, {
    allowCount: true,
    expandsFromStart: true,
    startDate: '2026-09-15',
  }));
  root.get('#event-rrule-freq').value = 'MONTHLY';
  root.get('#event-rrule-last-day').checked = true;

  bindRRuleEvents(root, 'event', {
    expandsFromStart: true,
    getStartDate: () => '2026-09-15',
  });
  assert.match(root.get('#event-rrule-monthday-hint').textContent, /2026-09-30/,
    'ohne Ende ist der konkrete erste Termin belegbar');

  root.get('#event-rrule-end').value = 'until';
  root.get('#event-rrule-until').value = '2026-09-20';
  root.get('#event-rrule-end').fire('change');
  assert.equal(root.get('#event-rrule-monthday-hint').textContent, 'rrule.lastDayOfMonthHint',
    'die Änderung des Endes muss den nun unmöglichen Termin sofort zurücknehmen');
});

test('die konkrete Vorschau wird erst mit der Monatsletzten-Wahl sichtbar und vorgelesen (#975)', () => {
  const unchecked = renderRRuleFields('event', 'FREQ=MONTHLY', {
    expandsFromStart: true,
    startDate: '2026-09-15',
  });
  assert.match(unchecked, /id="event-rrule-monthday-hint"[^>]*hidden/,
    'ohne gesetzte Wahl darf die Vorschau keine noch nicht getroffene Entscheidung behaupten');
  assert.doesNotMatch(unchecked, /id="event-rrule-last-day"[^>]*aria-describedby/,
    'eine verborgene direkt referenzierte Beschreibung würde trotzdem vorgelesen');

  const root = eventRoot(unchecked);
  const checkbox = root.get('#event-rrule-last-day');
  const hint = root.get('#event-rrule-monthday-hint');
  bindRRuleEvents(root, 'event', {
    expandsFromStart: true,
    getStartDate: () => '2026-09-15',
  });

  checkbox.checked = true;
  checkbox.fire('change');
  assert.equal(hint.hidden, false);
  assert.equal(checkbox.getAttribute('aria-describedby'), 'event-rrule-monthday-hint');

  checkbox.checked = false;
  checkbox.fire('change');
  assert.equal(hint.hidden, true);
  assert.equal(checkbox.getAttribute('aria-describedby'), null);
});

test('jeder Aufrufer des Wiederholungsformulars beantwortet die Expansionsfrage (#960)', async () => {
  // DER TEST OBEN BEWEIST NICHTS UEBER DIE AUFRUFER. Er uebergibt die Option
  // selbst, also bleibt er gruen, auch wenn calendar.js sie gar nicht setzt -
  // gemessen, nicht vermutet: das Entfernen im Aufrufer liess ihn durchgehen.
  //
  // Geprueft wird deshalb eine REGEL, keine Liste: wer das Formular einbindet,
  // muss `expandsFromStart` NENNEN. Rechnet das Modul die Regel vom Startdatum
  // aus (Kalender), steht dort true; schreibt es ein einzelnes Datum fort
  // (Aufgaben), false. Ein neues Modul kann die Frage damit nicht stillschweigend
  // ueberspringen und den falschen Hinweis erben - es muss sie beantworten.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../public/pages/', import.meta.url);

  const aufrufe = [];
  for (const datei of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const quelle = readFileSync(new URL(datei, dir), 'utf8');
    for (const m of quelle.matchAll(/renderRRuleFields\s*\(/g)) {
      // Von der Klammer an so weit lesen, wie der Aufruf reicht - die Optionen
      // stehen im letzten Argument und koennen ueber Zeilen laufen.
      let tiefe = 0, i = m.index + m[0].length - 1;
      for (; i < quelle.length; i++) {
        if (quelle[i] === '(') tiefe++;
        else if (quelle[i] === ')' && --tiefe === 0) break;
      }
      aufrufe.push({ datei, text: quelle.slice(m.index, i + 1) });
    }
  }

  assert.ok(aufrufe.length >= 2, `Reichweite: ${aufrufe.length} Aufrufe gefunden`);
  for (const { datei, text } of aufrufe) {
    assert.match(text, /expandsFromStart\s*:\s*(true|false)/,
      `${datei} bindet das Wiederholungsformular ein, ohne zu sagen, ob es die Regel vom Startdatum aus ausrechnet - der Monatsletzten-Hinweis waere dort geraten`);
  }

  // Und die eine Antwort, die aus der Sache folgt: der Kalender expandiert.
  const kal = aufrufe.find((a) => a.datei === 'calendar.js');
  assert.ok(kal, 'calendar.js bindet das Formular ein');
  assert.match(kal.text, /expandsFromStart\s*:\s*true/,
    'der Kalender expandiert die Serie ueber expandRecurringEvents und zeigt den ersten Monatsletzten');
  assert.match(kal.text, /\bstartDate\s*(?::|[,}])/,
    'das Startdatum muss als expliziter Wert aus dem Kalender kommen, nicht aus einem DOM-Selektor im Widget');

  const kalenderQuelle = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const bindStart = kalenderQuelle.indexOf("bindRRuleEvents(panel, 'event', {");
  const bindEnd = kalenderQuelle.indexOf('});', bindStart);
  const bindCall = kalenderQuelle.slice(bindStart, bindEnd + 3);
  assert.match(bindCall, /getStartDate\s*:/,
    'der Kalender muss auch spätere Datumsänderungen ausdrücklich an das Widget liefern');
  assert.match(bindCall, /#modal-allday[^]*#modal-allday-start[^]*#modal-start-date/,
    'das vom Kalender gelieferte Datum muss seinem aktiven Ganztags- oder Zeitfeld folgen');
  assert.doesNotMatch(
    readFileSync(new URL('../public/rrule-ui.js', import.meta.url), 'utf8'),
    /modal-(?:allday-)?start-date|modal-allday-start/,
    'das geteilte Widget darf keine privaten Feld-IDs des Kalenders erraten'
  );
});
