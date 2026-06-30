# Landing Page Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `docs/index.html` from a feature-list into an emotionally-driven narrative landing page targeting privacy-conscious families (Notion-style problem → trust → solution flow).

**Architecture:** Single-file edit (`docs/index.html`). All CSS lives in the inline `<style>` block, all JS in the inline `<script>` block, all i18n in the `T` object within the script. No new files, no build step, no framework.

**Tech Stack:** Vanilla HTML/CSS/JS, DM Sans + DM Serif Display (Google Fonts), GitHub REST API (star count fetch), sessionStorage for star count cache.

**Spec:** `docs/design/2026-05-30-landing-page-redesign.md`

---

## File Map

| File | Change |
|---|---|
| `docs/index.html` | All changes — HTML structure, inline CSS additions, inline JS additions |

---

## Task 1: CSS — New utility classes

**Files:**
- Modify: `docs/index.html` — `<style>` block, after the `.btn-secondary:hover` rule (~line 155)

- [ ] **Step 1: Add btn-ghost, proof-bar, problem-section, setup-steps styles**

Open `docs/index.html`. In the `<style>` block, directly after `.btn-secondary:hover { border-color: var(--text-3); transform: translateY(-1px); }`, insert:

```css
.btn-ghost {
  display: inline-flex; align-items: center; gap: 8px;
  background: none; border: none; color: var(--text-2);
  padding: 14px 20px; border-radius: 12px; font-weight: 600;
  font-size: 1rem; cursor: pointer; transition: color 0.2s ease;
  font-family: var(--ff-body); text-decoration: none;
}
.btn-ghost:hover { color: var(--text-1); }

/* Proof bar */
.proof-bar {
  background: var(--bg-alt); border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  height: 44px; display: flex; align-items: center;
}
.proof-bar .wrap {
  display: flex; align-items: center; justify-content: center;
  gap: 12px; font-size: 0.8125rem; font-weight: 500; color: var(--text-3);
}
.proof-sep { color: var(--border); }
#gh-stars-proof { color: var(--text-2); }
#gh-stars-proof:empty { display: none; }
#gh-stars-proof:empty + .proof-sep { display: none; }
@media (max-width: 600px) { .proof-dt-only { display: none; } }

/* Problem section */
.problem-section { padding: 80px 0; }
.problem-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;
  margin-bottom: 40px;
}
.problem-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 28px;
}
.problem-card h3 { font-size: 1rem; font-weight: 600; margin-bottom: 8px; }
.problem-card p { font-size: 0.875rem; color: var(--text-2); line-height: 1.7; }
.prob-cta {
  text-align: center; font-family: var(--ff-display);
  font-size: 1.4rem; color: var(--accent);
}
@media (max-width: 900px) { .problem-grid { grid-template-columns: 1fr; } }

/* Setup steps */
.setup-steps {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;
  margin: 32px 0 16px;
}
.setup-step {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 28px;
}
.setup-step-num {
  font-family: var(--ff-display); font-size: 1.5rem;
  color: var(--accent); margin-bottom: 12px; display: block;
}
.setup-step h3 { font-size: 0.9375rem; font-weight: 600; margin-bottom: 6px; }
.setup-step p { font-size: 0.875rem; color: var(--text-2); line-height: 1.6; }
.setup-toggle {
  background: none; border: 1px solid var(--border); color: var(--text-2);
  padding: 8px 16px; border-radius: 8px; font-size: 0.875rem;
  font-family: var(--ff-body); cursor: pointer; margin-bottom: 16px;
  transition: all 0.15s ease;
}
.setup-toggle:hover { border-color: var(--text-3); color: var(--text-1); }
.setup-guide-link {
  display: block; margin-top: 20px; font-size: 0.9375rem; font-weight: 500;
}
.footer-meta { font-size: 0.8125rem; color: var(--text-3); margin-bottom: 8px; }
@media (max-width: 900px) { .setup-steps { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: Open in browser and verify no visual regressions**

Open `docs/index.html` directly in a browser (file:// or a local server). The page should look identical to before — new CSS classes don't appear in the DOM yet.

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "style(landing): add btn-ghost, proof-bar, problem-section, setup-steps CSS"
```

---

## Task 2: Nav — live GitHub star count

**Files:**
- Modify: `docs/index.html` — nav HTML (~line 340), JS `<script>` block (~line 730)

- [ ] **Step 1: Add stars span to nav GitHub button**

