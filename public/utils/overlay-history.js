/**
 * ZURUECK SCHLIESST, WAS OBEN LIEGT (#871).
 *
 * Auf dem Telefon ist die Wischgeste von links der Zurueck-Knopf, und sie
 * bedeutet dort seit Jahren "eine Ebene raus". Wer einen Termin geoeffnet hat
 * und wischt, meint den Termin - nicht die Seite darunter. Die App tat
 * dagegen beides falsch herum: der Router navigierte im Hintergrund zurueck
 * auf die Uebersicht, und der Dialog blieb offen darueber stehen. Zurueck war
 * damit die einzige Geste, die den Zustand kaputt statt kleiner machte.
 *
 * ── WARUM EIN REGISTER UND NICHT EIN HANDLER JE DIALOG ────────────────────
 *
 * Diese App hat NICHT einen Dialog, sondern ein geteiltes Modal-System und
 * daneben ein Dutzend eigener Overlays (Bildpicker, Belegpicker, Buchungs-
 * picker, Suchblatt, Mehr-Blatt, Onboarding, Dokumentvorschau …). Ein
 * `popstate`-Handler je Overlay hiesse: dreizehn Stellen, die dieselbe
 * Geschichte mit der History fuehren, und die vierzehnte vergisst sie. Hier
 * steht sie einmal; ein Overlay schliesst sich in zwei Zeilen an.
 *
 * ── EIN MARKER FUER ALLE, NICHT EINER JE OVERLAY ──────────────────────────
 *
 * Das ist die zentrale Entscheidung dieses Moduls, und sie ist bezahlt: die
 * erste Fassung legte je Overlay einen eigenen History-Eintrag an, und eine
 * Review fand daran vier verschiedene Fehler, die alle DIESELBE Wurzel hatten
 * - zwei Buchhaltungen, die auseinanderlaufen koennen. Der echte
 * History-Stapel und das Register waren nur so lange einig, wie nichts
 * dazwischenkam:
 *
 *   - `history.back()` wirkt NICHT synchron. Schlossen zwei Overlays im selben
 *     Tick, sah das zweite `history.state` noch unveraendert, hielt sich fuer
 *     „nicht obenauf" und gab seinen Marker nie zurueck.
 *   - Riss ein Overlay ein anderes mit (Belegvorschau im Modal), blieb der
 *     untere Marker als toter Eintrag liegen.
 *   - Ging ein Blatt zu und ein Dialog im selben Tick auf, wurde ein Marker
 *     zurueckgegeben und sofort ein neuer gelegt - ein `back()` gegen ein
 *     `pushState`, deren Reihenfolge keine Spezifikation zusichert.
 *
 * Jeder tote Eintrag kostet eine Zurueck-Geste, die sichtbar NICHTS tut - also
 * genau den Fehler, den dieser Fix beheben soll, nur eine Ebene versetzt.
 *
 * MIT EINEM MARKER GIBT ES DIESE KLASSE NICHT MEHR. Er beantwortet eine
 * einzige Frage: „steht gerade irgendein Overlay?" Er entsteht, wenn das
 * Register von leer auf nicht-leer geht, und er geht zurueck, wenn es leer
 * wird. Wie viele Overlays dazwischen auf- und zugehen, ist der History egal.
 *
 * ── UND DESHALB IST DER ABGLEICH VERZOEGERT ───────────────────────────────
 *
 * `syncMarker()` laeuft in einem Microtask, nicht sofort. Das ist kein
 * Feinschliff, sondern der Grund, warum „Blatt zu, Dialog auf" im selben Tick
 * gar nicht erst zwei History-Operationen ausloest: netto hat sich nichts
 * geaendert, also passiert nichts. Genau daran scheiterte die erste Fassung
 * bei Hilfe, Aenderungsverlauf und Suche - die gehen alle aus dem Mehr-Blatt
 * heraus auf.
 *
 * ── DIE DREI WEGE AUS EINEM DIALOG ────────────────────────────────────────
 *
 * 1. ZURUECK-GESTE: der Browser verlaesst unseren Marker und feuert
 *    `popstate`. `handleBackNavigation()` schliesst das oberste Overlay und
 *    meldet dem Router, dass die Geste verbraucht ist. Liegt darunter noch
 *    eines, legt der Abgleich den Marker gleich wieder an.
 * 2. X / ESCAPE / SPEICHERN: das Overlay ruft `dropOverlay()`. Der Marker geht
 *    nur zurueck, wenn es das LETZTE war - sonst braeuchte die naechste Geste
 *    zwei Anlaeufe. Dieses `back()` loest selbst ein `popstate` aus;
 *    `pendingSelfPops` faengt genau die ab.
 * 3. ABGELEHNTES SCHLIESSEN: `closeModal()` fragt bei ungespeicherten
 *    Aenderungen zurueck. Sagt der Nutzer „nicht verwerfen", kommt der Eintrag
 *    ins Register zurueck - und mit ihm der Marker. Sonst fuehre die naechste
 *    Geste aus der Seite heraus.
 *
 * ── EINE ANNAHME, AUSGESPROCHEN ───────────────────────────────────────────
 *
 * Overlays schliessen in umgekehrter Oeffnungsreihenfolge (LIFO). Das ist bei
 * Dialogen keine Vereinfachung, sondern ihre Natur: das obere liegt ueber dem
 * unteren und faengt jeden Klick ab. Anders als in der ersten Fassung ist ein
 * Verstoss hier folgenlos - der Marker haengt an „ist noch etwas offen", nicht
 * an einer bestimmten Reihenfolge.
 */

