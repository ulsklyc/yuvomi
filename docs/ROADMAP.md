# Where Yuvomi is going

This page is direction, not a queue. It names the few themes that keep coming back across the
open discussions, says for each what has been decided and what is still open, and lists the
things the maintainer has called worth doing without giving them a ticket yet. It carries no
dates and no versions: with several releases a week, a date written here would be wrong the
next morning, and a version number the next afternoon. It is touched on the interface train, when
the interface release goes out, and it is edited rather than appended to, so that what is done
disappears from it.

What it is not: a promise that any of this ships, or a place to ask for something. An idea is a
[discussion](https://github.com/ulsklyc/yuvomi/discussions/new?category=ideas); what Yuvomi will
not become is in [SCOPE.md](SCOPE.md); a decision made once is in [DECISIONS.md](DECISIONS.md).
The [backlog](../BACKLOG.md) stays empty on purpose - the thread is the place for the single
wish, and this page is the view from above.

---

## People, not accounts

The most frequent need under the open threads is that a household is made of people, and only
some of them are users: a cleaner with a schedule and no login (#787), a wall tablet that must
not count as a member (#913), a pet that should be assignable (#846), a babysitter for one
evening (#777), and a person's own calendar rather than the household's (#739, #670, #573).

- **Decided.** A person is a row in `users`, and whether they can sign in is a state of that
  row - [DECISIONS.md entry 4](DECISIONS.md#4-a-household-is-people-not-accounts), reached in
  #1007, #913 and #787. Being visible as a person is a property, not a relationship.
- **Open.** The explicit "can sign in" state with its migration; the Family page adding a
  person with a login as an option; the one predicate replacing the three module-local answers
  (the first step, and the one without behaviour change). For the display account, #913 has
  two questions still with the maintainer: may it act at all, and does it authenticate like an
  account or like a provisioned device. For personal calendar connections, the missing piece
  is an owner on the connection (#739).

## Private by default, in one vocabulary

A household is one trust boundary, and inside it privacy is a property of a row with no admin
bypass ([entry 1](DECISIONS.md#1-privacy-beats-admin-convenience)). The threads that keep
testing that: personal notes (#699), calendar connections that stay private (#739), what a new
member sees on day one (#869, shipped in v2.62.0), the wall display (#913).

- **Decided.** One vocabulary for "who may see this row", normalised on read, never by
  migration - [entry 5](DECISIONS.md#5-one-visibility-vocabulary), from #699 and PR #1019.
- **Open.** The shared labels in the interface, then the read adapters module by module; a
  `visibility` column for notes (#699), where the default has to stay open so that an update
  hides nothing anybody already wrote.

## Notifications that follow events

Today a notification is a reminder somebody set. The asks are for notifications that follow
what happens: a task completed (#800), a medication due (#933), a reminder that reaches a
CalDAV client as an alarm (#705), and the general form, "when a date is reached in module X,
notify A and B" (#963).

- **Decided.** A default per module, applied to whatever is in that module, rather than a
  rule with conditions: no rule store, no condition language, no new place above the modules
  (#963). Event-driven notification follows the one path that exists for it, the @mention in
  a task comment, which checks visibility per recipient before it sends (#800).
- **Open.** Which events beyond "task completed" and "medication due"; the VALARM export;
  notifying somebody other than the assignee, which needs an assignment relationship to hang
  from and is separate work (#963).

## Writing back where today only reads

Several integrations are one-way by construction, and the threads ask for the other direction:
contacts back to CardDAV (#702) and Google contacts (#843), meal plans into the calendar (#624)
and into Tandoor (#747), reminders into CalDAV (#705), events created by a member back into
their Google calendar (#573).

- **Decided.** Yuvomi stays the server and a bridge is a client ([SCOPE.md section
  2](SCOPE.md#2-integrations-with-other-peoples-services)); what the API cannot do yet is
  answer "what changed", which every two-way sync needs - tracked as #1002.
- **Open.** The change feed itself; then each write-back on its own merits. Two calendars
  getting one event each is not free, since a later edit has to find both (#573).

## The wall tablet

A tablet on the kitchen wall is not a person, it is a device the whole family looks at, and it
keeps asking for its own treatment: a customisable wall mode (#915), the screensaver inside the
dashboard (#885), calendar names instead of "event" (#988), themes from design-token overrides
(#972), and the display account above (#913).

- **Decided.** No switch whose only job is to hide one button: the entry into wall mode is
  always visible, shipped in v2.60.0 that way on purpose (#915). Colours first for themes,
  fonts as a separate feature (#972).
- **Open.** Configurable widgets on the wall, the expensive half of #915; the display
  account's two questions.

## A different week

A week is not seven equal days for everyone: week views in blocks (#435), a weekly timetable
(#749), and work hours and school timetables per member (PR #1018).

- **Decided.** Timetables live in the Schedule module as several blocks per cycle day, not as
  a twentieth module - [entry 6](DECISIONS.md#6-one-model-not-two), from #786 and #1018.
- **Open.** The blocks-per-cycle-day change itself, in #1022; the side-by-side view of
  several members' timetables, decided in #1018 as a tab in Schedule rather than a mode in
  the calendar, and still to build.

---

## Later

Things the maintainer has called worth doing in a thread, without a ticket. Each line links to
where the shape was discussed; when one becomes an issue it moves to the tracker and leaves
this list.

- Move an item between shopping lists, inside the existing dialog (#998).
- Housekeeping without billing: a rate type "not tracked", so a live-in helper on a salary does
  not need a fake day rate (#787).
- Goals: define a target and see progress first, the version that links to everything later
  (#777).
- Recurring tasks with rotating assignees, built properly rather than worked around (#842).
- An owner on a calendar connection, so a member's own calendar can stay theirs (#739).
- Google contacts over CardDAV, a different shape from the calendar one (#843).
- OIDC identity looked up by `(provider, sub)` rather than `sub` alone, on its own merits and
  independent of multi-provider configuration (#848).
- Loan payoff across several loans, in instalments rather than in principle (#935).
- Themes: the font half, after the colour half has shipped (#972).
- A module index for third-party modules, the one open request in #746.

Already tickets, since 2 September 2026: bank export import with a saved mapping (#1000),
per-month budget plans (#1001), the health change feed (#1002), a price on a shopping item
(#1003), account metadata without the secret (#1004).