Find the `.nav-gh` anchor element (~line 340). It ends with:
```html
<span data-t="nav_gh">GitHub</span></a>
```

Change that closing to:
```html
<span data-t="nav_gh">GitHub</span><span id="gh-stars-nav"></span></a>
```

(Only addition: `<span id="gh-stars-nav"></span>` before `</a>`.)

- [ ] **Step 2: Add stars fetch + apply functions to JS**

In the `<script>` block, find the line `applyTheme();` near the very end (around line 732). Directly **before** that line, insert:

```javascript
function fmtStars(n) {
  if (n >= 1000) return '★ ' + (Math.round(n / 100) / 10) + 'k';
  return '★ ' + n;
}

function applyStars(val) {
  var nav = document.getElementById('gh-stars-nav');
  var proof = document.getElementById('gh-stars-proof');
  var footer = document.getElementById('gh-stars-footer');
  var footerSep = document.getElementById('footer-sep');
  if (nav) nav.textContent = ' ' + val;
  if (proof) proof.textContent = val;
  if (footer) {
    footer.textContent = val;
    if (footerSep) footerSep.style.display = 'inline';
  }
}

function loadStars() {
  var cached = sessionStorage.getItem('oikos-gh-stars');
  if (cached) { applyStars(cached); return; }
  var timedOut = false;
  var timer = setTimeout(function() { timedOut = true; }, 3000);
  fetch('https://api.github.com/repos/ulsklyc/yuvomi')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (timedOut) return;
      clearTimeout(timer);
      var val = fmtStars(d.stargazers_count || 0);
      sessionStorage.setItem('oikos-gh-stars', val);
      applyStars(val);
    })
    .catch(function() {});
}
```

- [ ] **Step 3: Call loadStars() at init**

In the same `<script>` block, after the existing `applyLang();` call (the last line before `})();`), add:

```javascript
loadStars();
```

- [ ] **Step 4: Verify in browser**

Open `docs/index.html`. After ~1 s the nav button should show "GitHub ★ 2.4k" (or current count). Open DevTools → Network: exactly one call to `api.github.com`. Reload: zero new API calls (sessionStorage cache).

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): add live GitHub star count to nav"
```

---

## Task 3: Hero — new copy + 3 CTAs

**Files:**
- Modify: `docs/index.html` — `<header class="hero">` block (~lines 346–376), T object in JS

- [ ] **Step 1: Replace hero HTML**

Find `<!-- HERO -->` and replace the entire `<header class="hero">...</header>` block with:

```html
<!-- HERO -->
<header class="hero">
  <div class="wrap">
    <div class="hero-content">
      <div class="hero-badge" data-t="hero_badge">Open Source · Privacy-First · No Subscriptions</div>
      <h1><span data-t="hero_h1_pre">Your family. Your data.</span><br><em data-t="hero_h1_em">Your home.</em></h1>
      <p class="hero-sub" data-t="hero_sub">One private place for everything that keeps your family running — without giving your data to Big Tech.</p>
      <div class="hero-actions">
        <a href="#carousel" class="btn-primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
          <span data-t="hero_cta_demo">See it in action</span>
        </a>
        <a href="install.html" class="btn-secondary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span data-t="hero_install">Installation Guide</span>
        </a>
        <a href="https://github.com/ulsklyc/yuvomi" class="btn-ghost" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"></path></svg>
          <span data-t="nav_gh">GitHub</span>
        </a>
      </div>
      <div class="hero-tags">
        <span class="tag">MIT License</span>
        <span class="tag">Docker</span>
        <span class="tag">PWA</span>
        <span class="tag">16 languages</span>
        <span class="tag" data-t="tag_nocloud">No Cloud Required</span>
      </div>
    </div>
    <div class="hero-mockup">
      <div class="mockup-tablet">
        <img class="sc" data-light="screenshots/dashboard-light-desktop.png" data-dark="screenshots/dashboard-dark-desktop.png" src="screenshots/dashboard-light-desktop.png" alt="Yuvomi Dashboard">
      </div>
    </div>
  </div>
