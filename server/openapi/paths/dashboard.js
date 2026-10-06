import { op } from '../helpers.js';

export function dashboardPaths() {
  return {
    '/api/v1/dashboard': {
      get: op({
        summary: 'Get dashboard data',
        tag: 'Dashboard',
        description: 'Aggregated data for every overview tile. Optional query parameters filter tasks, upcoming events and pinned notes before row limits and counts are computed. Task filters apply to every task slice (`urgentTasks`, `openTaskCount`, `overdueTaskCount`, `memberTodayTasks`, `tasksDoneToday`); note filters apply to `pinnedNotes`, `pinnedNotesCount` and `notesTotal` alike. Event filters apply to both `upcomingEvents` and `weekEvents` (the events touching the household days from yesterday to a week ahead, in a compact shape for the week strip of the calendar tile). The browser derives these filters from per-widget `options` stored in `dashboard_widgets`. `upcomingEvents` counts only appointments that have not ended toward its five-item cap; already ended ones of today (end before now in the household time zone, never all-day ones) come along outside the cap. `familyEvents` feeds the Family card: per household member the appointments of today (ended ones included) and the next coming ones, merged once; the `events_scope` filter does not apply to it, `events_birthdays` does. `wastePickups` lists the collections of today and tomorrow (Waste module), `myShiftsToday` the own shifts of the caller of today (Schedule module); both are empty when the module is denied. `splitBalance` (`{ net, positions }`) lists what the caller has open in shared expenses: net per currency and each open position from the settle-up view of the caller\'s active groups (the same balances as `GET /split-expenses/groups/{id}/balances`), household currency first; it is empty without `budget` read access. A module the household has switched off (`disabled_modules` in `/preferences`) is left out the same way as a denied one: its fields stay in the response with their empty values. `birthdays` is a switch of its own here, so the birthday fields follow it rather than the `calendar` switch, and `upcomingEvents`, `weekEvents` and `familyEvents` carry no birthday events while it is off.',
        params: [
          {
            name: 'notes_category',
            in: 'query',
            required: false,
            description: 'Limit pinned notes to those carrying every selected category (AND). Repeatable positive category IDs, deduplicated and capped at 50. Omitted or empty means all visible pinned notes. Only household categories and the caller\'s own personal categories may match; another user\'s personal category cannot reveal notes.',
            schema: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 50 },
            style: 'form',
            explode: true,
          },
          {
            name: 'tasks_category',
            in: 'query',
            required: false,
            description: 'Limit tasks to these categories. Repeatable; several values combine with OR. Omitted or empty means every category.',
            schema: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          },
          {
            name: 'events_scope',
            in: 'query',
            required: false,
            description: '`mine` limits appointments to those assigned to the calling user - among the assignees, so an unassigned event is not "mine" (same reading as the calendar module). Anything else means all appointments.',
            schema: { type: 'string', enum: ['all', 'mine'] },
          },
          {
            name: 'events_birthdays',
            in: 'query',
            required: false,
            description: '`hide` drops appointments that belong to a birthday entry from `upcomingEvents` and `weekEvents`, so a household that already shows the Birthdays tile does not read them twice. Applied before the cap (`events_limit`), so the freed rows are filled with the next real appointments. Anything else keeps them - birthdays are in by default.',
            schema: { type: 'string', enum: ['show', 'hide'] },
          },
          {
            name: 'events_limit',
            in: 'query',
            required: false,
            description: 'How many upcoming appointments `upcomingEvents` lists: `5`, `8` or `12`. The value is matched against exactly these three; anything else - omitted, empty, repeated, `7`, `500` - means `5`. Appointments of today that have already ended come on top and do not count against it. `weekEvents` and `familyEvents` are not affected.',
            schema: { type: 'integer', enum: [5, 8, 12], default: 5 },
          },
        ],
      }),
    },
  };
}
