import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHermesProfile } from '../server/services/hermes-profile-cleanup.js';

test('Hermes cleanup is opt-in for upstream installs without Yuvomi integration', async () => {
  assert.deepEqual(await cleanupHermesProfile(7, { env: {}, fetchImpl: () => { throw new Error('must not fetch'); } }), { configured: false });
});

test('Hermes cleanup sends a server-only bearer token to the exact personal profile endpoint', async () => {
  let request;
  const result = await cleanupHermesProfile(42, {
    env: { HERMES_USER_DELETION_URL: 'http://127.0.0.1:3051/api/extensions/hermes/', HERMES_LIFECYCLE_TOKEN: 'secret' },
    fetchImpl: async (url, options) => { request = { url: String(url), options }; return new Response(null, { status: 204 }); },
  });
  assert.deepEqual(result, { configured: true });
  assert.equal(request.url, 'http://127.0.0.1:3051/api/extensions/hermes/internal/users/42/deleted');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
});

test('required cleanup refuses account removal when deployment configuration is absent', async () => {
  await assert.rejects(() => cleanupHermesProfile(7, { env: { HERMES_USER_DELETION_REQUIRED: 'true' } }), /required but not configured/);
});