</header>
```

- [ ] **Step 2: Update i18n — hero keys in T object**

In the `T` object in the `<script>` block, update the following keys.

In `en`:
```javascript
hero_badge: 'Open Source · Privacy-First · No Subscriptions',
hero_h1_pre: 'Your family. Your data.',
hero_h1_em: 'Your home.',
hero_sub: 'One private place for everything that keeps your family running — without giving your data to Big Tech.',
hero_cta_demo: 'See it in action',
```

In `de`:
```javascript
hero_badge: 'Open Source · Privacy-First · Keine Abos',
hero_h1_pre: 'Eure Familie. Eure Daten.',
hero_h1_em: 'Euer Zuhause.',
hero_sub: 'Ein privater Ort für alles, was eure Familie zusammenhält — ohne eure Daten der Cloud zu überlassen.',
hero_cta_demo: 'App ansehen',
```

(`hero_cta` key stays in the object — it's now unused but removal is unnecessary.)

- [ ] **Step 3: Verify hero**

Open in browser. H1: "Your family. Your data." / "Your home." (italic, accent). Three buttons: filled → `#carousel`, outline → `install.html`, ghost → GitHub. Tag "16 languages" visible. Toggle DE/EN.

- [ ] **Step 4: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): new hero copy, 3-button CTA row, updated tags"
```

---

## Task 4: Social Proof Bar

**Files:**
- Modify: `docs/index.html` — insert after `</header>` (~line 376)

- [ ] **Step 1: Insert proof bar HTML**

Directly after the closing `</header>` tag of the hero section, insert:

```html
<!-- SOCIAL PROOF BAR -->
<div class="proof-bar">
  <div class="wrap">
    <span id="gh-stars-proof"></span>
    <span class="proof-sep proof-dt-only">·</span>
    <span class="proof-dt-only">14 modules</span>
    <span class="proof-sep">·</span>
    <span>16 languages</span>
    <span class="proof-sep proof-dt-only">·</span>
    <span class="proof-dt-only">MIT licensed</span>
    <span class="proof-sep">·</span>
    <span>v0.55.10</span>
  </div>
</div>
```

- [ ] **Step 2: Verify proof bar**

Open in browser. A thin bar appears below the hero mockup. On desktop: "★ 2.4k · 14 modules · 16 languages · MIT licensed · v0.55.10" (stars load async). Resize to 375px: only "16 languages · v0.55.10" visible.

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): add social proof bar (stars, modules, languages, version)"
```

---

## Task 5: "Das Problem" section

**Files:**
- Modify: `docs/index.html` — insert after proof bar div

- [ ] **Step 1: Insert Problem section HTML**

Directly after the `</div>` closing the proof-bar, insert:

```html
<!-- THE PROBLEM -->
<section class="problem-section">
  <div class="wrap">
    <div class="showcase-header reveal">
      <p class="section-label" data-t="prob_label">The problem</p>
      <h2 class="section-title" data-t="prob_title">Sound familiar?</h2>
    </div>
    <div class="problem-grid">
      <div class="problem-card reveal">
        <h3 data-t="prob_1_t">Ten different apps</h3>
        <p data-t="prob_1_d">Tasks here, shopping there, calendar somewhere else. Nothing talks to each other.</p>
      </div>
      <div class="problem-card reveal reveal-d1">
        <h3 data-t="prob_2_t">Subscriptions, forever</h3>
        <p data-t="prob_2_d">Notion, Google One, iCloud — another invoice every year. No way out.</p>
      </div>
      <div class="problem-card reveal reveal-d2">
        <h3 data-t="prob_3_t">Your data, everywhere</h3>
        <p data-t="prob_3_d">Your calendar on Google's servers. Your notes on Dropbox. Who actually owns your family's data?</p>
      </div>
    </div>
    <p class="prob-cta reveal" data-t="prob_cta">There's a better way.</p>
  </div>
</section>
```

- [ ] **Step 2: Add Problem section i18n keys to T object**

In the `T` object, add the following keys to **both** `en` and `de`.

In `en` (after `tag_nocloud`):
```javascript
prob_label: 'The problem',
prob_title: 'Sound familiar?',
prob_1_t: 'Ten different apps',
prob_1_d: 'Tasks here, shopping there, calendar somewhere else. Nothing talks to each other.',
prob_2_t: 'Subscriptions, forever',
prob_2_d: 'Notion, Google One, iCloud — another invoice every year. No way out.',
prob_3_t: 'Your data, everywhere',
prob_3_d: "Your calendar on Google's servers. Your notes on Dropbox. Who actually owns your family's data?",
prob_cta: "There's a better way.",
```

