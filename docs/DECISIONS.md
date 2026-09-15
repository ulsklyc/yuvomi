# Decisions made once

[SCOPE.md](SCOPE.md) says what Yuvomi will not become. This page is for the other kind of
answer: something Yuvomi does build, where the *shape* was argued out once in a thread and
would otherwise be argued again in the next one. Each entry states the rule in a sentence or
two, the reason, where the rule lives in the code, and what would reopen it. The full
reasoning stays where it was made - in the thread and in the CHANGELOG entry of the release
that shipped it - and this page points there rather than restating it a third time.

An entry earns its place when a decision reached in one thread has been reached again,
independently, in another. That is the sign it will be argued a third time. How a single
feature works belongs in [SPEC.md](SPEC.md); anything not built yet lives in its thread, and
the direction those threads add up to is in [ROADMAP.md](ROADMAP.md).

---

## 1. Privacy beats admin convenience

**Access to a member's private data is never implied by a role, and never widened by an
update.** It is granted per person, by an explicit and visible act, and the default is
closed.

Yuvomi is a household planner, not a company tool. The admin is usually a parent, and the
other members are partners, teenagers and grandparents with a privacy of their own. Somebody
who marked an entry private did so trusting that private means private. A right that reaches
into existing private data cannot be inferred from a field people filled in for another
purpose, and cannot be narrowed silently on update: permissions can be opened later, but what
somebody has already seen cannot be unseen.

The same rule was reached three times, each time from a different module:

- **Health, v1.83.0 (#584).** Asked for as a property of the family role - dad, mum,
  guardian. Built as a per-person grant an admin sets under Settings → Family, because the
  role version would have given two people read access to the private health data of
  everyone carrying the role "child" the moment they updated, including the seventeen-year-
  old who has that role only because it fit best. Until somebody sets a grant, nothing
  changes for anybody. A grant covers reading as well as writing, since a caregiver who could
  write but not read would lose sight of the reading they just took; the cycle diary is
  excluded, because giving medicine is care and reading someone's cycle diary is not.
- **Invitations, v2.62.0 (#869).** A new member used to start with every module. That was
  never decided for invitations: it was inherited from migration v74, where storing
  permissions sparsely was the right call so that existing households behaved exactly as
  before. The invite path got its own answer - a *starting permissions* field, preselected to
  *Without personal areas*, which locks Health, Budget and Documents, with the resolved set
  stored on the invitation. The stored default was left alone, so no household changed on
  update. There is deliberately no "full access" template: a member override cannot widen a
  role profile, and a template that quietly does nothing would be a promise that does not
  hold.
- **Documents, review of PR #989 (September 2026).** The destructive folder delete skipped
  the ownership check for admins, so an admin could permanently delete a member's private
  document that the single-document path would not even show them. Decided in review: the
  visibility rule stands and admins do not override it. The subtree is selected through the
  one visibility rule and refused as soon as one row in it is invisible to the caller;
  sharing a single document deliberately is the owner's act, and that path already exists.

The task lock in v2.30.0 rests on the same reasoning from the other side: a family role says
who somebody is, not what they may do, and Yuvomi had already replaced that inference with
explicit grants once.

### Where the rule lives

One rule, one place, so a future change cannot be forgotten in a copy:

- **Documents:** `documentVisibleSql()` in `server/services/document-access.js` has exactly
  three branches - creator, family visibility, explicit share - and no admin branch. Every
  path that hands out documents goes through it, including the modules that only link them.
- **Tasks and events:** `visibilityWhere()` in `server/services/visibility.js`, enforced on
  the server and without an admin bypass (#474).
- **Health:** `server/routes/health/caregivers.js`. Grants are per person, managed by admins,
  and every member can read their own.
- **Invitations:** `INVITE_PRESETS` in `server/permissions.js`, default `restricted`, and the
  invite handler in `server/auth.js`, where a *missing* field means the narrow template so
  that an older client cannot invite with full access by accident.

### What would reopen it

Whether an admin should ever see past the visibility rule is a real question, and it has an
address: #1007, member visibility as its own axis. If the answer there is ever yes, the change
goes into `document-access.js` - one rule, all paths, one test - and never into an `isAdmin`
check at a single call site. Until then, an admin who cannot see a document still has the
non-destructive path, and a pull request that adds an admin exception to any of the four
places above is undoing this decision rather than extending it.

---

## 2. A rule lives in one place, not at a call site

**Whatever decides who may see, write or store something exists once, as a function every
path calls, and never as a second copy at the place that happens to need it.** A copy is not
a shortcut. It is a second answer, waiting to diverge from the first.

Every copy is a place a future change can miss, and a missed copy fails silently: nothing
errors, one path simply answers differently from the other. Each time that happened here it
was found from outside, after it had shipped, by somebody comparing two paths to the same
data.

The rule was reached three times within the same two days of September 2026, from three
different shapes of copy:

- **An inlined check, review of PR #989.** The destructive folder delete selected its subtree
  without the document visibility rule and put an `isAdmin` check of its own in its place. Two
  paths to the same document gave two answers: the single-document path told an admin that a
  member's private document did not exist, the folder path deleted it. Decided in review: the
  subtree goes through the one visibility rule, and if admins are ever to see past it, that
  change goes into `document-access.js` - one rule, all paths, one test.
- **A second regex, #1013.** The storage check for dashboard widget ids was written without
  ever seeing how `fullWidgetId()` composes them, so it knew nothing of the colon in
  `<module-id>:<widget-id>`, and every layout containing a third-party widget was refused
  whole. Fixed in #1015 by moving the notation to where the composition is, with the storage
  check built from the same parts instead of imitating them.
- **A condition on a future build, #1007.** Member visibility, if it is built, comes with two
  conditions: every list of people goes through a single predicate, the way documents go
  through `documentVisibleSql()`, and all screens change at once, because a person hidden in a
  picker but visible in a mention is not hidden, only inconsistently visible.

An older instance shows the third shape of copy, a rule living inside a middleware. In
v2.25.1 (#823) the MCP tools ran in-process past Express, and so past the only place the
module permission had been written; a member with a module set to none got its data through
that door while the REST path refused. The fix moved the verdict into a function both
surfaces call - a call, not a rebuild. Earlier still, #583 folded three verbatim copies of the
document visibility SQL into one file, and that file's header records why.

### Where the rule lives

- **Documents:** `documentVisibleSql()` and `filterVisibleDocumentIds()` in
  `server/services/document-access.js`, called from documents, dms, tasks and the document
  links every other module uses.
- **Tasks and events:** `visibilityWhere()` in `server/services/visibility.js`. **Budget:**
  `server/services/budget-visibility.js`, owner-based and without an admin bypass.
- **Module permission:** `moduleAccessVerdict()` and `deniedModules()` in
  `server/permissions.js`. The path middleware and the MCP tool layer call the same verdict,
  and a route that carries several modules sorts with `deniedModules()`, because a middleware
  that reads the path cannot know what such a route returns.
- **Widget and module id notation:** `server/services/module-capabilities.js`, where
  `fullWidgetId()` composes them and `isWidgetId()` is built from the same parts.

### What counts as undoing it

An `isAdmin` or ownership check inlined at a call site instead of the shared predicate. A
regex for a format that already has an owner. A permission rule written inside a middleware
or a guard, which binds it to that guard's construction and leaves the next surface without
it. The test that protects such a rule kills it at its home and expects every path to go red;
a test that only reads the source for the right name stays green over dead code.

---

## 3. One head, one width

**A page head holds the edge of its widest body and does not move when the view changes.**
Where the bodies of a page differ in width, the narrow ones keep their own lane underneath;
the head is not narrowed along with them.

A head that follows its body is right in exactly one view and jumps in every other. The
calendar settled this on 27 August 2026 (v2.50.3): its head stood over four bodies, three of
them full width, and once the view switcher had moved into the toolbar row the full title
line no longer fit on one line inside the 720px reading cap. The answer was not a wider cap
but a rule: the head keeps the edge of its widest body, and the agenda list keeps its reading
lane underneath.

Tasks reached the same point in #1012, reported by @Kyrodan: three views, two head widths,
and the actions on the right moved 354px on every switch at 1358px. It was the same coupling,
and Tasks had not followed when the calendar changed course. The one-line fix did not exist:
PAGE-016 requires that a measure which caps anything on a page is visible in its head, so a
reading page cannot simply release its head. The page had to be built the calendar's way
first - no measure on the root, the reading lane taken back per view on the page root, the
head untouched - and only then did the jump stop, with the task rows still ending at 720px.

### Where the rule lives

- **The construction:** `app-page--full` on the page root, and `is-reading-measure` toggled
  on that root per view (`public/pages/calendar.js`, `public/pages/tasks.js`).
  `.app-page.is-reading-measure` in `public/styles/layout.css` sets the measure, and rows and
  filter rows cap themselves at it; the head reads nothing from it.
- **The guards** in `test/test-frontend-audit.js`. "EIN Kopf, EINE Breite" recognises the
  shape by how it is written - a measure toggle on the body with no toggle on the head - and
  requires a narrowed head on the list pages it scans. PAGE-016 closes the other door: a page
  with a measured mode and a full-width head may cap nothing.
- **The mechanism** of a narrowed head, the `::after` slot that pulls the row end to the
  measure, is described in [PAGE-COMPOSITION.md](PAGE-COMPOSITION.md).

### What counts as undoing it

Toggling a head's width modifier with the view. Releasing the head of a reading page without
changing the page's mode, which PAGE-016 reports. A new page with mixed body widths that
narrows its head to the narrow body: it will be right in one view and jump in the others,
and it will be reported by whoever switches views first.

---

## 4. A household is people, not accounts

**A person in the household is a row in `users`. Whether that person can sign in is a state
of that row, not a second table beside it; and what kind of person they are - member, staff,
guest, display - is a property of the row too, never a relationship between two people.**

The question arrives in different clothes: a pet that should be assignable (#846), a cleaner
who has a schedule but will never log in (#787), a wall tablet that must not count as a family
member (#913), a babysitter who is in the house for one evening (#777), and finally the
question underneath all of them, whether being *visible as a person* is a property or a
relationship (#1007). Yuvomi had already answered it twice in the code before anybody asked:
housekeeping staff are `users` rows filtered out of the member list, split-expense guests are
`users` rows with `access_scope = 'split_guest'`. Two kinds of person without a normal login,
each with its own side table and its own predicate. The decision is to say that out loud
rather than to add a third mechanism.

- **#1007, September 2026.** Decided: member visibility stays a property of a person, not a
  "who may see whom" matrix; what it rules in is a third kind of account alongside the two
  that exist. Two conditions attached: every list of people goes through one predicate, and
  the rollout is all of it or none of it, because somebody hidden from a picker but visible in
  a mention is not hidden, they are inconsistently visible.
- **#913, August 2026.** The display account is not a new type from scratch: `access_scope`
  already carries one non-member scope, and the real work is the exclusion list - every
  surface that lists people today reads the member list through its own query.
- **#787, August 2026.** Whether a staff member is a person with an account or a record about
  a person has two honest answers - the live-in helper is the first, the plumber who comes
  twice a year is the second - and the module is right for the first. The record-about-a-
  person case does not need an account model; it needs the module to work without billing.

The alternative, a `persons` table with an optional `user_id` (the shape Home Assistant and
Splitwise use), was considered and declined: every assignment, birthday, contact and balance
in this schema points at `users.id`, and a second table would make every new feature answer
"person or user?" again.

### Where the rule lives

- `server/services/household-members.js` - `householdMemberSql()`, the member predicate (a
  `users` row minus staff minus guests), and `accessScopeSql()`, which resolves `access_scope`
  per account to `family` or `split_guest`. The lists of members built from `users` go
  through the predicate, and `npm run test:household-member-guard` turns red when a new list
  reads `users` without it. The places that must see every row stand in the guard's allowlist
  with a reason, among them user administration (`GET /auth/users`, which today also feeds the
  calendar, budget and schedule pickers, so staff and guests are offered there), sign-in, the
  permission matrix and background jobs per account (#1207).
- Not every list applies the strict form yet: `includeGuests` (family members, 2FA overview,
  task options and mentions, dashboard, rewards, split expense candidates) and `includeStaff`
  (household size, API token subjects) keep what each list showed before the predicate
  existed. Whether they converge is open in #1207.
- `server/routes/housekeeping.js` (`createWorkerUser`) - a worker is a `users` row with a
  random password, role `member`, family role `other`.
- `server/services/oidc.js` - the `$oidc$` placeholder: "this account has no password" is a
  state of the column itself, which is the pattern "can sign in" follows.

### What is not built yet

"Can sign in" as an explicit state of the row, with a migration that classifies today's staff
and guests; the Family page adding a person with a login as an option rather than a
prerequisite; one form of the predicate for every list, where today three are in use (#1207).
The order and the threads are in [ROADMAP.md](ROADMAP.md). A `persons` table, a second list-of-people query that
bypasses the predicate, or a per-pair visibility setting would each be this decision undone.

---

## 5. One visibility vocabulary

**"Who may see this row" is answered in one vocabulary across modules: `private` (the owner),
a named set (assignees, or an explicit access list), and `all` (the household). A module keeps
storing what it stores; the read side maps `family` and `shared` to `all`. Stored values are
never rewritten by a migration, and the interface uses the same three words everywhere.**

The same question had grown three answers. Tasks and calendar say `all | assignees | private`
through one function. Health says `private | family`, default private. Budget says
`private | shared | shared_amount`, default shared, and its third value is not a visibility
level at all but a second axis ("what of it": the amount counts, the details stay). Documents
carry `family` plus a named list. The interface followed suit: "Alle Familienmitglieder",
"Ganze Familie", "Familie", "Mit dem Haushalt teilen" and "Alle im Haushalt" are five German
phrasings of one state.

- **#699, September 2026.** The maintainer's own correction after re-reading the schema: not
  three copies of one pattern but two patterns that disagree in both directions - health is
  private by default and calls the open state `family`, budget is shared by default and calls
  it `shared` - and the earlier answer had silently picked one vocabulary and the opposite
  default. The fork was real and had been presented as settled.
- **PR #1019, September 2026.** A new health tab arrived with its own `visibility` column in
  the health pair, default private, chosen alone as every module before it. Two vocabularies
  left "deliberately" means every new module picks, and the count grows.

Normalising on read rather than by migration follows #984 (read-side transformation) and
entry 1: a visibility default never changes existing data. `shared_amount` stays budget's own,
because it answers a different question.

### Where the rule lives

- `server/services/visibility.js` - `VISIBILITY_VALUES` and `visibilityWhere()`, the canonical
  set and the one WHERE fragment tasks and calendar share (#474).
- `server/routes/health/helpers.js` - the health pair, to be read through an adapter.
- `server/services/budget-visibility.js` - the budget triple, with `shared_amount` as the
  second axis.
- `server/services/document-access.js` - `documentVisibleSql()`, `family` plus the access list.
- `public/locales/*.json` - the visibility labels under tasks, documents, health, budget and
  quick links, the place the family sees first.

### What is not built yet

The shared labels in the interface, the read adapters per module, and the register of which
module has moved; new modules take the canonical set from the start. A fourth stored
vocabulary, a migration that rewrites `family` or `shared`, or a module-local label set would
each be this decision undone.

---

## 6. One model, not two

**Two threads describing the same arithmetic get one model, and a view of that model lives
where the model lives.** A fixed weekly timetable and a rotating shift rota are one feature
with two cycle lengths. A screen that shows either of them belongs to the module that owns the
rows, not to the page people happen to open most often.

The first half was settled on 24 August 2026, in #786 against #749. Benoit had asked for a
weekly timetable with a Week A and a Week B; @mclgoerg had proposed a shift planner with an
Early-Early-Late-Late-Night-Night-Off-Off rotation. They are the same thing: a "Week A / Week
B" timetable is a 14-day cycle anchored to a date, the rota an 8-day one. Building the
timetable separately would have meant writing the same cycle arithmetic a second time six
months later. One module went in, named `schedule` rather than `shifts`, so that the timetable
case would not be a guest in its own module.

A week after Schedule shipped, #1018 arrived from @matthiasNX: a module of its own,
`timetables`, with its own tables and a `week_type IN ('all','A','B')` column. The PR carried
its own proof. `week_type` had no anchor anywhere, so nothing in the module could answer "is
this week A or B?" - the user picked it from a dropdown, which is a label rather than a
recurrence. Every entry then stored its own subject, times and colour, which forced a
`POST /copy` endpoint that Schedule does not need, because a second pattern there points at the
same shift types. What was genuinely new in it - room, instructor, period number, and more than
one block per cycle day - was a change to the existing tables, and that is the shape #1022
built.

The same thread reached the rule a third time the following day, and that is the part worth
keeping. @mclgoerg asked, before building, where a side-by-side timetable overview should live:
a mode inside the calendar's week view, or a tab in Schedule. The answer came from the data
rather than from the traffic. Every schedule entry carries a `user_id` - `resolveEntries()`
stamps it on both the override and the pattern branch - so a lane per person is something the
rows already are. Holidays, events and tasks carry no person at all, and the calendar's week
view puts all three into one all-day cell per day, with a single column count shared by three
grid rows. Splitting a day column into person lanes would have meant answering "whose holiday
is Christmas?", a question the schema does not ask. The overview became a Schedule tab.

The calendar side of this had already been answered, from the other direction and for other
data. #670 asks for a multi-column family calendar, one column per member, and the reply on 24
August said that organising by person first and time second is a genuinely different layout
rather than a variant of week view, which is why it cannot be a switch on the existing one.
That request is open and welcome; it is about calendar events, which do carry assignments per
member. What this entry rules out is not a person-first view, but putting one module's data
into another module's page to get one.

The rule was reached a fourth time in September 2026, from household chores. #736 asked for a
cleaning plan for households without a cleaning helper, and @Kyrodan's daily routines, in the
same thread and in his wall-display vision in #913, asked for chores that reset, credit the
person who did them and stay out of the calendar. Yuvomi already had two answers to "do this
again some days after it was last done": the Housekeeping decay tasks (`frequency_days` counted
from `last_completed`) and tasks with `recurrence_from_completion`. It is the same arithmetic,
and only the task side carries assignees, points, a completion history and reminders. Growing
the decay tasks into the chores feature would have meant building each of those a second time.
Routines therefore become a kind of task, with their own tab in the tasks module; the decay
tasks move into them, and Housekeeping keeps the helper side (#787). The first step is #1205.

### Where the rule lives

- **The model:** migration 165 in `server/db.js` - `schedule_patterns` with `anchor_date` and
  `cycle_length`, `schedule_pattern_days` for the ordered cycle, `schedule_overrides` for a
  single day. Described under "Schedule" in [SPEC.md](SPEC.md).
- **The arithmetic, once:** `cyclePosition()` and `resolveEntries()` in
  `server/services/schedule.js`, covered by `npm run test:schedule`. There is exactly one
  implementation of cycle-position-from-anchor-date in the tree.
- **Computed on read, never materialised:** `GET /schedule/entries` resolves patterns and
  overrides per request and writes nothing. The calendar renders the result as a layer it can
  switch off; it does not own the rows.
- **The same move elsewhere:** cycle reminders (migration 177) anchor to
  `cycle_reminder_anchors` for a stable reminder id, but reuse `predictCycle()` from
  `public/utils/health-cycle.js` rather than keeping a second copy of the prediction maths.

### What counts as undoing it

A module that stores its own weekly or rotating pattern instead of a Schedule pattern. A
`week_type`, `week_parity` or similar column anywhere: it is a cycle length under another name,
and without an anchor it cannot say which week is which. Materialising a pattern into rows,
which trades one pattern row plus its overrides for roughly seven hundred rows per person per
two years, and makes every edit a reconciliation. And placing an editor or a comparison view
for schedule data inside the calendar because that is where people look first: the calendar
renders schedule entries as a layer, it does not host them. A person-first view of the
calendar's own events is a different question, asked in #670 and still open. A second model
for recurring household work next to tasks, whether as a module of its own or by giving the
Housekeeping decay tasks people, points or a history of their own.
