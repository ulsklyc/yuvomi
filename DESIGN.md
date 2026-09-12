---
name: Yuvomi
description: Familienplaner in Apples Handwerk und Yuvomis Handschrift - warme Buehne, eine violette Stimme, WCAG AA als Invariante
colors:
  accent-violet: "#6C3AED"
  accent-violet-hover: "#5B2FD4"
  accent-violet-dark: "#A78BFA"
  accent-light: "#F3EFFE"
  grouped-bg: "#F5F3ED"
  surface: "#FFFFFF"
  surface-dark: "#2B2825"
  surface-3: "#EDEAE3"
  fill-well: "#EDEAE3"
  surface-elevated: "#FBFAF7"
  surface-elevated-hover: "#EDEAE3"
  bg-dark: "#191816"
  label: "#1D1B17"
  text-secondary: "#63615B"
  text-tertiary: "#6B675F"
  text-quaternary: "#8C8880"
  border: "#E4E0D7"
  border-subtle: "#EDEAE3"
  border-strong: "#CFC9BC"
  ink-on-vivid: "#FFFFFF"
  success: "#1E7B35"
  warning: "#A85D00"
  danger: "#D70015"
  info: "#0663C7"
  # Familientoene (Block 2, 2026-08-10): die Modul-Einzeltoene sind neun
  # Familien; jedes --module-* bezieht aus seiner Familie. Hier steht bewusst
  # keine Zahl - sie ist schon einmal gedriftet (CLAUDE.md, „Kanonische
  # Quellen"). Quelle der Wahrheit und Modul-Zuordnung:
  # public/styles/tokens.css, Abschnitt 4.
  # overview: dashboard - time: calendar, reminders - work: tasks,
  # housekeeping, rewards - kitchen: meals, recipes, shopping, pantry -
  # money: budget, split-expenses - people: contacts, birthdays -
  # health: health - records: documents, notes, inventory - neutral: settings
  family-overview: "#6C3AED"
  family-time: "#00668F"
  family-work: "#157F3D"
  family-kitchen: "#C2410C"
  family-money: "#0F766E"
  family-people: "#CE2A63"
  family-health: "#9E1E88"
  family-records: "#42587E"
  family-neutral: "#677079"
  # Wetterlagen (2026-08-17): eine PARALLELE Domaenenfamilie, keine zehnte
  # Familie. Die Familientoene beantworten „welches Modul", die Wetterlage
  # beantwortet „was ist draussen" - deshalb teilt keine Lage den Wert einer
  # Familie, und keine erscheint ausserhalb einer Wetterflaeche. Bauart wie bei
  # den Mahlzeit-Typen. Dark-Werte und die fuenf Temperaturbaender der
  # Verlaufszeile: public/styles/tokens.css, Abschnitt 5b.
  weather-clear: "#B45309"
  weather-night: "#4C4FBF"
  weather-cloud: "#4F6478"
  weather-rain: "#0A5C9E"
  weather-snow: "#00768C"
  weather-storm: "#8B2FC9"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "clamp(3rem, 9vw, 4.5rem)"
    fontWeight: 700
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.21
    letterSpacing: "-0.015em"
  title-1:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.21
    letterSpacing: "-0.015em"
  title-2:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.21
    letterSpacing: "-0.015em"
  title-3:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.47
  subheadline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.47
  footnote:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.21
  micro-label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.21
    letterSpacing: "0.05em"
  caption-2:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.21
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  2xs: "2px"
  xs: "4px"
  sm: "10px"
  md: "12px"
  lg: "16px"
  xl: "26px"
  full: "9999px"
  glass-card: "26px"
  glass-inner: "18px"
spacing:
  px: "1px"
  0h: "2px"
  1: "4px"
  1h: "6px"
  2: "8px"
  2h: "10px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
  16: "64px"
components:
  button-primary:
    backgroundColor: "color-mix(in srgb, var(--color-accent) 88%, var(--neutral-950))"
    textColor: "{colors.ink-on-vivid}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, var(--color-accent) 76%, var(--neutral-950))"
  button-icon:
    rounded: "{rounded.full}"
    size: "44px"
  # Erhabene Surface-Pille, Modulton NUR in der Tinte (seit 2026-08-12; die
  # gefuellte Fassung ist zurueckgenommen, Rezept in tokens.css Abschnitt 6c).
  # rounded.full gilt fuer die Shell-Pille (.sub-tab); rounded.sm nur fuer das
  # konzentrisch eingesetzte .segmented__item im radius-md-Traeger.
  segment-active:
    backgroundColor: "var(--seg-active-bg)"
    textColor: "color-mix(in srgb, var(--module-accent, var(--color-accent)) var(--tint-ink), var(--color-text-primary))"
    rounded: "{rounded.full}"
  # Die ANDERE Haelfte von „eine Behandlung pro Kontrolltyp" (siehe „Chips"): der
  # aktive Filter-Chip ist eine getoente FLAECHE, ausdruecklich NICHT die
  # gefuellte Segment-Pille darueber. Drei Stufen derselben Farbe, alle drei aus
  # der Toenungsskala: --tint-state als Grund, --tint-hint als Kante (hier nicht
  # als Feld fuehrbar, das Vokabular kennt kein borderColor - sie steht an
  # .filter-chip--active), --tint-ink als Tinte. Inaktiv traegt das Label Sekundaertext, die Farbe
  # erscheint erst mit der Aktivierung (Beschluss 2026-08-17, umgesetzt
  # 2026-08-27; die dauerhaft getoente Schrift las sich als „Filter ist an").
  # Die Zahl hinter einer Stufe steht in tokens.css Abschnitt 6b, nirgends
  # sonst - der Chip nennt seit c788ce01 (2026-08-08) nur noch die Stufe.
  chip:
    backgroundColor: "color-mix(in srgb, var(--module-accent, var(--color-accent)) var(--tint-state), transparent)"
    textColor: "color-mix(in srgb, var(--module-accent, var(--color-accent)) var(--tint-ink), var(--color-text-primary))"
    rounded: "{rounded.full}"
    padding: "4px 12px (--space-1 / --space-3), Kante 1.5px"
    height: "48px (--target-lg); --sm-Variante 40px, auf (hover: none) 44px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "16px"
  widget-header:
    backgroundColor: "{colors.surface} (bandlos seit 2026-08-17; Absender ist das Vollton-Siegel)"
    padding: "12px 16px 8px (die .widget__header-Basisregel; keine Dashboard-Sonderregel mehr)"
    height: "52px (Titelzeile 32px + 12/8px Polster; keine Kante, keine min-height)"
  day-sheet:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
  row-carrier:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "0px"
  inset-well:
    backgroundColor: "{colors.fill-well}"
    rounded: "{rounded.md}"
    padding: "12px"
  # Der Daumen des eigenen Scrollbalkens (#970/#1039). Die 10px sind die SPUR;
  # schmaler wirkt der Daumen ueber die transparente Border, nicht ueber eine
  # kleinere Breite - die Treffflaeche bleibt. Die Seitenleiste mischt statt
  # --module-accent gegen --color-border (sie gehoert keinem Modul).
  scroller-thumb:
    backgroundColor: "color-mix(in srgb, var(--module-accent) var(--tint-hint), transparent)"
    rounded: "{rounded.full}"
    size: "10px Spur, Daumen per 3px transparenter Border + background-clip: padding-box"
  # Der Rahmen eines Vorschaubilds (#1059). Die Groesse folgt der Flaeche: 40px in
  # der Rezeptliste (--target-md), 32px im Planer (--target-sm), 20px in der
  # Kachel (--icon-lg, dort --radius-xs). Der Bild-Editor im Formular ist ein
  # KNOPF und deshalb rund (84px, siehe „Das Vorschaubild"). Die Farbe gilt nur
  # dem Platzhalter; das Bild fuellt den Rahmen per object-fit: cover.
  media-thumb:
    backgroundColor: "var(--color-surface-2)"
    rounded: "{rounded.sm}"
    size: "40px Rezeptliste / 32px Planer / 20px Kachel"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.label}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "48px"
  fab-glass:
    backgroundColor: "color-mix(in srgb, var(--color-accent) 78%, transparent)"
    textColor: "{colors.ink-on-vivid}"
    rounded: "{rounded.full}"
    size: "44px (mobil, in der Nav-Kapsel) / 48px (Desktop)"
  brand-tile:
    backgroundColor: "{colors.accent-violet}"
    textColor: "{colors.ink-on-vivid}"
    rounded: "{rounded.lg}"
    size: "64px"
---

# Design System: Yuvomi