// Was gerade offen ist, von unten nach oben.
const stack = [];

let seq = 0;

// Liegt UNSER Marker gerade obenauf in der History?
let markerActive = false;

// Wie viele `popstate`-Ereignisse noch von unseren eigenen `back()`-Aufrufen
// stammen und deshalb nicht als Zurueck-Geste zaehlen.
let pendingSelfPops = 0;

let syncScheduled = false;

/* Laeuft gerade ein `close()`, das noch antwortet?
 *
 * Es kann BELIEBIG LANGE dauern: `closeModal()` fragt bei ungespeicherten
 * Aenderungen zurueck und wartet auf den Menschen. In diesem Fenster ist der
 * Marker schon verbraucht und das Register schon leer - eine zweite
 * Zurueck-Geste (zweiter Wisch, wiederholtes Hardware-Back) faende also
 * „nichts offen" und liesse den Router hinter dem sichtbar offenen
 * Verwerfen-Dialog wegnavigieren. Genau der Zustand aus #871, nur in diesem
 * Zeitfenster.
 *
 * Die zweite Geste gehoert dem Dialog, der gerade fragt. Sie wird geschluckt,
 * nicht nachgeholt: was danach passiert, entscheidet die Antwort auf die
 * Rueckfrage, und `syncMarker()` legt den Marker danach neu an, falls noch
 * etwas steht. */
let closing = false;

/* Wer nach dem Schliessen eines Dialogs selbst einen Eintrag legt, wartet
 * hier (`whenHistorySettled`), bis der Abgleich durch ist. */
const settledWaiters = [];

function flushSettled() {
  if (stack.length > 0 || markerActive || syncScheduled || pendingSelfPops > 0) return;
  for (const resolve of settledWaiters.splice(0)) resolve();
}

function historyState() {
  return typeof history === 'undefined' ? null : history.state;
}

/**
 * Den Marker an den Zustand des Registers angleichen - im naechsten Microtask.
 *
 * Die Verzoegerung ist die Aussage: was innerhalb EINES Ticks auf- und zugeht,
 * hebt sich auf und fasst die History gar nicht erst an.
 */
