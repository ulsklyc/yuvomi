/**
 * Tests: Live changelog parser/proxy.
 * Ausführen: node --test test/test-changelog.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import changelogRouter, { buildRouter, __test } from '../server/routes/changelog.js';

test('parseReleaseBody keeps release sections and removes GitHub noise', () => {
  const sections = __test.parseReleaseBody(`
## Added
- New dashboard changelog modal ([#455](https://github.com/ulsklyc/yuvomi/pull/455))
- Internal commit 9f4a12bc should not leak

## Fixed
- Better widget sizing

Full Changelog: https://github.com/ulsklyc/yuvomi/compare/v1.0.0...v1.1.0
Assets
`);

  assert.deepEqual(sections, [
    {
      title: 'Added',
      items: [
        'New dashboard changelog modal (#455)',
        'Internal commit should not leak',
      ],
    },
    {
      title: 'Fixed',
      items: ['Better widget sizing'],
    },
  ]);
});

test('buildChangelogPayload marks current version when it appears in releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v1.2.2', body: '- Newest release', html_url: 'https://example.test/latest' },
    { tag_name: 'v1.2.1', body: '- Current release', html_url: 'https://example.test/current' },
  ], '1.2.1');

  assert.equal(payload.current_version, '1.2.1');
  assert.equal(payload.latest_version, 'v1.2.2');
  assert.equal(payload.current_in_releases, true);
  assert.equal(payload.releases.length, 2);
});

test('buildChangelogPayload reports current version missing from releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v0.88.1', body: '- Public release notes' },
  ], '1.2.1');

  assert.equal(payload.latest_version, 'v0.88.1');
  assert.equal(payload.current_in_releases, false);
});

test('changelog router fetches and sanitizes GitHub release JSON', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async (url, options) => {
      assert.match(url, /api\.github\.com\/repos\/ulsklyc\/yuvomi\/releases/);
      assert.equal(options.headers.Accept, 'application/vnd.github+json');
      return {
        ok: true,
        json: async () => [
          {
            tag_name: 'v1.2.1',
            body: '## Added\n- Live changelog\n\nFull Changelog: https://example.test',
            html_url: 'https://github.com/ulsklyc/yuvomi/releases/tag/v1.2.1',
          },
        ],
      };
    },
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.current_in_releases, true);
    assert.equal(body.data.releases[0].sections[0].items[0], 'Live changelog');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('default changelog router is an express router', () => {
  assert.equal(typeof changelogRouter, 'function');
});
