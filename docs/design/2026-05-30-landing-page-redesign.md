# Landing Page Redesign — Design Spec
**Datum:** 2026-05-30  
**Datei:** `docs/index.html`  
**Ziel:** Landing Page von Feature-Liste zu emotionaler Familienerzählung umbauen — Zielgruppe: privacy-bewusste Familien ohne Dev-Hintergrund, Referenz: Notion.so

---

## 1. Ziele & Erfolgs­kriterien

- Primäre Konversion: Besucher emotional überzeugen, dann mehrere Wege anbieten (Install, Screenshots, GitHub)
- Neue Haupt­zielgruppe: Privacy-bewusste Eltern, die Notion/Google verlassen wollen — technisch grundkompetent, aber kein Docker-Hintergrund
- Sekundäre Zielgruppe: Tech-affine Self-Hoster (werden weiterhin bedient, aber nicht mehr priorisiert)
- Kein Framework, kein Build-Schritt — bleibt vanilla HTML/CSS/JS wie bisher

---

## 2. Neue Seitenstruktur

```
1.  Nav                  (+Live GitHub-Sternzahl)
2.  Hero                 (neue Copy, 3 CTAs)
3.  Social Proof Bar     [NEU] Live-Sterne, Module-Zahl, Sprachen, Version
4.  "Das Problem"        [NEU] 3 Pain-Point-Karten + Überleitung
5.  Philosophie          [VORGEZOGEN] Umbenannt "Why Yuvomi", neue Reihenfolge
6.  Feature-Showcase     3 Bild-Zeilen, Benefit-Titel, Benefit-Einstiegssatz
7.  Feature-Grid         5 statt 9 Cards, Benefit-fokussierte Section-Title
8.  Carousel             unverändert
9.  Setup                [VEREINFACHT] 3-Schritt-Icons primär, Code-Block sekundär
10. CTA                  3 differenzierte Buttons
11. Footer               +Version, +Sterne
```

Die bisherige Reihenfolge (Feature-Grid vor Philosophie) wird umgekehrt: Vertrauen vor Features.

---

## 3. Nav

- Optisch identisch
- GitHub-Button: Live-Sternzahl per `fetch('https://api.github.com/repos/ulsklyc/yuvomi')`, gecacht in `sessionStorage` als `gh-stars`, Fallback "GitHub" wenn Fetch scheitert oder > 3 s dauert
- Timeout: 3000 ms, dann Fallback — kein Layout-Shift
- Anzeige: `★ 2.4k` neben dem GitHub-Label (kompakt: `Math.round(count/100)/10 + 'k'` ab 1000)

---

## 4. Hero

### Copy-Änderungen

| Element | Aktuell | Neu |
|---|---|---|
| Badge | "Open Source · Self-Hosted · Private" | "Open Source · Privacy-First · No Subscriptions" |
| H1 (EN) | "Your household, organized together." | "Your family. Your data. Your home." |
| H1 (DE) | "Euer Haushalt, gemeinsam organisiert." | "Eure Familie. Eure Daten. Euer Zuhause." |
| Subtext (EN) | 43-Wörter-Feature-Aufzählung | "One private place for everything that keeps your family running — without giving your data to Big Tech." |
| Subtext (DE) | analog | "Ein privater Ort für alles, was eure Familie zusammenhält — ohne eure Daten der Cloud zu überlassen." |
| Tags | MIT · Docker · PWA · No Cloud | MIT · Docker · PWA · 16 languages · No Cloud |

### CTAs (3 statt 2)

```
[ See it in action ]   [ Installation Guide ]   [ GitHub ]
  → #carousel (smooth   → install.html            → github.com
    scroll)
  btn-primary           btn-secondary             btn-ghost (neu: keine Border,
                                                  nur Text + Icon)
```

`btn-ghost`: `background: none; border: none; color: var(--text-2); padding: 14px 20px;`  
Hover: `color: var(--text-1)`

### Mockup-Screenshot
Bleibt unverändert (desktop mockup mit perspective-Transform).

---

## 5. Social Proof Bar [NEU]

Schmaler Streifen (48px hoch) direkt unter dem Hero, voller Breite, `background: var(--bg-alt)`, `border-top: 1px solid var(--border)`, `border-bottom: 1px solid var(--border)`.

Inhalt (zentriert, `--text-3`, `font-size: 0.8125rem`, `font-weight: 500`):

```
★ {stars}  ·  14 modules  ·  16 languages  ·  MIT licensed  ·  v{version}
```

- `{stars}`: live von GitHub API (selber Fetch wie Nav-Button, gemeinsam gecacht)
- `{version}`: statisch hardcodiert, bei jedem Release aktualisiert (aktuell: `v0.55.10`)
- Kein Bild, keine Icons außer `★` (Unicode)
- Auf Mobile: nur `★ {stars}  ·  16 languages  ·  MIT` (3 Elemente, Rest ausgeblendet via `@media (max-width: 600px)`)

---

## 6. "Das Problem" [NEU]

