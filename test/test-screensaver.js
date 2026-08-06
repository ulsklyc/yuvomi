import test from 'node:test';
import assert from 'node:assert/strict';

// server/db.js initializes on import; select an isolated database before the
// dynamic route import so this suite can never touch a developer installation.
process.env.DB_PATH = ':memory:';
const { __test } = await import('../server/routes/screensaver.js');

test('Immich URL accepts server roots and URLs ending in /api', () => {
  assert.equal(__test.immichUrl('https://photos.example', '/search/random'), 'https://photos.example/api/search/random');
  assert.equal(__test.immichUrl('https://photos.example/api', '/search/random'), 'https://photos.example/api/search/random');
});

test('screensaver is disabled unless URL and API key are both configured', () => {
  const previousUrl = process.env.IMMICH_URL;
  const previousKey = process.env.IMMICH_API_KEY;
  try {
    delete process.env.IMMICH_URL;
    delete process.env.IMMICH_API_KEY;
    assert.equal(__test.config().enabled, false);
    process.env.IMMICH_URL = 'https://photos.example';
    assert.equal(__test.config().enabled, false);
    process.env.IMMICH_API_KEY = 'secret';
    assert.equal(__test.config().enabled, true);
  } finally {
    if (previousUrl === undefined) delete process.env.IMMICH_URL; else process.env.IMMICH_URL = previousUrl;
    if (previousKey === undefined) delete process.env.IMMICH_API_KEY; else process.env.IMMICH_API_KEY = previousKey;
  }
});
