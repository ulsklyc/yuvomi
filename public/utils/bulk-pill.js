/**
 * Modul: Sammelaktions-Pille
 * Zweck: WO die Sammelaktion einer Liste lebt - einmal, für die Shell, die die
 *        Schicht anlegt, und für jede Seite, die eine Teilmenge anbietet.
 *
 * ANLASS (Etappe 5, 2026-08-13): die Leiste stand als statischer Block ÜBER der
 * Liste und kostete dort gemessene 358x103px bei y=113 - der Scroller begann
 * dadurch erst bei y=216 statt 113, also 103 von 552px Listenfläche, sobald ein
 * einziger Artikel abgehakt war. Die 103px kamen aus `flex-wrap`: Label auf
 * Zeile eins, beide Knöpfe auf Zeile zwei.
 *
 * SIE IST JETZT SHELL, KEIN INHALT. Das Material war die Entscheidung
 * (2026-08-12): Shell-Glas wie der Undo-Toast, weil es diese Schicht schon gibt
 * und sie genau EIN Material hat. Damit fällt auch der Modulton weg - in der
 * Shell-Schicht gilt Shell-Material, nicht Modul-Tinte.
 *
 * DER WOHNORT IST DERSELBE STAPEL WIE DER TOAST, und das löst den einzigen
 * echten Zielkonflikt: beide sind fixiert am selben unteren Rand. Als
 * Geschwister in EINER Spalte (`.shell-bottom-stack`, layout.css) rechnet
 * Flexbox das Ausweichen selbst - der Toast bleibt, wo Toasts immer stehen (er
 * ist der mit der Fünf-Sekunden-Frist), die Pille rutscht um genau eine
 * Toasthöhe hoch. Kein `:has()`, keine Variable für eine Höhe, die nicht
 * konstant wäre.
 *
 * SIE IST EINZEILIG PER KONSTRUKTION, sonst ist sie der Block von vorher in
 * dunkel: die Aktionen sind Kapseln auf dem Toast-Material (`.toast__undo`
 * teilt sich die Regel mit `.list-bulkbar__action`), nicht `.btn`-Knöpfe mit
 * Icon. Der Rang bei Enge: die Aktionen schrumpfen nie, das Label gibt nach -
 * es führt mit der Zahl, und die überlebt die Kürzung.
 *
 * NICHT im aria-live-Bereich der Toasts: die Pille steht dauerhaft und ist eine
 * Bedienung, keine Meldung. Eine Live-Region würde jede Änderung der Zahl
 * ansagen und den Toasts ins Wort fallen.
 *
 * DIE RÜCKFRAGE IST EIN ZUSTAND DERSELBEN FLÄCHE, KEIN ZWEITES FENSTER
 * (Critique 2026-08-13, P0). Die Löschen-Kapsel nahm die abgehakten Artikel
 * ohne jede Zwischenstufe, und sie sah dabei aus wie die harmlose Kapsel
 * daneben und wie das „Verwerfen" des Toasts darunter: dieselbe Form, dieselbe
 * Größe, dieselbe Tinte, 40px auseinander. Wer danebentippt, hat gelöscht.
 *
 * Ein Modal wäre die naheliegende Antwort und die falsche: es unterbricht für
 * eine Frage, die auf der Fläche Platz hat, die schon steht. Die Pille wechselt
 * stattdessen in den Bestätigungszustand - das Subjekt wird zur Frage, die
 * übrigen Aktionen treten ab (in eine Löschfrage gehört kein „In den Vorrat"),
 * und übrig bleiben Abbrechen und die Bestätigung.
 *
 * DER FOKUS GEHT AUF ABBRECHEN, nicht auf die Bestätigung. Sonst wäre ein
 * zweiter Enter-Anschlag genau der Fehltipp, gegen den die Frage gebaut ist.
 * Und er ist zugleich die Ansage: ein Fokuswechsel in eine `role="group"` lässt
 * den Screenreader die Gruppe samt ihrem `aria-labelledby` neu lesen, also die
 * Frage. Deshalb braucht die Rückfrage KEINE Live-Region - die wäre der Bruch
 * mit dem Absatz darüber.
 *
 * ESCAPE BRICHT AB, weil die Frage sonst nur mit der Maus zurückzunehmen wäre.
 */
import { t } from '/i18n.js';

export const BULK_PILL_LAYER = 'bulk-pill-layer';