`background: var(--bg)`, `padding: 80px 0`.

**Section Label:** `"The problem"` / `"Das Problem"`  
**Headline:** `"Sound familiar?"` / `"Kommt euch das bekannt vor?"`

3 horizontale Karten (`display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px`):

| Karte 1 | Karte 2 | Karte 3 |
|---|---|---|
| **Ten different apps** | **Subscriptions, forever** | **Your data, everywhere** |
| Tasks here, shopping there, calendar somewhere else. Nothing talks to each other. | Notion, Google One, iCloud — another invoice every year. No way out. | Your calendar on Google's servers. Your notes on Dropbox. Who actually owns your family's data? |

Darunter, zentriert, `color: var(--accent)`, `font-family: var(--ff-display)`, `font-size: 1.4rem`:  
`"There's a better way."` / `"Es geht auch anders."`

Auf Mobile: 3 Karten stacken zu 1 Spalte.

**Karten-Stil:** `background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px;`  
Kein Hover-Effekt (sind keine interaktiven Elemente — Informationsträger).

---

## 7. Philosophie [VORGEZOGEN & UMBENANNT]

Inhalt der 4 Karten bleibt identisch. Änderungen:

- **Section Label:** `"Philosophy"` → `"Why Yuvomi"` / `"Warum Yuvomi"`
- **Section Title:** `"Built different, on purpose"` → `"Built for families, not for profit."` / `"Für Familien gebaut, nicht für Profit."`
- **Karten-Reihenfolge:** Privacy First → Self-Hosted → Open Source → Zero Build Step  
  (Zero Build Step ist für Nicht-Techniker irrelevant und wandert ans Ende)

---

## 8. Feature-Showcase

Layout (alternierend, Bild + Text) und Screenshots: unverändert.

**Benefit-Titel (neu):**

| Aktuell | Neu (EN) | Neu (DE) |
|---|---|---|
| "Task Management" | "Everyone knows what needs to be done." | "Alle wissen, was zu tun ist." |
| "Meal Planning" | "Dinner sorted before anyone asks." | "Das Abendessen ist geplant, bevor jemand fragt." |
| "Calendar Sync" | "One calendar for the whole family." | "Ein Kalender für die ganze Familie." |

**Beschreibungstexte:** Jeweils ein Benefit-Einstiegssatz vorangestellt (kursiv), dann der bestehende Feature-Text:

- Tasks: *"No more 'I forgot.'"*
- Meals: *"From plan to shopping list in one click."*
- Calendar: *"Google Calendar, iCloud, Nextcloud — all in one place."*

Die Lokalisierungs-Keys (`f_tasks_d`, `f_meals_d`, `f_cal_d`) werden in beiden Sprachen aktualisiert.

---

## 9. Feature-Grid

Von 9 auf 5 Cards reduziert. Section-Title-Änderung:

- **Section Title:** `"Built for real family life"` → `"Everything your family actually uses."` / `"Alles, was eure Familie wirklich braucht."`

**Verbleibende 5 Cards (neue Reihenfolge):**
1. Shopping Lists
2. Budget & Split Expenses
3. Birthdays & Reminders
4. Documents
5. Works Everywhere (PWA)

**Entfernte Cards** (Housekeeping, Notes, Contacts, Recipes): Bleiben im Carousel sichtbar, sind weiterhin in Showcase/README vollständig dokumentiert. Kein Feature wird entfernt, nur deprioritisiert.

---

## 10. Carousel

Inhalt und Stil: unverändert. Einzige Änderung: `id="carousel"` zum `<section>`-Element hinzufügen, damit die Smooth-Scroll-Links in Hero-CTA (`#carousel`) und CTA-Sektion (`#carousel`) funktionieren.

---

## 11. Setup [VEREINFACHT]

**Primäre Ansicht — 3-Schritt-Überblick:**

`display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px`

| Schritt 1 | Schritt 2 | Schritt 3 |
|---|---|---|
| **①  Start the installer** | **②  Set up your account** | **③  Invite your family** |
| One command launches a setup wizard in your browser. No configuration by hand. | Create an admin account and choose your preferences. Takes 2 minutes. | Add family members, set roles, and start using Yuvomi together. |

**Sekundäre Ansicht — Code-Block:**  
Ein Toggle-Button `"Show Docker commands ▾"` / `"Docker-Befehle anzeigen ▾"` klappt den bestehenden `<div class="code-block">` aus (CSS `display: none` → `display: block`, kein JS-Framework).

Link zur `install.html` unter den 3 Schritten:  
`"→ Step-by-step installation guide"` / `"→ Schritt-für-Schritt-Installationsanleitung"`

**Section Label:** `"Get Started"` → `"Setup"` (prägnanter).

---

## 12. CTA-Sektion

**Headline:** `"Ready to take back control?"` — bleibt (stark).  
**Subtext:** `"Yuvomi is free, open-source, and built for families who value their privacy."` → `"Free. Open source. Runs on your server. No subscriptions, ever."` / `"Kostenlos. Open Source. Läuft auf eurem Server. Keine Abos, nie."`