function syncMarker() {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    /* SOLANGE EIN EIGENER SCHRITT UNTERWEGS IST, BLEIBT DIE HISTORY IN RUHE.
     *
     * `back()` wirkt asynchron, und der Abgleich deckt nur EINEN Tick: geht ein
     * Overlay zu und das naechste erst einen Tick spaeter auf (die Leseansicht
     * am Desktop schliesst, ihr Formular wartet noch auf die Erinnerungen; das
     * Loeschen wartet das Schliessen ab und fragt dann nach der Reichweite),
     * liefe hier ein `pushState` in das noch ausstehende `back()` hinein. In
     * Chrome gemessen: der Marker entsteht, und das `back()` traegt den Browser
     * danach UNTER ihn, auf die Seite selbst. Das Register haelt den Marker fuer
     * obenauf, steht aber darunter - und das Schliessen des Dialogs gibt mit
     * seinem `back()` einen Eintrag zurueck, den es nie gab: die Adresse zeigt
     * die Seite davor, waehrend der Kalender im Bild bleibt.
     *
     * Nachgeholt wird, sobald das eigene `popstate` da ist
     * (`handleBackNavigation`): dann steht der Browser wieder auf einem Eintrag,
     * den dieses Modul kennt. */
    if (pendingSelfPops > 0) return;
    const wanted = stack.length > 0;
    if (wanted === markerActive) {
      flushSettled();
      return;
    }

    if (wanted) {
      markerActive = true;
      history.pushState({ ...(historyState() ?? {}), overlay: true }, '', location.href);
      flushSettled();
    } else {
      markerActive = false;
      pendingSelfPops += 1;
      history.back();
    }
  });
}

/**
 * Ein Overlay hat sich geoeffnet.
 *
 * @param {(opts: {force: boolean}) => (boolean|void|Promise<boolean|void>)} close
 *   schliesst dieses Overlay. Ein ausdrueckliches `false` heisst „abgelehnt,
 *   bleibt offen"; alles andere gilt als geschlossen. `force: true` kommt vom
 *   Sitzungsende und von einer echten Navigation - dort darf nichts mehr
 *   zurueckfragen.
 * @returns {number} Marker fuer `dropOverlay()`.
 */
export function pushOverlay(close) {
  const token = ++seq;
  stack.push({ token, close });
  syncMarker();
  return token;
}

/**
 * Der Anschluss fuer die MODUL-EIGENEN Overlays: ein Knoten, der per
 * `.remove()` verschwindet.
 *
 * Sie sind die Mehrheit (Icon-Picker, Belegvorschau, Buchungspicker,
 * Logopicker, Onboarding, Hilfe …), und sie haben alle dasselbe Muster: kein
 * Lebenszyklus, kein Zustand, nur ein Knoten - dafuer aber DREI bis FUENF
 * Schliesswege (X, Escape, Klick daneben, Auswahl getroffen, Abbrechen), von
 * denen jeder einzeln `remove()` ruft. Ein `dropOverlay()` an jeder dieser
 * Stellen waere fuenfmal dieselbe Zeile und einmal die vergessene.
 *
 * Deshalb wird hier nicht das SCHLIESSEN abgefangen, sondern das VERSCHWINDEN:
 * der Beobachter meldet den Knoten ab, sobald er aus dem Dokument faellt -
 * egal, welcher der fuenf Wege ihn entfernt hat, und auch dann, wenn ein
 * Overlay darunter ihn mitgerissen hat.
 */
export function attachOverlay(el, close) {
  const token = pushOverlay(close);
  const entry = stack[stack.length - 1];
  const observer = new MutationObserver(() => {
    if (el.isConnected) return;
    dropOverlay(token);
  });
  observer.observe(document, { childList: true, subtree: true });
  entry.detach = () => observer.disconnect();
  return token;
}

/** Ein Overlay hat sich auf eigenem Weg geschlossen (X, Escape, Speichern). */
export function dropOverlay(token) {
  const index = stack.findIndex((entry) => entry.token === token);
  if (index === -1) return;
  stack.splice(index, 1)[0].detach?.();
  syncMarker();
}

