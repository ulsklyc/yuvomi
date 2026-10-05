/**
 * Tests: Zurueck schliesst, was oben liegt (#871)
 * Modul: /public/utils/overlay-history.js
 *
 * WARUM VERHALTENSTESTS UND KEIN QUELLTEXT-GUARD: die Wege aus einem Dialog
 * (Zurueck-Geste, X, abgelehntes Verwerfen, Navigation, Sitzungsende)
 * unterscheiden sich nicht im Code, sondern in der REIHENFOLGE, in der
 * History-Eintraege entstehen und verschwinden. Genau dort steckt der Fehler,
 * den man einbaut. Ein Test auf „ruft `pushState` auf" waere gruen und blind.
 *
 * DIE ATTRAPPE FUEHRT EINEN ECHTEN STAPEL und stellt `popstate` so zu, wie der
 * Browser es tut: `back()` wirkt NICHT synchron. Das ist keine Feinheit - an
 * dieser Annahme scheiterte die erste Fassung des Moduls gleich viermal.
 *
 * `depth` wird deshalb ueberall mitgeprueft, wo ein Marker entstehen oder
 * verschwinden soll. Eine fruehere Fassung dieser Tests prueste nur, dass NICHT
 * navigiert wurde - und blieb gruen, waehrend ein toter Eintrag liegenblieb,
 * der jede folgende Geste eine Runde kostete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------
// History-Attrappe
// --------------------------------------------------------

function makeHistory({ lateTraversal = false } = {}) {
  /* Die Attrappe fuehrt eine ADRESSE je Eintrag, nicht nur einen Zustand.
   *
   * Eine fruehere Fassung hielt `location.href` konstant, und genau das machte
   * sie blind: eine geschluckte Zweitgeste bewegt den Browser trotzdem, die
   * Adresse zeigte danach eine andere Seite als der Bildschirm - und kein Test
   * konnte es sehen. `forward()` gehoert aus demselben Grund dazu. */
  const entries = [{ state: { path: '/dashboard' }, href: '/dashboard' }];
  let index = 0;
  // Was der Router tun WUERDE, wenn die Geste nicht fuer einen Dialog war.
  const navigations = [];
  let onPop = null;

  const emit = () => onPop?.(entries[index].state);

  return {
    get state() { return entries[index].state; },
    get depth() { return index; },
    get href() { return entries[index].href; },
    get forwardLength() { return entries.length - 1 - index; },
    pushState(state, _title, href) {
      entries.splice(index + 1);
      entries.push({ state, href: href ?? entries[index].href });
      index = entries.length - 1;
    },
    replaceState(state, _title, href) {
      entries[index] = { state, href: href ?? entries[index].href };
    },
    back() {
      /* `lateTraversal`: SO WIE CHROME ES TUT (gemessen am 04.10.2026 an der
       * Leseansicht des Kalenders). Das Ziel eines `back()` steht beim AUFRUF
       * fest, und `popstate` kommt erst Millisekunden spaeter - ein
       * `pushState` dazwischen haengt seinen Eintrag an und aendert am Ziel
       * nichts mehr. Die Microtask-Fassung darunter stellt zu, bevor
       * irgendein spaeterer Tick etwas dazwischenlegen kann, und war damit
       * blind fuer genau diese Verschraenkung. */
      if (lateTraversal) {
        const target = index - 1;
        setTimeout(() => {
          if (target < 0) return;
          index = target;
          emit();
        }, 0);
        return;
      }
      // Der Browser feuert `popstate` NICHT synchron. Ein Test, der das
      // annimmt, verdeckt genau die Verschraenkung, die hier gefaehrlich ist.
      queueMicrotask(() => {
        if (index === 0) return;
        index -= 1;
        emit();
      });
    },
    forward() {
      queueMicrotask(() => {
        if (index >= entries.length - 1) return;
        index += 1;
        emit();
      });
    },
    setPopHandler(fn) { onPop = fn; },
    navigations,
  };
}

let instanceSeq = 0;
let observers = [];