In `de` (after `tag_nocloud`):
```javascript
prob_label: 'Das Problem',
prob_title: 'Kommt euch das bekannt vor?',
prob_1_t: 'Zehn verschiedene Apps',
prob_1_d: 'Aufgaben hier, Einkauf dort, Kalender irgendwo anders. Nichts spricht miteinander.',
prob_2_t: 'Abos, für immer',
prob_2_d: 'Notion, Google One, iCloud — jedes Jahr eine neue Rechnung. Kein Ausweg.',
prob_3_t: 'Eure Daten, überall',
prob_3_d: 'Euer Kalender auf Googles Servern. Eure Notizen auf Dropbox. Wem gehören eure Familiendaten wirklich?',
prob_cta: 'Es geht auch anders.',
```

- [ ] **Step 3: Verify Problem section**

Open in browser. Three cards appear below the proof bar. Below them: "There's a better way." in accent color and display font. Scroll-reveal animation fires as you scroll into view. Toggle DE/EN.

- [ ] **Step 4: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): add problem section with 3 pain-point cards"
```

---

## Task 6: Philosophy section — move up, rename, reorder cards

**Files:**
- Modify: `docs/index.html` — move `<section class="philosophy">` in DOM, update labels, reorder card 3 and 4

The philosophy section currently sits between the carousel and the setup sections. It needs to move to directly after the Problem section.

- [ ] **Step 1: Cut philosophy section from its current position**

Find the entire `<section class="philosophy">` block (starts with `<!-- PHILOSOPHY -->`, ends with the matching `</section>`). Cut it (remove from current location).

- [ ] **Step 2: Paste philosophy section after Problem section**

Insert the cut block directly after the closing `</section>` of the Problem section (`<!-- THE PROBLEM -->`).

- [ ] **Step 3: Update section label and title keys**

In the pasted philosophy section header, change:

```html
<p class="section-label" data-t="phil_label">Philosophy</p>
<h2 class="section-title" data-t="phil_title">Built different, on purpose</h2>
```

To:

```html
<p class="section-label" data-t="why_label">Why Yuvomi</p>
<h2 class="section-title" data-t="why_title">Built for families, not for profit.</h2>
```

(`phil_desc` key and its `<p>` element stay unchanged.)

- [ ] **Step 4: Reorder philosophy cards (swap card 3 and 4)**

Current card order in `.phil-grid`:
1. Privacy First (`p_priv_t`) — lock SVG
2. Self-Hosted (`p_self_t`) — server SVG
3. Zero Build Step (`p_build_t`) — lightning SVG
4. Open Source (`p_open_t`) — flag SVG

Swap cards 3 and 4 so the order becomes: Privacy First → Self-Hosted → Open Source → Zero Build Step.

After the swap, the `.phil-grid` should contain the four `.phil-card` divs in this order:
1. `p_priv_t` (lock SVG) — unchanged
2. `p_self_t` (server SVG) — unchanged
3. `p_open_t` (flag SVG) — moved from position 4
4. `p_build_t` (lightning SVG) — moved from position 3

- [ ] **Step 5: Add new i18n keys to T object**

In `en`:
```javascript
why_label: 'Why Yuvomi',
why_title: 'Built for families, not for profit.',
```

In `de`:
```javascript
why_label: 'Warum Yuvomi',
why_title: 'Für Familien gebaut, nicht für Profit.',
```

(Keep old `phil_label` / `phil_title` keys — now unused but harmless.)

- [ ] **Step 6: Verify philosophy section position and content**

Open in browser. Scroll order should now be: Hero → Proof Bar → Problem → **Philosophy** → Feature-Alt grid → Feature Showcase → Carousel → Setup → CTA → Footer. Section label reads "Why Yuvomi", title "Built for families, not for profit." Card 3 is Open Source, card 4 is Zero Build. Toggle DE/EN.

- [ ] **Step 7: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): move philosophy section up, rename to Why Yuvomi, reorder cards"
```

---

## Task 7: Feature-Showcase — benefit headlines and intro sentences

**Files:**
- Modify: `docs/index.html` — T object in JS (keys `f_tasks_t`, `f_meals_t`, `f_cal_t`, `f_tasks_d`, `f_meals_d`, `f_cal_d`)

No HTML changes — only i18n values change.

- [ ] **Step 1: Update feature showcase i18n in T object**

