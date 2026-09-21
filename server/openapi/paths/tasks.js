import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

export function tasksPaths() {
  return {
    '/api/v1/tasks': {
      // Die Filter stehen als echte Parameter da, nicht nur im Fließtext: ein
      // generierter Client und die MCP-Brücke (get_api_operation) lesen die
      // Liste, nicht die Beschreibung. `tag` braucht dabei explizit die
      // Wiederhol-Form, weil sich daraus die Serialisierung ergibt.
      get: op({
        summary: 'List tasks',
        tag: 'Tasks',
        description: 'Several tags narrow the result: a task must carry all of them. Tag matching ignores case, including non-ASCII letters. Archived tasks are omitted unless asked for.',
        params: [
          { name: 'status',      in: 'query', required: false, schema: { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'] }, description: 'Repeatable; several values are OR-ed. "archived" is not a status but the separate archive axis and behaves like the `archived` parameter.' },
          { name: 'archived',    in: 'query', required: false, schema: { type: 'string', enum: ['1', 'only'] }, description: 'Archived tasks are hidden by default. `1` includes them, `only` returns just the archive. A task keeps its own status while archived.' },
          { name: 'priority',    in: 'query', required: false, schema: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] } },
          { name: 'assigned_to', in: 'query', required: false, schema: { type: 'integer' }, description: 'Family member ID.' },
          { name: 'category',    in: 'query', required: false, schema: { type: 'string' }, description: 'Task category key.' },
          {
            name: 'tag',
            in: 'query',
            required: false,
            explode: true,
            style: 'form',
            schema: { type: 'array', items: { type: 'string' } },
            description: 'Repeat once per tag (?tag=a&tag=b). Each occurrence is one literal tag, never a comma-separated list, so a tag containing a comma survives.',
          },
          { name: 'include_future', in: 'query', required: false, schema: { type: 'string' }, description: 'Any non-empty value also returns tasks whose start date lies in the future.' },
        ],
      }),
      post: op({ summary: 'Create task', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null), description: 'Body accepts `locked: true` to close the task definition to everyone but its creator and administrators (#830). A subtask under a locked parent inherits the lock, and adding one requires the same rights. `status` may be set on creation (#807); it runs through the same transition handling as PUT and PATCH, so creating a task as `done` books its points and writes its completion entry. `null`, an empty string and `archived` all fall back to `open` - filing a task away is a separate axis and not something a creation can do.' }),
    },
    '/api/v1/tasks/meta/options': { get: op({ summary: 'Get task metadata', tag: 'Tasks' }) },
    '/api/v1/tasks/completions': {
      get: op({
        summary: 'List completed tasks, newest first',
        tag: 'Tasks',
        description: 'The household history of who completed which task, and when (#791). Each entry carries both people: `user_id` is who ticked it off and `done_by_user_id` is who was named as having done it (#1205, null when nobody was), with `person_user_id` resolving the two into the one the entry displays. Recording started with the release that introduced it, so nothing before that appears. Timestamps are UTC instants; which calendar day one belongs to is a question for the display timezone, which is why there is no date range here. Only tasks the caller may see are returned, evaluated live against the task - a task later set to private disappears from the history too. Subtasks are never recorded: a checklist item is part of its parent instruction, and the completion of the parent is the event.',
        params: [
          { name: 'limit',     in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'user_id',   in: 'query', required: false, schema: { type: 'integer' }, description: 'Only completions attributed to this member. That is whoever was named as having done the task (#1205), and the person who ticked it off where nobody was named - the same person the entry displays, so filtering and display cannot disagree.' },
          { name: 'before_at', in: 'query', required: false, schema: { type: 'string' }, description: 'Cursor, taken from `next_cursor` of the previous page. Paired with before_id because several completions can share a second.' },
          { name: 'before_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'Cursor, taken from `next_cursor` of the previous page.' },
        ],
      }),
    },
    '/api/v1/tasks/points/affected': {
      get: op({ summary: 'Count unfinished tasks on a given point value', tag: 'Tasks', description: 'Admin only. Preview for the default-points rebase: top-level tasks that are not done and whose points equal the query value.' }),
    },
    '/api/v1/tasks/points/rebase': {
      post: op({ summary: 'Move unfinished tasks from one point value to another', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null), description: 'Admin only. Applies a changed default point value to top-level tasks that still carry the previous default. Tasks in status done keep their value because the reward ledger already holds an earn entry for it.' }),
    },
    '/api/v1/tasks/categories': {
      get: op({ summary: 'List task categories', tag: 'Tasks' }),
      post: op({ summary: 'Create task category', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/tasks/categories/reorder': {
      patch: op({ summary: 'Reorder task categories', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/tasks/categories/{key}': {
      put: op({ summary: 'Rename task category', tag: 'Tasks', params: [stringPathParam('key', 'Category key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete task category', tag: 'Tasks', params: [stringPathParam('key', 'Category key')], stateChanging: true }),
    },
    '/api/v1/tasks/sync-targets': {
      get: op({
        summary: 'List selectable CalDAV reminder lists for the task editor',
        tag: 'Tasks',
        description: 'Available to every authenticated user (#695). Returns `{ data: { caldav: [{ accountId, accountName, listUrl, listName }] } }`, restricted to reminder lists the household has enabled **for tasks** - a list pointing at shopping is omitted, because a task sent there would come back as a shopping item. Carries no credentials or server URLs; account management stays admin-only. The identifier for `sync_target` on POST/PUT /tasks is `caldav:<accountId>|<listUrl>`.',
      }),
    },
    '/api/v1/tasks/tags': {
      get: op({ summary: 'List task tags', tag: 'Tasks', description: 'Every visible tag in use with its task count. Tags are free-form and have no registry: the list follows from the tasks themselves. Mirrored from VTODO CATEGORIES on CalDAV task lists, and distinct from the single category a task carries. Tags on tasks the caller cannot see are omitted, counts included.' }),
    },
    '/api/v1/tasks/tags/apply': {
      post: op({ summary: 'Add or remove tags on several tasks', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { ids, add?, remove? }. Applies to the tasks in `ids` the caller can see; the others are skipped silently. Locked tasks the caller may not edit are skipped as well and counted in `skipped`, so a partial run is visible rather than silent. Returns the number of tasks actually changed and the refreshed tag list.' }),
    },
    '/api/v1/tasks/archive': {
      post: op({ summary: 'Archive several tasks', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { ids } with at most 500 task IDs. Archives the listed tasks in one transaction under the same rules as PATCH /tasks/{id}/archive, checked per ID: tasks the caller cannot see are skipped silently and not counted, locked tasks the caller may not change (a subtask inherits the lock of its parent) are skipped and counted in `skipped`. A task that is already archived keeps its original `archived_at`. The status of each task is left untouched. Returns `{ data: { archived, skipped } }`, where `archived` counts the tasks this call actually archived. Send the IDs you show rather than every done task, so that nothing completed elsewhere since is archived unseen.' }),
    },
    '/api/v1/tasks/tags/{tag}': {
      put: op({ summary: 'Rename a task tag', tag: 'Tasks', params: [stringPathParam('tag', 'Tag name')], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { name }. Renames the tag on every task the caller can see. Renaming onto an existing tag merges the two. Tasks the caller cannot see keep the old tag, and so do locked tasks the caller may not edit - those are counted in `skipped`.' }),
      delete: op({ summary: 'Remove a task tag everywhere', tag: 'Tasks', params: [stringPathParam('tag', 'Tag name')], stateChanging: true, description: 'Detaches the tag from every task the caller can see. The tasks themselves stay. Locked tasks the caller may not edit keep the tag and are counted in `skipped`. Unlike categories there is no in-use guard: a tag is nothing but its uses.' }),
    },
    '/api/v1/tasks/{id}': {
      get: op({ summary: 'Get task', tag: 'Tasks', params: [idParam()] }),
      put: op({ summary: 'Update task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'On a locked task (`locked: 1`) only the creator and administrators may change the definition - title, description, category, priority, dates, recurrence, points, visibility, tags, sync target, the lock itself, and assigning other members. Everyone else may still send the full body as long as the outcome differs only in `status` or in their own entry in `assigned_to`; anything else answers 403. The comparison is against the stored values, not against which fields were sent.' }),
      delete: op({ summary: 'Delete task', tag: 'Tasks', params: [idParam()], stateChanging: true, description: 'On a locked task, the creator and administrators only (403 otherwise).' }),
    },
    '/api/v1/tasks/{id}/status': {
      patch: op({ summary: 'Update task status', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { status, done_by_user_id? }. Sending `archived` files the task away without touching its status - use PATCH /archive instead. Deliberately open on a locked task: ticking one off is the interaction the lock exists to preserve. `done_by_user_id` names who actually did the task (#1205), which is not necessarily the caller - on a shared tablet it rarely is. It has to be a household member (400 otherwise), it only applies to the transition into `done` and is ignored on any other status change, and it decides where the points go: a named member who takes part in rewards receives them instead of the assignees, a named member who does not take part means no points at all rather than crediting someone who did not do it. Omit it and nothing changes: the history shows the caller and the assignees rule applies. The naming is as idempotent as the completion itself - correcting it means reopening the task and ticking it off again. A paired wall display reaches this route too, and only this one of the writing routes (#1209): for it the field is required rather than optional, only the transition into `done` is allowed, and the task has to be visible to the whole household, which answers 404 rather than 403 so an invisible task is not confirmed to exist.' }),
    },
    '/api/v1/tasks/{id}/archive': {
      patch: op({ summary: 'Archive or restore a task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Archives the task by default. Send `{ "archived": false }` to bring it back. The status is left untouched: a task that was done stays done, and no reward booking changes. Filing a task removes it from everyone\'s view, so on a locked task this is the creator and administrators only.' }),
    },
    '/api/v1/tasks/{id}/check': {
      patch: op({
        summary: 'Tick one checklist item in the description, addressed by its source line',
        tag: 'Tasks',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { line, checked, expect? }. Rewrites exactly the one `- [ ]` / `- [x]` line at '
          + '`line` in the description and leaves the rest of the text byte for byte, so two members ticking '
          + 'different items at the same time do not overwrite each other - which PUT would do. `expect` is the '
          + 'line as the caller saw it; if it no longer matches, the answer is 409 rather than a tick on the '
          + 'wrong line. Deliberately open on a locked task, for the same reason PATCH /status is: the lock '
          + 'covers what the task is, not how far it has come.',
      }),
    },
    '/api/v1/tasks/{id}/documents': {
      get: op({ summary: 'List documents linked to a task', tag: 'Tasks', params: [idParam()], description: 'Returns family documents linked to the task that are visible to the current user.' }),
      put: op({ summary: 'Set documents linked to a task', tag: 'Tasks', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null), description: 'Replace-set of document_ids; only documents visible to the user are linked. Attachments are part of the task definition, so a locked task answers 403 for anyone but its creator and administrators.' }),
    },
    '/api/v1/tasks/{id}/completions': {
      get: op({
        summary: 'List completions of this task and its repetition chain',
        tag: 'Tasks',
        params: [idParam(), { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }],
        description: 'Answers "when was this last done" for a recurring task (#791). A completed repeating task spawns a follow-up instance, so its history is spread across a chain of rows; this walks the chain to its root and returns the whole series, newest first. A task the caller cannot see answers 404.',
      }),
    },
    '/api/v1/tasks/{id}/comments': {
      get: op({ summary: 'List comments on a task', tag: 'Tasks', params: [idParam()], description: 'Oldest first. Anyone who may see the task may read its comments; a task the caller cannot see answers 404.' }),
      post: op({ summary: 'Comment on a task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { comment }. `@Name` mentions are read from the text and push-notify the mentioned members that may see the task.' }),
    },
    '/api/v1/tasks/{id}/comments/{commentId}': {
      patch: op({ summary: 'Edit a comment', tag: 'Tasks', params: [idParam(), idParam('commentId', 'Comment ID')], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { comment }. The author only; sets updated_at.' }),
      delete: op({ summary: 'Delete a comment', tag: 'Tasks', params: [idParam(), idParam('commentId', 'Comment ID')], stateChanging: true, description: 'The author, or an admin moderating.' }),
    },
  };
}