**3 Buttons:**

```
[ Get started →  ]   [ See all screenshots ]   [ View on GitHub ★ ]
  → install.html       → #carousel (smooth)      → github.com
  btn-primary          btn-secondary             btn-ghost
```

`hero-actions` flex-Container wird wiederverwendet — `btn-ghost` neu hinzugefügt (s. Abschnitt 4).

---

## 13. Footer

**Neue Zeile über den Links:**  
`v0.55.10  ·  ★ {stars}  ·  Last release: June 2026` — selbes Sterne-Objekt aus sessionStorage.

**Neue vierte Link-Option:**  
`install.html` → `"Install"` / `"Installieren"` — neben GitHub, MIT, Contributing.

---

## 14. Lokalisierung

Alle neuen Texte erhalten `data-t`-Keys und werden in beide Sprachen (`en`, `de`) aufgenommen:

| Key | EN | DE |
|---|---|---|
| `hero_badge` | Open Source · Privacy-First · No Subscriptions | Open Source · Privacy-First · Keine Abos |
| `hero_h1_pre` | Your family. Your data. | Eure Familie. Eure Daten. |
| `hero_h1_em` | Your home. | Euer Zuhause. |
| `hero_sub` | One private place… | Ein privater Ort… |
| `hero_cta_demo` | See it in action | App ansehen |
| `prob_label` | The problem | Das Problem |
| `prob_title` | Sound familiar? | Kommt euch das bekannt vor? |
| `prob_1_t` | Ten different apps | Zehn verschiedene Apps |
| `prob_1_d` | Tasks here, shopping there… | Aufgaben hier, Einkauf dort… |
| `prob_2_t` | Subscriptions, forever | Abos, für immer |
| `prob_2_d` | Notion, Google One, iCloud… | Notion, Google One, iCloud… |
| `prob_3_t` | Your data, everywhere | Eure Daten, überall |
| `prob_3_d` | Your calendar on Google's servers… | Euer Kalender auf Googles Servern… |
| `prob_cta` | There's a better way. | Es geht auch anders. |
| `why_label` | Why Yuvomi | Warum Yuvomi |
| `why_title` | Built for families, not for profit. | Für Familien gebaut, nicht für Profit. |
| `f_tasks_t` | Everyone knows what needs to be done. | Alle wissen, was zu tun ist. |
| `f_meals_t` | Dinner sorted before anyone asks. | Das Abendessen ist geplant, bevor jemand fragt. |
| `f_cal_t` | One calendar for the whole family. | Ein Kalender für die ganze Familie. |
| `more_title` | Everything your family actually uses. | Alles, was eure Familie wirklich braucht. |
| `setup_label` | Setup | Setup |
| `setup_1_t` | Start the installer | Installer starten |
| `setup_1_d` | One command launches a setup wizard in your browser. | Ein Befehl startet den Setup-Assistenten im Browser. |
| `setup_2_t` | Set up your account | Konto einrichten |
| `setup_2_d` | Create an admin account and choose your preferences. | Admin-Konto erstellen und Einstellungen wählen. |
| `setup_3_t` | Invite your family | Familie einladen |
| `setup_3_d` | Add family members, set roles, start using Yuvomi. | Familienmitglieder hinzufügen und loslegen. |
| `setup_show_code` | Show Docker commands ▾ | Docker-Befehle anzeigen ▾ |
| `setup_guide_link` | → Step-by-step installation guide | → Schritt-für-Schritt-Installationsanleitung |
| `cta_desc` | Free. Open source. Runs on your server. No subscriptions, ever. | Kostenlos. Open Source. Läuft auf eurem Server. Keine Abos, nie. |
| `cta_btn_demo` | See all screenshots | Alle Screenshots ansehen |
| `footer_install` | Install | Installieren |

---

## 15. Technische Umsetzungshinweise

- **GitHub API Fetch:** Einmalig beim Laden, `sessionStorage`-Key `oikos-gh-stars`, Timeout 3 s, Fallback auf leerem String (Button zeigt dann nur "GitHub" ohne Zahl). Kein separater API-Call für Nav und Social Proof Bar — beide lesen aus demselben Cache.
- **`btn-ghost`:** Neuer Utility-Stil in `<style>`, kein separates CSS-File.
- **Toggle (Setup-Code):** `<button>` + `<div id="docker-code" style="display:none">` + inline `onclick` im `<script>`-Block — kein Framework, kein externes JS.
- **Social Proof Bar:** Kein Layout-Shift — Sterne-Span hat `min-width: 3ch` und wird leer initialisiert, dann befüllt.
- **Kein neues CSS-File** — alle neuen Stile kommen in den bestehenden `<style>`-Block in `index.html`.
- **`innerHTML` ist blockiert** (Hook) — alle dynamischen Sterne-Werte via `el.textContent = ...`.
- **Keine neuen `data-t`-Keys ohne DE-Übersetzung** — beide Sprachen vollständig befüllen.