In `en`, replace:
```javascript
f_tasks_t: 'Task Management',
f_tasks_d: 'Shared tasks with deadlines, priorities, subtasks, and recurring schedules. Assign to multiple family members simultaneously with stacked avatar display. Kanban board with one-tap status changes.',
f_meals_t: 'Meal Planning',
f_meals_d: 'Weekly drag-and-drop planner with ingredient lists. Automatically export ingredients to your shopping list with one click.',
f_cal_t: 'Calendar Sync',
f_cal_d: 'Two-way sync with Google Calendar and CalDAV providers (iCloud, Nextcloud, Radicale). Subscribe to public ICS calendars. Recurring events with yearly support. File attachments for events.',
```

With:
```javascript
f_tasks_t: 'Everyone knows what needs to be done.',
f_tasks_d: "No more ‘I forgot.’ Shared tasks with deadlines, priorities, subtasks, and recurring schedules. Assign to multiple family members simultaneously with stacked avatar display. Kanban board with one-tap status changes.",
f_meals_t: 'Dinner sorted before anyone asks.',
f_meals_d: 'From plan to shopping list in one click. Weekly drag-and-drop planner with ingredient lists that exports directly to shopping.',
f_cal_t: 'One calendar for the whole family.',
f_cal_d: 'Google Calendar, iCloud, Nextcloud — all in one place. Two-way CalDAV sync, public ICS subscriptions, recurring events with yearly support, and file attachments.',
```

In `de`, replace:
```javascript
f_tasks_t: 'Aufgabenverwaltung',
f_tasks_d: 'Gemeinsame Aufgaben mit Fristen, Prioritäten, Unteraufgaben und wiederkehrenden Terminen. Mehrere Familienmitglieder gleichzeitig zuweisen mit gestapelter Avatar-Anzeige. Kanban-Board mit Ein-Tipp-Status.',
f_meals_t: 'Mahlzeitenplanung',
f_meals_d: 'Wöchentlicher Drag-and-Drop-Planer mit Zutatenlisten. Zutaten per Klick auf die Einkaufsliste exportieren.',
f_cal_t: 'Kalender-Sync',
f_cal_d: 'Zwei-Wege-Sync mit Google Calendar und CalDAV-Anbietern (iCloud, Nextcloud, Radicale). Öffentliche ICS-Kalender abonnieren. Wiederkehrende Termine mit Jahres-Option. Dateianhänge für Termine.',
```

With:
```javascript
f_tasks_t: 'Alle wissen, was zu tun ist.',
f_tasks_d: 'Kein „Hab ich vergessen“ mehr. Gemeinsame Aufgaben mit Fristen, Prioritäten, Unteraufgaben und Wiederholungen. Mehrere Mitglieder gleichzeitig zuweisen. Kanban-Board mit Ein-Tipp-Status.',
f_meals_t: 'Das Abendessen ist geplant, bevor jemand fragt.',
f_meals_d: 'Von der Planung zur Einkaufsliste mit einem Klick. Wöchentlicher Drag-and-Drop-Planer mit Zutatenlisten.',
f_cal_t: 'Ein Kalender für die ganze Familie.',
f_cal_d: 'Google Calendar, iCloud, Nextcloud — alles an einem Ort. CalDAV-Sync, ICS-Abos, wiederkehrende Termine und Dateinhänge.',
```

- [ ] **Step 2: Verify feature showcase**

Open in browser, scroll to Feature Showcase (after Philosophy). The three section `<h3>` titles read as benefit statements: "Everyone knows what needs to be done." / "Dinner sorted before anyone asks." / "One calendar for the whole family." Toggle DE/EN.

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): rewrite feature-showcase titles as benefit statements"
```

---

## Task 8: Feature-Grid — reduce to 5 cards, new section title

**Files:**
- Modify: `docs/index.html` — `<section class="features-alt">` block (~lines 379–433), T object

- [ ] **Step 1: Remove 4 cards from feat-grid**

In the `<div class="feat-grid">` element, remove the following four `<div class="feat-card ...">` blocks entirely (identified by their `data-t` heading key):

- `f_recipes_t` (Recipes — chef-hat/fork SVG)
- `f_notes_t` (Notes — document SVG)
- `f_contacts_t` (Contacts — people SVG)
- `f_housekeeping_t` (Housekeeping — house SVG)

After removal, 5 cards remain: Shopping Lists, Documents, Birthdays, Budget, Works Everywhere (PWA).

- [ ] **Step 2: Update section title i18n**

In the `T` object, update `more_title` in both languages:

In `en`:
```javascript
more_title: 'Everything your family actually uses.',
```

In `de`:
```javascript
more_title: 'Alles, was eure Familie wirklich braucht.',
```

- [ ] **Step 3: Verify feature grid**

Open in browser. Feature grid section shows exactly 5 cards in an auto-fill grid. Section title reads "Everything your family actually uses." The 4 removed features are still visible in the screenshot carousel below. Toggle DE/EN.

- [ ] **Step 4: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): trim feature grid to 5 cards, update section title"
```