/**
 * Loest auf, sobald die History wieder dem Aufrufer gehoert: kein Overlay
 * mehr offen, sein Marker zurueckgegeben und das eigene `back()` dafuer
 * angekommen.
 *
 * WOZU. Der Verlassen-Schutz des Routers fragt per Dialog; lehnt der Nutzer
 * ein Zurueck ab, legt der Router die Adresse der stehengebliebenen Seite
 * wieder an. Der Dialog gibt beim Schliessen aber seinen Marker per `back()`
 * zurueck, und das wirkt asynchron. Sein Ziel steht beim Aufruf fest: der
 * Eintrag UNTER dem Marker. Ein sofortiges `pushState` haengte die Adresse nur
 * dahinter an, und das `back()` truege den Browser danach unter beide zurueck
 * (im Browser gemessen: "/calendar" in der Adresse, die Uebersicht im Bild).
 * Dieselbe Verschraenkung wie in `syncMarker`, dort mit dem eigenen Marker.
 *
 * Gewartet wird auf das LEERE Register, nicht nur auf den Abgleich: die
 * Antwort einer Rueckfrage steht fest, waehrend ihr Dialog noch ausblendet,
 * und abgemeldet wird er erst danach (im Browser 220ms spaeter). Erst einen
 * Makrotask spaeter nachgesehen, damit ein im selben Task geschlossenes
 * Overlay seinen Abgleich sicher angestossen hat. Kommt das `back()` nie an
 * (erster Eintrag der History) oder bleibt etwas offen, haelt eine Frist den
 * Aufrufer nicht fest.
 * @returns {Promise<void>}
 */
export function whenHistorySettled() {
  return new Promise((resolve) => {
    setTimeout(() => {
      settledWaiters.push(resolve);
      flushSettled();
    }, 0);
    setTimeout(resolve, 1000);
  });
}

/**
 * Der Router fragt bei jedem `popstate`: war das fuer einen Dialog gemeint?
 *
 * @returns {Promise<boolean>} true, wenn die Geste hier verbraucht wurde und
 *   der Router NICHT navigieren soll.
 */
export async function handleBackNavigation() {
  if (pendingSelfPops > 0) {
    pendingSelfPops -= 1;
    // Ein Abgleich, der auf diesen Schritt gewartet hat, laeuft jetzt (siehe
    // `syncMarker`); steht nichts an, gibt er die Wartenden frei.
    syncMarker();
    return true;
  }
  /* Eine zweite Geste, waehrend die erste noch fragt - Begruendung an
   * `closing`. SIE WIRD ZURUECKGENOMMEN, nicht nur verschluckt: der Browser
   * ist bereits einen Eintrag zurueckgegangen, und ein blosses `return true`
   * unterdrueckt nur das Rendern. Die Adresse zeigte danach eine andere Seite
   * als der Bildschirm, und der naechste `pushState` haette den echten
   * Vorwaertszweig abgeschnitten. `forward()` stellt beides wieder her - und
   * ist, wie das `back()` im Abgleich, ein eigener Schritt und keine
   * Nutzergeste. */
  if (closing) {
    pendingSelfPops += 1;
    history.forward();
    return true;
  }
  /* Ohne Marker war die Geste nicht fuer uns. Das ist die genauere Frage als
   * „ist etwas offen?": ein Overlay kann bereits im Register stehen, waehrend
   * sein Marker noch im ausstehenden Abgleich haengt - dann gehoert die Geste
   * dem Eintrag DARUNTER, also dem Router. */
  if (!markerActive) return false;

  // Der Browser hat unseren Eintrag gerade verlassen - vor dem `await`, sonst
  // liest ein zweites Ereignis in der Zwischenzeit den alten Wert.
  markerActive = false;

  const entry = stack.pop();
  if (!entry) return false;

  closing = true;
  try {
    const result = await entry.close({ force: false });
    if (result === false) stack.push(entry);
    else entry.detach?.();
  } finally {
    closing = false;
  }

  // Liegt darunter noch etwas - oder ist der Dialog offen geblieben -, legt
  // der Abgleich den Marker gleich wieder an.
  syncMarker();
  return true;
}

