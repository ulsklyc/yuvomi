import { op } from '../helpers.js';

export function familyPaths() {
  return {
    '/api/v1/family/members': {
      get: op({
        summary: 'List family members',
        tag: 'Family',
        description: 'Read-only endpoint for family-member profiles: household members only, without housekeeping staff and split-expense guests. It does not expose usernames or system access roles and does not support create/update/delete operations.',
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
  };
}