/**
 * Frische Modulinstanz je Test - das Register ist Modulzustand, und ein Test,
 * der den eines anderen erbt, misst nicht mehr, was er behauptet.
 */
async function freshModule(historyOptions) {
  const history = makeHistory(historyOptions);
  observers = [];
  globalThis.history = history;
  globalThis.location = { get href() { return history.href; } };
  globalThis.document = {};
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const mod = await import(`../public/utils/overlay-history.js?instance=${++instanceSeq}`);
  history.setPopHandler(async (state) => {
    const handled = await mod.handleBackNavigation();
    if (!handled) history.navigations.push(state?.path ?? null);
  });
  return { ...mod, history };
}

// Der Abgleich laeuft in einem Microtask, `back()` ebenso, und
// `handleBackNavigation` ist async - ein Makrotask laesst alles davon durch.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// --------------------------------------------------------
// Der gemeldete Fall
// --------------------------------------------------------

test('die Zurueck-Geste schliesst den Dialog, statt die Seite zu wechseln', async () => {
  const { pushOverlay, history } = await freshModule();

  let closed = 0;
  pushOverlay(() => { closed += 1; });
  await settle();
  assert.equal(history.depth, 1, 'der offene Dialog haelt einen History-Eintrag');

  history.back();
  await settle();

  assert.equal(closed, 1, 'der Dialog wurde geschlossen');
  assert.deepEqual(history.navigations, [],
    'der Router hat NICHT navigiert - genau das war der gemeldete Fehler (#871)');
  assert.equal(history.depth, 0, 'der Marker ist verbraucht');
});

test('eine zweite Zurueck-Geste wechselt dann die Seite', async () => {
  const { pushOverlay, history } = await freshModule();

  // Erst eine echte Seite, sonst hat der Stapel unter dem Dialog gar keinen
  // Vorgaenger - wie im Browser, der die App dann verlaesst.
  history.pushState({ path: '/calendar' });
  pushOverlay(() => {});
  await settle();

  history.back();
  await settle();
  assert.deepEqual(history.navigations, [], 'die erste Geste gehoert dem Dialog');

  history.back();
  await settle();
  assert.deepEqual(history.navigations, ['/dashboard'],
    'ohne offenen Dialog gehoert die Geste wieder dem Router');
});

// --------------------------------------------------------
// Ein Marker fuer alle - die Fehlerklasse der ersten Fassung
// --------------------------------------------------------

test('zwei gleichzeitig offene Overlays halten EINEN Eintrag, nicht zwei', async () => {
  const { pushOverlay, history } = await freshModule();
  pushOverlay(() => {});
  pushOverlay(() => {});
  await settle();
  assert.equal(history.depth, 1,
    'ein Marker je Overlay hiesse: jedes verschachtelte Overlay kostet spaeter eine '
    + 'eigene Zurueck-Geste, auch wenn es laengst zu ist');
});

test('zwei Overlays, die im selben Tick schliessen, lassen keinen Eintrag liegen', async () => {
  // DER FEHLER DER ERSTEN FASSUNG, wortwoertlich: sie las `history.state`, um
  // zu entscheiden, ob sie „obenauf" liegt. `history.back()` wirkt aber erst
  // spaeter, also sah das zweite Overlay den alten Zustand, hielt sich fuer
  // nicht-obenauf und gab seinen Marker nie zurueck.
  const { pushOverlay, dropOverlay, history } = await freshModule();

  const outer = pushOverlay(() => {});
  const inner = pushOverlay(() => {});
  await settle();

  dropOverlay(inner);
  dropOverlay(outer);
  await settle();

  assert.equal(history.depth, 0, 'kein toter Eintrag - genau hier lag der Fehler');
  assert.deepEqual(history.navigations, [], 'unser eigenes back() ist keine Nutzergeste');
});