/**
 * Wie lange die Bestätigung nach dem Aufmachen der Frage gesperrt bleibt.
 *
 * 400ms, unter der Doppelklick-Schwelle der Systeme (rund 500ms) und über
 * allem, was ein Mensch braucht, um eine Frage zu lesen. Ein bedachter Griff
 * merkt sie nicht; ein zweiter Tipp aus derselben Bewegung wie der erste läuft
 * ins Leere - und genau der ist der Anlass (die Bestätigung liegt auf der
 * Auslösung, siehe unten).
 */
const CONFIRM_GRACE_MS = 400;

/** Die Schicht, oder null, solange die Shell noch nicht steht. */
export function bulkPillLayer() {
  return document.getElementById(BULK_PILL_LAYER);
}

/**
 * Eine Kapsel der Pille. Eine Fabrik für beide Zustände: die Aktionen des
 * Ruhezustands und die Abbrechen/Bestätigen-Paarung der Rückfrage sind
 * dieselbe Schreibweise, und ein zweiter Bauweg wäre die zweite Grammatik,
 * die dieses Bauteil gerade abgeschafft hat.
 */
function actionButton({ label, ariaLabel, count, danger, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'list-bulkbar__action';
  // Die Gefahr trägt eine eigene Tinte, nicht eine eigene Form: die Kapsel ist
  // das Vokabular dieser Fläche, die Farbe ist der Zweitkanal daneben. Und sie
  // ist NICHT der einzige Unterschied - die Rückfrage ist der erste.
  if (danger) btn.classList.add('list-bulkbar__action--danger');
  btn.textContent = label;
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  // DIE ZAHL HOLT DAS SUBJEKT EIN, WENN ES WEGFÄLLT (Etappe 6, 2026-08-13).
  // Bei 320px steht die Pille ohne ihre Zeile da, und übrig blieben zwei
  // Kapseln ohne genanntes Objekt - über einer Liste mit 23 Artikeln. Gemessen:
  // „Löschen" plus Marke bleibt bei rund 191 von 264px Innenbreite einzeilig.
  //
  // Als MARKE, nicht als „(3)": „Beschriftung plus Anzahl daneben" ist ein
  // Muster, das die Listen-Tabs schon sprechen. Eine eigene Klammer-
  // Schreibweise wäre ein zweites Vokabular für dieselbe Aussage - und eine
  // Zahl ist keine Sprache, also braucht sie auch keinen Locale-Key.
  //
  // SIE IST FÜR DAS AUGE, NICHT FÜR DAS OHR (Etappe 7, 2026-08-13). Ohne
  // `aria-label` an der Kapsel ginge die Marke sehr wohl in deren Namen ein,
  // und der Vorrat ist genau dieser Fall: seine Kapsel hiesse dann „Alles auf
  // die Einkaufsliste 10" - neben einer Gruppe, die schon „10 Artikel fast
  // leer" heisst. Zweimal dieselbe Zahl in einer Ansage. Die Zahl steht ohnehin
  // IMMER im Namen der Gruppe, und `aria-labelledby` überlebt das
  // `display: none` bei 320px.
  if (count != null) {
    const badge = document.createElement('span');
    badge.className = 'list-bulkbar__action-count';
    badge.textContent = String(count);
    badge.setAttribute('aria-hidden', 'true');
    btn.appendChild(badge);
  }
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

/**
 * Zeichnet die Pille in einem ihrer beiden Zustände.
 *
 * @param {object} spec       die Spezifikation aus `setBulkPill`
 * @param {object|null} pending  die Aktion, deren Rückfrage offen steht
 */
function paint(spec, pending) {
  const layer = bulkPillLayer();
  if (!layer) return null;

  const bar = document.createElement('div');
  bar.className = 'list-bulkbar';
  // `group` plus Beschriftung: die Pille steht visuell losgelöst von ihrer
  // Liste, und ohne Rolle wäre sie für die Tastatur nur eine Folge von zwei
  // Knöpfen ohne Bezug. Die erklärende Zeile IST der Bezug.
  bar.setAttribute('role', 'group');
  if (pending) bar.classList.add('list-bulkbar--confirming');

  // SUBJEKT, NICHT LABEL. Die Zeile beschriftet nicht die Knöpfe - die tragen
  // ihre eigenen Wörter -, sie nennt, WORAUF sie wirken. Der alte Name
  // `__label` las sich neben `__action` wie dessen Beschriftung, und der
  // Label-Verlust-Guard hat ihn genau so gelesen: er verlangte für die Kapseln
  // die volle Zielgröße, sobald das Subjekt bei 320px wegfällt. Der Guard hatte
  // recht über den Namen und unrecht über die Sache.
  //
  // Im Bestätigungszustand ist derselbe Knoten die FRAGE. Ein zweiter Knoten
  // daneben wäre ein zweiter Bezug für dieselbe `role="group"`, und genau
  // dieser Knoten ist der, den `aria-labelledby` liest.
  const subject = document.createElement('span');
  subject.className = 'list-bulkbar__subject';
  subject.id = 'bulk-pill-subject';
  subject.textContent = pending ? pending.confirm.question : spec.label;
  bar.setAttribute('aria-labelledby', subject.id);
  bar.appendChild(subject);

  if (pending) {
    // DIE WAHL IST EIN PAAR, ALSO EIN KNOTEN. Ohne ihn entscheidet die
    // Restbreite, WELCHE der beiden Kapseln umbricht: gemessen stand die Frage
    // mit „Annuleren" in Zeile eins und „Verwijderen" allein darunter. Abbrechen
    // und Bestätigen gehören zusammen - entweder beide neben die Frage oder
    // beide darunter. Der Knoten trägt keine Rolle: die Kapseln bleiben direkte
    // Nachfahren der `role="group"`, die Fokusreihenfolge ist die des DOM.
    const choices = document.createElement('div');
    choices.className = 'list-bulkbar__choices';

    // Abbrechen steht VOR der Bestätigung: die Leserichtung führt vom
    // Rückweg zur Folge, nicht umgekehrt, und der Daumen trifft am rechten
    // Rand das, was er zuletzt bestätigt hat.
    const cancel = actionButton({
      label: t('common.cancel'),
      onClick: () => {
        const back = paint(spec, null);
        // Zurück auf die Kapsel, die die Frage aufgemacht hat - sonst landet
        // der Tastaturfokus am Dokumentanfang und der Weg ist verloren.
        back?.querySelectorAll('.list-bulkbar__action')[spec.actions.indexOf(pending)]?.focus();
      },
    });
    choices.appendChild(cancel);
    // Ohne Marke: die Zahl steht in der Frage links daneben, und zweimal
    // dieselbe Zahl in einer Fläche ist genau das Echo, das die Marke im
    // Ruhezustand vermeidet.
    const confirmBtn = actionButton({
      label: pending.confirm.confirmLabel ?? pending.label,
      ariaLabel: pending.ariaLabel,
      danger: pending.danger,
      onClick: (btn) => pending.onClick(btn),
    });
    // DIE BESTÄTIGUNG LIEGT AUF DER AUSLÖSUNG - gemessen dx=0, dy=0 bei 390 und
    // 414px. Beide Kapseln sind gleich breit („Löschen" hier, „Löschen" dort)
    // und beide stehen am rechten Ende der Pille, also trifft ein zweiter Tipp
    // an dieselbe Stelle die Bestätigung. Die Frage wäre damit genau für den
    // Fall wirkungslos, für den sie gebaut ist: den hektischen Doppeltipp.
    //
    // Der Ort lässt sich nicht verlässlich verschieben - bei 360px ergab die
    // Zählmarke zufällig 76px Versatz, bei 390 und 414 keinen, und ein
    // linksbündiges Paar liegt bei der nächsten Sprache wieder darunter.
    // Also die ZEIT statt des Ortes: ein Tipp, der schneller folgt als eine
    // gelesene Antwort, ist keine Antwort. Sichtbar über `:disabled`, das die
    // Kapsel schon kennt - eine stille Sperre sähe aus wie ein toter Knopf.
    //
    // Der Rückweg ist NICHT gesperrt: wer abbricht, darf das sofort.
    confirmBtn.disabled = true;
    setTimeout(() => { confirmBtn.disabled = false; }, CONFIRM_GRACE_MS);
    choices.appendChild(confirmBtn);
    bar.appendChild(choices);
    // DIE FOLGE, DIE DIE FRAGE NICHT TRAEGT (R11, 2026-09-27). Die Dokumente
    // loeschen endgueltig - einen Papierkorb gibt es nicht. In die Frage passt
    // das nicht: gemessen bei 390px stand "12 Dokumente endgueltig loeschen?
    // Kein Papierkorb." in 15 von 24 Sprachen ueber den Rand, und die Frage
    // bricht bewusst nicht innen um. Also eine eigene Zeile NACH dem Paar
    // (layout.css `.list-bulkbar__detail`: volle Zeile, bricht um), damit die
    // Frage und ihre Wahl in der ersten Zeile beieinander bleiben.
    //
    // Im Gruppennamen, nicht daneben: der Fokuswechsel auf Abbrechen liest den
    // Namen der Gruppe - das ist die Ansage der Rueckfrage (siehe Kopf). Ein
    // Satz, der dort fehlt, wird nicht gehoert.
    if (pending.confirm.detail) {
      const detail = document.createElement('span');
      detail.className = 'list-bulkbar__detail';
      detail.id = 'bulk-pill-detail';
      detail.textContent = pending.confirm.detail;
      bar.appendChild(detail);
      bar.setAttribute('aria-labelledby', `${subject.id} ${detail.id}`);
    }
    // ESCAPE NIMMT DIE FRAGE ZURÜCK. Ohne das wäre der Rückweg nur mit einem
    // gezielten Treffer zu haben - bei einer Frage, die man versehentlich
    // aufgemacht hat, ist das die falsche Anforderung.
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancel.click();
    });
  } else {
    for (const action of spec.actions) {
      bar.appendChild(actionButton({
        ...action,
        // Eine Aktion mit Rückfrage FÜHRT NICHT AUS, sie fragt. Ohne
        // `confirm` bleibt der direkte Weg - eine harmlose Aktion soll keine
        // Frage bekommen, nur weil eine andere in derselben Pille eine hat.
        onClick: action.confirm
          ? () => { paint(spec, action)?.querySelector('.list-bulkbar__action')?.focus(); }
          : (btn) => action.onClick(btn),
      }));
    }
  }

  /* DER FOKUS UEBERLEBT DAS NEUZEICHNEN.
   *
   * `paint()` baut die Pille jedes Mal neu, und `replaceChildren` wirft den
   * fokussierten Knopf mit weg - der Fokus faellt auf <body>. Sichtbar wurde
   * das an "Alle auswaehlen" in den Kontakten: der Knopf loest `renderList()`
   * plus `updateSelectUI()` aus, zeichnet also seine eigene Pille neu, und die
   * Tastatur stand danach wieder am Seitenanfang - ausgerechnet vor dem
   * Loeschen-Knopf, den die Auswahl gerade erst freigeschaltet hat. Die feste
   * Leiste davor hatte ihre Knoepfe nie abgehaengt (Codex-Review zu PR #754).
   *
   * Gemerkt wird die POSITION unter den Aktionen, nicht das Element: der neue
   * Knopf an derselben Stelle ist derselbe Knopf. Faellt die Aktion weg (die
   * Auswahl ist leer, es gibt nichts mehr zu loeschen), bekommt der letzte
   * verbliebene den Fokus - nur nicht der Body. Und nur, wenn der Fokus vorher
   * WIRKLICH in der Pille stand; sonst reisst das Neuzeichnen ihn aus einem
   * Eingabefeld irgendwo anders auf der Seite. */
  const alt = layer.querySelector('.list-bulkbar');
  const fokusIndex = alt && alt.contains(document.activeElement)
    ? [...alt.querySelectorAll('button')].indexOf(document.activeElement)
    : -1;

  layer.replaceChildren(bar);

  if (fokusIndex >= 0) {
    const knoepfe = [...bar.querySelectorAll('button')];
    (knoepfe[fokusIndex] ?? knoepfe[knoepfe.length - 1])?.focus();
  }
  return bar;
}

