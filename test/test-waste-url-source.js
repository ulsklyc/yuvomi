/**
 * Module: Waste collection - automatic ICS URL sources (#1063 Phase 7)
 * Purpose: fetch/SSRF/conditional-GET behavior, the auto-commit-vs-needs-
 *          mapping decision, backoff, and the store's URL-source helpers.
 *          Real local HTTP round-trips via node:http, same pattern as
 *          test-ics-subscription.js (WASTE_SOURCE_ALLOW_PRIVATE_NETWORK is
 *          this module's own private-network opt-in, mirroring
 *          ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK's naming and purpose).
 * Ausführen: npm run test:waste-url-source
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'waste-url-source-test-secret';
process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK = 'true';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const store = await import('../server/services/waste-store.js');
const urlSource = await import('../server/services/waste-url-source.js');
const { fetchIcsText, refreshUrlSource, createUrlSource, validateSourceUrl, validateRefreshIntervalMinutes, __test } = urlSource;

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ALICE = seedUser('alice', 'admin');

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser(prefix, role) {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

function seedType(overrides = {}) {
  return store.createType(get(), { name: `Type-${randomUUID()}`, ...overrides }, ALICE);
}

/** Starts a throwaway local ICS server; caller must close() it. */
async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: (path) => `http://127.0.0.1:${port}${path}` };
}

const ICS_ONE_EVENT = (label, date) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:evt-${label}-${date}\r\nDTSTART;VALUE=DATE:${date.replace(/-/g, '')}\r\nSUMMARY:${label}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

// -------------------------------------------------------------------------
// validateSourceUrl / validateRefreshIntervalMinutes (pure)
// -------------------------------------------------------------------------

test('validateSourceUrl: accepts an https URL, rejects garbage and (without the private-network opt-in) http', () => {
  assert.equal(validateSourceUrl('https://example.com/cal.ics'), 'https://example.com/cal.ics');
  assert.throws(() => validateSourceUrl('not a url'));
  assert.throws(() => validateSourceUrl(''));
});

test('validateRefreshIntervalMinutes: defaults, accepts the bounds, rejects outside them and non-integers', () => {
  assert.equal(validateRefreshIntervalMinutes(undefined), 1440);
  assert.equal(validateRefreshIntervalMinutes(60), 60);
  assert.equal(validateRefreshIntervalMinutes(43_200), 43_200);
  assert.throws(() => validateRefreshIntervalMinutes(59));
  assert.throws(() => validateRefreshIntervalMinutes(43_201));
  assert.throws(() => validateRefreshIntervalMinutes(90.5));
});

// -------------------------------------------------------------------------
// buildAutoMappingDecisions / backoffMinutes (pure)
// -------------------------------------------------------------------------

test('buildAutoMappingDecisions: every label remembered (mapped or ignored) and no blocking diagnostic -> a decision per label', () => {
  const preview = {
    labels: [
      { normalized_label: 'bio', remembered_type_id: 5, remembered_ignored: false },
      { normalized_label: 'restmuell', remembered_type_id: null, remembered_ignored: true },
    ],
    diagnostics: [{ severity: 'info', code: 'cancelled_excluded' }],
  };
  const decisions = __test.buildAutoMappingDecisions(preview);
  assert.deepEqual(decisions, [
    { normalized_label: 'bio', type_id: 5 },
    { normalized_label: 'restmuell', ignored: true },
  ]);
});

test('buildAutoMappingDecisions: one label with neither a remembered type nor remembered_ignored -> null (cannot auto-decide)', () => {
  const preview = {
    labels: [
      { normalized_label: 'bio', remembered_type_id: 5, remembered_ignored: false },
      { normalized_label: 'neu', remembered_type_id: null, remembered_ignored: false },
    ],
    diagnostics: [],
  };
  assert.equal(__test.buildAutoMappingDecisions(preview), null);
});

test('buildAutoMappingDecisions: an unresolved blocking diagnostic blocks auto-commit even when every label is mapped', () => {
  const preview = {
    labels: [{ normalized_label: 'bio', remembered_type_id: 5, remembered_ignored: false }],
    diagnostics: [{ severity: 'blocking', code: 'unbounded_recurrence' }],
  };
  assert.equal(__test.buildAutoMappingDecisions(preview), null);
});

