import { idParam, op } from '../helpers.js';

export function displaysPaths() {
  return {
    '/api/v1/displays': {
      get: op({
        summary: 'List wall displays and their paired devices',
        tag: 'Displays',
        description: 'Admin only. A display is a `users` row of its own kind (#1208, DECISIONS entry 4): not a household member, without a password, and unable to sign in with a username and password or through SSO. This list is the exact counterpart of the member predicate - it shows only the accounts every list of people leaves out. Each entry carries its devices with "last seen" and, for a revoked one, the moment it was revoked; no secret is ever returned.',
      }),
      post: op({
        summary: 'Create a wall display',
        tag: 'Displays',
        stateChanging: true,
        // AUSGESCHRIEBEN, NICHT `null`. Ohne Schema laesst `op()` den Rumpf ganz
        // weg: erzeugte Clients haetten kein Argument fuer den Namen, und eine
        // API-Konsole koennte ihn nicht mitgeben - der Aufruf liefe in das 400
        // der Route. Die Prosa allein reicht dafuer nicht.
        requestBody: {
          required: true,
          description: 'JSON request body',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['display_name'],
                properties: {
                  display_name: {
                    type: 'string',
                    maxLength: 128,
                    description: 'What this tablet is called in the settings list, for example "Kitchen".',
                  },
                },
              },
            },
          },
        },
        description: 'Admin only. Body: { display_name }. Creates a new `users` row marked as a display; an existing account can never be turned into one, because that would silently strip a person out of every list and void their password. The account has no usable password from the start, and no device until one is paired.',
      }),
    },
    '/api/v1/displays/pair': {
      post: op({
        summary: 'Exchange a pairing code for a device credential',
        tag: 'Displays',
        // Die einzige Route dieses Moduls OHNE Anmeldung - sie haengt in
        // server/index.js vor `requireAuth`. Ohne `auth: false` traegt der
        // Katalog hier Bearer, API-Key und Cookie ein und verlangt damit von
        // einem frisch aufgehaengten Tablett genau das Credential, das es sich
        // hier erst holt. Dieselbe Angabe wie bei /auth/login.
        auth: false,
        stateChanging: true,
        // Wie beim Anlegen: ohne Schema kein Rumpf im Katalog, und der Code
        // waere genau das Feld, das ein erzeugter Client nicht anbieten kann.
        requestBody: {
          required: true,
          description: 'JSON request body',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code'],
                properties: {
                  code: {
                    type: 'string',
                    description: 'The ten-character pairing code. Spaces and dashes are ignored, so a code read off a screen may be typed with or without grouping.',
                  },
                  label: {
                    type: ['string', 'null'],
                    maxLength: 120,
                    description: 'Optional name for this device, shown beside "last seen" in the settings list.',
                  },
                },
              },
            },
          },
        },
        description: 'The only route a display itself calls, and the only one that needs no authentication - a freshly mounted tablet has nothing to identify itself with yet, the same reason `/auth/login` is public. Body: { code, label? }. The credential is returned **only** as an httpOnly cookie and never in the response body, so no script on the page can read it. A code is valid once, expires after 15 minutes, and is replaced when a newer one is issued for the same display; all three failures answer the same 400, so guessing learns nothing. Rate-limited like the sign-in routes. A successful exchange revokes the display\'s previous device: one display, one tablet.',
      }),
    },
    '/api/v1/displays/{id}': {
      delete: op({
        summary: 'Delete a wall display',
        tag: 'Displays',
        stateChanging: true,
        // OHNE DIESE ZEILE IST DAS DOKUMENT UNGUELTIG: OpenAPI verlangt zu
        // jeder Variablen im Pfad einen Parameter, sonst weisen Validatoren es
        // ab und ein erzeugter Client kann die Id gar nicht mitgeben.
        params: [idParam('id', 'Display ID')],
        description: 'Admin only. Removes the account and, through `ON DELETE CASCADE`, its pairing codes and devices - any paired tablet stops working on its next request.',
      }),
    },
    '/api/v1/displays/{id}/pairing-code': {
      post: op({
        summary: 'Issue a one-time pairing code',
        tag: 'Displays',
        stateChanging: true,
        params: [idParam('id', 'Display ID')],
        requestBody: null,
        description: 'Admin only. Returns a ten-character code in plaintext exactly once, valid for 15 minutes. Issuing a new code spends the previous one immediately: two open codes would be two keys to the same door, and the older one would hang around unnoticed.',
      }),
    },
    '/api/v1/displays/people': {
      get: op({
        summary: 'List the people a paired display may act for',
        tag: 'Displays',
        description: 'For paired displays only; a signed-in person gets 403 and uses GET /api/v1/family/members instead. Returns the household members (#1207) with name, colour and picture, plus `can_tick_off` and `can_redeem`, which say whether that person may write the Tasks module and whether they may write Rewards and take part in them. The contact details that /family/members carries are deliberately absent: a tablet hangs in the open, and a picker needs a face and a name, not a phone number. The two flags follow the same permission resolution the write routes apply, so the picker never offers someone the next call would refuse (#1209).',
      }),
    },
    '/api/v1/displays/{id}/devices/{deviceId}/revoke': {
      post: op({
        summary: 'Revoke a paired device',
        tag: 'Displays',
        stateChanging: true,
        params: [idParam('id', 'Display ID'), idParam('deviceId', 'Device ID')],
        requestBody: null,
        description: 'Admin only. Sets `revoked_at` rather than deleting the row, so a revocation stays provable. Access ends on the device\'s next request - the credential is checked against the database every time, so there is no cached state a revocation would have to catch up with. The device has to belong to the display named in the path.',
      }),
    },
  };
}