test('ein Overlay, das ein anderes mitreisst, laesst keinen Eintrag liegen', async () => {
  // Die Belegvorschau liegt im geteilten Modal. Verknuepft man ein Dokument,
  // schliesst das Modal - und nimmt die Vorschau mit. In der ersten Fassung
  // blieb der Marker des Modals als toter Eintrag zurueck.
  const { pushOverlay, dropOverlay, history } = await freshModule();

  const modal = pushOverlay(() => {});
  const preview = pushOverlay(() => {});
  await settle();

  dropOverlay(modal);    // das Modal geht zuerst - LIFO verletzt
  dropOverlay(preview);  // und reisst die Vorschau mit
  await settle();

  assert.equal(history.depth, 0);
  assert.deepEqual(history.navigations, []);
});

test('Blatt zu und Dialog auf im selben Tick fassen die History gar nicht an', async () => {
  // Hilfe, Aenderungsverlauf und die Suche gehen alle aus dem Mehr-Blatt
  // heraus auf: das Blatt schliesst, der Dialog oeffnet, beides synchron. Die
  // erste Fassung gab hier einen Marker zurueck und legte sofort einen neuen -
  // ein `back()` gegen ein `pushState` im selben Tick.
  const { pushOverlay, dropOverlay, history } = await freshModule();

  const sheet = pushOverlay(() => {});
  await settle();
  assert.equal(history.depth, 1);

  let dialogClosed = 0;
  dropOverlay(sheet);
  pushOverlay(() => { dialogClosed += 1; });
  await settle();

  assert.equal(history.depth, 1, 'netto hat sich nichts geaendert, also passiert nichts');

  history.back();
  await settle();
  assert.equal(dialogClosed, 1, 'die Geste schliesst den Dialog');
  assert.deepEqual(history.navigations, [],
    'und nicht einen toten Marker, der die Geste verschluckt');
});

/* DER FALL DANEBEN: NICHT IM SELBEN TICK, SONDERN EINEN SPAETER.
 *
 * Die Leseansicht eines Termins ist am Desktop ein Popover mit eigenem
 * Registereintrag. "Bearbeiten" schliesst es und oeffnet das Formular erst,
 * wenn die Erinnerungen da sind; "Loeschen" wartet das Schliessen ab und fragt
 * dann nach der Reichweite der Serie. Zwischen Abmelden und Anmelden liegt
 * also mindestens ein Tick - der Abgleich hat sein `back()` schon abgeschickt,
 * und es ist noch nicht angekommen.
 *
 * Im Browser gemessen (Chrome, Tagesansicht, 18 von 18 Wegen): der neue Marker
 * entsteht, das ausstehende `back()` traegt den Browser unter ihn, und wer den
 * Dialog danach schliesst - "Nur diesen Termin", Abbrechen, Escape -, landet
 * mit der Adresse auf der Seite DAVOR, waehrend der Kalender im Bild bleibt. */
const lateSettle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('ein Overlay, das einen Tick nach dem vorigen aufgeht, legt seinen Marker nicht in das ausstehende back()', async () => {
  const { pushOverlay, dropOverlay, history } = await freshModule({ lateTraversal: true });
  history.pushState({ path: '/calendar' }, '', '/calendar');

  const popover = pushOverlay(() => {});
  await lateSettle();
  assert.equal(history.depth, 2, 'Vorbedingung: der Marker liegt ueber /calendar');

  dropOverlay(popover);
  // Ein Tick: der Abgleich hat sein back() abgeschickt, angekommen ist es nicht.
  await Promise.resolve();
  await Promise.resolve();
  let closed = 0;
  const form = pushOverlay(() => { closed += 1; });
  await lateSettle();

  assert.equal(history.state?.overlay, true,
    'der Browser steht AUF dem Marker - sonst gibt das Schliessen einen Eintrag zurueck, den es nie gab');
  assert.equal(history.depth, 2, 'ein Marker ueber /calendar, nicht darunter und nicht zwei');

  dropOverlay(form);
  await lateSettle();
  assert.equal(history.href, '/calendar', 'nach dem Schliessen steht die Adresse der Seite, nicht die der Seite davor');
  assert.equal(history.depth, 1);
  assert.equal(closed, 0);
  assert.deepEqual(history.navigations, [], 'und der Router hat nichts davon als Geste gelesen');
});