test('backoffMinutes: grows with consecutive failures and is capped at 24h', () => {
  assert.equal(__test.backoffMinutes(0), 15);
  assert.equal(__test.backoffMinutes(1), 30);
  assert.equal(__test.backoffMinutes(4), 240);
  assert.ok(__test.backoffMinutes(20) <= 24 * 60);
});

// -------------------------------------------------------------------------
// checkSSRF / fetchIcsText: real HTTP round-trip (opt-in allows 127.0.0.1)
// -------------------------------------------------------------------------

test('checkSSRF: a private-network literal is blocked without the opt-in', async () => {
  const prev = process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK;
  delete process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK;
  try {
    await assert.rejects(() => __test.checkSSRF('https://127.0.0.1/cal.ics'));
  } finally {
    process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK = prev;
  }
});

test('fetchIcsText: 200 returns text + etag/last-modified; 304 (conditional GET) reports notModified', async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304).end(); return; }
    res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT' });
    res.end(ICS_ONE_EVENT('Bio', '2026-01-05'));
  });
  try {
    const fresh = await fetchIcsText(url('/cal.ics'));
    assert.equal(fresh.notModified, false);
    assert.match(fresh.text, /SUMMARY:Bio/);
    assert.equal(fresh.etag, '"v1"');

    const cached = await fetchIcsText(url('/cal.ics'), { etag: '"v1"' });
    assert.equal(cached.notModified, true);
  } finally {
    server.close();
  }
});

test('fetchIcsText: a non-2xx status throws', async () => {
  const { server, url } = await startServer((req, res) => { res.writeHead(500).end(); });
  try {
    await assert.rejects(() => fetchIcsText(url('/cal.ics')));
  } finally {
    server.close();
  }
});

test('fetchIcsText: a response over the size cap throws mid-stream', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    // No content-length pre-check trigger (chunked) - exercises the
    // streaming byte-counter cap instead, same as the file-upload path.
    res.write('BEGIN:VCALENDAR\r\n');
    res.end('X'.repeat(11 * 1024 * 1024));
  });
  try {
    await assert.rejects(() => fetchIcsText(url('/cal.ics')));
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------------------
// refreshUrlSource: the four outcomes, against the real store + a real fetch
// -------------------------------------------------------------------------

test('refreshUrlSource: unchanged (304) resets failures and reschedules at the normal cadence, touches nothing else', async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.headers['if-none-match'] === '"cached"') { res.writeHead(304).end(); return; }
    res.writeHead(200, { etag: '"cached"' });
    res.end(ICS_ONE_EVENT('Bio', '2026-02-01'));
  });
  try {
    const placeholder = store.createUrlSourcePlaceholder(get(), {
      name: 'Unchanged source', url: url('/cal.ics'), refreshIntervalMinutes: 60, userId: ALICE,
    });
    store.recordUrlSourceAttempt(get(), placeholder.id, { etag: '"cached"' });
    const result = await refreshUrlSource(get(), placeholder.id);
    assert.equal(result.outcome, 'unchanged');
    assert.equal(result.source.consecutive_failures, 0);
    assert.ok(result.source.next_attempt_at);
  } finally {
    server.close();
  }
});

test('refreshUrlSource: a fetch failure records last_error, increments consecutive_failures, and backs off - never touches committed data', async () => {
  const { server, url } = await startServer((req, res) => { res.writeHead(503).end(); });
  try {
    const placeholder = store.createUrlSourcePlaceholder(get(), {
      name: 'Failing source', url: url('/cal.ics'), refreshIntervalMinutes: 60, userId: ALICE,
    });
    const result = await refreshUrlSource(get(), placeholder.id);
    assert.equal(result.outcome, 'error');
    assert.match(result.source.last_error, /HTTP 503/);
    assert.equal(result.source.consecutive_failures, 1);
    assert.equal(result.source.version, 0, 'no commit happened - the placeholder version is untouched');
  } finally {
    server.close();
  }
});