<!-- Neu aufgezeichnet 2026-08-06 aus dem GEBAUTEN Stand des HIG-Redesigns nach
     Fundament + Rest-Rollout Runde 1-3 und zwei Finish-Review-Durchlaeufen
     (feat/hig-redesign). Quelle der Wahrheit fuer JEDEN Wert: public/styles/tokens.css;
     die Kopf-Abgrenzung steht in public/styles/typography.css, die Buttonform in
     der .btn-Basisregel in public/styles/layout.css.

     Nachgefuehrt 2026-08-12 gegen den Stand v2.6.0 (Dashboard-Bogen v2.4.0-v2.6.0:
     Tagesprogramm, Wand-Modus, Absenderband). Der Abgleich lief ueber jeden
     Frontmatter-Wert und hat dabei drei Angaben korrigiert, die kein Token mehr
     deckte: den erfundenen 32px-Radius, den Modulton am Primaerknopf und den
     Modulton am Fokusring - die beiden letzten waren Reste aus der Zeit vor der
     Eine-Stimme-Regel und standen hier laenger als im Code.

     Nachgefuehrt 2026-08-15 gegen tokens.css und die Komponenten (109 Commits
     auf public seit dem letzten Edit). Der FLIESSTEXT war durchweg gedeckt, das
     FRONTMATTER an drei Stellen nicht: `segment-active` beschrieb noch die
     gefuellte Pille, obwohl der Body die Ruecknahme vom 12.08. schon fuehrt;
     `widget-header` trug Polster und Hoehe aus der Zeit vor der v2.6.0-Kur
     (12/44 statt 8/49); die Familienzuordnung kannte `inventory` nicht (PR #741,
     records-Familie). Die Modulzahl steht hier seither gar nicht mehr - sie war
     schon vor dem Merge nicht die Laenge ihrer eigenen Liste. Derselbe Lauf hat
     drei ueberlebte Kommentare im Code korrigiert (.btn--primary in layout.css,
     .sub-tab--active in sub-tabs.css, --color-text-secondary in tokens.css); in
     allen dreien war DESIGN.md aktueller als die Quelle.

     Der Sidecar-Nachzug am selben Tag hat eine Luecke aufgedeckt, die vorher
     niemandem auffiel, weil `.impeccable/design.json` sie zugedeckt hatte: der
     Sidecar fuehrte zur Eine-Stimme-Regel ein Do und ein Don't, die HIER nie
     standen (`git log -S` findet sie in keiner Fassung) - die zentrale Regel der
     App hatte in dieser Liste keinen einzigen Eintrag. Beide stehen jetzt in
     Do's and Don'ts, und der Sidecar leitet sie von dort ab statt sie zu
     erfinden. Im selben Zug sind die beiden verbliebenen „17" gefallen: der
     Modulzahl fehlte Inventar, und die Key Characteristics sagten „17
     AA-verifizierte Modul-Tints", waehrend die Overview zwoelf Zeilen darueber
     neun Familientoene fuehrt.

     Nachgefuehrt 2026-08-17 mit der Dark-Kur (Etappe 1 der Modernisierung,
     Critique vom selben Tag): die Dark-FLAECHEN sind gestiegen, die Buehne
     nicht (Surface #262422 -> #2B2825, Well/Elevated #322F2B -> #37332E,
     Hover #403C37 -> #443E37; Anlass: Buehne->Karte lag bei 1.15:1 und die
     Schwarz-Schatten sind auf der Kohle wirkungslos - das Board las als Wand
     gleich dunkler Rechtecke). Die opaken Dark-Schatten tragen jetzt den
     1px-Weiss-Ring der Glas-Schatten in leiser Dosierung, das Dark-Glas ist
     von iOS-Neutralgrau auf die warme Fassung der eigenen Surface gewechselt,
     und die Tertiaerrolle steht in BEIDEN Themes erstmals warm (#6B675F /
     #A9A39A statt Hue-291-Resten der abgeloesten Apple-Rampe). Messlauf:
     .impeccable/redesign-tools/dark-ramp-final.mjs; alle Werte gegen
     test:frontend-audit (296), test:document-guards (31) und test:typography
     (15) verifiziert.

     Etappe 2 am selben Tag: das Absenderband ist zurueckgebaut (Band,
     getoente Trennlinie UND 2px-Oberkante), der Absender jeder Dashboard-
     Karte ist das Vollton-Siegel, auch in der Kachelreihe. Etappe 3 hat den
     Vollton anschliessend zum EINEN Siegelgesicht gemacht und die Klasse
     `--vivid` damit gestrichen. Anlass und Messlatte stehen an der Signature Component
     „Der Widget-Kopf"; der ignore.md-Eintrag border-accent-on-rounded ist
     mit der 2px-Linie gegangen.

     Etappe 3 und 4 am selben Tag, beide aus derselben Chroma-Lehre: die
     Wochen- und Ganztages-Bloecke des Kalenders tragen ihre Layer-Farbe
     jetzt als 3px-VOLLTON-Kante statt als zweite Waschung (dazu die
     Initialen-Schwelle 20px/11px und 4px Polster an den Kalender-Chips),
     und die Familien-Geburtstage sprechen die Identitaetsfarbe ihres
     Mitglieds statt der Modul-Toenung (unverknuepfte Kontakte behalten
     sie). Die drei neuen Regeln stehen bei Colors, Typography und an der
     Signature Component „Event-Bloecke im Kalender"; verifiziert gegen
     test:frontend-audit (296), test:calendar (65), test:dashboard (71),
     test:document-guards (31).

     Nachgefuehrt 2026-08-18, geprueft gegen v2.21.0. Waehrend des Laufs kam
     v2.21.1 dazu (Mitternachts-Termin, Modal-Overflow, UTC-Tagesschluessel);
     ihre drei public/-Aenderungen beruehren keinen hier dokumentierten Wert -
     `.modal-panel` wechselt von `overflow: hidden` auf `clip` und ist keine der
     drei Stellen, an denen dieses Dokument `overflow: hidden` fuehrt. Seit dem
     letzten Schreibzugriff hat sonst KEIN Commit public/ angefasst, der
     Abgleich lief deshalb nicht gegen neue Arbeit, sondern gegen die eigene: Frontmatter (Farben, Radien, Spacing,
     Typo-Rollen), Schattenvokabular, Motion, Icon- und Zielgroessen sind
     mechanisch gegen tokens.css geprueft und decken sich; von den 115 hier
     genannten Tokens existiert jedes, von 46 Selektoren und 18 Dateinamen
     ebenfalls. Was NICHT stimmte, war dreimal dieselbe Stelle: die Etappe-3-
     Streichung von `module-seal--vivid` und `--seal-base` war an ihrer eigenen
     Signature Component ausgeschrieben, aber im Widget-Kopf-Abschnitt, im
     Nachsatz darunter und in der Do-Liste stand die Klasse weiter als gebauter
     Stand - dieselbe Datei verbot zwei Absaetze weiter oben ihre Rueckkehr per
     Guard. Zwei Wahrheiten in einer Datei, und die Etappe war nur Stunden alt.
     Der Sidecar trug denselben Rueckstand schaerfer: sein `.module-seal`-
     Snippet baute noch die 16-%-Toenung samt `--vivid`-Variante, also genau
     das, was der Guard verbietet, und `narrative.rules` fuehrte die
     zurueckgenommene Traeger-Regel als geltende.

     Drei weitere Sidecar-Befunde desselben Laufs, und alle drei sind hier nur
     deshalb notiert, weil `.impeccable/design.json` gitignored ist und keine
     CI ihn je anfasst: die tonalen Rampen von `family-overview` und
     `family-time` lagen auf Hue/Chroma eines Tons, den ihr Token nicht mehr
     traegt (family-time zeigte eine VIOLETTE Rampe unter einer azurblauen
     Scheibe - der Rueckstand des Umzugs, den ihre eigene Notiz beschreibt);
     die sechs Wetterlagen standen seit ihrer Aufnahme ins Frontmatter ohne
     jedes colorMeta da, waehrend alle neun Familientoene Name, Dark-Wert und
     Rampe fuehren; und ein Don't war auf seinen ersten Satz gekuerzt. Die
     Rampen sind aus dem jeweiligen canonical neu gerechnet, alle 29 Eintraege
     stimmen jetzt gegen ihren Ausgangswert. -->

## Page Composition

Visual language (colour, typography, components, AA) lives in this document and
`tokens.css`. **Spatial composition** - page width, header/body alignment,
composition modes, and extension layout rules - lives in
[`docs/PAGE-COMPOSITION.md`](docs/PAGE-COMPOSITION.md) with primitives in `layout.css` and
`public/utils/page-layout.js`.

## Direction Contract

Stand bis 2026-08-08 als HTML-Kommentar am Body-Anfang von `public/index.html`
und wurde damit an jeden Browser ausgeliefert. Er gehoert hierher, wo die
uebrigen Designentscheidungen stehen.

**THESIS:** Apples HANDWERK, Yuvomis HANDSCHRIFT. Die Struktur ist
Plattform-Kanon (Gruppenlisten, Kapsel-Controls, Typo-Skala, Motion,
AA-Disziplin); die Haut gehoert Yuvomi. Verweigert wird der Kategorie-Standard
(freundlicher Pastell-Organizer) - und seit 2026-08-10 ausdruecklich auch die
woertliche Uebernahme von Apples PALETTE und seinem Pro-App-Tint-Modell.

**KORREKTUR VOM 2026-08-10, und der Anlass steht in einem Satz des Betreibers:**
"Im Vergleich zum alten Yuvomi fuehlt sich die App nicht mehr wie aus einem Guss
an." Hier stand vorher "Plattform-Kanon in voller Treue" mit kuehlen
System-Neutralen (#F2F2F7 / Near-Black #0A0A0C) und Apple Indigo als globalem
Tint. Drei Uebernahmen waren zu woertlich, und alle drei sind zurueckgenommen:
die KUEHLE BUEHNE (Apples Grau war Apples Buehne, nicht Yuvomis - jetzt warmes
Papier #F5F3ED / warme Kohle #191816), der INDIGO-TINT (die Bildmarke ist
violett und gesetzt; Logo und App sprachen zwei Farben - jetzt #6C3AED) und das
PRO-APP-TINT-MODELL (Apple faerbt pro App, Yuvomi hat siebzehn Zimmer in EINEM
Haus - siehe die Eine-Stimme-Regel). Was BLEIBT, ist alles, was die Runden 1-9
an Struktur und Messbarkeit gebaut haben. Der Kanon war nicht der Fehler, seine
woertliche Anwendung auf die Haut war es.

**OWN-WORLD:** Liquid-Glass-Designphilosophie (Lesbarkeit vor Transparenz:
diffuses, sattes Glas, Inhalte opak). SF-Pro-System-Stack, Apple-Typo-Skala
(Body 17, Large Title 34, Footnote 13). WARME Neutrale (#F5F3ED grouped /
#191816 dunkel mit #2B2825-Flaechen). Eine Stimme: das Violett der Bildmarke
#6C3AED. Neun Familientoene als Orientierungsvokabular, im INHALT. Glas nur als
Chrome (Tab-Bar, Sidebar, Sheets), Inhalte opak. Kapsel-Controls,
Inset-Grouped-Listen, Feder-Motion.

**STORY:** Ein Familienmitglied oeffnet die App und sie fuehlt sich an wie ein
Ort, der ihm gehoert: Orientierung in zwei Sekunden, heute zuerst, jedes Modul
ein vertrauter Raum mit eigenem Zeichen - unter einem Dach, das nie die Farbe
wechselt.

**FIRST VIEWPORT:** Dashboard - Large-Title-Gruss, Heute-Programm als
Inset-Grouped-Listen, Glas-Tab-Bar mit eingesetztem FAB (mobil) /
Glas-Sidebar mit farbiger Modul-Legende (Desktop).

**FORM:** User-pinned Kanon (Apple HIG, Liquid-Glass-Designphilosophie;
Messlatte Apple-Systemapps + Fantastical) als STRUKTUR, nicht als Palette.

## Overview

**Creative North Star: "Apples Handwerk, Yuvomis Handschrift"**

Yuvomi ist so gebaut, wie eine mitgelieferte App gebaut waere - und sieht aus wie Yuvomi.
Der Kanon ist die Apple Human Interface Guidelines in der Liquid-Glass-Designphilosophie;
die Messlatte sind Apple-Systemapps und Fantastical. Er gilt fuer die STRUKTUR: Gruppen-
listen, Kapsel-Controls, Typo-Skala, Feder-Motion, die Messdisziplin. Er gilt NICHT fuer
die Haut - warme Buehne, das Violett der Bildmarke als einzige Stimme, neun Familientoene
im Inhalt. Verweigert wird der Kategorie-Standard (freundlicher Pastell-Organizer) ebenso
wie eine App, die aussieht wie irgendeine Systemapp. Diese Linie heisst Lesbarkeit vor
Transparenz: Glas ist diffus und satt statt roh-transparent, und es bleibt striktes
Chrome-Material (Tab-Bar, Sidebar, Sheets, FAB); alle Inhalte sind opak.

**Keine Versionsnummer in der Referenzzeile, und das ist eine gepruefte Angabe.** „iOS 27"
stand bis Runde 6 an neun Stellen im Quelltext und war nicht belegbar: die Suche auf
developer.apple.com findet die Liquid-Glass-Linie als **iOS 26 / macOS 26, eingefuehrt auf
der WWDC25** - das ist die Herkunft, und sie steht genau hier, einmal. Eine
Philosophie-Bezeichnung haelt auch, wenn Apple die naechste Fassung veroeffentlicht. Alles
Gebaute stimmt mit der belegten Linie ueberein; die kollabierende Large-Title-Leiste wird
von ihr sogar ausdruecklich bestaetigt. **Das war eine Korrektur der Referenzzeile, keine
Design-Revision.**

Jedes Modul ist ein vertrauter Raum mit eigenem Tint (Apple-Systemapp-Muster:
jede App ihre Farbe - hier aber im INHALT, siehe die Eine-Stimme-Regel), zusammengehalten
von warmen Neutralen, dem System-Font-Stack
und der Apple-Typo-Skala. WCAG AA ist Invariante, nicht Ambition: Apple-Rohwerte, die AA
verfehlen, werden auf ihre Accessible-Variante vertieft (Apples eigenes
Increased-Contrast-Muster); alle Modul-Tints sind gegen ihre realen Hintergruende
verifiziert. Light und Dark Mode sind gleichrangig; die Dark-Architektur laeuft ueber
private Tokens (`--_name`), die oeffentliche Token-API bleibt stabil.

Rollout-Stand: die ganze App steht in der neuen Welt. Runde 1 zog die geteilten Grundlagen
(Glas nur noch Chrome, EINE Segment-Sprache, keine Akzentstreifen, randlose Karten),
Runde 2 das Kasten-in-Kasten-Vokabular samt Traeger-Regel, Runde 3 die Befunde des
Finish-Reviews: die Zeilenlisten-Regel, EINE Buttonform, EIN Toenungsrezept, das
Wetter-Widget als randlose Karte ohne Verlauf, Notizfarben nach der User-Farben-Regel und
die Anmeldeseite als Teil der Welt. **Das Wetter-Widget hat 2026-08-17 Farbe
zurueckbekommen, aber nicht seinen Verlauf** - die randlose Karte bleibt, der Ton kommt
jetzt aus der Wetterlage statt aus dem globalen Akzent (siehe die Signature Component
„Das Wetter-Widget").

**Der Dashboard-Bogen (v2.4.0 bis v2.6.0) hat die Uebersicht von einem Raster zu einer
Buehne gemacht** - und dabei drei Formen hinzugefuegt, die es vorher nicht gab: das
TAGESPROGRAMM als das eine Blatt, das die Seite anfuehrt (Radius und Elevation setzen den
Rang, nicht Material), das ABSENDERBAND, das die Modulzugehoerigkeit einer Karte aus einer
2px-Haarlinie in eine getoente Kopfflaeche hebt (2026-08-17 vom VOLLTON-SIEGEL abgeloest -
die Waschung konnte im Dark keine Farbe tragen, siehe die Signature Component
„Der Widget-Kopf"), und den WAND-MODUS als den wachen Zustand
derselben Route - dieselbe Flaeche in anderer Gangart, gelesen aus zwei Metern. Erst mit
ihm bekommen die Display-Stufen 48/72px die Rolle, fuer die sie reserviert waren.

**Runde 6 (2026-08-07) hat die Regeln vollstaendig gemacht, statt neue Flaechen zu
gestalten** - und dabei den Satz gelernt, der ueber ihnen steht: **ein Guard ueber eine
Namensliste deckt keine Regel ab, sondern N Dateien.** Deshalb nennt jede Regel hier ab
sofort die EBENE, auf der sie pruefbar ist: Wert (existiert, statisch), Struktur (aus
deklarativen Quellen wie `ROUTES` abgeleitet, nie aus Dateilisten), Signatur (findet
Kandidaten ueber ihre Bauart im Quelltext, nicht ueber ihren Namen) und Dokument
(`npm run test:document-guards`, im gerenderten Zustand). Gebaut wurden: das Kopf-Fundament
und die Leisten-Regel als Kriterium, die vollendete Buttonform samt Label-Verlust- und
Zielgroessen-Regel, die bezahlten Namensschulden (`.list-row`, `.metric-card`, `.auth-*`),
die Zeilenlisten-Regel in Aufgaben und Agenda - und die Wischsemantik, deren Anlass kein
Konsistenzwunsch war, sondern die eine Stelle der App, an der eine Geste sofort und
endgueltig loeschte.

**Key Characteristics:**
- Plattform-Kanon statt Eigenwelt: Apple HIG, Liquid Glass, System-Font-Stack
- Glas nur als Chrome; Inhalte immer opak (Lesbarkeit vor Transparenz)
- Eine Stimme (Bildmarken-Violett) im Chrome, neun AA-verifizierte Familientoene im Inhalt,
  beides auf warmen Neutralen
- Apple-Typo-Skala (Large Title 34 / Body 17 / Footnote 13), Kapsel-Controls, Inset-Grouped-Listen
- Eine Kernform fuer Zeilenfolgen: genau ein Traeger, Zeilen als Haarlinien
- Der FAB sitzt in der Nav-Kapsel und kostet keine Contentflaeche
- Das Dashboard hat zwei Gangarten: Blatt und Raster am Geraet, Wand-Modus auf zwei Metern
- Feder-Motion (Overshoot-Easing) fuer Glas-Elemente, dezente Dauern fuer alles andere
- WCAG AA als Invariante in Light UND Dark, inkl. prefers-reduced-transparency- und prefers-contrast-Fallbacks

## Colors

Warme Neutrale als Buehne, das Violett der Bildmarke als Stimme, 17 Modul-Tints als
Orientierungsvokabular; alle Textfarben AA-vertieft. Es gibt keinen chromatischen
Verlauf auf Inhalt. Die Farbdramatik der App ist auf EINE Gattung beschraenkt: weiche,
kreisrunde Lichtfelder HINTER dem Inhalt, die nie eine Flaeche fuellen und nie unter Text
liegen, wo sie ihn traegt. Zwei Stellen gehoeren ihr an, und beide teilen dieselben
Ausschalter (in reduced-transparency und prefers-contrast auf 0):

- die driftenden **Backdrop-Blobs** hinter dem Glas (`--lg-blob-opacity` 0.16 light /
  0.20 dark);
- der **Lichthauch der Wetterglyphe** (`--weather-glow-opacity`, 2026-08-17), der aus dem
  Zeichen zu kommen scheint und lange vor dem Text auslaeuft.

**Die Unterscheidung ist keine Wortklauberei, sie ist die Lehre aus dem Verlauf, den
Runde 3 entfernt hat.** Der war die Karte: eine deckende Flaeche von Kante zu Kante, im
GLOBALEN Akzent statt in der Domaene, unter der jeder Text stand - und im Dark ein heller
Block im dunklen Dashboard. Ein Lichtfeld hinter einer Glyphe teilt davon keine einzige
Eigenschaft. Was auch nach der Rueckkehr der Farbe gilt: keine getoente Vollflaeche auf
Inhalt, kein Verlauf ueber eine Karte, kein Text auf einer Flaeche, die nicht gemessen ist
(der Sekundaertext ueber dem staerksten Punkt des Lichthauchs haelt 4.82-4.97:1).

### Primary
- **Das Violett der Bildmarke** (`accent-violet` #6C3AED): die Stimme der App. 6.10:1 auf
  Weiss, 5.49:1 auf dem Grouped-Grund; Dark-Variante `#A78BFA` (4.96:1 auf der hellsten
  Flaeche, auf der sie als Text steht). Der getoente Zwilling `accent-light` traegt
  Fokus-Glows und Heute-Chips. Das Dashboard teilt den Wert bewusst als Modul-Tint - es
  ist der Raum der Marke.

  **Hier stand bis 2026-08-10 Apple Indigo** (#5856D6, AA-vertieft auf #4F4DC9), mit der
  Begruendung "Brand-Naehe zur violetten Bildmarke, ohne das alte Violett zu wiederholen".
  Die Farbe war richtig gemessen und trotzdem falsch gewaehlt: die Bildmarke ist violett
  und laut PRODUCT.md als Marke gesetzt, die App war es nicht mehr - Logo und Oberflaeche
  sprachen zwei Farben. Und weil zusaetzlich jedes Modul das Chrome umfaerbte (siehe die
  Eine-Stimme-Regel), kam das Indigo ohnehin nur auf dem Dashboard vor: es gab keine Farbe,
  die app-weit "Yuvomi" hiess.

### Secondary
- **Neun Familientoene, aus denen die Modul-Tints beziehen** (Frontmatter `family-*`,
  Quelle `tokens.css` Abschnitt 4). Die siebzehn Einzeltoene waren siebzehn Entscheidungen und
  enthielten Kollisionspaare, die niemand auseinanderhalten konnte - zwei Violetts, zwei
  Teals. Jetzt gibt es neun klar trennbare Familien (`overview`, `time`, `work`, `kitchen`,
  `money`, `people`, `health`, `records`, `neutral`), jedes `--module-*` bezieht aus seiner,
  und **innerhalb einer Familie unterscheidet das Siegel-Icon, nicht der Ton**. Damit
  verschwinden die Kollisionen strukturell statt durch Nachjustieren. Die Kueche war der
  Praezedenzfall: vier Module, ein Ton, unterschieden durch ihr Zeichen. Die privaten
  `--_family-*` tragen den Dark-Wechsel; die oeffentliche `--module-*`-API bleibt vollstaendig.
- **17 Modul-Tints** (Frontmatter `module-*`): jedes Modul traegt seine eigene Akzentfarbe
  auf seinem Siegel, seinen Leisten und Segmenten, seinen Chips und seinem Widget - aber
  NICHT auf der Shell (Eine-Stimme-Regel). Der Router setzt `--active-module-accent` auf
  `<html>`; Komponenten im Inhalt greifen auf
  `var(--module-accent, var(--color-accent))` zu. Die Kuechen-Gruppe (Mahlzeiten, Rezepte,
  Einkaufen, Vorrat) ist im ROUTING vier Module mit vier eigenen `module:`-Werten und in
  NAVIGATION, AKZENT und STATUSBAR eines; sie teilt den Meals-Tint
  (`--module-kitchen: var(--_module-meals)`) - ein Farbwechsel beim Tabwechsel waere die staerkste
  "du hast den Kontext verlassen"-Botschaft der App; die vier Einzel-Tokens bleiben fuer
  Dashboard-Widgets und Nav-Icons bestehen. Alle Tints sind AA-verifiziert; sieben
  Light-Werte wurden gegen den Grouped-Grund nachvertieft (jetzt >=4.55:1 auf bg,
  >=5:1 auf Weiss). Dark Mode kippt auf vivide Hell-Varianten mit dunkler Tinte
  (`--color-ink-on-vivid`).
- **Die Modul-Identitaet lebt in den Elementen, nicht in der Flaeche.** Die PWA-theme-color
  ist app-weit der Seitengrund (#F5F3ED / #191816, also `--color-bg`), nicht der Modul-Tint.
- **Die NAVIGATION ist die Legende der Modultoene** - Sidebar und Tab-Bar, nicht die eine
  ohne die andere. Seit die Stimme das Chrome traegt, war die Frage offen, wo die neun
  Familien noch SICHTBAR werden, ohne den Rahmen wieder umzufaerben. Antwort: dort, wo alle
  Module nebeneinander stehen - jedes Zeichen in seinem Ton, einmal statt in jedem Zimmer
  (Apples Settings-Muster). Der Ton sitzt auf dem ICON, nie auf Label oder Flaeche: ein Icon
  ist Grafik (3:1), ein Label waere Text und muesste 4.5:1 halten - was sieben der neun
  Familientoene reissen wuerden.
  **Die Regel hing bis 2026-08-17 an einem Breakpoint**, und das war ein Fehler, keine
  Entscheidung: ueber 1024px trug jedes Nav-Zeichen seinen Ton, darunter waren alle grau.
  Dieselbe Komponente sprach je nach Fenstergroesse eine andere Sprache, und ausgerechnet auf
  Telefonen - der Hauptbuehne (PRODUCT.md) - war in der Navigation gar kein Modulton zu
  sehen. Gemessen gegen die Glaskapsel (der echte Grund ist die Mischung aus Kapsel und
  Seite, #F9F9FA / #2B2825): Light 4,79-6,81:1, Dark 4,57-8,41:1 - beides ueber der
  Textschwelle, der Ton ist hier also nicht die Grenze. Aktiv gewinnt in BEIDEN Leisten die
  Stimme zurueck: eine Zeile, die als Ganzes violett ist, deren Zeichen aber allein seine
  Familienfarbe behielte, liest sich als „nicht mitgemeint".
  **Pruefebene: Regel** (`die Sidebar zeigt die Modultoene als Legende` +
  `die Tab-Bar zeigt dieselbe Legende wie die Sidebar`, `test:frontend-audit`) - zwei Guards,
  weil die beiden Faelle getrennt kaputtgehen koennen.
- **DIE VOLLTON-REGEL: was eine Identitaet NENNT, traegt seine Farbe im Vollton** (seit
  2026-08-18). Eine 16-%-Waschung kann eine Farbaussage nicht tragen, und das ist gemessen,
  nicht empfunden: im Dark HELLT eine Beimischung fast nur auf (Buntheit 4-8 von 24-73 des
  Volltons, `dark-chroma.mjs`), im Light kollabieren benachbarte Familientoene auf denselben
  Wert - Notizen, Dokumente und Inventar teilen die Familie `records` und hatten bei 16 %
  BITWEISE denselben Scheibengrund. Die Toenung loescht genau den Unterschied, den sie
  zeigen soll. Die Regel hat zwei Zweige, und welcher gilt, entscheidet die HERKUNFT der
  Farbe:
  - **Kuratierter Ton** (Modul-/Familienton, Kategoriefarbe aus einer festen Liste): die
    Farbe IST die Flaeche, die Tinte ist `--color-ink-on-vivid`. Traeger ist `.vivid-mark`
    (layout.css) - dieselbe Regel, die auch das `.module-seal` haeutet, damit Sheen und
    Tinte nicht auseinanderlaufen koennen; die Geometrie bleibt bei der jeweiligen Marke.
    Gemessen ueber alle betroffenen Marken in beiden Themes, mit und ohne Sheen:
    **light 3,65-7,17:1, dark 6,17-12,24:1** (`.impeccable/redesign-tools/vollton-marken.mjs`) -
    dasselbe Feld, das schon am Siegel steht.
  - **Freie Nutzerfarbe** (Kalenderfarbe, Terminfarbe, Abo-Farbe): der Vollton steht NEBEN
    dem Inhalt, nicht darunter - als 3px-Kante, Ring oder Punkt. Eine Flaeche braucht eine
    Tinte, und auf einer frei gewaehlten Helligkeit gibt es keine (ein schwarzer Termin lag
    bei 1.22:1). Eine Kante braucht keine.

  **DIE GEGENRICHTUNG GEHOERT ZUR REGEL: wer nichts nennt, bleibt neutral.** Ein Platzhalter
  - die Dropzone, das leere Vorschaufeld, der Avatar eines Kontakts ohne Haushalts-
  Verknuepfung - sagte mit einer Modultoenung „Dokumente" auf einer Seite, die das schon
  beantwortet hat. Diese Flaechen sind neutral (`--color-fill-well` plus Sekundaertinte,
  also der dokumentierte Well und keine eigene Erfindung).

  **UND SIE GILT AUCH FUER DEN ORT, AN DEM DIE FARBE GEWAEHLT WIRD.** Die sieben Toene der
  Kontakt-Kategorien standen als sieben Regeln `.contact-group--<key>` in contacts.css -
  ein Selektor auf den Schluessel, der per Konstruktion nur die SEED-Kategorien treffen
  kann. Seit #357 legt der Haushalt eigene an, und die fielen alle auf den Modulton
  zurueck: „Familie" und „Dienstleistungen" sahen gleich aus. Seit Migration 152 traegt
  die Kategorie ihren Ton SELBST, waehlbar aus genau diesen sieben (Endpoint
  `/contacts/meta`, Palette im Kategorie-Manager), und ohne Wahl bleibt sie neutral.
  Gespeichert wird der Token-Ausdruck, nicht ein Hex-Wert - die Toene sind
  themenabhaengig, und ein Hex koennte den Dunkelmodus nicht bedienen (dasselbe Muster
  wie bei den Kontofarben des Budgets).

  **WARUM EINE ALLOWLIST UND KEIN FREIER FARBWAEHLER:** die Kategoriescheibe ist eine
  Vollton-Marke, ihre Tinte ist die feste `--color-ink-on-vivid`. Das haelt nur ueber
  kuratierten Toenen. Eine frei gewaehlte Farbe muesste nach dem zweiten Zweig als Kante
  erscheinen - und damit gaebe es wieder zwei Gesichter fuer eine Marke.

  **DER ANLASS IST EINE WIEDERHOLUNG, und die ist die eigentliche Lehre.** Die Messung von
  2026-08-17 hat `module-seal--vivid` und `--seal-base` gestrichen und einen Guard
  hinterlassen, der die KLASSE nannte. Elf Geschwister derselben Bauart lebten unter anderen
  Namen weiter - die Kategoriescheibe der Kontakte, das Absenderzeichen der Dokumentenkarte,
  das Modulzeichen der Einstellungs-Modulliste, die Marke der geteilten Ausgaben, das
  Schwangerschaftszeichen -, und im Kalender hatte dieselbe Etappe zwei von vier
  Ereignis-Ansichten umgestellt: Woche und Ganztag trugen die Vollton-Kante, Monat und Tag
  nicht. Ein Termin sprach zwei Sprachen, je nachdem welchen Ansichtsknopf man gedrueckt
  hatte. **Ein Guard ueber eine Namensliste deckt keine Regel ab, sondern N Dateien** - zum
  dritten Mal in diesem Projekt.
  **Pruefebene: Signatur** (`eine Marke nennt ihre Identitaet im Vollton, nicht zweimal als
  Waschung`, `test:frontend-audit`). Gesucht wird die BAUART, nicht der Name: ein bemessener
  Behaelter (`width` UND `height` - eine Marke ist bemessen, ein Chip waechst mit seinem
  Text), dessen Hintergrund eine Identitaetsfarbe als Waschung fuehrt und der dieselbe Farbe
  im Vordergrund noch einmal nennt, ohne sie irgendwo voll zu tragen.
- **DIE SKALEN-REGEL: ein Etikett nennt seinen Ton EINMAL, und zwar voll** (seit
  2026-08-18). Die Vollton-Regel hat die MARKEN geraeumt; ihr Guard sucht einen bemessenen
  Behaelter, und genau das liess die zweite Haelfte des Bestands stehen - ein Etikett ist
  nicht bemessen, es waechst mit seinem Text. Die Bauart war dieselbe: getoente Flaeche,
  darauf dieselbe Farbe noch einmal gemischt. Auf einer SKALA kostet sie mehr als an einer
  Marke, weil sie nicht eine Aussage schwaecht, sondern mehrere gegeneinander:
  - Gemessen an den vier Prioritaetsstufen der Aufgaben (`skalen-vollton.mjs`, CIEDE2000
    auf der Kartenflaeche): „Hoch" -> „Dringend" liegt als Waschung bei **3,47 light /
    4,01 dark**. Das ist ueber der Wahrnehmungsschwelle von 2,3, aber ein Drittel dessen,
    was dieses Projekt fuer die Diagramm-Serien als Abstand akzeptiert hat (11,3) - und
    zwei Etiketten der Liste stehen nie nebeneinander, sondern jedes allein in seiner
    Zeile. Im Vollton sind es **12,90 und 23,62**.
  - Und sie verdeckt Stufen, die es gar nicht gibt: `.birthday-chip--default` und
    `--soon` waren BITWEISE identisch, obwohl `countdownChip()` drei Stufen kennt und das
    im Kommentar sagt. Ein Geburtstag morgen und einer in vierzig Tagen sahen gleich aus.
    Niemandem aufgefallen, weil eine Toenung ohnehin kaum etwas sagt.

  **Drei Antworten, und was gilt, entscheidet, was das Etikett SAGT:**
  - **Meldung** (Danger/Warning/Success/Info - Vorrat, Inventar-Status, erwartete Buchung):
    der Ton steht in der SCHRIFT, im vollen Wert, ohne Flaeche. Die semantischen Toene
    halten das als Kleintext (Danger 5,38:1 light / 5,20:1 dark, Warning 4,96 / 7,13 auf
    `--color-surface`) - die Ink-Mischung war hier nie noetig, sie stammt aus der Regel
    fuer MODUL-Toene, die als Schrift wirklich scheitern. Zwei Meldungen nebeneinander
    trennt ein Mittelpunkt ueber den `+`-Kombinator, nicht eine Kapsel.
  - **Rangmarke** (eine Stufe einer geordneten Reihe - Aufgaben-Prioritaet): ein
    8px-Vollton-PUNKT traegt die Farbe, die Schrift bleibt Sekundaertinte. Gescannt wird
    der Punkt, gelesen das Wort. 8px ist das Bestandsmass fuer einen Farbpunkt
    (Kalender-Ebenen, Feiertagsmarke der Agenda). Der Punkt steht seit 2026-08-19 als
    `.priority-dot` in `list-row.css`, nicht mehr in `tasks.css`: dieselbe Stufe erscheint
    auch am Aufgaben-Chip des Kalenders, und ein Page-CSS je Seite heisst, dass tasks.css
    dort gar nicht geladen ist. Die zweite Fassung, die daraus entstand, war ein getoentes
    Feld mit getoenter Schrift - dieselbe Aufgabe sprach je nach Modul zwei Sprachen
    (gemessen lagen die vier Felder 6,61 und 6,77 auseinander, bei 11,3 fuer die
    Diagrammserien). **Wer eine Skala in einem zweiten Modul zeigt, verschiebt ihr Bauteil
    in ein geteiltes Stylesheet, statt es dort nachzubauen.**
  - **Zuordnung** (nennt eine Identitaet): Vollton-FLAECHE mit `--color-ink-on-vivid` -
    aber nur, wenn die genannte Identitaet nicht die des Raums ist, in dem das Etikett
    steht. Sonst greift die Herkunfts-Regel und das Etikett bleibt NEUTRAL
    (`--color-fill-well` plus Sekundaertinte). Nach dieser Haelfte sind acht Stellen
    neutral geworden, die den Modulton in seinem eigenen Modul trugen: Haushalt-Badge im
    Budget, Bedarfs-Badge und Schwangerschaftszeichen in der Gesundheit, Zaehlmarke im
    Mehr-Blatt, Widget-Zaehler, Alters-Badge (es stand neben einem Avatar in der
    MITGLIEDSfarbe), Uhrzeit im Gesundheits-Widget, offener Betrag im
    Haushaltshilfe-Widget.

  **Bedienelemente sind ausgenommen, und zwar mit Grund, nicht mit Namensliste:** fuer sie
  gilt die Eine-Stimme-Regel und ihr eigener Guard. Ein aktiver Filter-Chip beantwortet
  „wo bin ich", und dafuer ist der Modulton zustaendig.
  **Pruefebene: Signatur + Regel** (`was keine Marke ist, nennt seinen Ton auch nicht
  zweimal blass` und `zwei Stufen einer Reihe sehen nie unabsichtlich gleich aus`,
  `test:frontend-audit`). Der erste ist die KOMPLEMENTMENGE des Marken-Guards und traegt
  deshalb kein Namensmuster: alles, was nicht bemessen ist, keinen `cursor: pointer` hat
  und die Farbe nirgends voll traegt. Der zweite vergleicht Geschwister-Modifier EINER
  Basisklasse: malen zwei dasselbe, ohne sich eine Regel zu teilen, ist eine Stufe zu viel
  benannt - teilen sie sich eine (`--disposed, --lost`), ist die Gleichheit ausgesprochen.

### Tertiary
- **Semantik im Apple-Vokabular, AA-vertieft**: Success (Apple Green, 5.1:1), Warning
  (Amber-Braun, bewusst von Danger-Rot getrennt fuer Farbfehlsicht, 4.9:1), Danger
  (Apple Red, 5.4:1), Info (Apple Blue, 5.4:1, getrennt vom Contacts-Tint). Dark Mode:
  vivide Apple-Dark-Werte (#30D158 / #FF9F0A / #FF6961 / #409CFF) mit dunkler Tinte statt
  Weiss; die Toast-Textfarben kippen dafuer ueber eigene Tokens mit.
- **Chart-Serien** (`--chart-series-1..7`): eigene Datenreihen-Palette, bewusst KEINE
  geborgten Modul-Tints (Modulfarben tragen Bedeutung, die in einem Ausgaben-Donut falsch
  waere). Sieben Toene, im Dark aufgehellt auf >=3:1 Grafikkontrast; mehr Segmente werden
  zu "Sonstige" zusammengefasst. **Geborgt heisst gleicher WERT, nicht gleicher Name.**
  Der erste Guard pruefte, ob `--module-*` in der Palette steht - erfuellt, waehrend Serie 2
  buchstaeblich `--_family-money` war (#0F766E light, #2DD4BF dark), der Modulton des
  Budgets, in dem die Palette laeuft. Gemessen wird deshalb wahrnehmungsnah (CIEDE2000,
  Schwelle 2.3 = Just Noticeable Difference) und nur gegen die Module, die Diagramme
  wirklich zeigen: Serie 2 ist seit 2026-08-11 Petrol (#297989 / #22D3EE, dE 11.3 bzw.
  16.2 zu money). Serie 3 (= kitchen) und Serie 7 (= work, dE 1.9) bleiben stehen, weil
  Kueche und Aufgaben keine Diagramme haben - eine Ausnahme mit Verfallsdatum an beiden
  Enden, denn der Guard leitet die geprueften Module aus `router.js` ab und findet sie in
  dem Lauf, in dem dort ein Diagramm entsteht. Serie 1 (Indigo, dE 7.5 zum Akzent) bleibt
  bewusst: sie heisst in der Kontofarben-Wahl "Violett", dort ist die Naehe die Zusage.
- **Prioritaeten** (`--color-priority-low..urgent`): unveraendert aus dem Bestand, die
  Helligkeits-Trennung (High ~1,8x Urgent) ist farbfehlsicht-verifiziert. **Die
  Badge-Fuellung ist seit 2026-08-18 entfallen** (Skalen-Regel, Zweig Rangmarke): der Ton
  steht im 8px-Punkt, das Etikett traegt weder Fuellung noch Kante noch getoente Schrift.
  Was er vorher dreimal blass sagte, sagt er jetzt einmal voll.

### Neutral
- **Grouped Background** (`grouped-bg` #F5F3ED): der App-Grund - warmes Papier in Apples
  Grouped-MUSTER, nicht in Apples Grau. Die Luminanz ist die des abgeloesten systemGray6
  (L=0.8962 gegen 0.8910, also 0,6 % heller), damit der Tausch keinen dokumentierten
  AA-Wert reissen kann. Dark: warme Kohle `bg-dark` #191816 - dreifach ueber dem
  abgeloesten Near-Black #0A0A0C, das auf OLED schlicht "aus" hiess und Karten ohne
  lesbare Tiefe darauf schwimmen liess.
- **Surface** (`surface`, dark `surface-dark`): Karten, Zellen, Arbeitsflaechen
  (`--color-surface-work` fuer lesbare Arbeitsbereiche, `--color-surface-raised` fuer
  subtile Erhoehung).
- **Der Hover ist die naechste Flaechenstufe, keine eigene Farbe** - und deshalb gibt es
  ihn zweimal. `--color-surface-hover` ist der Schritt von `--color-surface` aus;
  `--color-surface-elevated-hover` (seit 2026-08-11) der Schritt von der bereits erhoehten
  Flaeche. Wer im Ruhezustand schon `--color-surface-elevated` traegt - Suchfeld im
  Mehr-Blatt, Suchbereich-Chip, Wieder-einblenden-Chip des Dashboards -, landete ohne diese
  Stufe im Dark auf seiner EIGENEN Farbe: der Hover war dort unsichtbar, gemessen 1:1. Dass
  es vorher trotzdem ging, war Zufall - der alte Dark-Wert sprang zwei Rampenstufen und traf
  so gerade noch darueber. Die Stufe ist nicht neu, sie war nur nie benannt; im Light faellt
  sie mit ihrer Schwester zusammen, weil die helle Rampe dort dicht liegt.
- **Inset-Well** (`fill-well` = `--color-surface-3`): die eine erlaubte Fuellung fuer eine
  Kachel INNERHALB einer Karte. Gemessen 1.20:1 light unter Weiss und 1.16:1 dark ueber
  `surface-dark`; Text darauf haelt AA in beiden Themes (Sonde 2 misst es am gerenderten
  Dokument).
- **Label** (`label` #1D1B17): Primaertext, 17.3:1 auf Weiss. Sekundaer 6.19:1 auf Weiss
  und 5.58:1 auf bg, Tertiaer >=4.6:1 auf bg (auch Placeholder-Farbe), Quartaer nur
  dekorativ, nie Fliesstext.
- **Kanten** (`border` Standard, `border-subtle` Trenner, `border-strong` Hover): im Dark
  Mode eigenstaendig gesetzt (#454039 / #37332E / #6F6A61), weil die Neutral-Rampe dort zu
  dicht an der Flaechenfarbe liegt. Bekannte, dokumentierte Betreiber-Entscheidung: Kanten
  von Bedienelementen erreichen die 3:1 von WCAG 1.4.11 nicht (gemessen 1.26:1 hell auf
  Surface, 1.13:1 auf dem Grouped-Grund, 1.60:1 dunkel; Zielwert waere #949494), wie Apples
  eigene Grouped-List-Separatoren. Der TEXT-Kontrast ist ueberall ohne Verstoss.

### Named Rules
**Die Eine-Stimme-Regel (2026-08-10).** Die App hat GENAU EINE Akzentfarbe, und das ist
das Violett der Bildmarke. Sie traegt alles, was in jedem Modul dasselbe tut: die
Tab-Leiste und die Sidebar samt Aktiv-Pille, den FAB, den Primaer- und Sekundaerknopf,
Umschalter und Checkboxen, den Fokusring, den Datepicker, die Suche und jedes
Shell-Overlay. Der MODULTON traegt, was sagt, wo man ist: das Siegel im Kopf, die Leisten
und Segmente INNERHALB des Moduls, seine Chips und Sektionsmarken, seine Zeilen-Hover,
sein Widget auf dem Dashboard, sein Zeichen in der Sidebar-Legende.

**Das Kriterium ist die Frage, die das Element beantwortet** - "was tut das hier" oder "wo
bin ich". Die Shell beantwortet nie die zweite: sie ist in jedem Modul dieselbe.

Der Anlass war das Urteil des Betreibers, die App fuehle sich "nicht mehr wie aus einem
Guss" an, und die Ursache war genau hier. Der Modulton war ins Chrome gewandert: Tab-Leiste,
FAB, Primaerknopf, Fokusring, sogar die Backdrop-Blobs lasen `--active-module-accent`. Beim
Wechsel Budget → Einkaufen → Aufgaben faerbte sich damit der ganze RAHMEN der App von Tuerkis
auf Rostrot auf Gruen um - nicht das Zimmer, das Haus. Apple faerbt pro APP, nicht pro TAB;
in einer App bleibt der Tint konstant, und der Tab-Name sagt, wo man ist.

**Gemessen und nicht behauptet:** vor der Regel las das Chrome an 43 Stellen in layout.css,
19 in glass.css und 7 in datepicker.css einen Modulton. Danach kein einziges Mal.

Pruefebene: **Struktur** (`test/test-frontend-audit.js`, Guard
`die Shell traegt die Stimme, nicht den Modulton`). Er leitet das Chrome aus SELEKTOR-Formen
ab - Shell-Wurzeln (`.nav-bottom`, `.nav-sidebar`, `.page-fab`, `.more-*`, `.search-overlay`,
`.modal-overlay`, `.app-shell`, `.lg-blob`) plus geteilte Bedienelemente (`.btn--*`,
`.toggle`, `.form-check`, `--focus-ring-color`) -, nicht aus einer Dateiliste; die Liste
waere beim achtzehnten Modul wieder unvollstaendig.

**Die Pro-Hintergrund-Regel.** AA gilt PRO Hintergrund, nicht pro Farbe. Ein Tint, der auf
Weiss besteht, kann auf dem Grouped-Grund reissen (sieben Modul-Tints taten genau das und
wurden nachvertieft). Jede neue Farb-Flaechen-Paarung wird gegen ihren realen Grund
gemessen, in Light und Dark - nicht geschaetzt und nicht aus einer fremden Palette
uebernommen. Als Guard im Repo steht die Messung in `test/test-document-guards.js`
(Sonde 2 misst den komponierten Kontrast am gerenderten Dokument).

**Die Akzent-auf-Toenung-Regel.** Akzent-TEXT auf akzent-getoentem Grund (Chips, Badges,
Avatare) nutzt `color-mix(in srgb, var(--module-accent) 70%, var(--color-text-primary))`;
bewusst kein Token, weil die Formel dort ausgewertet werden muss, wo `--module-accent`
gilt. Nur fuer Text; Icons tragen den vollen Akzent (dort gilt 3:1).
**Ihre Grenze:** die Formel gilt fuer KURATIERTE Modultoene, nicht fuer frei gewaehlte
Nutzerfarben. An den Enden der Helligkeitsachse bricht sie - weiss auf light 1.92:1,
schwarz auf dark 1.97:1, und selbst der graue Avatar-Fallback #8E8E93 landet bei 4.47:1.
Auf einer Nutzerfarben-Toenung traegt der Text deshalb ein TOKEN
(`--color-text-primary`: 9.3-17.0:1 ueber die ganze Palette und ueber Extremwerte).

**Die User-Farben-Regel.** Frei waehlbare Layer-/User-Farben (Kalender-Layer, Feiertage,
Notizzettel, Avatare) sind nie Textfarbe, nur Border oder Dot; Flaechen-Toenungen daraus
laufen ueber die gemessenen color-mix-Rezepte. Insbesondere traegt eine Nutzerfarbe nie
eine ganze Inhaltsflaeche: die Notizkarte tat das bis Runde 3 mit einer zur Laufzeit
gerechneten Textfarbe und war damit die einzige Stelle, an der die Lesbarkeit an einer
ungemessenen Farbe hing (und im Dark-Theme ein Feld heller Pastellbloecke).

**Die Identitaetsfarben-Regel** (2026-08-17, Etappe 4). Wo eine PERSON gemeint ist, spricht
ihre Identitaetsfarbe - und app-weit dieselbe. Ihr Traeger ist die Avatar-Scheibe im VOLLTON;
das ist keine Ausnahme von der User-Farben-Regel, sondern ihr Dot in seiner groessten Form,
und die Beschriftung darauf rechnet `getReadableTextColor()` gegen den gewaehlten Ton statt
gegen eine angenommene Flaeche. Anlass war das Geburtstags-Widget: es toente jede Scheibe mit
dem Modulton, und dieselbe Person leuchtete in der Familien-Kachel und sass eine Karte weiter
grau. **Ihre Grenze ist die Verknuepfung.** Ein Geburtstag ohne Familienmitglied
(`family_user_color` NULL, im Dashboard-Payload per LEFT JOIN mitgeliefert) behaelt die
neutrale Modul-Toenung. Eine gehashte Ersatzfarbe waere schlimmer als keine: sie spraeche die
Farbsprache des Haushalts fuer Fremde.

**Die Toenungsskala-Regel** (loest die frühere Ein-Toenungsrezept-Regel ab, Runde 9).
Jede Toenung nimmt eine benannte Stufe aus `tokens.css` (Abschnitt 6b), keine schreibt eine
Zahl. Die alte Fassung sagte „16 %, EIN Rezept, app-weit" und beschrieb damit 23 von 214
gemessenen Stellen; die uebrigen 191 hatten keinen Wert zu greifen und schrieben ihren
eigenen hin - 37 Prozentstufen.

Die sieben Stufen und ihre Rollen: `--tint-wash` (8 %) untergreift FREMDEN Inhalt (Leisten,
Banner, ganze Zeilen, Kalenderfelder); `--tint-state` (12 %) ist ein Zustand auf ungetoenter
Flaeche; `--tint-surface` (16 %) ist die Toenung, die das Element SELBST ist (Chip, Badge,
Icon-Well, Notizkarte, Event-Bar); `--tint-raised` (24 %) ein Zustand darauf; `--tint-hint`
(50 %) eine Andeutung (Kante, Linie, Leerzustands-Icon); `--tint-ink` (70 %) Text auf
getoenter Flaeche; `--tint-shadow` (20 %) ein Schatten daraus.

Die vier Flaechenstufen sind eine LEITER, und ein Zustand steigt eine Sprosse. Die
Unterscheidung wash/surface ist gemessen und keine Stilwahl: die niedrigen Fundstellen sind
im gerenderten Dokument im Median 47.520 px2 gross, die hohen 1.764 px2 - Faktor 27. Eine
Leiste traegt bei 1,11:1 Farbe ins Bild, wo ein 24px-Badge bei demselben Verhaeltnis
verschwindet; 16 % traegt in beiden Themes (1,19-1,41:1 gegen den jeweiligen Grund).

Was KEINE Toenung ist: Deckwerte ab 45 % (die Farbe IST dort die Flaeche und wird
verdunkelt), Nutzerfarben als Text (dort gilt die User-Farben-Regel) und Animationsstufen in
`@keyframes`. Pruefebene: Signatur (`jede Toenung nimmt eine Stufe der Toenungsskala`,
`test:frontend-audit`).

**Die Waschung untergreift fremden Inhalt - aber sie kann im Dark keine FARBE tragen
(Grenze nachgetragen 2026-08-17).** Zwei Stellen haben 2026-08-11 von einer Linie oder
einer neutralen Flaeche auf `--tint-wash` gewechselt („Farbe wird Flaeche, nicht Strich",
v2.6.0): der Widget-Kopf des Dashboards und die angeheftete Notiz, die ihre Notizfarbe
zurueckbekam. Die Notiz traegt sie weiter - dort ist die Waschung ein ZUSTAND auf heller
Flaeche und tut, was die Skala verspricht. Der Widget-Kopf dagegen wollte mit der Waschung
FARBE sagen, und genau das kann sie im Dark nicht: die CIEDE2000/LCh-Zerlegung
(dark-chroma.mjs) zeigt, dass die 8-%-Mischung dort fast nur AUFHELLT (Buntheit 4-8 gegen
24-73 des Volltons). Das Absenderband ist deshalb 2026-08-17 dem Vollton-Siegel gewichen
(siehe „Der Widget-Kopf"). Die Rollen-Grenze der Skala bleibt unveraendert:
`--tint-surface` ist die Stufe eines Chips, der SELBST das getoente Objekt ist, und
Farbaussagen gehoeren in Volltonelemente, nicht in Beimischung.

**Die Tagesmarke-Regel (2026-08-19).** „Heute" ist in jedem Modul dieselbe Aussage, also
traegt sie die STIMME. Wo eine TAGESZELLE den aktuellen Tag markiert, gehoert ihr die
Vollton-Marke in `--color-accent` mit `--color-ink-on-vivid` darauf, und die Zelle bekommt
weder Fuellung noch Rahmen - der Kanon, den der Kalender seit jeher fuehrt
(`.month-day--today .month-day__number`, `.week-view__day-num--today`) und dem der
Datepicker mit seinem Inset-Ring folgt. Kreis, wo eine Ziffer steht; Kapsel, wo ein Datum
steht.

Der Anlass war das Wochenboard der Kueche: es faerbte Wochentag UND Datum in
`--module-accent` und war damit die dritte Fassung von „heute" neben den zwei des
Kalenders - eine Marke, die ihre Identitaet als getoente SCHRIFT nennt statt im Vollton,
und dafuer auch noch den Modulton im eigenen Modul nimmt, wo der Kopf die Herkunft
laengst beantwortet. Das Nachziehen ueber die Bauart fand die zweite Fundstelle sofort:
der Zyklus-Kalender ringte seinen heutigen Tag im Gesundheitston, und das ist im
Zyklus-Gitter ausgerechnet der Ton, der den PHASEN am naechsten liegt (CIEDE2000 gegen
`--cycle-period`: **17,23 light / 14,33 dark**; in der Stimme 31,50 / 25,97, und der
engste Abstand des ganzen Gitters steigt damit von 17,23/14,33 auf 26,60/25,97). „Heute"
liegt regelmaessig auf einem geloggten Tag - dann stehen beide Ringe an derselben Zelle.

**Zwei Kategorien sind ausdruecklich NICHT gemeint, und beide unterscheiden sich nach der
Bauart, nicht nach einer Ausnahmeliste.** Eine FRISTMELDUNG („heute faellig",
`.due-date--today`, `.housekeeping-task--today`) sagt nicht „das ist der heutige Tag",
sondern „das ist jetzt dran", und traegt die Warnfarbe. Und die GEBURTSTAGSZEILE behaelt
ihren Modulton mit der Begruendung, die im Quelltext steht: die Zeile beantwortet „wann",
und der eine Tag, an dem die Antwort HEUTE lautet, ist der Anlass des ganzen Moduls -
gemessen 5,08:1 light / 7,35:1 dark. Beides sind Zeile, Chip oder Textspanne, keine
Tageszelle. Pruefebene: Signatur (`eine Tagesmarke traegt die Stimme, nicht den Modulton`,
`test:frontend-audit`) - der Guard sucht einen exakten Namensabschnitt `day` im Selektor,
weil ein `includes('day')` `birthday` mitfaengt.

## Typography

**Display/Body Font:** System-Stack (-apple-system, BlinkMacSystemFont, "SF Pro Text",
"Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif)
**Mono Font:** ui-monospace, 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace

**Character:** SF Pro auf Apple-Geraeten, die ehrliche Plattform-Grotesk ueberall sonst.
Keine Webfonts, keine Displayschrift; die Stimme ist die des Betriebssystems. Jede Rolle
ist genau einmal definiert (typography.css); ein Element nimmt sie ueber die
`u-*`-Utility-Klasse oder ueber seinen dort registrierten BEM-Selektor an.

### Hierarchy
Apple-Skala: Large Title 34, Title 2 22, Title 3 20, Headline 17 semibold, Body 17,
Subheadline 15, Footnote 13, Caption 2 11.

- **Large Title** (bold, 34px, lh 1.21, Tracking -0.015em): Seitentitel, Dashboard-Gruss und
  seit Runde 3 auch der Anmelde-Titel; bleibt auf Desktop stabil 34px. Traegt IMMER
  Label-Farbe.
- **Title 1** (bold, 28px, lh 1.21, Tracking -0.015em, `tabular-nums`): die KENNZAHL einer
  Karte, nicht eine Ueberschrift - der Kontosaldo, die Temperatur, die Uhrzeit der
  Uhr-Kachel. Sie steht gestapelt (kleines Label darueber, Zahl darunter), nie als Zahl am
  rechten Ende einer Beschriftungszeile: so gebaut ist sie anatomisch dasselbe wie die
  Nebenzeile darunter, und die Hauptaussage der Karte sieht aus wie ihre Fussnote.
- **Title 2** (bold, 22px, Tracking -0.015em, `text-wrap: balance`): Modul-Kopf-Titel im
  Canonical Page Head - EINE Rolle fuer alle Module, Settings-Leaf und Split.
- **Title 3** (semibold, 20px, lh 1.3): Bereichs-Ueberschrift in Satzschreibung.
- **Headline** (semibold, 17px, lh 1.3): Karten-/Item-Titel. Die Dichte-Variante
  (`.u-compact`, 15px) macht hohe Informationsdichte zur bewussten Entscheidung statt zum
  Groessen-Override pro Selektor.
- **Body** (regular, 17px, lh 1.47 = Apples 17/25): Fliesstext, Listenzellen.
- **Subheadline** (regular, 15px): Sekundaerzeilen.
- **Footnote** (medium, 13px, lh 1.21): Metazeilen, Label ueber Feldern, das Versal-Datum
  ueber dem Gruss.
- **Versal-Mikro-Label** (semibold, 12px, Tracking 0.05em, uppercase): der Sektionskopf
  einer Grouped-Liste. 0.05em (`--tracking-label`) ist der EINE Tracking-Wert und hat sechs
  gestreute Werte abgeloest.
- **Caption 2** (semibold, 11px): Badges, Zaehler.
- **Navigations-Gruppierungslabel** (semibold, 12px, Satzschreibung): Sidebar-Sektionen,
  Settings-Domaenen, Aufgaben-Gruppen. Ganze Phrasen lesen in Versal + Tracking geschrien
  und laufen dem warmen Familien-Ton zuwider.
- **Display** (bold, `clamp(48px, 9vw, 72px)`): die Wand-Uhr, und seit v2.5.0 der einzige
  Ort, an dem die zwei Display-Stufen ueberhaupt stehen. Sie existieren NUR fuer
  Anzeigewerte auf Distanz, nie fuer Ueberschriften; die Ueberschriften-Skala endet bewusst
  bei 34px. Die Stufen sind die Enden eines `clamp`, kein fester Wert - was aus zwei Metern
  lesbar sein muss, haengt an der Flaeche, nicht an einer Zahl.
- Inputs nie unter 16px (`--text-base`, iOS-Zoom-Schwelle).

### Named Rules
**Die Kopf-Abgrenzungs-Regel.** Zwei Kopfrollen, und was ein Kopf benennt entscheidet
welche: benennt er einen BEREICH der Seite ("Heute wichtig", "Punktestaende", "Nach
Kategorie", "Transaktionen"), ist er eine Ueberschrift in Satzschreibung. Wiederholt er
sich mit wechselndem Wert ueber EINE Liste (Kategorie in Kontakten, Mahlzeitentyp im
Wochenplan, Monat in einer Chronik), ist er ein Versal-Mikro-Label. Nicht der Traeger
entscheidet, sondern das Benannte. Ausgeschrieben in typography.css.

**Die Leisten-Regel.** Ob ein Seitentitel ueber einer Leiste steht, entscheidet der
`module:`-Wert der Zielroute (`ROUTES` in `router.js`). Wechselt die Leiste ihn, ist SIE die
Kopf-Navigation und traegt keinen Titel ueber sich - der Tab-Name IST der Modulname (Kueche:
vier eigenstaendige Module unter einer Leiste). Wechselt sie ihn nicht, oder wechselt sie gar
keine Route, gehoert sie unter den Large Title in den kanonischen `page-toolbar`-Kopf
(Gesundheit, Budget, Belohnungen, Haushaltshilfe). Sektionen mit eigener Shell
(Einstellungen) fuehren ihren Titel in ihrem eigenen Kopf; das ist der dritte Fall der Regel,
keine Ausnahme von ihr - als Ausnahme stuende er beim achtzehnten Modul wieder offen.

Nicht die Bauart entscheidet: `renderSubTabs` gegen `wireTablist` ist eine
Implementierungswahl, und bei der Gesundheit faellt beides auseinander - ihre Tabs sind echte
Routen und tragen trotzdem alle `module: 'health'`. Sie war deshalb bis Runde 6 das einzige
Modul mit Sichtwechsel ohne Seitentitel. An der Stelle, die das haette beantworten muessen,
stand „aus Layout-Gruenden": eine Beobachtung, kein Kriterium. Liegt die Leiste IM Kopf, gibt
sie dessen Rail-Verhalten ab (Sticky, Grund, Trennlinie, Hoehe) - derselbe Satz wie beim
Well: der Traeger entscheidet.

**Die Keine-sichtbare-Titelwiederholung-Regel.** Traegt eine Leiste den Namen eines Panels
bereits - Sub-Tabs in Gesundheit, die Navigation in den Einstellungen -, dann benennt eine
Ueberschrift direkt darunter keine Ebene, sondern verdoppelt Information. Alle sechs
Gesundheits-Panels taten das wortgleich ("Uebersicht" ueber "Uebersicht"), fuenf
Settings-Blaetter zuvor ebenso. Unsichtbar (`.sr-only`) darf und soll die Ueberschrift
stehen bleiben: sie haelt die Dokumentgliederung zwischen dem `h1` des Moduls und den `h3`
der Abschnitte, und ein `role="tabpanel"` traegt denselben Namen ohnehin im `aria-label`.
Verboten ist nur, sie zu ZEIGEN.

Dasselbe gilt eine Ebene tiefer: ein Abschnitt, der heisst wie sein Panel, benennt sich
gegen seine Geschwister nicht ("Medikamente" neben "Heute faellig" wurde "Alle
Medikamente"). Der Guard prueft JEDES Modul, das eine Leiste rendert, und leitet Leiste wie
Ueberschriften aus dem Markup ab. Zwei Vorfassungen waren Dateilisten: die erste kannte nur
die Einstellungen, die zweite nahm die Gesundheit dazu - eine Allowlist mit zwei Eintraegen.
Der erste Lauf der Regel fand sofort, was beide uebersahen: das Budget zeigte einen Tab
„Budget" unter dem Titel „Budget". Aufgeloest wurde das ueber den TAB, nicht ueber den Titel
(„Uebersicht") - das Budget hat sieben Tabs, von denen einer zufaellig den Modulnamen trug.

**Sie gilt auch fuer Laufzeitdaten, und dort war sie zwei Runden lang blind.** Der Einkauf
zeigte den Namen der gewaehlten Liste zweimal: als aktiven Chip der Listenwahl und direkt
darunter als Kopf mit Umbenennen-Stift und Ueberlaufmenue. Der Guard sah das aus drei
Gruenden nicht - die Chip-Leiste traegt kein `role="tablist"`, der Titel war kein `h1-3`
(ein `span.page-toolbar__title`), und der Name ist gar kein i18n-Key, sondern
`state.activeList.name`. Ein statischer Test kann diesen WERT nicht kennen; er kann aber
die STRUKTUR sehen: rendert eine Seite eine Auswahlleiste ueber eine Sammlung und zeigt sie
dasselbe Feld des GEWAEHLTEN Eintrags noch einmal in einem Titel-Slot, steht derselbe Text
zweimal auf der Seite - unabhaengig davon, welcher es zur Laufzeit ist. Das prueft seit
2026-08-11 eine zweite Sonde in `test-typography.js`. **Der gewaehlte Eintrag IST der
Titel**; was der Kopf sonst trug, gehoert neben ihn - im Einkauf an das hintere Ende der
Chip-Zeile, wo ein Ueberlaufmenue Umbenennen, Import, Kategorien und Loeschen fuehrt. Der
Umbau nahm mobil rund 64px (53 % auf 62 % Contentflaeche, gleichauf mit Aufgaben und
Budget) und loeschte dabei zwei Sonderbehandlungen, die es nur wegen des Kopfes gab: die
responsive Doppelfassung der Aktionen und eine `max-height`-Media-Query, die Listenwahl und
Kopf im Querformat nebeneinander zwang.

**Die Label-Farben-Regel.** Large Titles tragen immer `--color-text-primary`; kein
Gradient-Text und kein Akzent-Titel (beides gehoerte zur abgeloesten Welt; die Tageszeit
spricht allein ueber den Grusstext, die Marke allein ueber das Tile).

**Die Echte-Information-Regel.** Die Versal-Footnote ueber dem Large Title (Apple-News-
Muster, z. B. das Intl-formatierte Datum im Dashboard-Masthead) ist echte Information und
Kanon-Bestandteil. Dekorative Kicker und Eyebrows ohne Informationswert bleiben verboten;
die generische Opt-in-Klasse dafuer ist mit dem Rollout entfallen, weil ihr Name zur
Rueckkehr des Musters einlud.

**Die Initialen-Schwelle-Regel** (2026-08-17, Etappe 3). Unter der Lesbarkeit gibt es keine
Initialen, nur die Farbe. Ein Avatar zeigt seine Initialen - und der Stapel sein „+N" - erst
ab 20px Scheibe und dann nie unter 11px, dem Wert von Caption 2 und damit der kleinsten
Textrolle, die die App ueberhaupt kennt (Verhaeltnis <= 0.55 statt der freien Proportion).
Darunter IST die Scheibe der Kanal: die Nutzerfarbe traegt per Identitaetsfarben-Regel
ohnehin das Signal, der Name steht im `title`. Vorher stand hier eine 9px-Untergrenze, und
die Kalender-Gitter riefen mit `size` 14-16 genau hinein (Sonde `undersized-ui-text`, 13
Fundstellen). Ein 9px-Text sagt weniger als ein sauberer Punkt.

## Layout

- **Grund-Raster:** 4px (`--space-1` = 4px bis `--space-16` = 64px). Content-Spalte max
  1280px (`--content-max-width`), schmale Lesespalte 720px (`--content-max-width-narrow`).
- **Seiten-Gutter:** ein kanonischer Wert `--page-gutter` (16px, ab 1024px 32px), damit
  Kopf und Inhalt dieselbe Fluchtlinie haben. Full-Bleed-Koepfe ruecken ihren Inhalt per
  `--page-inline-pad` auf die zentrierte Spalte - genau EINMAL pro Ahnenkette, sonst
  addieren sich die Raender (Guard `page-inline-pad contract`).
- **Breakpoints, verbindlich:** <=640 Mobile (eine Spalte, Bottom-Nav), 768 Tablet,
  >=1024 Desktop (Sidebar, mehrspaltig), >=1440 Wide; dazu die zweite Achse <500px Hoehe
  (kompakte Hoehe, siehe „Die Chrome-Regel"). Komponenten-interne Umbrueche gehoeren in
  @container-Queries, nicht in neue Viewport-Breakpoints.
- **Was von der Breite eines BAUSTEINS abhaengt, fragt seinen Container - und die Regel hat
  zwei gemessene Anlassfaelle.** Das Notizen-Raster im Dashboard haengte seine Spaltenzahl
  an Viewport-Breakpoints und stand ab 1024px dreispaltig, auch wenn die Notizkarte selbst
  nur EINE Rasterspalte breit war: drei Notizen in je ~105px, uebrig blieben drei Ellipsen
  nebeneinander. Seine Schwellen sind jetzt Kartenbreiten und aus der Kachel
  zurueckgerechnet (eine Notizkachel braucht ~200px fuer Titel und zweizeilige Vorschau,
  also 420px fuer zwei und 620px fuer drei). Die Wand-Buehne schaltet aus demselben Grund
  auf zwei Spalten - ein fuenfter Viewport-Breakpoint neben den vier verbindlichen waere die
  Alternative gewesen.
  **Die Falle dabei:** `container` gehoert an den VORFAHREN, nie an das Element, das die
  Query stellt - `@container` sucht immer aufwaerts. An der Buehne selbst deklariert, blieb
  die Regel darunter wirkungslos und die Wand einspaltig, bei jeder Breite und ohne
  Fehlermeldung.
- **Dashboard-Raster:** `auto-fill` mit Mindestspalte 280px (`minmax(min(100%, 280px), 1fr)`)
  und `dense`-Flow. Bei 240px legte ein 1440er-Fenster vier 270px-Spalten an, in denen die
  Ellipse reihenweise echte Inhalte kappte („Familienmitg…", „Tante Claire Bec…"). Eine
  Spalte, in der Namen nicht ganz stehen, ist keine Spalte; drei ruhige tragen dieselben
  fuenf Karten besser als vier gedraengte, und ab ~1700px kommt die vierte von selbst
  zurueck.
- **Navigation:** mobil eine schwebende Glas-Tab-Bar-Kapsel (60px hoch plus 8px Luft und
  safe-area; die Bar-Zone selbst ist transparent, das Glas traegt die Kapsel). Ab 1024px
  Glas-Sidebar (56px kollabiert / 220px expandiert) mit gleitender Aktiv-Pille.
- **Touch-Targets:** `--target-base` 44px auf Zeigergeraeten, waechst via
  `@media (hover: none)` auf 48px. Das Kriterium ist die Zeigerfaehigkeit, nicht die Breite;
  die 44pt der iOS-HIG sind ein Minimum, kein Ziel.
- **FAB-Geometrie:** `--target-base` unter 1024px (44px am Zeiger, 48px am Finger), weil der
  Knopf dort IN der Nav-Kapsel sitzt, und `--target-lg` (48px) ab 1024px, wo er wieder frei
  ueber dem Inhalt schwebt. **Hier stand bis 2026-08-11 „52px mobil, 48px ab Desktop":** die
  52px sind das Grundmass des frei schwebenden Knopfes in der Wurzel und werden von beiden
  Groessenklassen ueberschrieben, greifen also in keinem Viewport mehr. `--fab-safe-zone` ist
  der NACHLAUF am Inhaltsende (`padding-block-end` an `.app-content`), sodass am Scroll-Ende
  nichts Bedienbares unter dem Knopf liegt; unter 1024px ist sie 0, weil er dort in der
  Nav-Kapsel sitzt. Der FAB lebt in der Shell-Layer `#fab-layer`, nicht im Scrollport. Siehe
  „Die Nachlauf-Regel".
- **Icon-Stufen:** genau vier (12/16/20/24px, `--icon-sm..xl`); Lucide bleibt das Icon-Set,
  keine Glyphen-Fonts.
- **Ein Modul fuehrt EIN Zeichen, in EINER Hand** (2026-08-17). Wo ein Modul sich zu erkennen
  gibt - Leiste, Sidebar, „Mehr"-Blatt, Widget-Kopf, Kennzahl-Kachel, „Heute wichtig", Suche,
  Wand -, zeichnet Yuvomis eigener monoliniger Satz (`public/nav-icons.js`); was er nicht
  kennt, faellt auf Lucide zurueck. Aktions- und Zustandszeichen (Chevron, Plus, Uhrzeit-Slot
  einer Mahlzeit) bleiben Lucide - sie beantworten nicht „welches Modul".
  **Der Fehler war nicht ein falscher Glyph, sondern die dritte Tabelle:** die Zuordnung
  Modul → Zeichen stand in `navItems()`, in `widgetIcon()` und noch einmal an jeder
  `widgetHeader()`-Aufrufstelle. Sie sind auseinandergelaufen - Notizen war in der Leiste ein
  Zettel (`sticky-note`) und im Widget-Kopf eine Stecknadel (`pin`), Haushaltshilfe ein Pinsel
  und auf der Kachel Funkeln (`sparkles`). Jetzt gibt es `MODULE_ICON`, und die Koepfe
  bekommen ihre WIDGET-ID statt eines Icon-Namens: die Abweichung ist nicht mehr schreibbar.
- **Die Strichstaerke ist die Handschrift, nicht ein Zufall** (`--icon-stroke`, 1.35 gerenderte
  px plus `vector-effect: non-scaling-stroke` auf Siegel- und Nav-Zeichen). Der eigene Satz
  zeichnet mit 1.6 auf viewBox 24, Lucide mit 2; bei 20px bzw. 16px ergab beides zufaellig
  1,333px - die Uebereinstimmung hing an den GROESSEN, nicht an einer Regel, und fiel, sobald
  ein eigenes Zeichen bei 16px stand. CSS schlaegt das `stroke-width`-Attribut, deshalb gilt
  der Wert fuer beide Haende.
- **Motion:** Dauern kanonisch 80-400ms (`--duration-2xs..2xl`), immer in ms. `--ease-out`
  cubic-bezier(0.16,1,0.3,1) fuer Einblendungen; Feder mit Overshoot `--ease-glass`
  cubic-bezier(0.34,1.56,0.64,1) fuer Glas-Elemente; die Sidebar-Pille bekommt die sanftere
  Feder `--ease-sidebar-glide`, damit sie nicht ueber das Ziel-Item hinausschiesst.
  prefers-reduced-motion schaltet Signature-Animationen ab.
- **Scroll-Affordanz:** horizontal scrollende Leisten (Chip-Reihen, Filterzeilen) tragen
  eine Fade-Mask an der ueberlaufenden Kante (`has-fade-start`/`has-fade-end`, gesetzt von
  `wireScrollFade`) und 24px `scroll-padding-inline`, damit das erste sichtbare Element nicht
  an der Kante klebt.

## Elevation & Depth

Hybrid aus zurueckhaltenden iOS-Schatten fuer opake Inhalte und Glas-Material fuer
Chrome. Tiefe entsteht primaer ueber Material (Blur + Transluzenz + Specular-Kanten), nicht
ueber dramatische Schatten. Dark Mode verstaerkt die Schatten deutlich (Glas braucht dort
mehr Trennung vom dunklen Grund) - und seit der Dark-Kur (2026-08-17) tragen auch die
opaken Stufen sm/md/lg/xl dort den 1px-Weiss-Ring der Glas-Schatten (0.05-0.06): ein
rgba(0,0,0)-Wurf auf der Kohle-Buehne ist gemessen unsichtbar, der Ring ist die Trennung,
die der Schatten im Dark nicht leisten kann. Im Light bleibt der Ring den Glas-Schatten
vorbehalten; xs bleibt in beiden Themes ohne Ring.

### Shadow Vocabulary
- **shadow-xs** (`0 1px 2px rgba(0,0,0,0.08)`): kleinste Abhebung.
- **shadow-sm** (`0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04)`): Karten und
  Zeilen-Traeger in Ruhe.
- **shadow-md** (`0 2px 10px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)`): Dropdowns,
  Hover, Marken-Tile.
- **shadow-lg** (`0 8px 28px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.04)`): Modals, FAB.
- **shadow-xl** (`0 18px 56px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.06)`): hoechste Ebene.
- **glass-shadow-sm/md/lg**: Glas-Varianten mit eingebautem 1px-Weiss-Ring
  (z. B. `0 6px 24px rgba(0,0,0,0.10), 0 0 0 1px rgba(255,255,255,0.50)`). Ausnahme: die
  schwebende Tab-Bar-Kapsel traegt einen eigenen dunklen Halt, weil der weisse Ring auf dem
  hellen Grouped-Grund unsichtbar ist und die Kapsel sonst formlos schwimmt.
- **Specular-Insets**: `--glass-inset-soft..strong` (inset 0 1px 0 Weiss 0.18-0.32) als
  Oberrand-Lichtkante, komplementaer `--glass-inset-bottom-*` (dunkler Unterrand).
  `--glass-sheen` ist der gethemte Flaechen-Lichtfang der oberen Kapselhaelfte (light 0.35,
  dark bewusst nur auf 0.16 abgesenkt statt auf die 0.09 der Kanten-Highlights, damit
  getoentes Glas im Dark-Theme von einer opaken Flaeche unterscheidbar bleibt).

### Named Rules
**Die Glas-ist-Chrome-Regel.** backdrop-filter existiert nur auf Chrome-Elementen:
Tab-Bar-Kapsel, Sidebar, Sheets/Modals, Toast, Datepicker-Popover, FAB samt seinem
Backdrop und seinen Aktionen. Inhalte - Karten, Listen, Widgets, Text - sind opak.
Blur-Stufen kanonisch 2/6/10/20/32px (`--blur-2xs..lg`).

**Der Modulkopf traegt KEIN Glas, und das ist eine begruendete Abweichung vom Kanon, keine
Auslassung.** Die belegte Liquid-Glass-Linie fuehrt Navigationsleisten transparent; Yuvomi
stellt den Kopf nahtlos und opak auf den Seitengrund (`--color-bg`). Zwei Gruende, beide
gemessen: die kollabierende Large-Title-Leiste lebt davon - Glas zeigte am Scroll-Anfang
eine Flaeche, wo gerade keine sein soll, und haette die gewonnene Ruhe wieder aufgehoben -
und `position: sticky` plus `backdrop-filter` in einem `overflow: auto`-Container leert auf
iOS 26+ den ganzen Scrollport (WebKit-Compositor-Bug, der Kommentar steht an der Regel).
Der Guard `Der Modulkopf traegt kein Glas, und das bleibt so` haelt sie: er lernt die
Kopf-Klassen aus dem Markup, damit auch ein Modul auffaellt, das seiner EIGENEN Kopfklasse
Glas gaebe. Der letzte Rest der alten Annahme - ein
`prefers-reduced-transparency`-Fallback fuer fuenf Modul-Koepfe, der ein backdrop-filter
abschaltete, das keiner mehr trug, und sie dabei auf `--color-surface` umfaerbte - ist mit
Runde 6 entfallen.

**Die Rang-Regel (v2.6.0).** Welchen Rang ein Block auf seiner Seite hat, sagen RADIUS und
ELEVATION - nie das Material. Wer wichtiger ist, bekommt die groessere Kartenform und eine
Schattenstufe mehr, und er bleibt trotzdem opaker Inhalt; Glas waere hier der falsche Griff,
weil es Chrome bedeutet und nicht Bedeutung.

Der Anlass war das Tagesprogramm: es lag auf `--radius-lg` plus `--shadow-sm` und damit eine
Stufe UNTER den Widgets darunter, die `--shadow-md` tragen. Der wichtigste Block der Seite
war der leiseste - „Was steht heute an?" wog optisch weniger als „Geburtstage". Es traegt
jetzt `--radius-xl` (26px, die Kartenform der Glas-Welt) und `--shadow-lg`, und der Abstand
zum Raster ist damit eine Stufe in beide Richtungen. Dieselbe Rechnung ist auch der Grund,
warum es mobil nicht mehr schrumpft: auf dem Geraet, das PRODUCT.md als Hauptszene fuehrt,
war es die kleinste Fassung seiner selbst.

**Die Fallback-Regel.** Jede Glas-Flaeche hat einen opaken Fallback. Nicht-Blur-Stile
(background, border, shadow) stehen AUSSERHALB von `@supports` und wirken ueberall; nur der
backdrop-filter steht drin (mit webkit-Zwilling fuer Safari < 18). prefers-reduced-
transparency kippt alle Glas-Tokens auf `--color-surface`-Werte und alle Blur-Stufen auf 0;
prefers-contrast: more haertet Kanten auf Textfarben, schaltet Blur und Backdrop-Blobs ab
und hebt den Notes-Tint auf 6.3:1.

## Shapes

Apple-Kurvatur, durchgehend gerundet, nie scharfkantig: Formfelder und Zellen 10px
(`--radius-sm`), Karten 12px (`--radius-md`), Zeilen-Traeger und grosse Flaechen 16px
(`--radius-lg`), Sheets und Glas-Chrome 26px+ (`--radius-xl`, `--radius-glass-card` 26 /
`--radius-glass-inner` 18), Kapseln und Pillen `--radius-full` (Tab-Bar-Kapsel, FAB, Chips,
ALLE Buttons). Sheets runden oben (`var(--radius-xl) var(--radius-xl) 0 0`). Ein
border-radius wird ausschliesslich ueber ein Radius-Token oder eine Prozentangabe gesetzt
(Guard in test-frontend-audit.js).

**Die Konzentrik-Regel.** Verschachtelte Rundungen sind konzentrisch: der innere Radius ist
der aeussere minus Abstand, ausgeschrieben als `calc(var(--radius-*) - Npx)` bzw. `+ Npx`
fuer Umhuellungen (belegt in tasks.css, documents.css, health.css). Nie denselben Radius
blind nach innen kopieren.

## Components

### Buttons
- **Shape:** die Kapsel (`--radius-full`) in der `.btn`-Basisregel, min-height 48px, Padding
  8px 16px, Label 14px medium. EINE Form fuer ALLE Varianten - primary, secondary, ghost,
  danger, icon, icon-sm. Bis Runde 3 stand `--radius-md` in der Basisregel, waehrend
  glass.css primary/secondary auf `--radius-full` zog: welche Form ein Button bekam,
  entschied die Ladereihenfolge. Die Kapsel gewinnt, weil der Direction Contract
  "Kapsel-Controls" ausdruecklich nennt.
- **Primary:** die STIMME leicht abgedunkelt (`color-mix(in srgb, var(--color-accent) 88%,
  var(--neutral-950))`) mit `--color-ink-on-vivid` (light weiss, dark dunkle Tinte) und
  shadow-sm plus Specular-Inset. **Hier stand bis 2026-08-12 „Modul-Akzent":** derselbe Rest
  aus der Zeit vor der Eine-Stimme-Regel, den der FAB-Abschnitt einen Tag zuvor abgelegt
  hat. `layout.css` liest `--color-accent`, seit die Regel gilt; der Primaerknopf tut in
  jedem Modul dasselbe und ist damit nach ihrem Kriterium eindeutig. Auf modullosen Routen
  (Login, Setup) war er ohnehin immer die Stimme.
- **Hover:** vertieft auf 76-%-Mix, shadow-md, Transitions 150ms.
- **Fokus (app-weit):** 2px-Ring in `--focus-ring-color` (= `var(--color-accent)`), Offset
  2px. **Auch hier stand bis 2026-08-12 der Modulton** - und er war die groesste einzelne
  Fundstelle im Chrome, weil jedes fokussierbare Element der App an diesem einen Token
  haengt. Die zwei Zeilen werden
  ausgeschrieben, kein Shorthand-Token: ein Shorthand auf `:root` baeckt die Farbe ein und
  lokale Ueberschreibungen blieben wirkungslos. `--focus-ring-offset-inset` (-2px) ist nur
  fuer Elemente an einer geclippten Kante da.

**Die Eine-Buttonform-Regel.** Es gibt genau eine Buttonform, und sie steht genau an einer
Stelle. Der Guard `one button shape app-wide` prueft die Kapsel in der `.btn`-Basisregel und
verbietet JEDER weiteren Regel mit einer `.btn`-Variante im Selektor, einen border-radius zu
setzen. `--radius-glass-button` ist entfallen, weil ein eigener Token nahelegte, es gaebe
daneben noch eine zweite, nicht-glaeserne Buttonform.

**Die Regel gilt auch fuer Knoepfe, die keine `.btn` sind.** Ein Guard, der eine KLASSE
sucht, findet nur, wer sie schon traegt - und blind blieben ausgerechnet die drei Knoepfe,
die das Problem waren: "Aktuell" (Budget), "Heute" (Kalender) und "Heute" (Wochenplan)
beanspruchten `.btn` nie und standen deshalb in drei Formen und zwei Farbgrammatiken
nebeneinander, obwohl sie dieselbe Funktion tragen. Der Budget-Knopf war Deklaration fuer
Deklaration eine `.btn--secondary`, nur mit `--radius-sm` statt der Kapsel. Wer die
Grammatik einer geteilten Variante braucht, nimmt die KLASSE. Der Guard prueft das seit
Runde 5 ueber die SIGNATUR der Variante (ihre Kante `--color-border` plus ihre Tinte im
Modul-/App-Akzent), nicht ueber ihren Namen.

**Der Geltungsbereich ist positiv formuliert (Runde 6, Phase 3).** Er stand vorher als zwei
Negativlisten da und liess im gerenderten Dokument 41 Knoepfe ausserhalb - darunter
`.row-action`, die zweithaeufigste Buttonform der App, eine geteilte Shell-Klasse in sechs
Modulen, direkt neben Kapsel-Knoepfen im selben Kopf. Der Wortlaut:

> Es gibt EINE Buttonform: die Kapsel. Sie gilt fuer jedes Element, das eine Aktion
> ausloest und eine eigene Flaeche oder Kante traegt. Bei einem quadratischen Icon-Knopf
> ist die Kapsel ein Kreis.
> Ausgenommen sind Zustandsschalter (Checkbox, Toggle, Segment, Wochentagswaehler),
> Drop-Ziele, Zellen eines Rasters und ZEILEN einer Zeilenliste.
> Die Ausnahme ist eine Liste von KATEGORIEN, keine Liste von Selektoren.

**Die vierte Kategorie ist neu und keine neue Idee.** Eine ZEILE ist kein Kasten - das
sagt das Kasten-in-Kasten-Vokabular seit Runde 5 und die Zeilenlisten-Regel seit Runde 6.
Ihre Hervorhebung (Hover, Auswahl, Rang) folgt der Form ihres Traegers, nicht der eines
Knopfes; deshalb behalten `.rewards-widget-row`, `.rw-standing__id` und
`.meal-slot__add-more-btn` ihre Form. Ein Knopf IN einer Zeile ist davon nicht gedeckt:
`.row-action` ist rund. Wer die Kategorie nicht nennen kann, traegt die Kapsel.

**Geprueft auf zwei Ebenen, weil eine sie nicht traegt.** Im Stylesheet steht weder Tag
noch Rolle; was dort scharf ist, ist die Form eines umgrenzten Ziels. Ebene 3
(`ein quadratischer Icon-Knopf ist ein Kreis`, test-frontend-audit.js) prueft deshalb alle
Regeln mit gleicher Breite und Hoehe und fuehrt die Ausnahmen mit ihrer Kategorie. Ebene 4
(Sonde „Buttonform", test-document-guards.js) prueft den Rest im gerenderten Dokument, wo
Tag, Rolle und Nachbarschaft bekannt sind.

Zwei Einzelfaelle sind dabei mit erledigt: `.dashboard .weather-widget__refresh` hat seine
`border-radius`-Zeile verloren (sie ueberschrieb die Kapsel der Basisregel 1455 Zeilen
spaeter mit 0-2-0, direkt unter einem Kommentar, der vor genau dieser Spezifitaetsfalle
warnt), und `.cal-toolbar__view-btn` traegt jetzt die konzentrische Formel
`calc(var(--radius-sm) - 2px)` statt `--radius-xs` - sein Traeger ist deklarationsgleich
mit dem von `.group-toggle__btn`, das sie schon trug.

**Die Label-Verlust-Regel (Runde 6, Phase 3b).** Verliert ein beschriftetes Bedienelement
sein Label - weil der Viewport schmal wird oder weil es in seiner Icon-only-Variante steht -,
dann wechselt es in die Icon-Form seiner Familie, **behaelt die Zielgroesse `--target-base`**
und traegt seinen Zustand ueber getoente Flaeche PLUS gefuelltes Icon. Nie ueber die Kante
allein: eine Kante liest niemand als „eingeschaltet".

Der Kern ist die Zielgroesse: **ein Label zu verlieren darf ein Ziel nie verkleinern.** Genau
das war der Bestand, und zwar viermal mit vier eigenen Antworten - `.cal-toolbar__mine-btn`
schrumpfte unter 640px vom beschrifteten Chip auf 28x28, `.birthdays-toolbar__import` zog nur
seinen Innenabstand zusammen und blieb als 50x48-Oval in einer Form zurueck, die es sonst
nirgends gibt, `.perm-seg__opt` stand als Icon-Segment auf 34x30, und allein
`.documents-dms-link-btn` machte es richtig. Alle messen `--target-base`
(auf Touch `--target-lg`).

**Der erste der vier ist seit 2026-08-28 GESCHICHTE, und sein Ende ist die staerkere Lesart
derselben Regel.** `.cal-toolbar__mine-btn` und die vier Ebenen-Chips daneben sind aus dem
Kalenderkopf verschwunden; ihre Schalter stehen jetzt beschriftet im Filter-Blatt
(`openCalendarFilters`). Der Anlass war gemessen: die Regel hatte ihre Zielgroesse gerettet,
aber nicht die Verstaendlichkeit - ein 48px-Kreis mit einem 8px-Punkt darin ist ein volles
Ziel und sagt trotzdem nichts, und der Zustand, den er „ueber getoente Flaeche" tragen sollte,
mass 1,085:1. **Die Regel sagt, was passiert, wenn ein Label faellt. Sie sagt nicht, dass es
fallen muss** - und wo ein Blatt Platz hat, ist das Label die bessere Antwort als die beste
Icon-Form.

**DIE BLATT-REGEL (2026-08-28).** Traegt eine Werkzeugzeile mehr als zwei gleichrangige
Schalter, gehoeren sie in ein Blatt hinter EINEN Knopf, und der Knopf traegt die ZAHL der
aktiven. Drei Gruende, alle drei gemessen und alle drei im Kalenderkopf zugleich aufgetreten:
die Zeile kostet Hoehe, die auf dem Telefon der Inhalt bezahlt (56px = 6,6 % der
Viewporthoehe); die Schalter verlieren unter 640px ihr Label und werden zu Kreisen, die
sehend nicht mehr auseinanderzuhalten sind; und ihr Zustand muss dann von einer Toenung
getragen werden, die ihn nicht tragen kann.

Der Zaehler ist dabei kein Schmuck, sondern die eigentliche Leistung: er beantwortet die
einzige Frage, die der Kopf beantworten MUSS („nehme ich gerade etwas weg?"), und er tut es
mit einer Zahl statt mit einem Farbunterschied - lesbar auch dort, wo eine Waschung keine
Farbe tragen kann. **Was ein Blatt nicht aufnimmt, sind Meldungen.** Die
Ueberlappungswarnung des Schichtplans (`role="status"`) blieb im Kopf: eine Warnung, die man
erst aufklappen muss, ist keine.

**Ein leeres Filterset heisst ALLE, nie KEINE.** Die Umkehrung erzeugt einen Zustand, aus dem
die leere Flaeche selbst nicht mehr herausfuehrt - wer alle Haekchen entfernt, saehe nichts
mehr und haette ausserhalb des Blatts keinen Hinweis darauf, warum. Aus derselben Ueberlegung
faellt beim Laden jede gespeicherte Auswahl weg, die es nicht mehr gibt (ein ausgetretenes
Mitglied), und eine Auswahl, die wieder alle umfasst, wird zu „kein Filter" zurueckgesetzt -
sonst zaehlte der Knopf einen Filter, der nichts wegnimmt.

NICHT geregelt ist, WANN ein Label faellt: das entscheidet die Leiste, in der das Element
steht, denn es haengt daran, was sonst noch in ihr liegt. Kalender und Geburtstage geben ihr
Label bei 640px ab, die Dokumente bei 768px, und die Einstellungen genau umgekehrt - dort
faellt es auf dem BREITEN Viewport, weil am Zeiger der Tooltip die kompaktere Antwort ist.
Geregelt ist nur, was dann passiert.

**Geprueft auf Ebene 3** (`wer sein Label verliert, bleibt ein volles Ziel`,
test-frontend-audit.js): der Guard sucht die SIGNATUR des Label-Verlusts - eine Regel, die
ein `span` oder ein `__label`/`__text`/`__name`-Element auf `display: none` setzt - und
verlangt vom Traeger im SELBEN At-Block beide Achsen als Zielmass. Wer klickbar ist, kommt
dabei aus dem Markup (`<button>`, `role="button"`, `.btn`), nicht aus dem Klassennamen: die
erste Fassung fragte nur nach `cursor: pointer` und nach Namen auf `-btn` und war damit blind
fuer jeden Knopf, der seine Klickbarkeit von `.btn` erbt und sich nach seiner Funktion nennt.

**Die Zielgroessen-Regel (Runde 6, Phase 3c).** **Eine Reihe traegt ihre Dichte gemeinsam, ein
Einzelziel muss allein treffbar sein.** Daraus folgen genau zwei Faelle:

- **Freistehend** - kein gleichartiges Ziel engt es ein. Es haelt die Zielgroesse seiner
  Gerätewelt (`--target-md` am Zeiger, `--target-lg` am Finger; `--target-base` liefert
  beides) in **mindestens einer Achse** und erfuellt in der anderen WCAG 2.5.8.
- **In einer Reihe** - ein anderes Ziel, das mindestens eine Klasse mit ihm teilt, steht
  weniger als 16px entfernt. Fuer es gilt allein WCAG 2.5.8: 24x24, oder kein anderes
  Zielzentrum naeher als 24px.

Das Kriterium ist die **Einengung**, nicht die Anzahl: ein Ziel in einer Reihe kann nicht
wachsen, ohne seinen Nachbarn zu verdraengen - genau deshalb darf es dicht sein. Ein
freistehendes Ziel hat den Platz und keine Ausrede. Dieselbe Antwort gibt Fitts: ein
isoliertes Ziel wird einzeln angesteuert und braucht seine Flaeche; ein Ziel in einer Reihe
wird im Kontext angesteuert, und Vergroessern kostet dort die Uebersicht. Und die Einengung
ist eine Eigenschaft des **Bauteils**, nicht der Instanz - ein Tagfilter an einer Aufgabe mit
nur einem Tag steht allein da und bleibt ein Reihen-Bauteil.

**Keine Namensliste fuer Dichte.** Die Spacing-Ausnahme des Standards deckt jeden bewusst
dichten Fall mechanisch ab - gemessen: Monatsraster-Chips (Zentrumsabstand 31,5),
Aufgaben-Tagfilter (29,3), Sidebar-Umschalter (31,5). Die Ausnahmeliste des Guards ist leer.

**Wer die Spacing-Ausnahme nimmt, muss sie brauchen (Critique 2026-08-10, Befund 3).** Ein
FREISTEHENDES Ziel nimmt den Platz, den sein Traeger ihm laesst. Die Ausnahme ist fuer Ziele
gedacht, die dicht stehen MUESSEN - dieselbe Begruendung wie die Einengung selbst. Wer unter
24px bleibt, obwohl sein Traeger ihm den Raum laesst, ist kurz aus Versehen, nicht aus
Platznot.

Der Anlass: `.task-card__title` mass 22,1px in einer Karte mit 12px leerem Padding darueber
und 4px darunter, und Sonde 4 sagte gruen, weil das naechste Zielzentrum weit genug weg lag.
Die Critique mass denselben Fall gegen einen pauschalen 44px-Massstab - und hatte damit recht
aus dem falschen Grund. Nicht 44px ist der Massstab (die Regel oben begruendet ausfuehrlich,
warum nicht), sondern die ungenutzte Reserve. Der Titel traegt jetzt 38px Trefferflaeche ueber
ein `::before`, der Text steht unveraendert.

**Zwei Grenzen gehoeren zur Klausel, und beide sind gemessen, nicht gesetzt.** Sie gilt NICHT
fuer Reihen-Bauteile - die erste Fassung meldete die Aufgaben-Tagfilter und zwoelf
`.cal-task-chip`, formal zu Recht (sie stehen nebeneinander, koennten also vertikal wachsen),
aber das waere eine neue Regel gewesen, keine Klausel. Und sie gilt NICHT fuer Inline-Ziele:
WCAG 2.5.8 nimmt ein Ziel ausdruecklich aus, dessen Groesse durch die Zeilenhoehe des
umgebenden Textes bestimmt ist. Ohne diese Ausnahme meldete sie drei Hinweis-Links in
`<p class="form-hint">`, und der einzige Weg sie „zu reparieren" waere gewesen, den Fliesstext
um sie herum auseinanderzuziehen.

Gefunden hat die Klausel ausser dem Titel genau einen weiteren echten Fall: der
`.nav-sidebar__toggle` mass 219x23 am Fuss der Sidebar, mit Platz nach beiden Seiten - 23px
ist die Hoehe seines 15px-Icons plus Zeilenrest, keine Entscheidung. Er traegt jetzt
`--target-md`.

**Dabei fiel eine Modifier-Blindheit von Sonde 4 auf.** `rowBuilt` schluesselte ueber die
volle Klassenliste, und damit war `cal-task-chip.cal-task-chip--high` ein anderes Bauteil als
`--medium`: wer nur in fuenf von sechs Varianten in einer Reihe vorkommt, galt in der sechsten
als freistehend. Drei `--high`-Chips blieben so gemeldet, waehrend die uebrigen als Reihe
erkannt wurden. Die Sonde fuehrt jetzt zusaetzlich jede EINZELKLASSE - dieselbe Blindheit, die
Sonde 6 hatte, als sie nach `.metric-grid` fragte und die Reihe nicht sah.

**Gemessen wird die TREFFERFLAECHE, nicht die Box.** `.weather-widget__refresh` ist 34x34
gross und dehnt seine Flaeche per `::before` auf `--target-base` aus; eine Box-Messung meldet
ihn als Verstoss, obwohl der Finger 44px findet. Das ist zugleich das Rezept fuer „kompakt
aussehen, voll treffen".

**Die Groesse des Icon-Knopfs gehoert der Shell.** `.btn--icon` nimmt `--target-base` und
schaltet damit ueber `(hover: none)`. Vorher schaltete es ueber `@media (min-width: 1024px)`,
also nach der Breite - ein Tablet ab 1024px bekam 40px, und Aufgaben wie Abonnements hatten
den Shell-Fehler je fuer sich lokal repariert. Derselbe Kopf-Icon-Knopf mass dadurch 40px in
Kalender und Kontakten und 44px in Aufgaben und Dokumenten.

**Geprueft auf zwei Ebenen, weil es zwei Zusagen sind.** Die Zielgroessen-Regel haengt an
Nachbarschaft und Trefferflaeche und ist nur im Dokument pruefbar (**Ebene 4**, `Sonde 4` in
test-document-guards.js, beide Geraetewelten). Die Besitzfrage des Icon-Knopfs steht dagegen
offen im Stylesheet und waere im Dokument unsichtbar, weil beide Antworten die
Zielgroessen-Regel halten (**Ebene 3**, `die Groesse des Icon-Knopfs gehoert der Shell`).

### Segmented Controls
- **EINE Sprache shell-weit:** aktives Segment = erhabene Surface-Pille im Well
  (`--seg-active-bg` + `--seg-active-shadow`), Modulton NUR als Tinte
  (`color-mix(in srgb, <Akzent> var(--tint-ink), var(--color-text-primary))`); inaktiv
  Sekundaertext, Hover hebt nur die Textfarbe. Gilt identisch fuer Aufgaben-Gruppentoggle,
  Kalender-Ansichtswahl, Budget-Tabs, Sub-Tabs, Kuechen-Tabs, Dokumenten-View-Toggle,
  Listen-Tabs, Gesundheits-Zeitraum und die Settings-Schalter. Der Traeger ist ein Well
  (`--color-surface-3`), sonst ist die Pille kein Zustand (gemessen 1.20:1 hell / 1.16:1
  dunkel gegen Surface, plus Schatten). Innenradius konzentrisch
  (`calc(var(--radius-sm) - 2px)`). Kein 3px-Akzentstreifen unter aktiven Tabs.
- **EINE BEHANDLUNG PRO KONTROLLTYP.** Der Modulton erscheint genau einmal als FLAECHE
  (aktiver Filter-Chip, getoent) und einmal als TINTE (aktives Segment). Bis 2026-08-12
  war das Segment deckend gefuellt; auf `/tasks` standen dadurch vier Gruen-Behandlungen
  gleichzeitig im Bild (gefuellter Ansichtsumschalter, gefuelltes Gruppen-Segment,
  getoenter Chip, Chip mit roher Akzent-Kante). Die alte Begruendung fuer die Fuellung
  („Modul-Akzent als Text erreicht nur ~3.5:1") stammt aus der Zeit vor den Familientoenen
  (v2.1.0) und ist abgelaufen: heute haelt selbst der rohe Ton 5.04:1 hell / 4.82:1 dunkel,
  die `--tint-ink`-Mischung 7.37:1 / 6.61:1 ueber alle neun Familien. Gehalten von
  `das aktive Segment ist ueberall dieselbe Pille` in `test/test-frontend-audit.js`,
  in beiden Richtungen (Vollstaendigkeit der drei Zeilen UND kein Rueckfall auf gefuellt).
- **Die Tinte ist kein Token, und das ist Absicht.** Ein Custom Property, das
  `var(--module-accent)` enthaelt, wird dort aufgeloest, wo es DEKLARIERT ist. An `:root`
  gibt es keinen Modulton - ein `--seg-active-ink` war in jedem Modul violett und riss den
  Filter-Chip gleich mit. Die `color-mix`-Zeile steht deshalb an jeder Fundstelle
  ausgeschrieben; zusammengehalten wird sie vom Guard, nicht von der Kaskade.

### Chips
- **Form:** Kapsel (`--radius-full`), Kante wie ein Bedienelement. Kalender-Layer-Chips
  tragen die User-Farbe als Border mit ~60 % Deckung (>=3:1), nie als Textfarbe; alle
  Labels stehen inaktiv in Sekundaertext - auch der Mir-zugewiesen-Chip (Beschluss
  2026-08-17, umgesetzt 2026-08-27: seine dauerhaft getoente Schrift las sich als
  „Filter ist an"; die Farbe erscheint erst mit der Aktivierung). Ein aktiver
  Filter-Chip traegt den Ton als
  getoente FLAECHE (`--tint-state` Grund, `--tint-hint` Kante, `--tint-ink` Tinte) - das
  ist die andere Haelfte der Regel „eine Behandlung pro Kontrolltyp" und ausdruecklich
  NICHT die Segment-Pille. Scrollende Chip-Reihen bekommen die Fade-Mask (siehe Layout).
- **Innenabstand:** vertikal mindestens 4px (`--space-1`). Die Kalender-Aufgaben-Chips
  standen mit 2px buendig an der Kante ihrer eigenen Toenung (Sonde `cramped-padding`, 7
  Fundstellen); eine getoente Flaeche braucht Luft zu ihrem Rand, sonst liest sie sich als
  abgeschnitten statt als Chip. Einzige Ausnahme ist das dichte Monatsraster, das seine
  engere Fassung ueber einen `.month-day`-Override behaelt.

### Cards / Containers
- **Corner Style:** 12px (`--radius-md`) fuer die Karte, 16px (`--radius-lg`) fuer den
  Zeilen-Traeger, 26px fuer Glas-nahe Container.
- **Background:** `--color-surface`, opak. Karten sind randlos auf dem Grouped-Grund - die
  Trennung leistet der Schatten, nicht eine Kante.
- **Shadow:** shadow-sm in Ruhe; Hover-Anhebung nur fuer interaktive Karten.
- **Inset-Grouped-Liste:** die Kernform der neuen Welt. "Heute wichtig" auf dem Dashboard ist
  EINE Inset-Grouped-Liste (ein Traeger, Zeilen mit Haarlinien, getoente Icon-Kachel plus
  Titel plus Modul-Untertitel plus trailing Count), nicht viele Einzelkarten.
- **Internal Padding:** 16px (`--space-4`), kompakt 12px.

### Named Rules
**Die Kasten-in-Kasten-Regel.** Karten sind randlos auf dem Grouped-Grund, also traegt
NICHTS in einer Karte eine eigene Kante - sonst stuende ein umrandeter Kasten in einer
kantenlosen Karte. Es gibt genau zwei Antworten, app-weit dieselben: eine ZEILE wird zur
Haarlinie (`+ selector { border-top: 1px solid var(--color-border-subtle) }`,
Container-`gap` auf 0, Padding vertikal, keine Flaeche, kein Radius); eine KACHEL wird zum
Inset-Well (`background: var(--color-fill-well)`, KEINE border, Radius bleibt). Echte
BEDIENELEMENTE - Inputs, Buttons, Chips, Checkboxen, Stepper, Drop-Ziele - behalten ihre
Kante: sie sind keine Kaesten, sondern Griffe.

**Die Traeger-Regel.** Der Well gilt nur INNERHALB einer Karte. Dieselbe Kachel auf dem
Grouped-Grund ist eine randlose Karte (`--color-surface` + `--shadow-sm`) - ein Well liegt
dort bei 1.06:1 und verschwindet; der Well sitzt bewusst auf der Surface-3-Rolle statt auf
dem Grouped-Grund, weil der Grund im Dark ein Loch zur Buehne risse (1.16:1 nach unten) und
im Light zu schwach traegt (1.12:1). Traegt eine Komponente beide Kontexte, steht der Well im
Kontextselektor der Karte, nie in der Basisregel (Muster
`.health-overview__card .health-metric-card`). LEERZUSTAENDE bekommen gar keine Flaeche:
zentrierter Sekundaertext, kein Rahmen, kein Well - sonst muesste jeder Leerzustand seinen
Traeger kennen.

**Die Fusszeilen-Regel (v2.6.0). Ueberschuessige Hoehe wird Atem, nicht Loch.** Eine Karte
mit Fusszeile streckt ihren Koerper (`flex: 1`) und verankert die Fusszeile unten
(`margin-block-start: auto`), damit der Ueberschuss ZWISCHEN Inhalt und Abschluss faellt
statt hinter den Abschluss.

Der Anlass ist eine Eigenheit jedes Rasters: die Zeilenhoehen richten sich nach den
1x1-Kacheln, eine 1x2-Karte bekommt also die Summe zweier Zeilen plus Gap. Gemessen waren
das 489px Karte gegen 319px Inhalt bei „Familie" und 294px bei „Budget" - und weil jeder
Koerper oben klebte, sass der Rest als toter Block unter dem letzten Element. Mit dem Anker
liest die Karte als bewusst gesetzter Rahmen aus Kopf, Inhalt und Fuss. Die Regel gilt fuer
JEDE Karte mit Fusszeile, nicht nur fuer die zwei, die heute zu kurz sind.

Sie loest das Loch nicht allein: dazu gehoert, dass eine Listen-Kachel ihre Zeilenzahl aus
ihrer HOEHE nimmt statt aus einer Konstante, die fuer eine und fuer zwei Rasterzeilen
dieselbe war. Ueber das Standard-Board gemessen bleiben 3px Leerraum pro Karte.

**Und eine Fusszeile ist eine Auskunft, kein Griff.** Die Tagesbilanz des Haushalts schliesst
ihre Karte als hairline-getrennte Zeile ab, exakt wie der Fuss der Budgetkarte - ein
getoentes Well haette dieselbe Form gehabt wie „1 zu bestaetigen" in den Belohnungen, und das
ist eine HANDLUNGSaufforderung. Dieselbe Form fuer zwei Bedeutungen ist genau der Befund, den
das Board schon einmal hatte.

**Die Zeilenlisten-Regel.** Die Kasten-in-Kasten-Regel sagt, wie eine Zeile INNEN aussieht;
diese sagt, worauf sie liegt. Eine Folge gleichartiger Zeilen liegt in GENAU EINEM Traeger:
einer randlosen Karte (`background: var(--color-surface)`, `--radius-lg`,
`box-shadow: var(--shadow-sm)`, `overflow: hidden`). Die Zeilen darin sind flaechen- und
kantenlos und trennen sich ueber den `+`-Kombinator, NIE per `border-bottom` je Zeile - das
zieht eine Linie unter die letzte und macht den Traegerrand doppelt. Der Kopf steht UEBER dem
Traeger auf dem Grund, nie in ihm (welche Kopfrolle, sagt die Kopf-Abgrenzungs-Regel). Es
gibt damit weder eine traegerlose Zeilenfolge auf dem Grund noch eine Karte pro Zeile; drei
Vokabulare koexistierten vorher (Geburtstage, Belohnungen, Kontakte, Budget,
Einstellungs-Uebersicht, Medikamente). Begruendung: eine Zeilenfolge direkt auf dem Grund hat
keinen linken Rand, an dem das Auge die Liste als EIN Objekt fasst; eine Karte pro Zeile hat
N Raender und damit N Objekte. Einzige Ausnahme: ein RASTER aus Objekten mit eigenem Medium
(Foto, Dokumentvorschau) - dort ist jede Kachel eine eigene Karte, weil sie nebeneinander
steht statt untereinander. Guard: `row lists sit in exactly one carrier` liest ALLE
Stylesheets und haelt jede Haarlinien-Zeile frei von Karten-Merkmalen (Schatten, Radius,
Surface-Fuellung).

**Die Traegergrammatik steht zweimal, und sie ist nicht zweimal dieselbe (offener Befund,
2026-08-11).** Geteilt liegt sie als `.row-carrier` (list-row.css) - genau die vier
Deklarationen oben, samt der Ausnahme, dass ein Traeger, der nur einen Leerzustand enthaelt,
seine Karte abgibt. Daneben steht `.list-rows`, der Traeger der gruppierten Listen (Einkauf,
Vorrat, Rezepte, Aufgaben, Agenda); `tokens.css` nennt ihn „dieselbe Grammatik plus dem
Lesemass der Kuechenlisten". Nachgemessen ist er das nicht: er traegt `--radius-md` (12px)
statt `--radius-lg` und **gar keinen Schatten** - `border: 1px solid transparent` und sonst
nichts. Der Radius ist an seiner Verwendungsstelle begruendet (shopping.css: die Gruppe
klippt mit ihrem `overflow: hidden` die Wischflaeche), der fehlende Schatten nirgends. Die
Fuellung ist dagegen keine Abweichung: `--color-surface-work` hat in beiden Themes denselben
Wert wie `--color-surface` (#FFFFFF / #2B2825).

**Das LESEMASS ist seit 2026-08-13 keine der Abweichungen mehr.** Es trug nur `.list-rows`,
mit der ausgeschriebenen Begruendung, die Listen ausserhalb der Kueche seien breiter. Das war
eine Beschreibung des Bestands: gemessen bei 1440px stand die Aufgabenliste auf 720px und die
Kontaktliste auf 1156px, also sprang die Inhaltsspalte beim Modulwechsel um 436px. Beide
Traeger kappen jetzt auf `--content-max-width-narrow`, und beide machen den Container
`list-rows` auf. Welche der zwei Klassen eine Zeilenfolge traegt, ist damit eine Frage ihrer
Verschachtelung (Gruppe im Scroller gegen alleinstehender Traeger), nicht ihrer Breite. Guard:
`die Kuechen-Listen teilen eine Zeilen-Grammatik`, Abschnitt 4.

**Was die Zeile hat und was daneben steht.** Die geteilte Zeile (`.list-row`) fuehrt seit dem
Dichte-Paket vierzehn Module. Zwei benannte Stufen weichen begruendet ab - `--roomy` fuer eine
Zeile, deren Titel-Trefferflaeche die Polsterung mitrechnet (Aufgaben), `--tight` fuer eine,
die links ein BILD statt eines Bedienelements fuehrt (Kontakte). Mehr Stufen gibt es nicht:
eine dritte Zahl in einem Modul-Stylesheet ist ein Nachbau, und ein Guard sagt das auch so
(„Abweichen ist erlaubt, wiederholen nicht").

**Drei Flaechen sind AUSDRUECKLICH keine Zeilenliste**, damit sie beim naechsten Durchgang
nicht wieder als Rueckstand gelesen werden: die Notizen (Masonry-Raster, eigener Guard), die
Aufteilung im Budget (Karten-IA mit eigener Rechenlogik) und die Mahlzeiten-Slots (Zellen
eines Wochenrasters mit Drag-und-Drop und Ablagezustand, `style="${gridPos}"` - eine
Rasterzelle ist keine Zeile, auch wenn sie eine Zeile hoch ist). Sie fallen unter die
Raster-Ausnahme der Zeilenlisten-Regel oben.

**Warum das mehr ist als eine Ungenauigkeit:** diese Regel und der Karten-Abschnitt machen
beide den SCHATTEN zum Trenner („randlos auf dem Grouped-Grund - die Trennung leistet der
Schatten, nicht eine Kante"). Ohne ihn haengt die Kante des Traegers allein an der Luminanz:
gemessen 1.11:1 (Weiss auf `--color-bg`) und 1.15:1 im Dark - dieselbe Groessenordnung, mit
der die Traeger-Regel den Well vom Grouped-Grund verbannt hat. Der Guard kann es nicht sehen,
weil er die ZEILE prueft (sie darf keine Karte sein), nie den Traeger. Was daraus folgt -
`.list-rows` bekommt Schatten und 16px, oder die Regel nennt zwei Traegerformen samt
Kriterium -, ist offen und gehoert an das gerenderte Material, nicht in diesen Absatz.

**Die Wischsemantik-Regel.** Dieselbe Geste bedeutet in jeder Liste dasselbe. Der
Zeilenanfang traegt die primaere positive Aktion, das Zeilenende das Destruktive oder
Sekundaere; die Kante ist logisch, die Fingerbewegung dahin spiegelt in RTL. Zugeordnet
wird ein RANG, keine Rolle - `--edit` ist primaer, wo keine positive Aktion daneben steht,
und sekundaer, wo eine steht. Fest liegen die Enden: `--delete` steht nie am Zeilenanfang,
`--done` nie am Ende. **Und eine Geste, die loescht, hat einen Rueckweg** - nie ein direktes
`api.delete`. Der Anlass der Regel war kein Konsistenzwunsch, sondern die eine Stelle der
App, an der eine Geste sofort und endgueltig loeschte.

**Es gibt zwei Rueckwege, und die REICHWEITE der Tat entscheidet.** Laesst sie sich in einem
Satz zuruecknehmen, gehoert ihr der Undo-Toast (`scheduleUndoableDelete`): er unterbricht
nicht und haelt den Weg fuenf Sekunden offen - Geburtstag, Einkaufszeile, Buchung. Wirkt sie
UEBER IHR MODUL HINAUS, gehoert ihr die Bestaetigung (`confirmModal` mit `danger: true`),
denn dann muss der Rueckweg die Nebenwirkung BENENNEN, und das kann nur ein Dialog vor der
Tat: ein Abo zu loeschen nimmt seine Erinnerungen und die Budget-Buchung der naechsten
Zahlung mit. Keiner der beiden ist die Ausnahme des anderen - es ist dieselbe Trennung, die
der Kanon zwischen Undo und Action Sheet zieht. Eine Bestaetigung ohne `danger` zaehlt
nicht: die rote Taste ist das, was den Rueckweg erkennbar macht.

Zuordnung als Tabelle bei der Signature Component; Guards auf Ebene 3
(`Eine Wischgeste, die loescht, hat einen Rueckgaengig-Weg`) und Ebene 4 (Sonde 5), weil
nur das gerenderte Dokument sieht, ob eine Liste ueberhaupt verdrahtet ist.

### Inputs / Fields
- **Style:** 10px Radius (`--radius-sm`), 1.5px Border `--color-border`, Surface-Grund,
  Padding 8px 12px, min-height 48px (Desktop 40px), Schriftgroesse nie unter 16px,
  Placeholder `--color-text-placeholder` (= Tertiaer, gethemt; NIE die Disabled-Farbe, und
  als Elementselektor auf `input`/`textarea`, damit kein Feld auf Chromes UA-Default
  zurueckfaellt).
- **Feldkanon:** ein `select` bekommt zusaetzlich 32px Innenpolster rechts
  (`padding-inline-end: var(--space-8)`) plus `text-overflow: ellipsis`, weil sein Chevron
  INNERHALB der Box sitzt und lange Optionstexte sonst mittendrin gekappt werden. Das ist
  app-weiter Kanon, kein Modul-Detail.
- **Focus:** Akzentkante plus 3px Glow in `--color-accent-light`; interaktive Nicht-Felder
  tragen den app-weiten 2px-Ring.
- **Klassenname:** `.input` und `.form-input` sind ein Alias auf dieselbe Regel (layout.css).
  Kanonisch fuer neuen Code ist `.form-input` - der Name, den `.form-group`/`.form-field`/
  `.form-label` schon fuehren. Bestand bleibt unangetastet, Umbenennen aller Fundstellen ist
  keine Migration wert.

### Navigation
- **Mobil:** schwebende Glas-Kapsel (`--glass-bg-elevated` + `--blur-md` + saturate,
  radius-full) mit gleitendem Aktiv-Indikator.
- **Desktop:** Glas-Sidebar mit gleitender Aktiv-Pille; Toolbar ohne Akzentstreifen, Titel in
  Title 2.
- Labels in 12px; lange Locales duerfen die Kapsel wachsen lassen, nie clippen.
- **Filled Variant, app-weit:** JEDER ausgewaehlte Zustand traegt sein Icon gefuellt
  (`fill: color-mix(in srgb, currentColor 30%, transparent)`) - Tab-Bar, Sub-Tabs,
  Listen-Tabs, Filterchips, Segmente, View-Toggles. Lucide bleibt Stroke-Bibliothek; die
  Fuellung entsteht unter vollem Stroke und wirkt nur auf geschlossene Pfade. 16 % las auf
  20px-Tab-Bar-Groesse noch als Outline, deshalb 30 %. Zweiter Kanal neben der Flaeche,
  nie ihr Ersatz.

### Modulkopf (Signature Component)
Eine `.page-toolbar` pro Modul, **Absender-Siegel und Titel links**, Center-Slot (Suche oder
Zeitraum-Navigation), Aktionen rechts. In der KOMPAKTEN Groessenklasse (<1024px, die Welt mit
Tab-Bar) steht der Titel am Scroll-Anfang als **Large Title** (34px) auf eigener Zeile und
faellt beim Scrollen auf den Inline-Schnitt (22px) zurueck; die Trennlinie erscheint erst beim
Andocken, davor steht der Kopf nahtlos auf dem Seitengrund. Ab 1024px regiert die Sidebar -
dort bleibt es beim Inline-Titel, wie in Apples regulaerer Groessenklasse.

**Die Werkzeugzeilen-Regel (Critique 2026-08-27, P1).** Die Werkzeug-Leiste eines Modulkopfs
(Tab-Leiste, Ansichts-Segment) ist die BAR-ZEILE: eine eigene, volle Zeile unter Titel,
Center und Aktionen (`.page-toolbar__bar`, order 4), auf ALLEN Viewports. Der Slot stand
seit Runde 6 als Zusage im Shell-Kommentar („eine Tab-Leiste im Kopf ist eine eigene,
horizontal scrollende Zeile") - die Regel darunter gab aber nur das Scrollen, nie die Zeile,
und die Einzeilen-Doktrin aus #882 zwang jede Leiste in die Titelzeile, wo sie ihre eigenen
Module versteckte. Gemessen bei 1280px: die Budget-Tabs hatten 138px clientWidth fuer 606px
Inhalt (1 von 7 Tabs sichtbar - Abonnements, Darlehen und Statistik waren Geheimwissen),
das Kalender-Segment 212px fuer 245px („Agenda" unsichtbar, das Monatslabel daneben auf
seiner 7ch-Untergrenze ellipsiert); mobil zeigte Gesundheit 3 von 6, die Haushaltshilfe
3 von 4 Tabs, und das einzige Existenzsignal war ein Fade. Drei Zusagen:

1. **Die Titelzeile bleibt EINE Zeile** - #882 gilt unveraendert; die Bar-Zeile ist die eine
   erlaubte zweite und bricht selbst nie um (sie scrollt). Pruefebene: Dokument (Sonde 19
   zaehlt Titel- und Bar-Zeile getrennt; Sonde 15 erlaubte die Bar-Zeile der kompakten
   Hoehe schon immer - neu ist, dass sie eine Eigenschaft des KOPFES ist, keiner
   Groessenklasse).
2. **Eine ueberlaufende Leiste zeigt ihre Fortsetzung**: Scroll-Fade (wireScrollFade; die
   eps-Toleranz des Helfers steht seit 2026-08-27 auf 2px - bei 8px schluckte sie einen
   echten 4px-Ueberlauf des uk-Kalender-Segments) plus ein Ende IN der Fade-Zone: die
   scharfe Tab-Leisten-Maske (12px statt der 24px der Chip-Reihen, Masken-Familie in
   filter-chip.css, gilt auch der Kuechen-Rail) schneidet das letzte Werkzeug sichtbar an -
   auch eines, dessen Kante zufaellig buendig faellt. Der Befund ist LEERRAUM vor der
   Endkante, der breiter ist als der Fade: dann faded die Maske Leere, und das naechste
   Werkzeug ist unauffindbar (so verdeckte der breite Fade das „Vorrat 10"-Badge komplett).
   Pruefebene: Dokument (Sonde 20: Fade verdrahtet UND Leerraum an der Endkante <= 12px).
3. **Ein Scope-Schalter ist keine Werkzeug-Leiste.** Die zwei Pillen „Mein Budget /
   Haushalt" beantworten „wessen Zahlen", nicht „welcher Bereich", und bleiben in der
   Titelzeile - eine Zwei-Optionen-Wippe auf eigener Zeile waere Zeilenverbrauch ohne
   Sichtbarkeitsgewinn.

Traeger: die Klasse sitzt direkt an einer Pillen-Leiste (budget-tabs, sub-tabs-bar im Kopf,
housekeeping-/rewards-tabs) oder als neutraler Wrapper um einen Segment-Traeger, dessen
Well nicht die ganze Zeile faerben darf (Kalender-Views). Der fruehere Rail-Pad-
Ausnahmeeintrag fuer Tab-Innenabstaende ist mit dem Subjekt-Scan des #577-Guards entfallen:
ein Selektor, dessen letztes Compound nicht die Rail ist, polstert ein KIND der Rail.

**Der Absender steht genau einmal, und die Shell setzt ihn.** Das Markensiegel des Moduls
sitzt unmittelbar vor dem Seitentitel und wird von `wireCollapsingHeader` angehaengt - am
selben Ort und aus demselben Grund wie der angedockte Titel: der Kopf ist die eine
Komponente, die alle Module teilen, und "genau eines" ist nur dort eine Eigenschaft des
Bauteils, wo der Kopf es selbst anlegt. Als Opt-in fehlte es beim achtzehnten Modul, und als
Modul-Markup waere die Dosierung eine Bitte an siebzehn Dateien. Es haengt am TITEL, nicht am
Kopf: wo kein Seitentitel steht, hat der Kopf keinen Absender zu fuehren - dieselbe
Abgrenzung, die die Leisten-Regel zieht.

**Das Siegel nimmt den Rang seines Titels an.** Die zwei Schnitte der
Canonical-Page-Head-Rolle haben ihre Entsprechung in EINEM Wertepaar an der Leiste
(`--seal-head-size` / `--seal-head-icon`): 32px neben dem Large Title, 24px neben dem
Inline-Schnitt, in denselben drei Zustaenden, die typography.css fuehrt. Die Titelbasis
rechnet ab, was das Siegel belegt (`calc(100% - var(--seal-head-lead))`) - mit `100%` haette
der Titel sich unter sein eigenes Siegel geschoben und die Lead-Zone waere um eine Zeile
gewachsen. Gemessen ueber alle zehn Koepfe: Kopfhoehe und Lead-Zone sind mit und ohne Siegel
identisch, es kostet also keine Zeile.

**Die Kuechen-Leiste fuehrt ihren Absender selbst.** Nach der Leisten-Regel IST sie die
Kopf-Navigation; ihr Siegel steht vor dem Titel "Kueche" und bleibt auch mobil stehen, wo der
Titel selbst ausgeblendet ist - das Wort fuehrt dort die Bottom-Nav, das Zeichen den Raum.
Die vier Kuechen-Koepfe bleiben siegellos: sie teilen einen Tint, weil sie ein Raum sind, und
zwei von ihnen tragen gar keinen Seitentitel. `renderSubTabs` weist ein Siegel deshalb
zurueck, wenn die Leiste das Modul nicht wechselt (`semantics: 'tabs'`, Gesundheit) - dort
liegt sie IM Kopf, und der traegt seinen Absender bereits.

**Andocken kann nur ein Kopf mit Lead-Zone** - und eine hat nur, wessen Inhalt auf mehr als
einer Zeile steht. Wo keine ist, traegt die Leiste ihre Linie durchgehend und markiert
schlicht die Kopfkante. Das ist kein Sonderfall, sondern derselbe Satz von der anderen
Seite: ohne wegscrollende Zeile gibt es kein Andocken zu zeigen. Gemessen trifft das zwei
Lagen - die regulaere Groessenklasse ab 1024px (Inline-Titel; seit der Werkzeugzeilen-Regel
traegt ein Kopf dort zwar zusaetzlich seine Bar-Zeile, aber die gehoert nicht zur Lead-Zone -
sie ist die Bedienzeile, die beim Andocken stuende, und Andocken bleibt ohnehin der kompakten
Klasse) und mobil die drei einzeiligen Kuechen-Koepfe (Einkauf, Rezepte, Vorrat), wo die
Kuechen-Leiste den Modulnamen traegt, also kein Seitentitel darueber steht und der Kopf
allein seinen Center-Slot fuehrt. Der Essensplan ist unter den vieren die Ausnahme: seine
Zeitraum-Navigation und seine Aktionen brauchen zwei Zeilen, also hat er eine Lead-Zone.

Und **was als Zeile zaehlt, entscheidet die UEBERLAPPUNG der vertikalen Intervalle, nicht
die Oberkante.** Flex-Items unterschiedlicher Hoehe stehen mittig ausgerichtet nebeneinander
und beginnen dabei bis zu 15px auseinander; ein hoehenloser Slot, den ein Modul nur je nach
Zustand fuellt, macht gar keine Zeile auf. Beide Faelle sind einmal als Lead-Zone
durchgegangen und haben dabei genau die Linie verborgen, die zu zeigen war - auf Desktop bei
11 von 14 Koepfen folgenlos (jede Regel dazu steht in der kompakten Groessenklasse), bei den
Rezepten sichtbar.

### Der Solo-Haushalt (Critique 2026-08-10, Persona Miriam)

**Was nur eine sinnvolle Belegung hat, wird nicht gefragt.**

PRODUCT.md fuehrt seit 2026-08-06 Solo-Nutzer als bestaetigte zweite Zielgruppe, und die
Oberflaeche wusste davon nichts: das prominenteste Widget zeigte eine grosse 1 mit „im
Haushalt" - ein Zaehler, dessen einziger Inhalt ist, dass man allein ist. Jede Aufgabe trug
das Pflichtfeld „Sichtbarkeit" mit genau einer Antwort, jede Dokumentkarte wiederholte „Ganze
Familie", „Zugewiesen an" bot einen selbst und „- Niemand -".

**Ein stiller Schalter, keine Einstellung.** Der Haushalt hat eine Groesse, die App kann sie
zaehlen (`/auth/me` liefert `householdSize`, `utils/household.js` haelt sie), und ein
Schalter fuer etwas Zaehlbares waere ein Formular fuer eine Frage, die niemand stellen
wollte - dazu einer, den Solo-Nutzer erst faenden, nachdem sie die Bevormundung schon gesehen
haben. Es ist derselbe Mechanismus, den der Block-2-Brief fuer das Ueberlappungszeichen
festgelegt hat: „erscheint nur, wenn es mehr als einen moeglichen Beteiligten gibt; im
Solo-Haushalt entfaellt es still".

**Der Schalter aendert keine Daten.** Ein Eintrag behaelt seine `visibility` und seine
Zuweisung; nur gefragt wird nicht mehr danach - die Felder bleiben im DOM und tragen ihren
Wert, sie sind `hidden`. Kommt ein zweites Mitglied dazu, stehen sie wieder da, und alles, was
inzwischen entstanden ist, hat schon die richtigen Werte. Ein Schalter, der Daten wegnimmt,
waere eine Migration; dieser ist eine Darstellung.

**Split-Gaeste zaehlen nicht mit** - sie sind externe Beteiligte einer Ausgabenteilung, keine
Haushaltsmitglieder (dieselbe Grenze, die `access_scope` zieht). Ein Haushalt von einer Person
mit drei Reisebekanntschaften ist ein Solo-Haushalt.

**Eine Quelle, nicht zwei.** Das Aufgaben-Formular fragte vorher `users.length > 1` - dieselbe
Frage aus einer anderen Zahl, naemlich der geladenen Nutzerliste des Moduls. Zwei Quellen
laufen auseinander, sobald eine einen Sonderfall bekommt, und diese hatte schon einen: die
Nutzerliste zaehlt Split-Gaeste mit.

**Zusaetzlich eine Wurzelklasse** (`html.household-solo`): manche Stellen sind reines Layout
und haben kein JS, das fragen koennte. Eine Quelle, zwei Wege.

### Das Ueberlappungszeichen (Block-2-Brief, gebaut 2026-08-10)

Der dritte Teil der Formfamilie, neben dem Siegel und seiner Herkunfts-Regel. **Ein Avatar
ueberlappt das Markensiegel - wer ∩ was**, das Familien-Zeichen der Drei-Kreise-Bildmarke, auf
zwei Kreise gebracht: einer sagt, aus welchem Raum das Objekt kommt, der andere, wen es
angeht.

**Sein Einsatzgesetz ist das des Siegels plus zwei Bedingungen.** Es erscheint, wo ohnehin ein
Siegel steht (also an Mischstellen), UND das Objekt traegt eine Person, UND der Haushalt hat
mehr als ein Mitglied. Nie Pflichtelement: wer keine Person hat, bekommt sein Siegel wie
bisher. Das ist der Sinn und keine Bequemlichkeit - ein Zeichen, das immer da ist, sagt
nichts.

**Die Ueberlappung IST das Zeichen, nicht die Nachbarschaft.** Zwei Kreise nebeneinander
waeren zwei Angaben; erst der Schnitt macht daraus eine. Der Versatz betraegt ein Drittel des
Avatars, und der Ring darum nimmt `--seal-pair-ground` (Voreinstellung `--color-surface`) -
die Flaeche, auf der das PAAR steht. Er hiess `--seal-base` und teilte sich den Namen mit dem
Mischgrund des Siegels; das waren immer zwei Fragen, und mit dem Vollton ist von ihnen nur
noch die des Rings uebrig. Ohne den Ring laufen zwei gesaettigte Flaechen ineinander, sobald
die Toene sich aehneln - seit dem Vollton noetiger als vorher, nicht weniger.

**Gebaut ist es an der Mischstelle „Heute wichtig"**, wo es das „von wem" der Aufgabe und des
Termins traegt; Einkauf und Essen bekommen keines, weil sie keine Person haben. Gehalten von
`utils/seal-pair.js` und einem Guard („das Ueberlappungszeichen kommt aus einer Hand"), der
Handnachbauten verbietet - sie haetten die drei Bedingungen nicht.

**NICHT gebaut im Monatsraster**, und das ist eine Entscheidung: der Chip misst dort 20px und
traegt bewusst nur den Titel (Apple-Kalender-Kanon, im Quelltext begruendet). Ein Zeichen
darin waere die Siegel-Inflation, die der Brief als Anti-Ziel fuehrt. Das „Wer" eines
Monatstermins bleibt damit ein offener Befund - seine Antwort liegt in der Tages- und
Detailansicht, nicht in einer kleineren Marke.

**Auch nicht im Erinnerungs-Toast**, aus einem anderen Grund: `/reminders` liefert keine
Personendaten (geprueft 2026-08-10, nur `entity_title`). Das waere eine Server-Erweiterung und
gehoert in einen eigenen Schritt.

### Die Chrome-Regel (Critique 2026-08-10, Frage 4)

**Ueber dem Inhalt stehen der Kopf und hoechstens EINE Bedienzeile. Was nicht hineinpasst,
wandert hinter einen Einstieg, nicht in eine dritte Zeile.**

Das ist die vierte Regel dieser Bauart, neben der Wischsemantik (die Reichweite der Tat
entscheidet den Rueckweg), dem Kopf-Kontrakt (der `module:`-Wert der Route entscheidet die
Leiste) und der Zielgroessen-Regel. Sie beantwortet die Frage, an der laut Critique Aufgaben,
Kalender, Einkaufen und Budget gleichzeitig scheiterten: was ist der primaere Inhalt einer
Modulseite, und wieviel Chrome darf davorstehen.

**Die Groessenklasse hat dafuer eine zweite Achse** (tokens.css §11c): unter 500px
Viewporthoehe faellt der Kopf auf seine Bar-Zeile, die Suche in ihre Icon-Form, jede Leiste
gibt eine Padding-Stufe ab, und `--fab-safe-zone` schrumpft auf Gap plus Knopf. Die Breite
allein konnte das nicht entscheiden - nach ihr ist ein 640x400-Fenster (ein 1280x800-Laptop
bei 200 % Zoom, also WCAG 1.4.4) von einem 375x812-Telefon nicht zu unterscheiden, auf dem
dieselben 296px Kopf unauffaellig sind. Dieselbe Lage haben Splitscreen-Tablets, kleine
Fenster und jedes Telefon im Querformat; iOS fuehrt sie als `verticalSizeClass`.

**Die Suche wechselt in ihre Icon-Form, nicht in ein leeres Feld.** Das ist die
Label-Verlust-Regel, angewandt auf den Flaechenverlust, und sie braucht dafuer weder Markup
noch JS: `.page-search` IST ein `<label for>`, ein Klick darauf fokussiert den Input, und
`:focus-within` klappt das Feld wieder auf - der Einstieg ist derselbe Knoten wie das Feld.
Die Bedingung ist woertlich die der gedeckelten Architektur (nur ohne Fokus UND ohne Wert):
eine Suche, die einem beim Scrollen der eigenen Treffer unter den Haenden verschwindet, waere
der falsche Gehorsam gegenueber der Regel.

**Was NICHT passiert: keine Leiste verschwindet, keine Zielgroesse schrumpft.** Eine Leiste
wegzunehmen hiesse, eine Navigationsebene zu verstecken, die es nur in dieser Groessenklasse
nicht gaebe. Die Tabs behalten `--target-base` und verlieren nur die Luft um sich herum.

**Und die FAB-Zone faellt so weit, wie sie kann, und keinen Pixel weiter.** Die erste Fassung
setzte sie auf 0 und war damit falsch: am Scroll-Ende lagen `.pantry-stepper__btn` und
`.contact-more-menu` unter dem Knopf und waren nicht mehr erreichbar - genau die Zusicherung
aus #634, an einem Scrollstand, den niemand mehr aufloesen kann, weil es unter ihm nichts
mehr gibt. Verzichtbar sind die 16px Luft und ein Teil des Schwebeabstands, nicht die Flaeche
des Knopfes. Der grosse Gewinn kommt ohnehin aus dem Kopf: auf /tasks 296px Chrome ueber
231px Scrollport vorher, 137px ueber 263px nachher - von "keine einzige Aufgabe sichtbar" auf
zwei.

**Diesen Absatz hat die Nachlauf-Regel ueberholt** (siehe unten): die Zone muss gar nicht
fallen, sie muss ihren MECHANISMUS wechseln. Was hier als „so weit, wie sie kann" formuliert
ist, war ein Kompromiss zwischen Flaeche und Erreichbarkeit - und der war nur noetig, solange
die Reserve den Scrollport verkuerzte.

### Die Nachlauf-Regel (2026-08-12)

**Die Reserve des FAB ist ein NACHLAUF am Inhaltsende, keine Verkuerzung des Scrollports.**
`padding-block-end: var(--fab-safe-zone)` an `.app-content`, nicht `margin-block-end`. Der
Scrollport reicht damit bis an die Fensterkante, und die 96px liegen als leerer Raum HINTER
der letzten Zeile - erreichbar nur, wenn man ganz nach unten scrollt, und genau dort gebraucht.

**Die eigentliche Korrektur ist die Invariante, nicht der Mechanismus.** Die Marge sicherte zu:
„bei KEINEM Scrollstand liegt etwas Bedienbares unter dem Knopf". Notwendig ist: **nichts ist
UNERREICHBAR.** Beide gemessenen Schadensfaelle lagen am SCROLL-ENDE - mobil
`.pantry-stepper__btn` und `.contact-more-menu` (2026-08-10), am Desktop acht Ziele mit
verdecktem Zentrum, darunter `contact-more-menu__trigger` mit 64 % und Budgets
`row-action--danger` mit 45 % (2026-08-12). Am Scroll-Ende laesst sich nichts mehr wegschieben;
mitten im Scrollen dagegen jederzeit, in beide Richtungen.

**Der Anlass war das Dashboard-Raster.** Am Desktop kostete die Marge 96px ueber die volle
Breite: gemessen 12 % eines 900er-Fensters und 25 % zusaetzlicher Scrollweg auf dem
Standard-Board. Sichtbar wurde sie als Widget-Reihe, die 96px ueber der Fensterkante mitten in
den Karten abbrach, mit totem Band darunter. Ein Raster, dessen Zusage buendige, gleich hohe
Karten sind, kann seine Unterkante nicht an eine unsichtbare Reserve abgeben.

**Dass der Knopf im Scrollen auf Inhalt liegt, ist kein Mangel, sondern was ein schwebender
Knopf IST.** Und es ist sicher, weil die Gefahrenrichtung stimmt: er liegt oben, ein Fehlgriff
landet also auf „Anlegen" und nicht auf „Loeschen" darunter. Laege es umgekehrt, waere die
strenge Invariante ihren Preis wert.

**Der Nachlauf gehoert an das, was WIRKLICH scrollt** (2026-08-20). Hier stand: „Ein Nachlauf
trifft beide Scrollport-Architekturen richtig, auf zwei Wegen - geprueft, nicht angenommen …
gemessen ueber 15 Routen: kein totes Band." Der erste Weg stimmt: wo `.app-content` selbst
scrollt (Dashboard, Aufgaben, Belohnungen, Geburtstage, Dokumente …), reitet der Nachlauf am
Inhaltsende und der Scrollport bleibt fensterhoch. Der zweite war falsch, und die Formulierung
sagt auch, warum er durchging: „verkuerzt er dessen Bezugshoehe - dort verhaelt sich alles exakt
wie mit der Marge, also **ohne Regress**". Gemessen wurde gegen den Vorzustand, nicht gegen die
Zusage. Kein Regress heisst nicht richtig: bei den acht Modul-Roots mit `height: 100%` verkuerzt
das Padding an `.app-content` den echten Scrollport bei jedem Scrollstand und laesst darunter
einen Streifen stehen, der nichts traegt und nicht mitscrollt.

Sichtbar wurde es erst, als die Sammelpille dazukam: sie bekam 2026-08-13 die richtige Fassung
(Nachlauf am echten Scrollport), die alte an `.app-content` blieb daneben stehen, und die drei
Module mit Pille zahlten sie sieben Tage lang doppelt - 76px am Zeiger, 80px am Finger, in jedem
der drei gleich. Die Regel lautet deshalb: **der Nachlauf haengt an der Rolle `.page-scrollport`,
die jede Seite mit eigenem Scrollport selbst vergibt** - nie an der Box, die den Scrollport
enthaelt. Die drei fixierten Flaechen sind Summanden (`--fab-tail`, `--bulk-pill-tail`,
`--install-prompt-tail`), eine Regel legt die Summe an. Ein Scrollport mit eigenem Bodenpolster
meldet es als `--scrollport-pad` an, statt `padding-bottom` zu schreiben, sonst ersetzt der
Nachlauf es.

**Mobil aendert die Regel nichts, und das ist per Konstruktion so:** unter 1024px ist
`--fab-safe-zone` 0, weil der Knopf in der Nav-Kapsel sitzt. Ein Nachlauf von 0 ist dasselbe
wie eine Marge von 0.

Pruefebene: **Dokument** (`Sonde 18 - am Scroll-Ende liegt nichts Bedienbares unter dem FAB`,
test-document-guards.js, beide Geraetewelten) plus **Struktur** (`der FAB weicht der Zeile,
statt eine Gasse zu reservieren`, test-frontend-audit.js), der die Marge ausdruecklich
verbietet. Seit 2026-08-20 dazu drei Guards ueber die Rolle: `wer seinen eigenen Scrollport
mitbringt, markiert ihn` (Kriterium ist die Bauart des Modul-Roots, keine Modulliste),
`die Scrollport-Rolle sitzt an einer Box mit Ueberlauf` (Gegenrichtung) und `die Pillenzone
steht nur am markierten Scrollport` (Abwesenheit an `.app-content`). Der letzte ist die Lehre
aus dem Vorgaenger, den er ersetzt: der forderte die falsche Bauart ausdruecklich ein und
zementierte damit den Defekt, den er absichern sollte. Sonde 18 ist gegen ihren Anlassfall gegengeprueft: ohne Reserve meldet sie
`contact-more-menu__trigger` (64 %) und `row-action--danger` (45 %). **Und sie hatte selbst
zwei blinde Fassungen** - die erste suchte den Scroller an seinem Namen statt an seinem
Overflow und meldete Zwischenstaende als Ende, die zweite zaehlte Ziele mit, die der Scrollport
WEGSCHNEIDET (`getBoundingClientRect` meldet die Layout-Position, nicht die Sichtbarkeit; mobil
waren das drei Kuechen-Ziele bei y 721-838 hinter einem Scrollport, der bei 735,9 endet).
Dieselbe Falle 2, die Sonde 4 an ihren Kanten beschreibt.

**Gemessen wird sie an der Sichtflaeche, nicht am Scrollport** - der Unterschied ist bei
dieser Regel entscheidend und war zweimal die Quelle einer falschen Messung. Die App hat zwei
Scrollport-Architekturen: in Kueche, Budget, Kalender, Notizen und Kontakten liegt der Kopf
AUSSERHALB des scrollenden Containers. Eine Sonde, die ab Scrollport-Oberkante misst, sieht
sein Chrome dort gar nicht und meldet 0 %, obwohl 252px Leisten darueber stehen.

**In der Kueche ist der Kopf zweiteilig, und das ist kein Sonderfall.** Nach der
Leisten-Regel IST die Kuechen-Leiste die Kopf-Navigation (siehe „Modulkopf"); der Modulkopf
darunter benennt den Platz IN dem Raum. Zusammen sind sie DER Kopf, und die Regel zaehlt sie
als einen. Das ist die einzige ehrliche Lesart: die Leiste traegt bei 375px schon 347-375px
Inhalt in 375px Breite, ein Zusammenfuehren zu einer physischen Zeile braeuchte horizontales
Scrollen - und dann waere der Modulkopf weg, sobald jemand die Tabs bedient.

Damit sind die Rezepte konform (Kopf plus die eine Bedienzeile ihres Center-Slots) und der
Essensplan traegt seinen dokumentierten zweizeiligen Kopf. Uebrig blieben genau zwei Routen
mit einer Zeile zu viel, und beide sind lokal geloest, ohne die Kuechen-Architektur
anzufassen:

- **Einkauf:** Listenwahl und Listenkopf teilen sich eine Zeile (Grid, zwei Spalten). Der
  Listenname im Kopf ist ohnehin eine Dublette der aktiven Tab links - ausblenden schied
  trotzdem aus, weil er dort kein Text ist, sondern das Ziel zum Umbenennen. Er schrumpft
  stattdessen als Erster. Gemessen 640x400: Scrollport 27 → 84px, die erste Artikelzeile ist
  wieder da.
- **Vorrat:** Modulkopf und Filterzeile teilen sich eine Zeile. Das ist ein direkter Gewinn
  aus der Kopf-Regel - die Suche steht in der kompakten Hoehe als Icon da statt als
  291px-Feld, und den Platz nimmt die Filterzeile. Gemessen: Chrome 173 → 105px, Scrollport
  106 → 158px, zwei volle Artikelzeilen.

**Was aus der Lead-Zone mitgeht, entscheidet der Inhalt des Slots** - dieselbe Abgrenzung
wie zwischen Bereich und Gruppe: eine SUCHE verschwindet (Apples
`hidesSearchBarWhenScrolling`), solange sie weder Fokus noch Wert hat; der ZEITRAUM einer
Seite (Monat im Budget, Datum im Kalender) bleibt stehen und beantwortet weiter „wo bin ich".

Die MECHANIK richtet sich nach der Scrollport-Architektur des Moduls, die Regel nicht:
- **Die Seite scrollt** (Aufgaben, Geburtstage, Dokumente, Belohnungen, Haushaltshilfe): der
  Kopf liegt im Scrollport und dockt ueber ein negatives `top` an (`--page-toolbar-lead` =
  Hoehe der Zeilen ueber der letzten). Seine Hoehe aendert sich NIE - ein Klassen-Umschalter
  wuerde hier ein Element im Fluss verkuerzen, den Scroll-Offset verschieben und den Kopf um
  seine eigene Schwelle pendeln lassen.
- **Eine innere Liste scrollt** (Budget, Kalender, Notizen, Kontakte): der Modul-Root ist
  `overflow: hidden`, der Kopf liegt ausserhalb und bewegt sich nie. Dort klappt die
  Titelzeile wirklich ein - gefahrlos, weil der Hoehenwechsel nur den inneren Port
  verlaengert, ohne dessen Offset anzufassen.

Der Kopf bleibt in ZEILENRICHTUNG - kein Modul setzt eine eigene Flex-Richtung auf einer
Kopf-Klasse. Eine Tab-Leiste im Kopf ist eine eigene, horizontal scrollende Zeile UNTER dem
Large Title; die Shell erkennt sie an `[role="tablist"]`, nicht an einem Klassennamen (die
vier heissen `.housekeeping-tabs`, `.rewards-tabs`, `.cal-toolbar__views`, `.budget-tabs` -
eine Regel ueber diese Liste fehlte beim fuenften). Wer dort steht, sagt die Leisten-Regel
oben.

Verdrahtet wird EINMAL, von der Shell (`wireCollapsingHeader` in `utils/ux.js`, aufgerufen
vom Router): der Kopf ist die eine Komponente, die alle Module teilen, und ein Opt-in, das
jedes Modul selbst setzen muesste, fehlt beim naechsten. Die Titelgroesse gehoert der
Canonical-Page-Head-Rolle in typography.css, der Umbruch layout.css.

### Der getoente Scrollbalken (#970, #1039)

**Ein Scroller, dessen Balken das Betriebssystem zeichnet, gehoert sichtbar dem System und
nicht der App.** Auf Plattformen mit klassischem, Platz nehmendem Balken stand neben jeder
getoenten Liste ein voller System-Balken, unter Windows/Firefox/Chromium dauerhaft sichtbar
statt nur beim Scrollen. Die Antwort ist kein Verstecken, sondern ein eigener, duenner
Balken aus Tokens.

**Die Rezeptur sind vier Deklarationen, und sie steht zweimal da, weil zwei Engines sie
verschieden lesen.** Firefox nimmt `scrollbar-width: thin` plus `scrollbar-color` direkt am
Scroller; WebKit und Chromium brauchen die Pseudo-Element-Fassung: `::-webkit-scrollbar` mit
`width: 10px`, ein transparenter Track, und der Daumen als
`color-mix(in srgb, var(--module-accent) var(--tint-hint), transparent)` mit
`border-radius: var(--radius-full)`. Der Daumen traegt eine **3px transparente Border mit
`background-clip: padding-box`** - so wirkt er schmaler als die 10px-Spur, ohne dass die
Treffflaeche schrumpft. `--tint-hint` ist nicht frei gewaehlt: tokens.css fuehrt die Stufe
ausdruecklich fuer „Kante, Linie, Scrollbar-Daumen".

**Der Balken ist nicht der Fade, und keiner ersetzt den anderen.** Der Fade am
Scrollport-Ende beantwortet „ist da noch mehr?" (Audit F-01, sonst waren Budget, Gesundheit
und Einstellungen auf 800er-Laptops unauffindbar). Der Balken beantwortet „wo bin ich, und
womit ziehe ich?". Ein Anriss ist eine Andeutung, kein Griff. Am Telefon ist der Unterschied
gleichgueltig, weil dort die Geste zieht; am Desktop mit Maus IST der Balken das
Bedienelement. Die Regel haengt deshalb an der BREITE, nicht am Vorkommen einer Zeile:
`scrollbar-width: none` bleibt am Telefon richtig.

**Der Anlass war eine Ruecknahme, keine Neuerung** (#970). Bis v2.64.1 stand
`scrollbar-width: none` samt verstecktem `::-webkit-scrollbar` am Seitenmenue ausgerechnet
in `@media (min-width: 1024px)` - also genau dort, wo mit der Maus gezogen wird und keine
Wischgeste einspringt, und der Fade darunter galt als Ersatz. Er beantwortete eine andere
Frage.

**Drei Traeger, drei angepasste Kopien - es gibt keine gemeinsame Basis, und das ist
benannt, nicht uebersehen:**

- `.budget-list` samt `.budget-loans__list` und den beiden Tab-Panels (budget.css) ist das
  Vorbild und stand vor der Regel da; seit #904 scrollt das Budget-Panel selbst und gehoerte
  deshalb in dieselbe Gruppe.
- `.list-scroller` (list-row.css, seit #1039) ist der geteilte Scroller von Einkauf, Vorrat
  und Rezepten - eine Regel, drei Module. budget.css blieb dabei unveraendert.
- `.nav-sidebar__items` (layout.css, seit #970) mischt gegen `--color-border` statt gegen
  `--module-accent`: **die Seitenleiste gehoert keinem Modul und darf nicht die Farbe des
  gerade offenen annehmen.**

**Zwei Abweichungen teilen die Kopien nicht, und beide stehen hier ungeglaettet.** Erstens
gibt es den Hover-Zustand nur an `.list-scroller`
(`calc(var(--tint-hint) + var(--tint-state))`, gerechnet auf zwei bestehenden Stufen statt
auf einer neuen Zahl): eine reine `--tint-hint`-Kante traegt laut tokens.css nie allein, ein
Zustand auf ihr braucht denselben Bezug. Budget und Seitenleiste haben ihn nicht. Zweitens
nennt `scrollbar-color` in Budget und Listen-Scroller den `--module-accent` in VOLLER
Saettigung, waehrend der WebKit-Daumen daneben auf `--tint-hint` mischt - Firefox zeichnet
den Daumen dort also kraeftiger als Chromium. Das steht in beiden Dateien zeichengleich, ist
damit die Rezeptur und kein Ausrutscher; die Seitenleiste ist die einzige, die beide Seiten
gleich toent.

**Offen, und bewusst nicht behauptet:** die `mask-image`-Fades liegen auf DEMSELBEN Element
wie der Balken, und eine Maske erfasst die Elementbox samt Scrollbalken. Auf Plattformen mit
klassischem, Platz nehmendem Balken verblasst sein unterstes Stueck deshalb im Fade-Bereich.
Die BEDIENUNG bleibt, weil eine Maske die Deckkraft aendert und nicht das Hit-Testing -
nachmessen liess es sich hier nicht, macOS zeichnet Overlay-Balken, die dabei gar nicht
erscheinen. Wenn es stoert, ist der Weg nicht `scrollbar-width: none` zurueck, sondern der
Fade von der Maske auf ein ueberlagertes Gradient-Pseudoelement; dann liegt er ueber dem
Inhalt statt ueber der Box.

Pruefebene: **Struktur**, zwei Guards. `Seitenmenue: der Scrollbalken ist am Desktop
sichtbar (#970)` (test-frontend-audit.js) misst den Zustand IN der Desktop-Query statt das
Vorkommen einer Zeichenfolge in der Datei, verbietet dort `scrollbar-width: none` und das
versteckte Pseudo-Element und besteht auf `scrollbar-color` aus Tokens statt als Literal.
`Der Listen-Scroller traegt einen duennen, getoenten Scrollbalken (#1039)`
(test-shopping.js) haelt beide Engine-Fassungen und den Hover fest. Das Vorbild in
budget.css hat keinen - der Guard haengt an der Kopie, nicht am Original.

### Das Vorschaubild (#1059)

**Ein fremdes Bild bekommt einen festen Rahmen, nie die Hoehe seiner Zeile.** Mealie und Tandoor
liefern ihre Rezeptbilder in jedem Seitenverhaeltnis, ein selbst hochgeladenes Bild ebenso.
Jedes Vorschaubild steht deshalb in einem quadratischen Rahmen fester Groesse mit
`overflow: hidden`, und das Bild darin traegt `width: 100%`, `height: 100%` und
`object-fit: cover`: **schneiden statt verzerren.** Eine bebilderte Karte ist damit genauso
hoch wie ihre textige Nachbarin (laut Kommentar in meals.css gemessen 121px zu 121px an
derselben Karte).

**Die Rezeptur ist ein JS-Baustein und drei Rahmen.** `public/utils/recipe-thumb.js` baut den
Rahmen fuer alle drei Anzeigeflaechen (Rezeptliste, Essensplaner, Kachel „Mahlzeiten heute"),
damit der Ruecksturz auf den Platzhalter nicht an drei Orten einzeln richtig sein muss. Der
Baustein waehlt die Quelle - **das eigene Bild gewinnt** (`/recipes/:id/image` vor
`/recipes/:id/provider-thumbnail`), weil sich, wer eines hochlaedt, fuer genau dieses
entschieden hat - und setzt `alt=""` (der Titel daneben sagt dasselbe) und `loading="lazy"`.
Auf denselben Platzhalter (`utensils`-Symbol, Klasse `<rahmen>--placeholder`) faellt er in
zwei Faellen: kein Bild laut letztem Sync, dann **ohne Request**, weil Mealie jeden 404 als
Fehlerzeile in sein eigenes Log schreibt (mealie-recipes/mealie#4804); oder Bild seit dem Sync
verschwunden, dann ueber den `error`-Listener. Die String-Form `recipeThumbHtml()` fuer Planer
und Kachel braucht nach dem Einfuegen `wireRecipeThumbs(root)`: ein `onerror` im Markup waere
ein Inline-Handler und scheitert an der CSP. Ein Bild, das beim Verdrahten schon fertig und
ohne Abmessungen ist (`complete` mit `naturalWidth === 0`), gilt dabei als Fehlerfall, sonst
waere ein schneller 404 vorbei, bevor jemand zuhoert.

**Die Groesse folgt der Flaeche, und nur der Ausloeser ist rund:**

- `.recipe-row__thumb` (recipes.css) ist das Vorbild aus der Mealie-Anbindung: `--target-md`
  (40px), `--radius-sm`, Platzhalter auf `--color-surface-2` mit Tertiaertinte. Die
  Rezeptliste zeigt den Rahmen IMMER, notfalls als Platzhalter.
- `.meal-card__thumb` (meals.css): `--target-sm` (32px), `--radius-sm`, derselbe Platzhalter.
  **Nur die bebilderte Karte wird zum Grid** (`.meal-card__open--with-thumb`), jede andere
  bleibt die Spalten-Flex, die sie war. Die erste Fassung gab jeder Karte einen Bildslot und
  bezahlte das mit 32px plus Abstand von einer rund 100px breiten Wochenspalte, in jeder Zelle.
  Das Ticket schliesst genau das aus: „a missing picture is a quiet gap, not a layout change".
- `.meal-slot__thumb` (dashboard.css): `--icon-lg` (20px), `--radius-xs`, **nur mit Bild** und
  IN der Titelzeile, so hoch wie sie. Der Slot traegt oben rechts schon das Symbol seiner
  Mahlzeitenart; ein zweites Besteck-Symbol daneben waere Unruhe ohne Aussage.
- Der Bild-Editor im Rezeptformular (`.recipe-image-preview`, recipes.css) ist dieselbe Bauart
  wie `.inventory-photo-editor` (inventory.css): 84px, `--radius-full`, Grund aus
  `--module-accent` auf `--tint-surface`, die Vorschau ist selbst der Ausloeser, daneben zwei
  Knoepfe. **Rund ist hier keine Geschmacksfrage:** der Editor ist ein quadratischer KNOPF,
  und die Ausnahmen der Kreis-Regel sind Zustandsschalter, Rasterzellen und Felder mit eigener
  Kante. Die drei Vorschau-Rahmen darueber loesen nichts aus, fallen deshalb nicht unter die
  Regel und tragen das abgerundete Quadrat.

Planer und Kachel rufen den Baustein nur, wenn eines der beiden Bild-Flags gesetzt ist; der
Platzhalter aus dem ersten Fall erscheint dort also nie, nur der Ruecksturz aus dem zweiten.

**Zwei Abweichungen stehen hier ungeglaettet.** Erstens teilen die beiden Editoren Form und
Groesse, aber nicht die Tinte ihres Platzhalter-Symbols: `.inventory-photo-preview__fallback`
mischt den Modulton auf `--tint-ink`, `.recipe-image-preview` steht auf
`--color-text-tertiary`. Zweitens liegt der Platzhalter von Zeile und Karte auf
`--color-surface-2`, der der Editoren auf der Modultoenung: das eine ist ein ruhiger
Leerplatz in einer Liste, das andere ein Bedienelement, das zum Hochladen einlaedt.

**Offen, aus dem Code gelesen und nicht im Browser nachgestellt:** die Kachel hat keinen
Platzhalter-Stil. Faellt ihr Bild im zweiten Fall weg, haengt `wireRecipeThumbs()` trotzdem
`meal-slot__thumb--placeholder` samt `utensils`-Symbol an, und dashboard.css kennt die Klasse
nicht. Dann stuende neben dem Symbol der Mahlzeitenart ein zweites Besteck-Symbol, also genau
die Doppelung, die der Kommentar in `renderTodayMeals()` vermeiden will. Ob der Rahmen dort im
Fehlerfall wegfallen oder einen eigenen Platzhalter bekommen soll, ist nicht entschieden.

Pruefebene: **keine Struktur-Guards fuer den Rahmen selbst.** Kein Test haelt
`object-fit: cover`, die festen Abmessungen oder den Ruecksturz in `recipe-thumb.js` fest.
Gesichert sind drei Randbedingungen: `ein quadratischer Icon-Knopf ist ein Kreis`
(test-frontend-audit.js) erzwingt die runde Editor-Form; `eine geaenderte Modifier-Klasse
verhindert das Wiederfinden nicht` (test-modal-utils.js) haelt fest, dass
`meal-card__open--with-thumb` Darstellung ist und keine Identitaet, denn wer beim Bearbeiten
ein Bild hinzufuegt, aendert die Klasse des Knopfes, zu dem der Fokus zurueck muss; und
test-recipes-routes.js prueft, dass die Rezeptliste nur das Flag `has_own_image` traegt, nie
die Bilddaten.

### Wischbedienung (Signature Component)
Listenzeilen tragen ihre Aktionen auf Touch in zwei Wischrichtungen; auf Zeigergeraeten
bleiben die sichtbaren Knoepfe, denn dort gibt es keine Geste. Die Panels hinter der Karte
trennen **zwei Achsen**: die SEITE ist die Kante, an der das Panel liegt (`--leading` am
Zeilenanfang, `--trailing` am Zeilenende), die ROLLE traegt allein die Bedeutung (`--done`
success, `--edit` accent, `--delete` danger). Eine Klasse, die beides packt, ist beim
zweiten Nutzer verbraucht.

**Die Kante ist logisch, nicht links und rechts.** In `ar` und `fa` setzt die App
`dir=rtl`; die Panels stehen auf `inset-inline-start/-end` und den vier logischen
Eckradien, und `wireSwipeRows` leitet aus derselben Schreibrichtung ab, welche
Fingerbewegung welche Kante aufdeckt. Der Nudge-Hinweis und der permanente Chevron sind
Richtungsangaben und spiegeln mit.

**Dieselbe Geste bedeutet in jeder Liste dasselbe.** Der Zeilenanfang traegt die primaere
positive Aktion, das Zeilenende das Destruktive oder Sekundaere:

| Liste | Zeilenanfang (in LTR: Wisch nach rechts) | Zeilenende (in LTR: Wisch nach links) |
|---|---|---|
| Aufgaben | erledigt umschalten (`--done`), fliegt hinaus | Detailansicht (`--edit`), federt zurueck |
| Einkauf | abhaken (`--done`), fliegt hinaus | loeschen (`--delete`), federt zurueck, widerrufbar |
| Geburtstage | bearbeiten (`--edit`), federt zurueck | loeschen (`--delete`), federt zurueck, widerrufbar |
| Abonnements | Zahlung buchen (`--done`), federt zurueck, fragt nach | loeschen (`--delete`), federt zurueck, fragt nach |

Die Abo-Zeile ist die einzige, deren `--done` nicht abhakt, sondern BUCHT: sie schiebt das
Faelligkeitsdatum und legt einen Budget-Eintrag an. Ein zweiter Wisch nimmt das nicht
zurueck, anders als bei einer Aufgabe an derselben Kante - deshalb fragt sie nach, und
deshalb fliegt sie nicht hinaus. Bearbeiten liegt dort auf keiner Wischrichtung, sondern auf
dem Zeilenkoerper (`.list-row__main--interactive`), und der ist ein echter `<button>`: ein
blosser Tap-Handler haette den Bearbeiten-Knopf aus der Zeile genommen, ohne einen
Tastaturweg an seine Stelle zu setzen.

`--edit` steht in Aufgaben am Zeilenende und in Geburtstagen am Anfang, und das ist kein
Widerspruch: die Regel ordnet einen RANG zu, keine Rolle. Wo eine positive Aktion in der
Liste steht, ist Bearbeiten die sekundaere; wo keine steht, ist es die primaere. Fest
liegen die beiden Enden der Skala - `--delete` steht nie am Zeilenanfang, `--done` nie am
Ende. Genau das misst der Guard.

**Eine Geste, die loescht, hat einen Rueckweg**, nie ein direktes `api.delete`. Der Einkauf
war die eine Stelle, die sofort und endgueltig loeschte - wer die Geste in zwei Listen als
harmlos gelernt hat, verlor in der dritten Daten ohne Rueckweg. Welcher der beiden Rueckwege
richtig ist, entscheidet die Reichweite der Tat: der Undo-Toast, wo sie sich in einem Satz
zuruecknehmen laesst, die Bestaetigung, wo sie ueber ihr Modul hinaus wirkt (siehe „Die
Wischsemantik-Regel" bei Cards / Containers).

Die Karte fliegt nur dann hinaus, wenn die Zeile die Liste tatsaechlich verlaesst; ist die
Aktion widerrufbar oder oeffnet sie nur einen Dialog, federt die Karte zurueck. Eine
hinausgeflogene Karte behauptet, die Sache sei erledigt, waehrend das Undo-Fenster noch
offen steht. Die Geste selbst - Schwellwert 80px, Daempfung darueber, Scroll-Erkennung,
Haptik am Schwellwert, Ausnahme fuer den Sortiergriff, der einmalige Hinweis nach dem
Seitentausch - liegt geteilt in `utils/swipe-row.js`.

**Geprueft auf zwei Ebenen, weil jede etwas anderes sehen kann.** Ebene 3 (statisch, in
`test-frontend-audit.js`) folgt von jeder Wischrichtung mit `--delete` der Kante zu der
Funktion, die sie ruft, und verlangt dort den Rueckweg. Ebene 4 (`test:document-guards`,
Sonde 5) faehrt die Geste im gerenderten Dokument in `de` und `ar` und misst, welches
Panel sie aufdeckt - **ob eine Liste ueberhaupt verdrahtet ist, sieht nur diese Ebene.**
Der Einkauf verdrahtete seine Gesten nur im Nachlade-Pfad und antwortete beim ersten
Oeffnen der Seite auf gar nichts; im Quelltext stand alles richtig da.

### Das Markensiegel (Signature Component)
Yuvomis eigene Ausweisform und die Antwort auf "Health hat die Ringe, was hat Yuvomi?" - die
eine Stelle, an der die Marke etwas kann, was keine Systemapp braucht: **Yuvomi ist der
einzige Ort, an dem siebzehn Apps in einem Raum leben, und das Siegel weist jedes Ding als
"aus Raum X" aus.**

**Material:** eine kreisrunde VOLLTON-Scheibe mit Modul-Icon und der Sheen-Lichtkante der
Bildmarke (drei transluzente Kreise) - Flaeche im Familienton, Tinte `--color-ink-on-vivid`,
Sheen als Gradient aus `--glass-sheen`. **KEIN backdrop-filter**: die Glas-ist-Chrome-Regel
bleibt unberuehrt, und der Sheen-Stop kippt unter `prefers-reduced-transparency` und
`prefers-contrast` mit seinem Token auf die flache Scheibe.

**Die Herkunfts-Regel (das Einsatzgesetz).** Ein Siegel zeigt die Herkunft eines Objekts, und
Herkunft zeigt man nur, wo sie nicht selbstverstaendlich ist. Daraus folgen genau zwei Faelle:

- **Jede MISCHSTELLE** - eine Liste, deren Zeilen aus verschiedenen Modulen stammen
  (moduluebergreifende Suche, "Heute wichtig", Dashboard-Widget-Koepfe, "Mehr"-Liste,
  Benachrichtigungsdarstellung) - gibt jedem Objekt sein Siegel und BENENNT dabei die fremde
  Herkunft, inline oder ueber die Klasse ihres Traegers.
- **Im eigenen Modul** steht es genau einmal, als Absender im Kopf (siehe Modulkopf). Es
  benennt dort nichts, sondern ERBT den Ton des Raumes, in dem es steht - genau daran ist die
  Rolle zu erkennen.

Damit ist die Dosierung Gesetz statt Geschmack. Vorher trug die Gesundheit vierzehn
Vorkommen und die Dokumente keines. Anti-Ziel ist die Siegel-Inflation: in den Listen eines
Moduls spraeche ein wiederholtes Siegel den Modul-Tint ueber die etablierten Elemente.
**Pruefebene: Signatur** (`wer ein Markensiegel baut, benennt eine Herkunft oder ist der
Kopf`, `test:frontend-audit`) - der Guard findet jede Bau-Stelle ueber ihre Bauart und
verlangt von jeder eine der beiden Rollen; die Kopfrolle darf nur die Shell bauen.

**Die Navigation traegt KEINES, und das ist dieselbe Regel, nicht ihre Ausnahme.** In der
Tab-Bar und der Sidebar steht das Label unter dem Icon - die Herkunft ist dort
selbstverstaendlich, ein Siegel waere Dekor. Was sie traegt, ist der Ton auf dem nackten
Zeichen (Legende, siehe „Colors") - das ist kein halbes Siegel, sondern der andere Kanal:
keine Scheibe, keine Flaeche, nur die Farbe des Zeichens. Die Leiste ist ausserdem der einzige Ort, der
nicht "woher" beantwortet, sondern "wo bin ich"; getoente Scheiben auf allen Eintraegen nehmen
der aktiven Pille ihre Alleinstellung, und Suche, Hilfe und Abmelden bekaemen Scheiben ohne
Modul. Das Mehr-Sheet traegt Siegel, weil es ein VERZEICHNIS von Raeumen ist - der
Unterschied bleibt nur lesbar, solange die Leiste keine traegt. (Entscheidung von Ulas am
2026-08-10, am gerenderten Material getroffen.)

**Zwei Groessenrollen:** Listenzeile `--sm` (24px, Icon 16px) und Modulkopf (32/24px je nach
Rang seines Titels, siehe Modulkopf).

**Das Siegel hat EIN Gesicht, und es ist der Vollton** (2026-08-17). Hier standen zwei: eine
16-%-Toenung fuer den Regelfall und `--vivid` fuer die eine umgekehrte Flaeche (den Toast),
dazu ein Parameter `--seal-base` fuer den Grund, gegen den die Toenung mischt. Der Vollton hat
die Regel gewonnen, statt neben ihr zu bestehen - erst der Widget-Kopf, dann die Kachelreihe,
und beide mit derselben Begruendung.

**Was die Toenung erledigt hat, ist eine Messung, und zwar zweimal dieselbe.** Im Dark zerlegt
`dark-chroma.mjs` die Beimischung in Helligkeits- und Buntheitsanteil: sie hellt fast nur auf
(Buntheit 4-8 von 24-73 des Volltons) - eine Waschung KANN im Dark keine Farbe tragen. Im Light
war der Befund schaerfer und stand sichtbar im „Mehr"-Blatt: Notizen, Dokumente und Inventar
teilen die Familie `records`, und ihr Scheibengrund war bei 16 % **bitweise derselbe**
(#E1E4EA). Die Toenung loeschte genau den Unterschied, den sie zeigen soll. Der Vollton ist
dieselbe Sprache, die die App fuer jede vivide Flaeche schon fuehrt (Primaerknopf, FAB,
aktives Segment, Marken-Tile).

**Gemessen ueber alle neun Familientoene, Glyph gegen Scheibe, an der unguenstigsten Stelle**
(unter dem Sheen, wo 16 % Weiss den Ton aufhellen): Light 3,65-5,18:1, Dark 7,42-12,24:1 -
ueberall ueber der 3:1-Grafikschwelle. Ohne Sheen liegt Light bei 5,04-7,17:1.
**Pruefebene: Regel** (`dashboard „Heute wichtig" is one inset-grouped list`,
`test:frontend-audit`) - der Guard verbietet die Rueckkehr von `--seal-base` UND von
`--vivid`, und er liest ueber `eachRule`, damit ihn die Begruendung in den Kommentaren nicht
selbst ausloest.

**Das Ueberlappungszeichen** (Avatar ueberlappt Siegel, "wer ∩ was") ist das Familien-Zeichen
aus der Drei-Kreise-Marke. Es erscheint nur, wenn es mehr als einen moeglichen Beteiligten
gibt; im Solo-Haushalt entfaellt es still. **Nie Pflichtelement** - ein Personen-Zwang fuer
Solo-Nutzer ist ein Anti-Ziel des Briefs.

**Eine Systembenachrichtigung kann kein Siegel tragen**, und der Titel uebernimmt seine
Aufgabe: sie hat kein DOM, ihr `icon` erreicht nur einen Teil der Plattformen, und Android
maskiert ihr `badge` monochrom, womit der Familienton ohnehin verloren ginge. Der Titel
erreicht jede Plattform und stand app-weit auf "Yuvomi" - auf dem, was das System darueber
ohnehin anzeigt. Er nennt jetzt das Herkunftsmodul (Kalender, Aufgaben, Abonnements,
Medikamente), serverseitig uebersetzt ueber die Datensprache des Haushalts, clientseitig ueber
die Sprache des Nutzers. Die beiden Karten liegen beidseits der Schichtgrenze und sind an die
`entity_type` gebunden, die der Server wirklich schreibt (Guard-Ebene Signatur).

### Der Widget-Kopf: das Vollton-Siegel als Absender (Signature Component)
Seit 2026-08-17 (Widget-Kopf-Kur, Etappe 2 der Modernisierung) ist der Kopf einer
Dashboard-Karte eine TITELZEILE DIREKT AUF DER KARTENFLAECHE: davor das Markensiegel im
Vollton (Ton = Flaeche, Tinte = `--color-ink-on-vivid`), Titel in
Text-Primary, Zaehler als getoenter Badge, „Alle" als neutraler Textlink mit Ton erst im
Hover. Kein Band, keine getoente Trennlinie, keine 2px-Oberkante: der Absender einer Karte
ist GENAU EIN Element, und es traegt den Modulton zu 100 %. Die Kachelreihe
(`metric-card--tile`) fuehrt dasselbe Siegel - zwei Siegel-Gesichter auf einem Board
waeren zwei Wahrheiten.

**Hier stand `module-seal--vivid`, und die Klasse gibt es nicht mehr.** In Etappe 2 war sie
die Ausnahme neben der 16-%-Toenung; Etappe 3 desselben Tages hat den Vollton zur Regel
gemacht, er steht seither in der `.module-seal`-Basisregel, und die Variante ist mitsamt
`--seal-base` gestrichen (siehe „Das Markensiegel"). Der Kopf setzt hier also keine Klasse
mehr, er setzt nur `--seal-accent`.

**Hier stand von v2.6.0 bis 2026-08-17 das ABSENDERBAND** - ein vollbreites
`--tint-wash`-Band mit getoenter Trennlinie plus der 2px-Haarlinie an der Oberkante, drei
Farbaussagen in ~51px. Es ist an seiner eigenen Messlatte zurueckgebaut: es sollte den im
Dark unsichtbaren Haarlinien-Kanal ersetzen, aber eine WASCHUNG kann im Dark keine Farbe
tragen. Die Chroma-Zerlegung (CIEDE2000/LCh, `.impeccable/redesign-tools/dark-chroma.mjs`)
zeigt: die 8-%-Mischung hellt fast nur auf (Buntheit 4-8 gegen 24-73 des Volltons; records
VERLIERT auf der warmen Kohle sogar Buntheit). Das Band war damit im Light ein
Pastellstreifen und im Dark ein Braunschleier - „klobige eingefaerbte Zeile" (Betreiber,
Critique 2026-08-17) traf beide. Die Lehre ist allgemeiner als das Band: **wer im Dark Farbe
sagen will, sagt sie im Vollton eines kleinen Elements, nicht in der Beimischung einer
grossen Flaeche.**

**Den Ton setzt die Karte, nicht die Seite.** Jede `.widget--*`-Klasse legt `--widget-accent`
auf ihren Modulton (fuer Badge, Link-Hover und Fehlerkante); das Siegel selbst bekommt
`--seal-accent` aus dem Slug seiner Route. Der Fallback ist die Stimme. Ein
`--active-module-accent` an dieser Stelle loeste auf dem Dashboard den Akzent der UEBERSICHT
auf, also bekaemen alle Widgets dieselbe Farbe - ausgerechnet in dem Raster, in dem siebzehn
Module nebeneinanderstehen.

**`--seal-base` braucht der Kopf nicht mehr - und niemand sonst.** Die Mischgrund-Falle
(„Der Traeger entscheidet, welches Gesicht es zeigt") gehoerte zum getoenten Gesicht auf dem
Band-Grund; der Vollton kennt keine Mischung, sein Ton IST die Flaeche (AA an der
Toast-Herkunft gemessen: Glyph auf Scheibe 5,1-9,8:1 in beiden Themes). Der Parameter ist
mit ihr app-weit entfallen, ein Guard verbietet seine Rueckkehr; was den Namen weiterfuehrt,
ist `--seal-pair-ground` am Ueberlappungszeichen, und das beantwortet eine andere Frage.

### Das Tagesprogramm (Signature Component)
Das eine Blatt, das die Uebersicht anfuehrt: EIN Traeger auf `--color-surface` mit
`--radius-xl` und `--shadow-lg`, Zeilen als Haarlinien, je Zeile ein Siegel fuer den Raum,
aus dem der Eintrag kommt. Kein Glas und kein `backdrop-filter` - die Glas-ist-Chrome-Regel
gilt, das Blatt ist Inhalt (Rang kommt aus Radius und Elevation, siehe „Die Rang-Regel").

**Seine Zeilen atmen mehr als eine Listenzeile** (`--space-3` statt `--space-2` vertikal): das
Blatt traegt drei bis sechs Zeilen, nicht dreissig - der gewonnene Raum kostet keinen Scroll
und ist der Unterschied zwischen „Liste" und „Programm". Die Zeilenhoehe ist auf allen
Geraeten dieselbe.

**Der Zustand spricht im Ton der Zeile, nicht in Neutralgrau.** Jede Zeile weiss ueber
`--today-card-accent` schon, aus welchem Raum sie kommt - das Siegel links zeigt es -, und ein
neutraler Hover warf diese Auskunft im Moment der Beruehrung weg. `--tint-state` (12 %) ist
die Skalenstufe fuer genau das: Zustand auf einer ungetoenten Flaeche.

### Das Wetter-Widget (Signature Component)

**Das Wetter ist der einzige Inhalt der App, den niemand im Haushalt eingegeben hat** - er
kommt von draussen und aendert sich von selbst. Deshalb ist es die einzige Kachel, die eine
eigene Farbe und eine eigene Bewegung traegt. Bis 2026-08-17 stand seine Glyphe in
`--module-dashboard`, also im Violett der Uebersicht: die Karte sagte damit, WO sie haengt -
eine Auskunft, die auf einer Dashboard-Karte niemand braucht, weil sie schon aus der Seite
folgt.

**SECHS LAGEN ALS TON** (tokens.css 5b): klar, Nacht, bewoelkt, Regen, Schnee, Gewitter.
Sie sind eine PARALLELE Domaenenfamilie, keine zehnte Familientonfamilie - das Vokabular
der neun Familien gehoert den Modulen, und keine Lage teilt den Wert einer von ihnen. Die
Lage wird aus dem ICON-NAMEN abgeleitet, nicht aus dem Beschreibungstext: der ist
lokalisiert und in der OWM-Fassung frei formuliert, das Icon ist beim selben Provider immer
derselbe Schluessel. Zwoelf Werte, gemessen gegen ihre drei realen Gruende je Theme,
Zielwert **4.5:1 statt 3:1** - der Ton traegt in der Verlaufszeile auch die
Hoechsttemperatur, und das ist Kleintext. Farbe ist nie alleiniger Traeger: daneben stehen
die Glyphe der Lage und der ausgeschriebene `wmo.*`-Text.

**DER LICHTHAUCH** haengt an der Glyphe, nicht an der Karte - eine Huelle um sie, weil ein
SVG keine Pseudo-Elemente hat. Zwei Stufen, zwei Rollen: der Kern toent als Objekt
(`--tint-surface`), das auslaufende Feld untergreift fremden Inhalt (`--tint-wash`). Der
erste Anlauf hing an `.weather-widget__main` und rechnete sich von dessen Inline-Ende zur
Glyphe zurueck; ab 860px Containerbreite bekommt der Kasten eine feste Basis und das Licht
lag gemessen 108px neben seiner Sonne. **Wo ein Bezug eine Rechnung braucht, ist der
Anker falsch gewaehlt.**

**VIER GANGARTEN**, und jede sagt, was sie zeigt: `rays` dreht die Sonnenstrahlen um die
stehende Scheibe (72s), `drift` laesst die Wolke ziehen, `fall` schickt Tropfen und Flocken
versetzt nach unten, `flash` laesst das LICHT doppelt aufleuchten statt die Glyphe zucken
(ein Blitz IM Zeichen liest bei 24px wie ein Darstellungsfehler). Die Gangart haengt am
Icon, NICHT am Ton: `sun` und `cloud-sun` tragen denselben Bernstein und bewegen sich
gegensaetzlich, weil bei `cloud-sun` die Wolke selbst ein `<path>` ist. Ziele sind
Kindknoten der Lucide-SVGs; trifft eine Regel nach einem Update ins Leere, steht die Glyphe
still - der schlechteste Ausgang ist kein Defekt.

**DER AUSSCHALTER IST EINE BEDINGUNG, KEINE GEGENREGEL**, und das ist die uebertragbare
Lehre dieser Runde. Der erste Anlauf folgte der Hausform
(`@media (prefers-reduced-motion: reduce) { ... animation: none }`) und hat den Regen nicht
angehalten: die Tropfenregel traegt ein `:not(:first-child)` und damit eine Klasse mehr
Spezifitaet als die Gegenregel. Die Sonne stand still, der Regen fiel weiter, und beide
standen im selben Block. Ein Spezifitaets-Wettruesten waere die zweite Falle gewesen - jede
neue Gangart braeuchte ihre eigene Gegenzeile, und die vergisst man genau einmal. Die
Bewegung steht deshalb NUR DANN im Stylesheet, wenn sie erwuenscht ist
(`prefers-reduced-motion: no-preference`). Was bleibt, bleibt: Ton, Lichthauch und
Spannenbalken sind Farbe und Form, keine Bewegung. Guard-Ebene: Signatur (jede Regel, die
eine Wetterflaeche animiert, muss unter einer Bewegungs-Bedingung stehen) - er fand
denselben Befund im Bestand, den Ladekringel des Aktualisieren-Knopfs, und der bleibt als
BENANNTE Ausnahme: eine Aktivitaetsanzeige muss auch unter reduzierter Bewegung erkennbar
sein, und die Zusicherung belegt, dass sie fluechtig ist.

**DIE SPANNE DER WOCHE** macht aus der Verlaufszeile eine Auskunft. Unter jedem Wochentag
standen zwei nackte Zahlen ohne Beziehung zueinander - welcher Tag der waermste ist, war
eine Rechenaufgabe. Der Balken ist auf die Spanne der GANZEN Vorhersage normiert: Lage sagt,
wo der Tag in der Woche liegt, Laenge, wie weit er schwankt, Farbe, wie warm es wird. Fuenf
BENANNTE Temperaturbaender statt einer stufenlosen Rampe, und der Grund ist ein Guard: eine
Interpolation haette ihren Mischwert als Zahl am Element gebraucht
(`calc(var(--x) * 100%)`), und genau diese Bauart sieht der Toenungs-Guard nicht - sie waere
die achtunddreissigste Prozentstufe gewesen, nur unsichtbar. Die Schwellen stehen in jeder
Einheit ausgeschrieben statt umgerechnet: „unter null" ist im Fahrenheit-Haushalt 32 °F und
nicht 31,999.

**DREI FLAECHEN, ZWEI GANGARTEN.** Karte, Masthead-Zeile und Wand-Modus teilen Ton und
Bewegung; die Kartenglyphe traegt Farbe allein, ihre fuenf Vorhersagezeichen bleiben
sekundaer und die Auskunft uebernimmt der Balken. Auf der WAND ist es umgekehrt: dort traegt
jeder der vier Tage seinen eigenen Ton, weil aus zwei Metern Farbe die schnellere Auskunft
ist als Form. Nachts gibt die Wand beides ab - ein bernsteinfarbenes Sonnenzeichen waere im
dunklen Flur der hellste Punkt im Raum.

### Anmeldeseite
Die erste Seite der App ist Teil derselben Welt, keine Ausnahme. Die Buehne ist der reine
Seitengrund ohne Verlauf (bis Runde 3 stand hier der letzte chromatische Verlauf der App).
Die Marke traegt allein das Tile: 64px, `--radius-lg`, gefuellt in Akzent, Zeichen in
`--color-ink-on-vivid` (6.06:1 light / 6.40:1 dark - nicht `--color-text-on-accent`, das
statisches Weiss ist und im Dark auf 2.72:1 faellt), shadow-md plus feine Lichtkante. Der
Titel ist ein Large Title in Label-Farbe wie jeder Seitentitel. Die Bildmarke selbst - drei
transluzente violette Kreise mit Sheen - ist als Marke gesetzt und unantastbar.

### FAB (Signature Component)
Getoente Glas-Kapsel: der App-Akzent mit 78 % Deckung
(`color-mix(in srgb, var(--color-accent) 78%, transparent)`) ueber
`--blur-md` + `saturate(var(--lg-glass-saturate))`, Specular-Kanten (`--glass-inset-strong`
plus Bottom-Inset) und `--glass-sheen` auf der oberen Kapselhaelfte als Materialbeweis -
am Scroll-Ende liegt per `--fab-safe-zone` leerer Nachlauf unter dem FAB, der Sheen ist dort
der einzige Beweis, dass die Flaeche Glas ist. Die 78 % sind eine Untergrenze: darunter faellt das
Plus-Glyph auf hellen Modul-Tints unter 3:1 (gemessen 78 % Tasks-Gruen auf Weiss = 3.4:1).
Hover geht auf Vollton, der Fallback ist opak. Einblendung als Feder (420ms `--ease-out`
plus Ring-Pulse), reduced-motion-sicher.

**Er traegt die Stimme, nicht den Modulton - hier stand bis 2026-08-11
`var(--module-accent, var(--color-accent))`.** Der Wert war ein Rest aus der Zeit vor der
Eine-Stimme-Regel: `layout.css` (Basisregel und opaker Fallback) und `glass.css` (Glaspfad)
lesen seit 2026-08-10 beide `--color-accent`, und die Frontmatter fuehrte ihn ebenfalls schon
richtig - allein dieser Abschnitt beschrieb noch den alten Zustand. Der FAB ist nach dem
Kriterium der Regel eindeutig: er tut in jedem Modul dasselbe. Die 3:1-Messung oben stammt
noch aus der Modulton-Zeit und bleibt die Begruendung der Untergrenze; sie haelt fuer den
einen Akzent erst recht, weil das Violett dunkler ist als das gemessene Tasks-Gruen.

### Event-Bloecke im Kalender (Signature Component)
**Im Monatsraster** flache Tint-Bars statt satter Farbfelder: Flaeche auf `--tint-surface`
(Layer-Farbe auf `--color-surface-work`, Hover eine Sprosse hoeher auf `--tint-raised`),
Tinte `color-mix(in srgb, var(--ev-color) 35%, var(--color-text-primary))`; gemessen
7.2-9.5:1 ueber die Layer-Farben. Keine Borders, Icons oder Avatar-Stacks im Monat (das
"wer" traegt das title-Attribut). "Heute" ist NUR ein gefuellter Akzent-Kreis auf der Ziffer;
Nachbarmonatstage dimmen ueber Flaeche UND Ziffer (AA-fest), nie ueber blosse Opacity auf
Text allein.

**Die Vollton-Kanten-Regel** (2026-08-17, Etappe 3). Wo ein Block GROSS genug ist, ihn zu
tragen, sagt eine Kante im Vollton, zu wem er gehoert - 3px an der Inline-Start-Seite, der
Zeitleisten-Kanon der Messlatte (Apple Kalender, Fantastical). Der Tagesspalten-Block hatte
sie als eigenes Element (`.day-event__spine`) laengst; Wochen- und Ganztages-Bloecke bekamen
sie als `border-inline-start`, weil sie ohne sie im Dark entsaettigter Nebel waren: 16 %
Fuellung plus eine 1px-Kante auf halber Deckung ist dieselbe Beimischungs-Falle, an der das
Absenderband zerbrochen ist - **eine Waschung hellt auf, sie faerbt nicht.** Fuellung
(`--tint-surface`) und Tinte (38 % im Wochen- und Tagesblock, 35 % im Ganztages-Balken und
im Monat) bleiben bei ihren gemessenen Rezepten unveraendert; die Farbe wandert in die Kante,
wo die User-Farben-Regel sie ausdruecklich zulaesst.

**Hier stand bis 2026-08-28 „Das Monatsraster bleibt kantenlos", und das war seit der
Umsetzung falsch.** Alle VIER Blockarten tragen die Kante - `.month-day__event` genauso wie
`.week-event`, `.day-event` und `.allday-event`; im Quelltext ist sie am Monatschip
begruendet, nur hier war die Ausnahme stehengeblieben. Zwei Wahrheiten in zwei Dateien, und
die Datei mit dem Anspruch, die Quelle zu sein, war die falsche. Der befuerchtete Effekt
(„bei 20px Chiphoehe waere die Kante ein Viertel des Blocks") ist gemessen nicht
eingetreten: 3px auf 20,8px sind ein Siebtel, und der Chip liest als Balken mit Kante, nicht
als Kante mit Rest.

**DER PUNKT BRAUCHT EINEN RING, DIE KANTE NICHT** (2026-08-28). Unter 640px faellt der
Monatschip auf einen Punkt zusammen, und damit wird die freie Nutzerfarbe vom Beiwerk zum
EINZIGEN Informationstraeger der Hauptansicht - ab da schuldet sie 3:1 nach WCAG 1.4.11,
und das kann sie nicht halten: von den neun Seed-Terminfarben fielen FUENF gegen die helle
Arbeitsflaeche durch (Amber 2,15:1, Cyan 2,43:1, Teal 2,49:1, Gruen 2,54:1, Orange 2,80:1),
gegen die Wochenendflaeche zusaetzlich Rot. Im Dark bestanden alle - **eine Invariante, die
nur in einem Theme haelt, ist keine.** Die Antwort ist nicht, die Farbe nachzudunkeln: sie
gehoert dem Haushalt. Ein Ring in `--color-text-tertiary` traegt die Abgrenzung stattdessen
selbst (light 4,74-5,64:1, dark 5,88:1), und der Punkt waechst dafuer von 8 auf 10px, damit
Ring UND Farbe nebeneinander lesbar bleiben. Alle 24 gemessenen Kombinationen liegen danach
bei mindestens 4,69:1.

Die Regel dahinter, und sie gilt ueber den Kalender hinaus: **wo eine freie Nutzerfarbe zum
alleinigen Traeger einer Information wird, traegt nicht sie den Kontrast, sondern ihre
Fassung.** Die User-Farben-Regel kannte bis dahin den Textfall (verboten) und den
Flaechenfall (gemessene Mix-Rezepte); fuer den Punkt, der zur einzigen Auskunft wird, gab es
kein Rezept. Jetzt gibt es eines.

### Der Wand-Modus (Signature Component)
**Der WACHE Zustand des Dashboards - keine zweite Seite, sondern dieselbe Flaeche in anderer
Gangart.** Gelesen wird sie aus zwei Metern und ohne Beruehrung; alles Weitere folgt aus
diesem einen Satz. Der Screensaver bleibt der ruhende Zustand und legt sich nach seiner
Leerlaufzeit unveraendert darueber.

**Die Shell tritt ab.** Sidebar und Tab-Leiste sind Arm-Laengen-Moebel; auf zwei Metern sind
sie siebzehn unleserliche Ziele. Auch die Installations-Einladung verschwindet - auf einer
Anzeige, die niemand bedient, waere sie die lauteste Karte im Bild.

**Eine Distanz-Skala, an einer Stelle** (`--wall-clock`, `--wall-row-title`, `--wall-row-sub`,
`--wall-section`, `--wall-pad`), und sie hat ZWEI Bezugsgroessen aus zwei gemessenen Gruenden:
die Uhr haengt an `vw`, weil sie eine einzelne lange Ziffernfolge ist und von der BREITE
begrenzt wird; alles andere haengt an `vmin`. Mit `vh` wurden die Zeilen auf einem Tablet im
Hochformat groesser, weil dort Hoehe reichlich ist - und liefen seitlich in die Enge und unten
aus dem Bild. `vmin` bindet die Groesse an die knappe Seite und haelt beide Lagen im Schirm.
**An einer Wand kann niemand scrollen, das Bild muss passen.** Die Enden der Skala sind
Tokens: hier bekommen die Display-Stufen 48/72px ihre Rolle.

**Genau EIN gefuellter Traeger** - die Programmliste - und sonst Inhalt auf der Buehne. Die
Anti-Referenz ist die Smart-Home-Dashboard-Optik: Kacheln voller Messwerte, Ringe und Sensoren
ohne Anlass. Die Uhr ist deshalb keine Kachel, sondern der Kopf der Flaeche: kein Surface, kein
Rahmen, linksbuendig wie jeder Seitenkopf.

**Eine Zeile, nicht zwei.** Auf zwei Metern erkennt man einen Eintrag an seinem Anfang; ein
Umbruch kostet die Hoehe einer ganzen weiteren Zeile, und die Flaeche hat sechs davon, bevor
sie scrollen muesste. Die Zaehler an den Gesichtern sind aus derselben Rechnung keine
Mikro-Badges, sondern volle Marken mit Kante - eine 13px-Marke an einem 56px-Gesicht waere aus
zwei Metern Dekoration.

**Nachtabsenkung nach UHRZEIT, nicht nach Farbmodus.** Zwischen 22 und 6 Uhr traegt die Wurzel
`data-wall-night` und der dunkle Grund wird erzwungen, auch bei hellem Theme: das Problem im
Flur ist die Leuchtdichte, und ein dunkles Theme leuchtet immer noch. Erzwungen heisst nicht
gespeichert - die Wahl des Nutzers bleibt unberuehrt und wird am Morgen zurueckgestellt.

**Geraetelokal und manuell geschaltet** (`localStorage`, wie Theme und Locale). Das Wandtablet
laeuft in der Praxis auf einem geteilten Konto; eine servergespeicherte Einstellung schaltete
allen Familienmitgliedern das Handy-Dashboard um. Und keine Automatik nach Geraeteform: eine
Fehlerkennung auf dem Laptop erzeugte einen Zustand, den niemand angefordert hat.

**Der Ausstieg ist leise da und hell auf Beruehrung.** Ein dauerhaft voller Knopf
widerspraeche der ruhigen Flaeche, ein unsichtbarer waere eine Falle: im Ruhezustand steht nur
sein Zeichen in Sekundaerfarbe (weiterhin AA, weiterhin fokussierbar, volle Zielgroesse), jede
Beruehrung setzt `data-wall-awake` und hebt ihn fuer sechs Sekunden auf die volle Kapsel samt
Beschriftung. Bewegt wird dabei nur Farbe - eine Breiten-Transition waere eine
Layout-Animation fuer einen Zustand, den aus zwei Metern niemand beobachtet.

**Dass die Flaeche lebt, sagt eine absolute Uhrzeit**, kein „vor 3 Minuten": eine relative
Angabe braeuchte einen zweiten Timer, nur damit sie sich selbst aktuell haelt.

## Do's and Don'ts

### Do:
- **Do** jeden Design-Wert aus `public/styles/tokens.css` beziehen; hartkodierte Werte in
  Komponenten sind Bugs (Projekt-Invariante).
- **Do** Dark Mode ueber die privaten `--_name`-Tokens fuehren; die oeffentliche Token-API
  bleibt stabil und wird nie doppelt geaendert.
- **Do** jede neue Farb-Flaechen-Paarung gegen ihren REALEN Hintergrund auf AA messen
  (Pro-Hintergrund-Regel), in Light und Dark.
- **Do** die Stimme fuer alles nehmen, was in jedem Modul dasselbe tut (Shell, FAB,
  Primaer- und Sekundaerknopf, Umschalter, Fokusring, Suche, Overlays), und den Modulton
  nur fuer das, was sagt, WO man ist (Siegel im Kopf, Leisten und Segmente im Modul, Chips,
  Zeilen-Hover, Widget). Das Kriterium ist die Frage, die das Element beantwortet - „was tut
  das hier" oder „wo bin ich" (Eine-Stimme-Regel).
- **Do** eine Folge gleichartiger Zeilen in GENAU EINEN Traeger legen und ueber den
  `+`-Kombinator trennen (Zeilenlisten-Regel).
- **Do** in einer Karte zwischen ZEILE (Haarlinie) und KACHEL (Inset-Well) waehlen; nur
  Bedienelemente behalten ihre Kante.
- **Do** jede Toenung eine benannte Stufe der Toenungsskala nehmen lassen (`--tint-wash` 8 /
  `--tint-state` 12 / `--tint-surface` 16 / `--tint-raised` 24 / `--tint-hint` 50 /
  `--tint-ink` 70 / `--tint-shadow` 20), nie eine eigene Zahl; die vier Flaechenstufen sind
  eine Leiter, ein Zustand steigt eine Sprosse.
- **Do** verschachtelte Radien konzentrisch rechnen (`calc(var(--radius-*) - Npx)`).
- **Do** opake Fallbacks fuer jedes Glas-Element mitliefern (reduced-transparency,
  prefers-contrast, fehlender backdrop-filter).
- **Do** ein Markensiegel nur setzen, wo es eine Rolle hat: an einer Mischstelle benennt es
  eine fremde Herkunft, im eigenen Modul steht es genau einmal als Absender im Kopf
  (Herkunfts-Regel). Und **Do** seinen Ton allein ueber `--seal-accent` setzen: die Scheibe
  traegt ihn im Vollton und mischt gegen gar nichts, deshalb stellt sich die Frage nach dem
  Grund nur noch fuer die Tinte darauf.
- **Do** den Rang eines Blocks ueber Radius und Elevation setzen, nie ueber Material
  (Rang-Regel); der wichtigste Block einer Seite darf nicht der leiseste sein.
- **Do** einer Karte mit Fusszeile den Koerper strecken und die Fusszeile verankern
  (`flex: 1` plus `margin-block-start: auto`), damit Ueberschuss zwischen Inhalt und
  Abschluss faellt statt dahinter.
- **Do** eine Spaltenzahl, die von der Breite eines BAUSTEINS abhaengt, per `@container`
  fragen - und den `container` am VORFAHREN deklarieren, nie am fragenden Element.
- **Do** die Kennzahl einer Karte gestapelt setzen (kleines Label darueber, Zahl in Title 1
  darunter, `tabular-nums`), nie als Zahl am rechten Ende einer Beschriftungszeile. Title 1
  ist die Zusage, nicht die einzige Stufe: eine schmale KENNZAHLREIHE klemmt ihre Werte auf
  Title 2 (unter 600px) und Title 3 (unter 400px), und Title 3 ist die Untergrenze - darunter
  waere die Kennzahl so gross wie die Ueberschrift ueber ihr. Gefragt wird die REIHE, nicht
  die Karte: wer eine Reihe aus `.metric-card` baut, deklariert
  `container: metric-grid / inline-size` an ihr (`.metric-grid` und das Vitalraster der
  Gesundheit tun genau das). Ein `container-type` an der KARTE selbst ist der Fehler dahinter -
  `contain: inline-size` nimmt einem Grid-Item seine intrinsische Breite, und die Karten
  fielen gemessen auf 18px zusammen.
- **Do** einen Wert, der auch auf der kleinsten Stufe nicht passt, TEILEN statt weiter zu
  verkleinern: die Kennzahl traegt eine Aussage, die Praezisierung gehoert in
  `.metric-card__note`. „18.08.2026 · 08:30" war Datum UND Uhrzeit in einer Zahl und lief
  38px ueber die Kartenkante; jetzt steht das Datum im Wert und die Uhrzeit in der Fussnote.
- **Do** eine AUSWERTUNGSFLAECHE nach vier Zusagen bauen (die Grammatik, die der
  Wetterbalken aus v2.21.0 gestiftet hat - sie war bis 2026-08-19 die einzige Flaechenfamilie
  ohne Abschnitt hier, und das war kein Zufall, sondern die Ursache fuer fuenf Dialekte):
  1. **Ein Verhaeltnis steht als ANTEIL am Element** (`--bar-scale`, `--span-from/--span-to`,
     jeweils 0..1), nie als gerechnete Pixelhoehe im Markup. Der Wert ist DATEN, die Geometrie
     ist DESIGN - das Balkenpaar der Haushaltshilfe trug `style="height:88px"` und skalierte
     deshalb nicht mit seiner Karte.
  2. **Ein Balken hat eine BAHN.** Ohne sie zeigt er nur sich selbst; mit ihr zeigt er seinen
     Anteil. Die Bahn ist neutral (`--color-fill-well`), die Fuellung traegt die Farbe.
  3. **Die Achse gehoert INS Diagramm**, nicht daneben: eine Beschriftung ausserhalb des SVG
     verschiebt sich gegen ihre eigenen Gitterlinien, sobald das Diagramm skaliert.
     `chartGridMarkup()` in health.js ist die Referenz - fuenf Linien mit Werteachse, EINE
     geteilte Geometrie (`CHART`) fuer alle drei Charts des Moduls.
  4. **Ein Diagramm ist nie der alleinige Traeger.** Die Zahl steht dabei; der Balken ist der
     zweite Kanal, nicht der Ersatz.
- **Do** jeder fixierten Shell-Flaeche ueber dem Scrollport einen NACHLAUF am Inhaltsende
  geben, und zwar als Summand (`--install-prompt-tail`), nicht als weitere `:has()`-Fassung:
  FAB, Sammelaktions-Pille und Install-Banner sind drei Flaechen und waeren als Kombinatorik
  acht Regeln. Der Banner hatte bis 2026-08-19 gar keinen und verdeckte auf /rewards gemessen
  97px der letzten Zeile, ohne Scrollweg dorthin. Wer den Summanden setzt, schreibt ihn als
  `:root:has(...)` - `html:has(<typ>)` ist Spezifitaet (0,0,2) und verliert gegen das `:root`
  der Basis.
- **Do** den Primaerknopf eines Modulkopfs sein NOMEN zeigen lassen (`newLabel.*`:
  „Termin", „Geburtstag"); das Verb traegt das Plus-Zeichen, der ganze Satz bleibt im
  `aria-label`. Der kurze Text steht als `data-dock-label` am `.page-fab`, damit der
  Router ihn beim Andocken findet (Register-Regel).
- **Do** die Zugehoerigkeit eines farbigen Blocks ueber eine VOLLTON-Kante tragen (3px an der
  Inline-Start-Seite), sobald der Block sie tragen kann, und Fuellung wie Tinte bei ihren
  gemessenen Rezepten lassen (Vollton-Kanten-Regel).
- **Do** eine Person ueberall in ihrer Identitaetsfarbe zeigen, und zwar auf der
  Vollton-Scheibe; wer keine hat (unverknuepfter Kontakt), bleibt NEUTRAL, statt eine
  gehashte oder die Modul-Toenung zu bekommen (Identitaetsfarben-Regel). Der Modulton stand
  hier bis 2026-08-18 als „neutral" - er ist es nicht, er ist eine leise Farbaussage, und
  sie sagte „Geburtstage" auf einer Seite, die das schon beantwortet hat.
  **Die PERSON schlaegt dabei ihre Kategorie:** eine Kontaktzeile mit
  `family_user_id` traegt Bild und Farbe des Mitglieds, keine Kategoriescheibe - und ihre
  Tinte kommt aus `getReadableTextColor`, weil eine Avatarfarbe frei gewaehlt und ihre
  Helligkeit damit unbestimmt ist.
- **Do** eine Marke, die eine Identitaet NENNT, ihre Farbe im VOLLTON tragen lassen:
  kuratierter Ton als Flaeche (Klasse `vivid-mark`, Tinte `--color-ink-on-vivid`), freie
  Nutzerfarbe als Kante, Ring oder Punkt daneben. Und **Do** neutral bleiben, wo nichts
  genannt wird - ein Platzhalter braucht keine Herkunft (Vollton-Regel).
- **Do** den heutigen Tag einer TAGESZELLE in der Stimme markieren, als Vollton-Marke am
  Datum, waehrend die Zelle selbst leer bleibt (Tagesmarke-Regel) - Kreis um eine Ziffer,
  Kapsel um ein Datum. Eine Fristmeldung („heute faellig") ist keine Tageszelle und
  behaelt ihre Warnfarbe.
- **Do** einer Zahl, die neben einer anderen Zahl steht, ihr Wort mitgeben („wird 37" neben
  „13 Tage"); stand das Wort bisher nur unsichtbar im `title`, ist es sichtbar faellig -
  Kopfrechnen ist keine Gestaltung.
- **Do** eine Liste, die im Schmalen zur Liste wird, dort auch die Zeilen-Grammatik
  sprechen lassen (Textspalte mit `min-width: 0`, unschrumpfbare Bedienzone, EINE Zeile).
  Der Wochenplan der Kueche stapelte als einziger der vier Tabs - Titel, Aktionszeile,
  Anlege-Streifen - und kostete damit 172px Slot fuer 16 Zeichen und 5830px Scroll fuer
  eine Woche bei 454px sichtbarer Flaeche. Als Zeile: 73px und 3056px.
- **Do** ein Etikett seinen Ton EINMAL und voll nennen lassen (Skalen-Regel): eine Meldung
  in der Schrift, eine Rangmarke im 8px-Punkt neben neutraler Schrift, eine Zuordnung als
  Vollton-Flaeche - und neutral (`--color-fill-well`), wenn die genannte Identitaet die des
  Raums ist, in dem das Etikett steht.
- **Do** den Glyph einer Kennzahlkarte die Farbe seines LABELS tragen lassen (`inherit`):
  er ist das Piktogramm der Beschriftung neben ihm, und die Farbe der Karte gehoert ihrem
  WERT (`trendValence()` in `utils/metric-card.js`). Neun Vitalkarten mit neun identischen
  Modul-Glyphen sagten neunmal, in welchem Modul man steht - das ist die Wetter-Glyphe vor
  v2.21.0, nur an einem geteilten Bauteil.
- **Do** die Werkzeug-Leiste eines Modulkopfs in die Bar-Zeile legen
  (`.page-toolbar__bar`): eine eigene, volle Zeile unter Titel, Center und Aktionen, auf
  allen Viewports, scrollend mit Peek-Fade statt buendigem Ende (Werkzeugzeilen-Regel).
  Ein Zwei-Optionen-Scope-Schalter bleibt in der Titelzeile.

### Don't:
- **Don't** einen zweiten Buttonradius einfuehren; die Kapsel steht in der `.btn`-Basisregel
  und gilt fuer alle Varianten inklusive Icon-Buttons.
- **Don't** ein `aria-label` als sichtbaren Text weiterreichen; es beschreibt eine
  Handlung („Geburtstag hinzufuegen") und wird als Knopfbeschriftung zum dritten
  Register neben denen, die es schon gibt.
- **Don't** einen zweiten Anlege-Weg neben einem sichtbaren stehen lassen; und wenn
  einer weichen muss, dann unter DERSELBEN Bedingung, unter der der andere erscheint -
  nie unter einer eigenen Zahl daneben.
- **Don't** der Shell oder einem geteilten Bedienelement den Modulton geben - auch nicht
  unter einem eigenen Klassennamen. Der Struktur-Guard liest SELEKTOR-Formen; wer
  `.btn--secondary` unter eigenem Namen umfaerbt, steht in keiner davon. Genau dafuer gibt
  es den zweiten Guard ueber die Klassen-Kopplung im Markup.
- **Don't** Gradient-Text oder Akzent-Titel: Large Titles und Ueberschriften tragen immer
  Label-Farbe.
- **Don't** chromatische Verlaeufe auf Inhalt legen; auch nicht auf der Anmeldebuehne und
  nicht auf einem Widget. Ein weiches Lichtfeld HINTER einer Glyphe ist keins - es fuellt
  keine Flaeche, laeuft vor dem Text aus und traegt die Ausschalter der Backdrop-Blobs
  (siehe „Colors"). Wer es kopiert, kopiert auch die Messung.
- **Don't** Akzentstreifen an Toolbars, Tabs oder Koepfen; die gehoerten zur abgeloesten Welt.
- **Don't** dekorative Kicker/Eyebrows; eine Versal-Zeile ist nur als echte Information
  erlaubt (Apple-News-Muster, z. B. das Masthead-Datum).
- **Don't** Glas auf Inhalte legen; backdrop-filter gehoert ausschliesslich dem Chrome.
- **Don't** einer Zeile in einer Liste eine Karte anziehen (Schatten, Radius,
  Surface-Fuellung) und nie `border-bottom` je Zeile.
- **Don't** User-/Layer-Farben als Textfarbe verwenden; nur Border/Dot bzw. die gemessenen
  16-%/35-%-Mix-Rezepte, und nie eine ganze Inhaltsflaeche (die Avatar-Scheibe ist der Dot
  in seiner groessten Form, keine Flaeche - Identitaetsfarben-Regel).
- **Don't** Initialen unter die kleinste Textrolle der App schrumpfen; ab 20px Scheibe
  11px, darunter traegt die Farbe allein (Initialen-Schwelle-Regel).
- **Don't** die Bildmarke anfassen (drei transluzente Kreise, Violett plus Sheen); sie ist
  als Marke gesetzt.
- **Don't** Ueberschriften ueber 34px; die Display-Stufen 48/72px sind exklusiv fuer
  Anzeigewerte (Wandtablet-Uhr).
- **Don't** neue Viewport-Breakpoints erfinden; die vier Grenzen sind verbindlich,
  komponenteninterne Umbrueche laufen ueber Container-Queries.
- **Don't** Siegel in die Listen eines Moduls streuen oder der Tab-Bar/Sidebar geben; im
  eigenen Raum ist die Herkunft selbstverstaendlich, und die Leiste beantwortet "wo bin ich",
  nicht "woher".
- **Don't** eine Stufe einer Skala als getoentes Feld bauen - schon gar nicht mit
  getoenter Schrift und getoenter Kante darauf. Die vier Prioritaets-Etiketten nannten
  ihren Ton dreimal blass, und zwischen den beiden obersten Stufen blieben davon 3,47
  (light) uebrig. Und **Don't** zwei Stufen derselben Reihe dieselbe Regel schreiben, ohne
  sie ihnen zu GEBEN: `--default` und `--soon` der Geburtstags-Chips waren bitweise gleich,
  weil die Gleichheit in zwei Regeln stand statt in einer.
- **Don't** eine Zugehoerigkeit ueber eine Haarlinie allein tragen lassen; was in einem Theme
  ein Signal ist und im anderen keines, ist kein Kanal. Und **Don't** sie ueber eine
  Waschung tragen lassen: eine Beimischung hellt im Dark fast nur auf. Der Kanal fuer
  Zugehoerigkeit ist das Vollton-Siegel (Widget-Kopf, 2026-08-17; davor Absenderband).
- **Don't** dieselbe Identitaetsfarbe zweimal blass nennen - getoente Flaeche UND blasser
  Glyph darauf. Das ist die zurueckgenommene Fassung des Siegels unter anderem Namen, und
  sie hat elf Mal ueberlebt, weil der Guard von damals die Klasse nannte statt der Regel.
- **Don't** eine Regel dieser Art nur dort anwenden, wo sie aufgefallen ist. Die
  Vollton-Kante erreichte zwei von vier Kalender-Ansichten, und das Vollton-Siegel eine von
  zwoelf Marken - beide Male war die Etappe „fertig", waehrend dasselbe Objekt zwei
  Sprachen sprach. Wer eine Regel setzt, sucht ihre Geschwister ueber die BAUART. Und
  **Don't** dabei eine Bauart ueber `includes()` suchen: „jede Klasse mit `day` darin"
  faengt `birthday` mit, und die Geburtstagszeile ist der dokumentierte Gegenfall. Der
  Vergleich laeuft ueber NAMENSABSCHNITTE.
- **Don't** eine Tab-Leiste in den Actions-Slot oder neben den Titel setzen; dort versteckt
  sie ihre eigenen Module hinter einem Fade (Budget: 1 von 7 Tabs bei 1280px, „Agenda" des
  Kalenders unsichtbar). Die Bar-Zeile ist ihr Ort, und wer sie verlaesst, macht Sonde 19
  und 20 rot (Werkzeugzeilen-Regel).
- **Don't** eine Regel in einen Media-Block schreiben, der VOR den Bauteilen steht, die sie
  ueberschreiben soll. Bei gleicher Spezifitaet gewinnt die spaetere Regel: `display: none`
  und `flex-direction: row` im 640px-Block von meals.css verloren gegen die
  Komponentendefinitionen 200 Zeilen darunter, und jede einzelne Regel sah dabei richtig
  aus. Aufgefallen ist es nur an der Messung - das Wochengitter war danach 358px HOEHER
  statt niedriger. Wer einen schmalen Zustand baut, stellt ihn hinter sein Bauteil.
- **Don't** einen Zustand ueber `opacity` auf dem eigenen Inhalt zeigen; eine Kachel, die
  ihren Text schlechter lesbar macht, um Anfassbarkeit zu signalisieren, steigt stattdessen
  eine Sprosse der Toenungsskala.
- **Don't** einen Wert der Distanz-Skala als Einzelzahl hinschreiben; die Wand-Flaeche fuehrt
  ihre Skala an einer Stelle, und was aus zwei Metern lesbar sein muss, haengt an `vmin` (die
  Uhr an `vw`), nie an `vh`.
- **Don't** einen Scrollbalken dort verstecken, wo mit der Maus gezogen wird: ein
  `scrollbar-width: none` gehoert ans Telefon, wo die Geste zieht, nie in eine
  Desktop-Query. Der Fade darunter ist kein Ersatz - er sagt, DASS mehr da ist, der Balken
  sagt, WO man ist, und laesst einen hin (siehe „Der getoente Scrollbalken").
- **Don't** einem fremden Bild die Hoehe seiner Zeile ueberlassen oder einem engen Raster
  vorsorglich in jeder Zelle einen Bildslot geben. Ein Vorschaubild steht in einem festen
  Rahmen mit `object-fit: cover`, und im Wochenplaner wird nur die bebilderte Karte zum Grid;
  ein fehlendes Bild ist eine ruhige Luecke, keine Layout-Aenderung (siehe „Das Vorschaubild").