test('die Zurueck-Geste ueber dem nachgerueckten Overlay schliesst es und bleibt auf der Seite', async () => {
  const { pushOverlay, dropOverlay, history } = await freshModule({ lateTraversal: true });
  history.pushState({ path: '/calendar' }, '', '/calendar');

  const popover = pushOverlay(() => {});
  await lateSettle();
  dropOverlay(popover);
  await Promise.resolve();
  await Promise.resolve();
  let closed = 0;
  pushOverlay(() => { closed += 1; });
  await lateSettle();

  history.back();
  await lateSettle();
  assert.equal(closed, 1, 'die Geste gehoert dem Dialog');
  assert.equal(history.href, '/calendar', 'und fuehrt nicht aus der Seite heraus');
  assert.deepEqual(history.navigations, []);
});

test('ein ausstehendes back() haelt die Wartenden nicht fest, wenn nichts nachrueckt', async () => {
  // Der Abgleich laesst die History in Ruhe, solange das eigene back()
  // unterwegs ist. Rueckt nichts nach, muss `whenHistorySettled` trotzdem mit
  // dessen Ankunft aufloesen - nicht erst an seiner Frist.
  const { pushOverlay, dropOverlay, whenHistorySettled, history } = await freshModule({ lateTraversal: true });
  history.pushState({ path: '/calendar' }, '', '/calendar');
  const token = pushOverlay(() => {});
  await lateSettle();
  dropOverlay(token);
  const started = Date.now();
  await whenHistorySettled();
  assert.ok(Date.now() - started < 500, 'aufgeloest mit dem popstate, nicht mit der Frist von einer Sekunde');
  assert.equal(history.href, '/calendar');
  assert.equal(history.depth, 1);
});

// --------------------------------------------------------
// Die einzelnen Wege hinaus
// --------------------------------------------------------

test('das X gibt seinen Marker zurueck - die naechste Geste braucht keinen Leerlauf', async () => {
  const { pushOverlay, dropOverlay, history } = await freshModule();

  const token = pushOverlay(() => { throw new Error('darf nicht aufgerufen werden'); });
  await settle();
  dropOverlay(token);
  await settle();

  assert.equal(history.depth, 0, 'der Marker ist zurueckgegeben');
  assert.deepEqual(history.navigations, [],
    'das eigene back() darf nicht als Nutzergeste durchgehen - sonst navigiert '
    + 'der Router beim Schliessen per X');
});

test('das obere Overlay geht zuerst zu, das untere bleibt', async () => {
  const { pushOverlay, history } = await freshModule();

  const order = [];
  pushOverlay(() => { order.push('unten'); });
  pushOverlay(() => { order.push('oben'); });
  await settle();

  history.back();
  await settle();
  assert.deepEqual(order, ['oben'], 'die Geste meint das oberste Overlay');
  assert.equal(history.depth, 1, 'fuer das untere liegt der Marker wieder da');

  history.back();
  await settle();
  assert.deepEqual(order, ['oben', 'unten']);
  assert.deepEqual(history.navigations, [], 'erst die dritte Geste gehoert dem Router');
  assert.equal(history.depth, 0);
});

test('ein abgelehntes Schliessen behaelt seinen Marker', async () => {
  // Ungespeicherte Aenderungen, „nicht verwerfen": der Dialog bleibt offen -
  // und muss die naechste Geste wieder abfangen, statt sie aus der Seite
  // hinauslaufen zu lassen.
  const { pushOverlay, history } = await freshModule();

  let allow = false;
  pushOverlay(() => (allow ? undefined : false));
  await settle();

  history.back();
  await settle();
  assert.equal(history.depth, 1, 'der Marker liegt wieder da');
  assert.deepEqual(history.navigations, [], 'die Geste ist verbraucht, nicht weitergereicht');

  allow = true;
  history.back();
  await settle();
  assert.equal(history.depth, 0);
  assert.deepEqual(history.navigations, [], 'auch der zweite Anlauf bleibt beim Dialog');
});

test('die Zurueck-Geste fragt ohne Zwang - der Dirty-Guard darf greifen', async () => {
  const { pushOverlay, history } = await freshModule();
  let seen = null;
  pushOverlay((opts) => { seen = opts; });
  await settle();

  history.back();
  await settle();
  assert.deepEqual(seen, { force: false });
});