---

## Task 9: Carousel — add id for smooth scroll

**Files:**
- Modify: `docs/index.html` — `<section class="carousel-section">` (~line 480 after Task insertions above)

- [ ] **Step 1: Add id attribute to carousel section**

Find:
```html
<section class="carousel-section">
```

Replace with:
```html
<section class="carousel-section" id="carousel">
```

- [ ] **Step 2: Verify smooth scroll**

Open in browser. Click "See it in action" button in the Hero → page smooth-scrolls to the carousel section. Same for "See all screenshots" in the CTA section (added in Task 11 — verify after that task).

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): add id=carousel to enable smooth-scroll from hero and CTA"
```

---

## Task 10: Setup section — 3-step view + Docker toggle

**Files:**
- Modify: `docs/index.html` — `<section class="setup" id="setup">` inner content, T object, JS script block

- [ ] **Step 1: Replace setup section inner content**

Find `<section class="setup" id="setup">` and replace everything between the opening and closing tags with:

```html
  <div class="wrap">
    <div class="section-label reveal" data-t="setup_label">Setup</div>
    <h2 class="section-title reveal" data-t="setup_title">Up and running in minutes</h2>
    <div class="setup-steps reveal">
      <div class="setup-step">
        <span class="setup-step-num">①</span>
        <h3 data-t="setup_1_t">Start the installer</h3>
        <p data-t="setup_1_d">One command launches a setup wizard in your browser. No configuration by hand.</p>
      </div>
      <div class="setup-step">
        <span class="setup-step-num">②</span>
        <h3 data-t="setup_2_t">Set up your account</h3>
        <p data-t="setup_2_d">Create an admin account and choose your preferences. Takes 2 minutes.</p>
      </div>
      <div class="setup-step">
        <span class="setup-step-num">③</span>
        <h3 data-t="setup_3_t">Invite your family</h3>
        <p data-t="setup_3_d">Add family members, set roles, and start using Yuvomi together.</p>
      </div>
    </div>
    <div class="setup-inner reveal">
      <button class="setup-toggle" id="toggle-docker" type="button" data-t="setup_show_code">Show Docker commands ▾</button>
      <div id="docker-code" style="display:none">
        <div class="code-block"><span class="c"># Pull and start with Docker</span>
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/ulsklyc/yuvomi/main/.env.example
cp .env.example .env
<span class="c"># Set SESSION_SECRET and DB_ENCRYPTION_KEY in .env</span>
<span class="h">docker compose up -d</span>
<span class="h">docker compose exec oikos node setup.js</span></div>
        <p class="setup-note" data-t="setup_note">Then open <code>http://localhost:3000</code> and log in. Need a step-by-step guide, HTTPS setup, or troubleshooting? See the <a href="https://github.com/ulsklyc/yuvomi/blob/main/docs/installation.md" target="_blank" rel="noopener">Installation Guide</a>.</p>
      </div>
      <a href="install.html" class="setup-guide-link" data-t="setup_guide_link">→ Step-by-step installation guide</a>
    </div>
  </div>
