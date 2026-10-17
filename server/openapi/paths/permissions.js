import { op, jsonBody } from '../helpers.js';

/** Der Rollen-Name ist kein numerischer Bezeichner - idParam() passt hier nicht. */
const familyRoleParam = {
  name: 'familyRole',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'] },
  description: 'Family role the profile belongs to.',
};

const userIdParam = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: { type: 'integer' },
  description: 'Member the overrides belong to.',
};

const BODY = 'Body: { modules, widgets, capabilities } - `modules` maps a module key to `none`, `read` or `write`, '
  + '`widgets` maps a widget id to `none` or `allow`, and `capabilities` maps '
  + '`notes_manage_household_categories`, `health_use_fasting` and `housekeeping_view_amounts` to `none` or `allow`. Module and widget rows are replaced on every '
  + 'request. Capability rows are replaced only when `capabilities` is explicitly present, so older clients '
  + 'cannot silently remove them. Role values '
  + 'that match the default are not stored; a member-level `none` capability may be stored to override an '
  + 'inherited `allow`.';

export function permissionsPaths() {
  return {
    '/api/v1/permissions/catalog': {
      get: op({
        summary: 'Get the permission catalog',
        tag: 'Permissions',
        admin: true,
        description: 'Modules, widgets, capabilities (including access levels and defaults), roles and the member list for the rights matrix. The catalog '
          + 'is the authoritative list of what can be granted - the enforcing side reads the same one, '
          + 'so the two cannot drift apart. defaults.capability is the legacy fallback; each capability item\'s default takes precedence when present. '
          + '`childStart` lists what a new child account starts with in addition (modules and capabilities).',
      }),
    },
    '/api/v1/permissions/role/{familyRole}': {
      get: op({
        summary: 'Get the stored rights of a role profile',
        tag: 'Permissions',
        admin: true,
        params: [familyRoleParam],
        description: 'Only the deviations from the default are stored, so an empty answer means '
          + '"this role uses the defaults", not "this role has nothing".',
      }),
      put: op({
        summary: 'Replace a role profile',
        tag: 'Permissions',
        admin: true,
        stateChanging: true,
        params: [familyRoleParam],
        requestBody: jsonBody(null),
        description: BODY,
      }),
    },
    '/api/v1/permissions/user/{userId}': {
      get: op({
        summary: 'Get the stored overrides of one member',
        tag: 'Permissions',
        admin: true,
        params: [userIdParam],
        description: 'Member overrides sit on top of the role profile. An empty answer means the '
          + 'member inherits their role unchanged.',
      }),
      put: op({
        summary: 'Replace the overrides of one member',
        tag: 'Permissions',
        admin: true,
        stateChanging: true,
        params: [userIdParam],
        requestBody: jsonBody(null),
        description: `${BODY} Each empty map means "inherit from the role" for that axis. To remove every override, send { modules: {}, widgets: {}, capabilities: {} }.`,
      }),
    },
  };
}
