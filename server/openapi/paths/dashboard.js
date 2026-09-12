import { op } from '../helpers.js';

export function dashboardPaths() {
  return {
    '/api/v1/dashboard': {
      get: op({
        summary: 'Get dashboard data',
        tag: 'Dashboard',
        description: 'Aggregated data for every overview tile. Optional query parameters filter tasks, upcoming events and pinned notes before row limits and counts are computed. Task filters apply to every task slice (`urgentTasks`, `openTaskCount`, `overdueTaskCount`, `memberTodayTasks`, `tasksDoneToday`); note filters apply to both `pinnedNotes` and `pinnedNotesCount`. The browser derives these filters from per-widget `options` stored in `dashboard_widgets`.',
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
            description: '`hide` drops appointments that belong to a birthday entry from `upcomingEvents`, so a household that already shows the Birthdays tile does not read them twice. Applied before the five-item cap, so the freed rows are filled with the next real appointments. Anything else keeps them - birthdays are in by default.',
            schema: { type: 'string', enum: ['show', 'hide'] },
          },
        ],
      }),
    },
  };
}