/**
 * Eine echte Navigation steht an: das Register raeumen und melden, ob unser
 * Marker der aktuelle History-Eintrag ist.
 *
 * DIE NEUE SEITE TRITT AN SEINE STELLE (`replaceState` statt `pushState`).
 * Der Marker ist ein Platzhalter ohne eigenen Inhalt; laege die neue Seite
 * darueber, zeigte der Rueckweg erst auf ihn - eine Geste, die sichtbar nichts
 * tut, weil dieselbe Adresse noch einmal gerendert wuerde.
 *
 * KEIN `history.back()` HIER: es liefe gegen das `pushState`/`replaceState`
 * der Navigation im selben Tick, und welches zuerst wirkt, sichert keine
 * Spezifikation zu.
 *
 * Overlays, die eine Navigation ueberdauern, gibt es nicht - ein Dialog ueber
 * der falschen Seite IST der Zustand aus #871. Deshalb bekommen sie hier ihr
 * `close({ force: true })`, ohne Rueckfrage: wer navigiert, hat die Frage nach
 * ungespeicherten Aenderungen bereits beantwortet.
 */
export function consumeOverlayMarker() {
  const open = stack.splice(0);
  for (const entry of open.reverse()) {
    entry.detach?.();
    // Ein hakendes Overlay darf die Navigation nicht aufhalten.
    try { entry.close({ force: true }); } catch { /* siehe oben */ }
  }
  const had = markerActive;
  markerActive = false;
  flushSettled();
  return had;
}

/**
 * Sitzungsende: alles schliessen, was noch steht.
 *
 * NICHT NUR VERGESSEN. Ein geteiltes Modal haengt an `document.body` und
 * ueberlebt das Abraeumen der App-Shell; ein bloss geleertes Register liesse
 * es ueber der Anmeldeseite stehen, und die Zurueck-Geste faende dann nichts
 * mehr zu schliessen - sie navigierte darunter weg, also wieder #871.
 *
 * Die History bleibt unangetastet: ein Marker, den niemand mehr einloest,
 * kostet eine Geste - ein Register auf entfernten Knoten kostet einen Fehler
 * bei jeder folgenden.
 */
export function closeAllOverlays() {
  const open = stack.splice(0);
  for (const entry of open.reverse()) {
    entry.detach?.();
    try { entry.close({ force: true }); } catch { /* darf das Abmelden nicht aufhalten */ }
  }
  /* `markerActive` BLEIBT STEHEN, anders als bei `consumeOverlayMarker()`.
   *
   * Auf das Sitzungsende folgt eine Navigation nach `/login`, und die soll den
   * Marker ERBEN (`replaceState`). Wer ihn hier schon verbraucht, laesst sie
   * einen neuen Eintrag daruebersetzen: Zurueck von der Anmeldeseite landet
   * dann auf dem toten Marker der geschuetzten Route, wird nach `/login`
   * umgeleitet und die Geste ist verpufft - wiederholbar, also eine Falle
   * statt eines Wegs. */
}

/**
 * Steht DIESER Marker noch im Register?
 *
 * Wer seinen Token ueber mehrere Zustaende haelt - das Modal-System tut das,
 * weil ein Bestaetigungsdialog das Formular darunter parkt -, muss das fragen
 * koennen. `handleBackNavigation()` nimmt den Eintrag heraus, BEVOR es
 * schliesst; wer danach nur „habe ich einen Token?" fragt, haelt sich fuer
 * angemeldet und ist es nicht. Genau so verlor ein wieder hervorgeholtes
 * Formular seinen Anspruch auf die naechste Geste.
 */
export function isOverlayOpen(token) {
  return stack.some((entry) => entry.token === token);
}

/** Steht gerade irgendein Overlay im Register? */
export function hasOpenOverlay() {
  return stack.length > 0;
}