/**
 * Setzt die Pille (und ersetzt eine bestehende, samt einer offenen Rückfrage:
 * ändert sich die Teilmenge, ist die Frage von gerade eben nicht mehr dieselbe).
 *
 * @param {object} spec
 * @param {string} spec.label   Was die Teilmenge IST - führt mit der Zahl.
 * @param {Array<{label: string, ariaLabel?: string, count?: number, danger?: boolean, confirm?: {question: string, detail?: string, confirmLabel?: string}, onClick: (btn: HTMLButtonElement) => void}>} spec.actions
 *   `count` setzt eine Marke an die Kapsel, sichtbar erst dort, wo das Subjekt
 *   wegfällt. `danger` gibt ihr die Tinte der Gefahr, `confirm` die Rückfrage -
 *   beides gehört zusammen und ein Guard prüft das (test-frontend-audit.js).
 *   `confirm.detail` ist optional: eine Folge, die die Frage nicht trägt
 *   (Dokumente: kein Papierkorb), als eigene Zeile unter Frage und Wahl.
 */
export function setBulkPill(spec) {
  return paint({ actions: [], ...spec }, null);
}

/**
 * Nimmt die Pille weg. Entfernt statt `hidden`: die Schicht ist leer, wenn es
 * keine Teilmenge gibt, und `.shell-bottom-stack > :empty` nimmt sie damit aus
 * dem Stapel - eine leere Zelle zöge sonst ihre Lücke zwischen die Toasts.
 */
export function clearBulkPill() {
  bulkPillLayer()?.replaceChildren();
}