```

- [ ] **Step 2: Add toggle click handler to JS**

In the `<script>` block, after the `document.getElementById('langBtn').onclick` assignment, add:

```javascript
document.getElementById('toggle-docker').onclick = function() {
  var el = document.getElementById('docker-code');
  var btn = document.getElementById('toggle-docker');
  var opening = el.style.display === 'none';
  el.style.display = opening ? 'block' : 'none';
  btn.setAttribute('data-t', opening ? 'setup_hide_code' : 'setup_show_code');
  var s = T[lang];
  btn.textContent = opening
    ? (s.setup_hide_code || 'Hide Docker commands ▴')
    : (s.setup_show_code || 'Show Docker commands ▾');
};
```

(`data-t` attribute is updated so `applyLang()` picks the right key on language switch.)

- [ ] **Step 3: Add setup i18n keys to T object**

In `en`, add after existing setup keys:
```javascript
setup_label: 'Setup',
setup_1_t: 'Start the installer',
setup_1_d: 'One command launches a setup wizard in your browser. No configuration by hand.',
setup_2_t: 'Set up your account',
setup_2_d: 'Create an admin account and choose your preferences. Takes 2 minutes.',
setup_3_t: 'Invite your family',
setup_3_d: 'Add family members, set roles, and start using Yuvomi together.',
setup_show_code: 'Show Docker commands ▾',
setup_hide_code: 'Hide Docker commands ▴',
setup_guide_link: '→ Step-by-step installation guide',
```

In `de`, add the same keys:
```javascript
setup_label: 'Setup',
setup_1_t: 'Installer starten',
setup_1_d: 'Ein Befehl startet den Setup-Assistenten im Browser. Keine manuelle Konfiguration.',
setup_2_t: 'Konto einrichten',
setup_2_d: 'Admin-Konto erstellen und Einstellungen wählen. Dauert 2 Minuten.',
setup_3_t: 'Familie einladen',
setup_3_d: 'Familienmitglieder hinzufügen, Rollen vergeben und gemeinsam loslegen.',
setup_show_code: 'Docker-Befehle anzeigen ▾',
setup_hide_code: 'Docker-Befehle ausblenden ▴',
setup_guide_link: '→ Schritt-für-Schritt-Installationsanleitung',
```

Note: `setup_label` and `setup_title` keys already exist in the T object with old values — update them in place rather than duplicating.

- [ ] **Step 4: Verify setup section**

Open in browser, scroll to Setup. Three numbered step cards visible. "Show Docker commands ▾" button below. Click: code block appears, button text becomes "Hide Docker commands ▴". Click again: collapses. "→ Step-by-step installation guide" link present. Switch to DE: button text in German. While code is open, switch language: button stays correct (▴ form in German).

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): simplify setup with 3-step overview and collapsible Docker commands"
```

---

## Task 11: CTA section — 3 buttons + updated copy

**Files:**
- Modify: `docs/index.html` — `<section class="cta-section">` block, T object

- [ ] **Step 1: Replace CTA box content**

Find `<section class="cta-section">` and replace its entire `.cta-box` div with:

```html
    <div class="cta-box reveal">
      <h2 data-t="cta_title">Ready to take back control?</h2>
      <p data-t="cta_desc">Free. Open source. Runs on your server. No subscriptions, ever.</p>
      <div class="hero-actions">
        <a href="install.html" class="btn-primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span data-t="cta_btn_install">Get started →</span>
        </a>
        <a href="#carousel" class="btn-secondary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
          <span data-t="cta_btn_demo">See all screenshots</span>
        </a>
        <a href="https://github.com/ulsklyc/yuvomi" class="btn-ghost" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"></path></svg>
          <span data-t="cta_btn_gh">View on GitHub</span>
        </a>
      </div>
    </div>
```

- [ ] **Step 2: Update CTA i18n keys in T object**

In `en`:
```javascript
cta_desc: 'Free. Open source. Runs on your server. No subscriptions, ever.',
cta_btn_install: 'Get started →',
cta_btn_demo: 'See all screenshots',
cta_btn_gh: 'View on GitHub',
```

In `de`:
```javascript
cta_desc: 'Kostenlos. Open Source. Läuft auf eurem Server. Keine Abos, nie.',
cta_btn_install: 'Jetzt starten →',
cta_btn_demo: 'Alle Screenshots ansehen',
cta_btn_gh: 'Auf GitHub ansehen',
```

(`cta_btn` key stays in T object — now unused but harmless.)

- [ ] **Step 3: Verify CTA section**

Open in browser, scroll to CTA. Three buttons in a row: filled "Get started →", outline "See all screenshots", ghost "View on GitHub". "See all screenshots" smooth-scrolls to carousel. Toggle DE/EN.

- [ ] **Step 4: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): update CTA to 3 differentiated buttons and sharper copy"
```

---

## Task 12: Footer — stars, version, install link

**Files:**
- Modify: `docs/index.html` — `<footer>` block, T object, `applyStars()` function in JS

- [ ] **Step 1: Replace footer HTML**

Find `<footer>` and replace the entire block with:

```html
<footer>
  <div class="wrap">
    <p class="footer-meta"><span id="gh-stars-footer"></span><span id="footer-sep" style="display:none"> · </span>v0.55.10 · June 2026</p>
    <p data-t="footer_heart">Built with care for families who value privacy and simplicity.</p>
    <div class="footer-links">
      <a href="install.html" data-t="footer_install">Install</a>
      <a href="https://github.com/ulsklyc/yuvomi" target="_blank" rel="noopener">GitHub</a>
      <a href="https://github.com/ulsklyc/yuvomi/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a>
      <a href="https://github.com/ulsklyc/yuvomi/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener" data-t="footer_contrib">Contributing</a>
    </div>
  </div>