// --------------------------------------------------------
// Navigation und Sitzungsende
// --------------------------------------------------------

test('eine Navigation schliesst offene Overlays und erbt ihren Eintrag', async () => {
  // Ein Dialog ueberlebt keine Navigation - er stuende sonst ueber der
  // falschen Seite, also wieder #871.
  const { pushOverlay, consumeOverlayMarker, history } = await freshModule();

  let forced = null;
  pushOverlay((opts) => { forced = opts; });
  await settle();

  assert.equal(consumeOverlayMarker(), true, 'der aktuelle Eintrag war unser Platzhalter');
  assert.deepEqual(forced, { force: true },
    'wer navigiert, hat die Frage nach ungespeicherten Aenderungen beantwortet');

  // Der Router setzt die neue Seite an DIE STELLE des Markers.
  history.replaceState({ path: '/notes' });

  history.back();
  await settle();
  assert.deepEqual(history.navigations, ['/dashboard'],
    'EINE Geste fuehrt zurueck auf die Ausgangsseite, nicht auf einen leeren Zwischenschritt');
});

test('ohne offenes Overlay meldet die Navigation keinen Marker', async () => {
  const { consumeOverlayMarker } = await freshModule();
  assert.equal(consumeOverlayMarker(), false,
    'sonst ersetzte eine Navigation den Eintrag der Seite, von der sie kommt');
});

test('ein hakendes Overlay haelt die Navigation nicht auf', async () => {
  const { pushOverlay, consumeOverlayMarker } = await freshModule();
  pushOverlay(() => { throw new Error('kaputt'); });
  await settle();
  assert.doesNotThrow(() => consumeOverlayMarker());
});

test('das Sitzungsende schliesst, was noch steht - es vergisst es nicht nur', async () => {
  // Ein geteiltes Modal haengt an `document.body` und ueberlebt das Abraeumen
  // der App-Shell. Ein bloss geleertes Register liesse es ueber der
  // Anmeldeseite stehen, und die Zurueck-Geste faende nichts mehr zu
  // schliessen - sie navigierte darunter weg.
  const { pushOverlay, closeAllOverlays, hasOpenOverlay } = await freshModule();

  let closedWith = null;
  pushOverlay((opts) => { closedWith = opts; });
  await settle();

  closeAllOverlays();
  assert.deepEqual(closedWith, { force: true },
    'beim Abmelden fragt niemand mehr nach ungespeicherten Aenderungen');
  assert.equal(hasOpenOverlay(), false);
});

test('nach einem Sitzungsende faengt die Geste wieder Dialoge ab', async () => {
  // Die erste Fassung merkte sich im Modal-System ein Token ueber das
  // Sitzungsende hinaus und legte danach nie wieder einen Marker an - die
  // Zurueck-Geste waere ab dem naechsten Login still wieder kaputt gewesen.
  const { pushOverlay, closeAllOverlays, history } = await freshModule();

  pushOverlay(() => {});
  await settle();
  closeAllOverlays();

  let closed = 0;
  pushOverlay(() => { closed += 1; });
  await settle();

  history.back();
  await settle();
  assert.equal(closed, 1);
  assert.deepEqual(history.navigations, []);
});

// --------------------------------------------------------
// attachOverlay
// --------------------------------------------------------

test('ein Overlay meldet sich ab, wenn sein Knoten aus dem Dokument faellt', async () => {
  // `attachOverlay` faengt nicht das Schliessen ab, sondern das Verschwinden -
  // der Grund: die modul-eigenen Overlays haben drei bis fuenf Schliesswege,
  // die alle einzeln `remove()` rufen.
  const { attachOverlay, history } = await freshModule();

  const el = { isConnected: true };
  attachOverlay(el, () => { throw new Error('darf nicht aufgerufen werden'); });
  await settle();
  assert.equal(history.depth, 1);

  // Irgendeiner der Schliesswege hat den Knoten entfernt.
  el.isConnected = false;
  observers[0].cb();
  await settle();

  assert.equal(history.depth, 0, 'der Marker ist zurueckgegeben');
  assert.equal(observers[0].disconnected, true, 'der Beobachter laeuft nicht weiter');
  assert.deepEqual(history.navigations, []);
});

