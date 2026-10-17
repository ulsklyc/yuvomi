import { op } from '../helpers.js';

export function emailPaths() {
  return {
    '/api/v1/email/config': {
      get: op({
        summary: 'Get SMTP email configuration (password masked)',
        tag: 'Email',
        admin: true,
      }),
      put: op({
        summary: 'Update SMTP email configuration',
        tag: 'Email',
        description: 'Nothing is stored when a value is refused: a `port` outside 1 to 65535 is a 400 with `reason: email_port_invalid`, a non-empty `fromAddress` that is not one address with a single @ is a 400 with `reason: email_from_invalid`.',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  host: { type: 'string' },
                  port: { type: 'integer', minimum: 1, maximum: 65535 },
                  secure: { type: 'string', enum: ['ssl', 'starttls', 'none'] },
                  user: { type: 'string' },
                  pass: { type: 'string', description: 'Write-only. Omit to keep the stored password.' },
                  clearPassword: { type: 'boolean' },
                  fromAddress: { type: 'string' },
                  fromName: { type: 'string' },
                },
              },
            },
          },
        },
      }),
    },
    '/api/v1/email/test': {
      post: op({
        summary: 'Send a test email to validate SMTP settings',
        tag: 'Email',
        description: 'Answers 200 with `data.ok`. A failed test carries `data.reason` (`not_configured`, `auth`, `connection`, `tls`, `rejected` or `unknown`) next to the server message in `data.error`. Without a recipient (no `to` and no e-mail address on the account) the answer is a 400 with `reason: email_no_recipient`.',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { to: { type: 'string', description: 'Optional recipient override; defaults to the admin\'s linked email.' } },
              },
            },
          },
        },
      }),
    },
  };
}
