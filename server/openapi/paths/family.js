import { jsonBody, op } from '../helpers.js';

const apiError = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

export function familyPaths() {
  return {
    '/api/v1/people/{id}/avatar': {
      get: op({
        summary: "Fetch a person's profile picture",
        tag: 'Family',
        params: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, description: 'User ID' },
          {
            name: 'v',
            in: 'query',
            required: true,
            schema: { type: 'string', pattern: '^[0-9a-f]{32}$' },
            description: 'The picture key, taken from the address in a list row. Without the matching key the answer is `404`.',
          },
        ],
        description: 'The image bytes of a profile picture (PNG, JPEG or WebP). List rows that show a person - '
          + '`assigned_avatar` and `assigned_users[].avatar_data` on tasks and events, `creator_avatar` on notes, '
          + '`worker_avatar_data` on housekeeping visits, `user_avatar`/`person_avatar` in the completion feed and '
          + '`user_avatar` in the money ledger - carry this address (with a `v` query parameter, a random key that changes with '
          + 'every new picture and is required here) instead of a data URL, or `null` when the person has no picture. Requests authenticated '
          + 'with an API token keep receiving the data URL in these fields, since an image request does not carry '
          + 'the bearer token; the address is what the app itself (session cookie, wall display) gets. Sessions and wall displays '
          + 'may read it; an API token with scopes may not (it has the data URL already), nor may split-expense guests. The response '
          + 'carries `Cache-Control: private, no-cache` and an `ETag` derived from the picture key, so a client revalidates on every use '
          + '(through authentication and the access checks, also after a sign-out in the same browser) and `If-None-Match` answers `304`. '
          + 'Errors stay `no-store`. '
          + 'Without the matching key the answer is `404`, the same as for a person without a picture.',
        responses: {
          200: {
            description: 'The picture',
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'image/webp': { schema: { type: 'string', format: 'binary' } },
            },
          },
          304: { description: 'Unchanged since the given ETag; no image bytes' },
          400: apiError('Invalid person ID'),
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('Split-expense guest'),
          404: apiError('No picture for this person, or the key in `v` does not match'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/family/members': {
      get: op({
        summary: 'List family members',
        tag: 'Family',
        description: 'Family-member profiles: household members only, without housekeeping staff, split-expense guests, wall displays and deactivated accounts. It does not expose usernames or system access roles. '
          + 'The list comes in the household member order: members with a position (`sort_order`) first, by position; members without one (`sort_order: null` - new members, and everyone in a household that never arranged its members) after them, by display name without regard to ASCII letter case, then by id. '
          + 'Every list of people the API returns follows this one order; it is set with `PATCH /api/v1/family/members/reorder`.',
        responses: {
          200: {
            description: 'Family members',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyMembersResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/family/members/reorder': {
      patch: op({
        summary: 'Set the household member order',
        tag: 'Family',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/FamilyMemberReorderInput'),
        description: 'Administrators only. Body: `{ order }` with the ids of ALL household members in the wanted order - exactly the ids `GET /api/v1/family/members` lists, each once. '
          + 'The members get the positions 1..n in that order; there is one order per household, the same for everyone who looks, and every list of people follows it. '
          + 'An account that is not a household member (housekeeping staff, a split-expense guest, a wall display, a deactivated account) has no position and is refused. '
          + 'A member created later has no position and sorts after the placed ones by display name until the order is set again. '
          + 'Refusals carry a stable `reason`: 403 `admin_required`; 400 `invalid_order` (not a non-empty array of positive integers), `duplicate_member`, `not_a_household_member`, `incomplete_order` (a household member is missing). Nothing is written on a refusal. '
          + 'Returns the member list in the new order, in the shape of `GET /api/v1/family/members`.',
        responses: {
          200: {
            description: 'Members in the new order',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FamilyMembersResponse' } } },
          },
          400: apiError('The order is not a complete list of the household members'),
          401: { $ref: '#/components/responses/Unauthorized' },
          403: apiError('Only administrators can change the member order'),
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