test('die Zurueck-Geste schliesst ein angehaengtes Overlay ueber seinen Weg', async () => {
  const { attachOverlay, history } = await freshModule();

  let closed = 0;
  const el = { isConnected: true };
  attachOverlay(el, () => { closed += 1; el.isConnected = false; });
  await settle();

  history.back();
  await settle();
  assert.equal(closed, 1);
  assert.equal(history.depth, 0);
  assert.deepEqual(history.navigations, []);
});

test('eine zweite Geste waehrend einer laufenden Rueckfrage geht nicht an den Router', async () => {
  // `closeModal()` fragt bei ungespeicherten Aenderungen zurueck und wartet
  // auf den Menschen - beliebig lange. In diesem Fenster ist der Marker schon
  // verbraucht und das Register schon leer. Ohne Sperre faende eine zweite
  // Wischgeste „nichts offen" und liesse den Router hinter dem sichtbar
  // offenen Verwerfen-Dialog wegnavigieren: der Zustand aus #871, nur in
  // diesem Zeitfenster.
  const { pushOverlay, history } = await freshModule();

  // Eine echte Seite unter dem Dialog - sonst hat die zweite Geste im Stapel
  // gar kein Ziel, und der Test bliebe gruen, auch ohne Sperre. (Gemessen:
  // ohne diese Zeile faellt die Gegenprobe nicht.)
  history.pushState({ path: '/calendar' });

  let antwort;
  const gefragt = new Promise((resolve) => { antwort = resolve; });
  pushOverlay(() => gefragt);
  await settle();

  history.back();          // erste Geste: die Rueckfrage geht auf
  await settle();
  assert.deepEqual(history.navigations, []);

  history.back();          // zweite Geste, waehrend noch gefragt wird
  await settle();
  assert.deepEqual(history.navigations, [],
    'die zweite Geste gehoert dem Dialog, der gerade fragt - nicht dem Router');

  antwort(undefined);      // „verwerfen"
  await settle();
  assert.deepEqual(history.navigations, []);
});

test('ein abgelehntes Schliessen bekommt seinen Marker auch nach einer zweiten Geste', async () => {
  const { pushOverlay, history } = await freshModule();
  history.pushState({ path: '/calendar' });

  let antwort;
  const gefragt = new Promise((resolve) => { antwort = resolve; });
  pushOverlay(() => gefragt);
  await settle();

  history.back();
  await settle();
  history.back();
  await settle();

  antwort(false);          // „nicht verwerfen" - der Dialog bleibt offen
  await settle();
  // Die Aussage ist der MARKER, nicht eine bestimmte Tiefe: der Dialog steht
  // noch, also muss die naechste Geste wieder bei ihm ankommen.
  assert.equal(history.state?.overlay, true, 'der Marker liegt wieder da');
  assert.equal(history.href, '/dashboard',
    'und auf der Adresse, auf der der Dialog steht - die zurueckgenommene '
    + 'Zweitgeste darf sie nicht verschoben haben');
  assert.deepEqual(history.navigations, []);
});

test('die zurueckgenommene Zweitgeste laesst die Adresse stehen', async () => {
  // Das Schlucken allein reicht nicht: der Browser IST zurueckgegangen, und
  // ein blosses „nicht rendern" liesse die Adresse auf der vorigen Seite
  // stehen, waehrend der Dialog der aktuellen zu sehen ist. Der naechste
  // `pushState` haette dann obendrein den echten Vorwaertszweig abgeschnitten.
  const { pushOverlay, history } = await freshModule();
  history.pushState({ path: '/calendar' }, '', '/calendar');

  let antwort;
  const gefragt = new Promise((resolve) => { antwort = resolve; });
  pushOverlay(() => gefragt);
  await settle();
  const adresseMitDialog = history.href;

  history.back();          // erste Geste: die Rueckfrage geht auf
  await settle();
  history.back();          // zweite Geste, waehrend noch gefragt wird
  await settle();

  assert.equal(history.href, adresseMitDialog,
    'die Adresse ist mitgewandert - der Bildschirm zeigt eine andere Seite als die Leiste');

  antwort(undefined);
  await settle();
  assert.deepEqual(history.navigations, []);
});

