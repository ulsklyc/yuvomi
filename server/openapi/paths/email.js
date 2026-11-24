import { op, withValidationRefusal } from '../helpers.js';

export function emailPaths() {
  return {
    '/api/v1/email/config': {
      get: op({
        summary: 'Get SMTP email configuration (password masked)',
        tag: 'Email',
        admin: true,
      }),
      put: withValidationRefusal(op({
        summary: 'Update SMTP email configuration',
        tag: 'Email',
        description: 'Nothing is stored when a value is refused: a `port` that is not a whole number from 1 to 65535 (text, a list or `""` included) is a 400 with `reason: email_port_invalid`, a `fromAddress` that is neither text nor null, or a non-empty one that is not one address with a single @, is a 400 with `reason: email_from_invalid`. A field left out keeps its stored value; a field the server takes from its environment is not stored.',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  host: { type: ['string', 'null'], description: 'null clears it.' },
                  port: {
                    type: ['integer', 'null'],
                    minimum: 1,
                    maximum: 65535,
                    'x-reason': 'email_port_invalid',
                    description: 'A whole number from 1 to 65535, or null to clear it.',
                  },
                  secure: { type: 'string', enum: ['ssl', 'starttls', 'none'] },
                  user: { type: ['string', 'null'], description: 'null clears it.' },
                  pass: { type: 'string', description: 'Write-only. Omit it, or send "", to keep the stored password.' },
                  clearPassword: { type: 'boolean', description: '`true` clears the stored password when no `pass` is sent.' },
                  fromAddress: {
                    type: ['string', 'null'],
                    'x-reason': { type: 'email_from_invalid' },
                    description: 'Empty, or one address with a single @ (checked after trimming). null clears it.',
                  },
                  fromName: { type: ['string', 'null'], description: 'null clears it.' },
                },
              },
            },
          },
        },
      })),
    },
    '/api/v1/email/test': {
      post: withValidationRefusal(op({
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
      })),
    },
  };
}