</footer>
```

- [ ] **Step 2: Update applyStars() to include footer**

Find the `applyStars(val)` function added in Task 2 and replace it with the full updated version:

```javascript
function applyStars(val) {
  var nav = document.getElementById('gh-stars-nav');
  var proof = document.getElementById('gh-stars-proof');
  var footer = document.getElementById('gh-stars-footer');
  var footerSep = document.getElementById('footer-sep');
  if (nav) nav.textContent = ' ' + val;
  if (proof) proof.textContent = val;
  if (footer) {
    footer.textContent = val;
    if (footerSep) footerSep.style.display = 'inline';
  }
}
```

- [ ] **Step 3: Add footer_install i18n key to T object**

In `en`:
```javascript
footer_install: 'Install',
```

In `de`:
```javascript
footer_install: 'Installieren',
```

- [ ] **Step 4: Verify footer**

Open in browser, scroll to footer. First line shows "★ 2.4k · v0.55.10 · June 2026" (stars async). "Install" link appears as first footer link. Toggle DE: "Install" → "Installieren", "Contributing" → "Mitmachen".

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "feat(landing): add version, stars, and install link to footer"
```

---

## Task 13: i18n audit — verify all keys complete

**Files:**
- Modify: `docs/index.html` — T object only (fix any gaps found)

- [ ] **Step 1: Run missing-key audit in browser console**

Open `docs/index.html` in browser. Open DevTools (F12) → Console. Paste and run:

```javascript
var missing = Array.from(document.querySelectorAll('[data-t]'))
  .map(function(el){ return el.getAttribute('data-t'); })
  .filter(function(k,i,a){ return a.indexOf(k)===i; })
  .filter(function(k){ return !(T.en[k] || T.de[k]); });
console.log('Missing keys:', missing);
```

Expected output: `Missing keys: []`

- [ ] **Step 2: Run DE-completeness audit in browser console**

```javascript
var deMissing = Object.keys(T.en).filter(function(k){ return !T.de[k]; });
console.log('DE missing:', deMissing);
```

Expected output: `DE missing: []`

- [ ] **Step 3: Fix any reported gaps**

For each missing key, add the correct translation to both `en` and `de` in the T object.

- [ ] **Step 4: Full page walkthrough — EN and DE**

Manually scroll the full page in English. Then click DE and scroll again. Confirm:
- No untranslated English text visible in DE mode (except proper nouns: Docker, GitHub, PWA, MIT, CalDAV, CardDAV)
- No layout breaks from text length differences in DE

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "fix(landing): complete i18n audit, all keys present in EN and DE"
```

---

## Self-Review

### Spec coverage

| Spec section | Task |
|---|---|
| Nav: live star count | Task 2 |
| Hero: new copy, 3 CTAs, updated tags | Task 3 |
| Social Proof Bar | Task 4 |
| "Das Problem" section | Task 5 |
| Philosophy: move up, rename, reorder | Task 6 |
| Feature-Showcase: benefit titles | Task 7 |
| Feature-Grid: 5 cards, new title | Task 8 |
| Carousel: id="carousel" | Task 9 |
| Setup: 3-step view, toggle | Task 10 |
| CTA: 3 buttons, new copy | Task 11 |
| Footer: stars, version, install link | Task 12 |
| i18n completeness | Task 13 |

All spec sections covered. No gaps.

### Consistency check

- `btn-ghost` CSS defined in Task 1, used in Tasks 3 and 11 — consistent.
- `applyStars()` defined in Task 2 with nav + proof bar, extended in Task 12 to include footer — Task 12 shows the full updated function body.
- `setup_show_code` / `setup_hide_code` keys defined in Task 10 i18n, toggle handler uses them via `T[lang]` — consistent.
- `#gh-stars-nav`, `#gh-stars-proof`, `#gh-stars-footer` — all three IDs introduced in Tasks 2, 4, 12 respectively; `applyStars()` in Task 12 handles all three.
- `reveal` (without hardcoded `vis`) used consistently in all new and modified sections — IntersectionObserver handles animation.
- `data-t` attribute updated on toggle button (`setup_hide_code` / `setup_show_code`) so `applyLang()` picks the correct key on language switch — no stale text bug.