test('das Sitzungsende laesst seinen Marker fuer die Anmeldeseite liegen', async () => {
  // Auf `closeAllOverlays()` folgt `navigate('/login')`, und die soll den
  // Marker ERBEN (`replaceState`). Wer ihn schon verbraucht, laesst die
  // Navigation einen Eintrag daruebersetzen: Zurueck von der Anmeldeseite
  // landet dann auf dem toten Marker der geschuetzten Route, wird wieder nach
  // `/login` umgeleitet - und die Geste ist verpufft, wiederholbar.
  const { pushOverlay, closeAllOverlays, consumeOverlayMarker } = await freshModule();

  pushOverlay(() => {});
  await settle();

  closeAllOverlays();
  assert.equal(consumeOverlayMarker(), true,
    'die folgende Navigation findet keinen Marker zum Erben');
});

test('ein herausgenommener Eintrag gilt nicht mehr als angemeldet', async () => {
  // `handleBackNavigation()` nimmt den Eintrag aus dem Register, BEVOR es
  // schliessen laesst. Wer danach nur fragt, ob er einen Token HAT, haelt sich
  // fuer angemeldet und ist es nicht - genau so verlor ein wieder
  // hervorgeholtes Formular (Bestaetigungsdialog darueber, Zurueck-Geste)
  // seinen Anspruch auf die naechste Geste, und der Router navigierte dahinter
  // weg. Das Modal-System fragt deshalb `isOverlayOpen(token)`.
  const { pushOverlay, isOverlayOpen, history } = await freshModule();

  let gesehen = null;
  const token = pushOverlay(() => { gesehen = isOverlayOpen(token); });
  await settle();
  assert.equal(isOverlayOpen(token), true, 'vor der Geste ist er angemeldet');

  history.back();
  await settle();
  assert.equal(gesehen, false,
    'waehrend des Schliessens ist er es nicht mehr - wer hier "ja" liest, '
    + 'meldet sich nie wieder an');
  assert.equal(isOverlayOpen(token), false);
});

test('whenHistorySettled: wer nach einer Rueckfrage die Adresse zuruecklegt, wartet auf deren back()', async () => {
  // Der Verlassen-Schutz des Routers (A7 P2-1): Zurueck von "/" nach "/calendar"
  // fragt per Dialog, der Nutzer sagt "Abbrechen", und die Adresse soll wieder
  // "/" zeigen. Der Dialog gibt beim Schliessen seinen Marker per back() zurueck
  // - asynchron. Legte der Router "/" SOFORT per pushState zurueck, kaeme das
  // back() danach an und die Adresse stuende wieder auf "/calendar".
  const run = async (wait) => {
    const { pushOverlay, dropOverlay, whenHistorySettled, history } = await freshModule();
    history.pushState({ path: '/calendar' }, '', '/calendar');
    const token = pushOverlay(() => {});
    await settle();
    // Der Router wartet ab dem Moment, in dem die Antwort feststeht - der
    // Dialog blendet dann noch aus und meldet sich erst DANACH ab (im Browser
    // gemessen: 220ms zwischen Antwort und back()).
    const settled = wait ? whenHistorySettled() : null;
    await settle();
    dropOverlay(token);
    if (wait) await settled;
    history.pushState({ path: '/' }, '', '/');
    await settle();
    return history.href;
  };
  assert.equal(await run(false), '/calendar', 'ohne Warten verliert die Adresse (Nachweis der Falle)');
  assert.equal(await run(true), '/', 'mit Warten steht die Adresse der Seite, die stehen blieb');

  const { whenHistorySettled } = await freshModule();
  let done = false;
  whenHistorySettled().then(() => { done = true; });
  await settle();
  await settle();
  assert.equal(done, true, 'ohne offenes Overlay loest es sofort auf');
});