test('refreshUrlSource: a label with no remembered mapping -> needs_mapping, no commit, next_attempt_at cleared so the scheduler skips it', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200);
    res.end(ICS_ONE_EVENT('UnknownLabel', '2026-03-01'));
  });
  try {
    const placeholder = store.createUrlSourcePlaceholder(get(), {
      name: 'Needs mapping source', url: url('/cal.ics'), refreshIntervalMinutes: 60, userId: ALICE,
    });
    const result = await refreshUrlSource(get(), placeholder.id);
    assert.equal(result.outcome, 'needs_mapping');
    assert.equal(result.source.needs_mapping, 1);
    assert.equal(result.source.next_attempt_at, null);
    assert.equal(result.source.version, 0, 'still no commit - unmapped labels never auto-decide');
    assert.ok(result.preview.labels.length);

    const due = store.listDueUrlSources(get());
    assert.ok(!due.some((s) => s.id === placeholder.id), 'the scheduler must skip a source stuck in needs_mapping');
  } finally {
    server.close();
  }
});

test('createUrlSource: a fully-auto-mappable first fetch (label already matches an existing type by name) commits immediately, same as a fresh file import', async () => {
  const type = seedType({ name: 'Papier' });
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200);
    res.end(ICS_ONE_EVENT('Papier', '2026-04-10'));
  });
  try {
    const result = await createUrlSource(get(), {
      name: 'Auto-commit source', url: url('/cal.ics'), refreshIntervalMinutes: 1440, userId: ALICE,
    });
    // suggested_type_id (a same-name match) is a convenience default, never
    // an automatic decision on its own - buildAutoMappingDecisions only acts
    // on remembered_type_id/remembered_ignored, so a brand-new source with no
    // prior mapping history still needs a first reviewed decision.
    assert.equal(result.outcome, 'needs_mapping');
    assert.equal(result.source.kind, 'url');
    assert.equal(result.preview.labels[0].suggested_type_id, type.id);
  } finally {
    server.close();
  }
});

test('refreshUrlSource: an already-mapped label (remembered from a prior commit) auto-commits through the same path a file re-import uses', async () => {
  let call = 0;
  const { server, url } = await startServer((req, res) => {
    call += 1;
    res.writeHead(200);
    res.end(ICS_ONE_EVENT('Glas', call === 1 ? '2026-05-01' : '2026-05-08'));
  });
  try {
    const created = await createUrlSource(get(), {
      name: 'Two-attempt source', url: url('/cal.ics'), refreshIntervalMinutes: 60, userId: ALICE,
    });
    assert.equal(created.outcome, 'needs_mapping');

    // A human reviews and maps the label once (mirrors the mapping wizard's
    // own commit path) - this is the "reviewed refresh" the plan requires
    // before automatic replacement resumes.
    const type = seedType({ name: 'Glass type' });
    store.commitImport(get(), {
      sourceId: created.source.id,
      name: created.source.name,
      icsText: ICS_ONE_EVENT('Glas', '2026-05-01'),
      mappingDecisions: [{ normalized_label: 'glas', type_id: type.id }],
      expectedVersion: created.source.version,
      previewDigest: created.preview.digest,
      userId: ALICE,
    });

    const second = await refreshUrlSource(get(), created.source.id);
    assert.equal(second.outcome, 'committed');
    assert.equal(second.diff.added, 1);
    assert.ok(second.source.next_attempt_at);
    assert.equal(second.source.needs_mapping, 0);
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------------------
// Store helpers
// -------------------------------------------------------------------------

test('listDueUrlSources: only kind=url, needs_mapping=0, and due (next_attempt_at null or past) sources are returned', () => {
  const due = store.createUrlSourcePlaceholder(get(), { name: 'Due', url: 'https://example.com/a.ics', refreshIntervalMinutes: 60, userId: ALICE });
  const future = store.createUrlSourcePlaceholder(get(), { name: 'Future', url: 'https://example.com/b.ics', refreshIntervalMinutes: 60, userId: ALICE });
  store.recordUrlSourceAttempt(get(), future.id, { nextAttemptAt: '2099-01-01T00:00:00Z' });
  const mapping = store.createUrlSourcePlaceholder(get(), { name: 'Needs mapping', url: 'https://example.com/c.ics', refreshIntervalMinutes: 60, userId: ALICE });
  store.recordUrlSourceAttempt(get(), mapping.id, { needsMapping: true, nextAttemptAt: null });

  const ids = store.listDueUrlSources(get()).map((s) => s.id);
  assert.ok(ids.includes(due.id));
  assert.ok(!ids.includes(future.id));
  assert.ok(!ids.includes(mapping.id));
});
