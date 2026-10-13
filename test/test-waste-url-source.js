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
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'waste-url-source-test-secret';
process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK = 'true';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const store = await import('../server/services/waste-store.js');
const urlSource = await import('../server/services/waste-url-source.js');
const { fetchIcsText, refreshUrlSource, createUrlSource, validateSourceUrl, validateRefreshIntervalMinutes, __test } = urlSource;
const { default: wasteRouter } = await import('../server/routes/waste/index.js');
const { runDueWasteSourceRefreshes } = await import('../server/services/waste-source-scheduler.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ALICE = seedUser('alice', 'admin');

// A real Express app with the actual waste router mounted, exactly like
// test-waste-routes.js - needed for the reimport/preview + reimport/commit
// route-level test below, which reproduces a bug the store-level tests above
// cannot: the ROUTE (not refreshUrlSource) fetches the URL independently for
// preview and for commit, so it is the one place two real, separate fetches
// of the same source happen back to back.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = ALICE;
  req.session = { userId: ALICE, role: 'admin' };
  next();
});
app.use('/api/v1/waste', wasteRouter);
const apiServer = http.createServer(app);
await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
const apiOrigin = `http://127.0.0.1:${apiServer.address().port}/api/v1`;

async function apiCall(method, path, { body } = {}) {
  const res = await fetch(`${apiOrigin}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test.after(() => { suiteDatabase.close(); apiServer.close(); });

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
// #1909: the class of a failed fetch, one reason each
// -------------------------------------------------------------------------

test('classifyFetchFailure: what fetchIcsText really throws, by class - never by the wording of the message', async () => {
  const { classifyFetchFailure, WasteFetchError } = urlSource;
  const { createGuardedLookup, BlockedAddressError } = await import('../server/utils/ssrf.js');
  const { safeRequest } = await import('../server/utils/http.js');
  const { MAX_ICS_BYTES } = await import('../server/services/waste-import.js');
  const limitMb = Math.round(MAX_ICS_BYTES / (1024 * 1024));
  const thrownBy = async (run) => { try { await run(); } catch (err) { return err; } return null; };

  // The status of the other side, and a body over the limit.
  const { server, url } = await startServer((req, res) => {
    if (req.url === '/gone') { res.writeHead(410).end(); return; }
    res.writeHead(200); res.end('X'.repeat(MAX_ICS_BYTES + 10));
  });
  try {
    const status = await thrownBy(() => fetchIcsText(url('/gone')));
    assert.ok(status instanceof WasteFetchError);
    assert.equal(status.message, 'HTTP 410', 'the message last_error stores is unchanged');
    assert.deepEqual(classifyFetchFailure(status), { reason: 'waste_source_fetch_http_status', params: { status: 410 } });

    const large = await thrownBy(() => fetchIcsText(url('/big')));
    assert.match(large.message, /^ICS file exceeds the \d+ MB limit\.$/);
    assert.deepEqual(classifyFetchFailure(large), { reason: 'waste_source_fetch_too_large', params: { limit_mb: limitMb } });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }

  // A port nothing listens on: Node's own error, the remainder class.
  const probe = await startServer(() => {});
  const deadUrl = probe.url('/cal.ics');
  await new Promise((r) => probe.server.close(r));
  const refused = await thrownBy(() => fetchIcsText(deadUrl));
  assert.equal(refused.code, 'ECONNREFUSED');
  assert.deepEqual(classifyFetchFailure(refused), { reason: 'waste_source_fetch_unreachable' });
  // A timeout is the same class (the abort of the 15 s timer).
  assert.deepEqual(classifyFetchFailure(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
    { reason: 'waste_source_fetch_unreachable' });

  // A blocked address, from both places that refuse one: the pre-check on a
  // literal, and the lookup at connect time (a name that resolves privately -
  // the DNS answer is injected, nothing leaves this process).
  const prev = process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK;
  delete process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK;
  try {
    const literal = await thrownBy(() => fetchIcsText('https://127.0.0.1/cal.ics'));
    assert.ok(literal instanceof BlockedAddressError);
    assert.equal(literal.message, 'URL resolves to a private IP address: 127.0.0.1');
    assert.deepEqual(classifyFetchFailure(literal), { reason: 'waste_source_fetch_blocked' });

    // The stored address no longer passes validation: its own reason.
    const plain = await thrownBy(() => fetchIcsText('http://example.org/cal.ics'));
    assert.deepEqual(classifyFetchFailure(plain), { reason: 'waste_source_url_not_https' });
  } finally {
    process.env.WASTE_SOURCE_ALLOW_PRIVATE_NETWORK = prev;
  }
  const lookup = createGuardedLookup({ lookup: (_host, _opts, cb) => cb(null, [{ address: '10.0.0.7', family: 4 }]) });
  const rebound = await thrownBy(() => safeRequest('http://rebound.test/cal.ics', { lookup }));
  assert.ok(rebound instanceof BlockedAddressError, `the lookup's own error reaches the caller unwrapped: ${rebound}`);
  assert.deepEqual(classifyFetchFailure(rebound), { reason: 'waste_source_fetch_blocked' });

  // A message that merely SOUNDS like a class is not that class.
  assert.deepEqual(classifyFetchFailure(new Error('HTTP 404')), { reason: 'waste_source_fetch_unreachable' });
  assert.deepEqual(classifyFetchFailure(new Error('URL resolves to a private IP address: 10.0.0.1')), { reason: 'waste_source_fetch_unreachable' });
});

test('refreshUrlSource and createUrlSource: a failed fetch names its class in the answer, a fetch that worked names none', async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.url === '/ok.ics') { res.writeHead(304).end(); return; }
    res.writeHead(404).end();
  });
  try {
    const failing = store.createUrlSourcePlaceholder(get(), { name: 'Gone feed', url: url('/cal.ics'), refreshIntervalMinutes: 60, userId: ALICE });
    const failed = await refreshUrlSource(get(), failing.id);
    assert.equal(failed.outcome, 'error');
    assert.equal(failed.reason, 'waste_source_fetch_http_status');
    assert.deepEqual(failed.params, { status: 404 });
    assert.equal(failed.source.last_error, 'HTTP 404');
    assert.equal('reason' in store.getSource(get(), failing.id), false, 'the class is not stored with the source');

    const created = await createUrlSource(get(), { name: 'Gone on create', url: url('/cal.ics'), refreshIntervalMinutes: 60, userId: ALICE });
    assert.equal(created.outcome, 'error');
    assert.equal(created.reason, 'waste_source_fetch_http_status');

    const fine = store.createUrlSourcePlaceholder(get(), { name: 'Unchanged feed', url: url('/ok.ics'), refreshIntervalMinutes: 60, userId: ALICE });
    const unchanged = await refreshUrlSource(get(), fine.id);
    assert.equal(unchanged.outcome, 'unchanged');
    assert.equal('reason' in unchanged, false);
    assert.equal('params' in unchanged, false);
  } finally {
    server.close();
  }
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

test('fetchIcsText: a multi-byte UTF-8 character split across a chunk boundary decodes correctly, not as two replacement characters', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    // "ü" (U+00FC) is the two bytes 0xC3 0xBC in UTF-8 - split them across two
    // separate writes/chunks on purpose, with a flush and a short delay
    // between them so they arrive as genuinely separate reads on the client
    // side, not coalesced into one by the transport.
    const prefix = Buffer.from('BEGIN:VCALENDAR\r\nSUMMARY:Gr', 'utf8');
    const split = Buffer.from([0xC3]); // first byte of "ü"
    const rest = Buffer.concat([Buffer.from([0xBC]), Buffer.from('nschnitt\r\nEND:VCALENDAR\r\n', 'utf8')]);
    res.write(prefix);
    res.write(split);
    res.flushHeaders?.();
    setTimeout(() => res.end(rest), 20);
  });
  try {
    const result = await fetchIcsText(url('/cal.ics'));
    assert.match(result.text, /SUMMARY:Grünschnitt/,
      `expected the split "ü" to decode correctly, got: ${JSON.stringify(result.text)}`);
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
// Route-level reimport/preview + reimport/commit: the actual bug the
// store-level "two-attempt" test above cannot see, because it commits
// through store.commitImport with the FIRST fetch's own text directly. The
// real HTTP route re-fetches the URL independently for preview and again for
// commit - two genuinely separate network round-trips of the same feed.
// -------------------------------------------------------------------------

test('reimport/preview then reimport/commit against a URL source: a feed that returns byte-different-but-semantically-identical content on each fetch (e.g. a per-request DTSTAMP) still commits, not stuck in a 409 loop', async () => {
  const type = seedType({ name: 'Papier' });
  let call = 0;
  const { server, url } = await startServer((req, res) => {
    call += 1;
    res.writeHead(200);
    // Same event/label/date every time; only a request-time DTSTAMP differs,
    // exactly the shape the review flagged (a live feed's bytes are rarely
    // byte-identical across two fetches even when nothing meaningful changed).
    // Full SECONDS apart (not milliseconds): the DTSTAMP format truncates
    // sub-second precision (`.split('.')[0]`), so two fetches inside the same
    // wall-clock second produced byte-IDENTICAL text despite the `+call` ms
    // offset - which meant this test stayed green even with the old raw-byte
    // digest reinstated (round 2 of the review caught this exact gap: 20/20
    // either way). `call * 1000` guarantees a real second-level difference
    // between the preview fetch and the commit's own re-fetch, regardless of
    // how fast the two run.
    res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nDTSTAMP:${new Date(Date.now() + call * 1000).toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\nBEGIN:VEVENT\r\nUID:evt-papier\r\nDTSTART;VALUE=DATE:20260410\r\nSUMMARY:Papier\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  });
  try {
    const created = await createUrlSource(get(), {
      name: 'Volatile-bytes source', url: url('/cal.ics'), refreshIntervalMinutes: 1440, userId: ALICE,
    });
    assert.equal(created.outcome, 'needs_mapping', 'no remembered mapping yet - needs a first reviewed decision');

    const preview = await apiCall('POST', `/waste/sources/${created.source.id}/reimport/preview`, { body: {} });
    assert.equal(preview.status, 200);

    const commit = await apiCall('POST', `/waste/sources/${created.source.id}/reimport/commit`, {
      body: {
        mappings: [{ normalized_label: 'papier', type_id: type.id }],
        preview_digest: preview.body.data.digest,
        expected_version: preview.body.data.expected_version,
      },
    });
    assert.equal(commit.status, 200, `expected the commit to succeed despite the byte-different refetch, got ${JSON.stringify(commit.body)}`);
    assert.equal(commit.body.data.diff.added, 1);

    const sourceAfter = await apiCall('GET', `/waste/sources/${created.source.id}`);
    assert.equal(sourceAfter.body.data.needs_mapping, 0);
    assert.equal(sourceAfter.body.data.version, 1);
  } finally {
    server.close();
  }
});

test('reimport/preview then reimport/commit against a URL source: content that genuinely changed between the two fetches (a different pickup date) is still refused with 409', async () => {
  const type = seedType({ name: 'Glas' });
  let call = 0;
  const { server, url } = await startServer((req, res) => {
    call += 1;
    res.writeHead(200);
    // Every fetch returns a genuinely different pickup date (not just an
    // incidental byte) - the guard must still catch this regardless of how
    // many prior fetches happened (createUrlSource's own initial fetch is
    // call 1, so the preview/commit calls below must still differ from
    // EACH OTHER, not just from call 1).
    const date = `202604${String(10 + call).padStart(2, '0')}`;
    res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:evt-glas\r\nDTSTART;VALUE=DATE:${date}\r\nSUMMARY:Glas\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  });
  try {
    const created = await createUrlSource(get(), {
      name: 'Genuinely-changing source', url: url('/cal.ics'), refreshIntervalMinutes: 1440, userId: ALICE,
    });
    assert.equal(created.outcome, 'needs_mapping');

    const preview = await apiCall('POST', `/waste/sources/${created.source.id}/reimport/preview`, { body: {} });
    assert.equal(preview.status, 200);

    const commit = await apiCall('POST', `/waste/sources/${created.source.id}/reimport/commit`, {
      body: {
        mappings: [{ normalized_label: 'glas', type_id: type.id }],
        preview_digest: preview.body.data.digest,
        expected_version: preview.body.data.expected_version,
      },
    });
    assert.equal(commit.status, 409, 'a real content change between preview and commit must still be refused');
    assert.equal(commit.body.reason, 'preview_changed', 'the refusal names its reason, so the client can say it in the household language');
  } finally {
    server.close();
  }
});

// #1795: limburg.net stamps every VEVENT with a fresh UID on EVERY request (a
// PHP uniqid(), measured: two fetches three seconds apart shared no UID at
// all), next to the request-time DTSTAMP the test above already covers. The
// pickups themselves - which type on which day - are the same every time.
function volatileUidFeed() {
  let call = 0;
  const pickups = [['Huisvuil', '20260113'], ['Pmd', '20260113'], ['Huisvuil', '20260127']];
  return (req, res) => {
    call += 1;
    const stamp = `${new Date(Date.UTC(2026, 9, 8, 12, 0, call)).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
    const events = pickups.map(([label, date], index) => (
      `BEGIN:VEVENT\r\nUID:6ac76c${call}${index}ee0f\r\nDTSTART;VALUE=DATE:${date}\r\nSEQUENCE:0\r\nSUMMARY:${label}\r\nDTSTAMP:${stamp}\r\nEND:VEVENT\r\n`
    )).join('');
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
    res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:www.limburg.net\r\n${events}END:VCALENDAR\r\n`);
  };
}

test('#1795 reimport/preview then reimport/commit: a feed that mints a new UID for every event on every request still commits', async () => {
  const huisvuil = seedType({ name: 'Huisvuil' });
  const pmd = seedType({ name: 'Pmd' });
  const { server, url } = await startServer(volatileUidFeed());
  try {
    const created = await createUrlSource(get(), {
      name: 'Volatile-UID source', url: url('/cal.ics?toevoeging=&eventTypes[]=14&eventTypes[]=22'), refreshIntervalMinutes: 1440, userId: ALICE,
    });
    assert.equal(created.outcome, 'needs_mapping');

    const preview = await apiCall('POST', `/waste/sources/${created.source.id}/reimport/preview`, { body: {} });
    assert.equal(preview.status, 200);

    const commit = await apiCall('POST', `/waste/sources/${created.source.id}/reimport/commit`, {
      body: {
        mappings: [
          { normalized_label: 'huisvuil', type_id: huisvuil.id },
          { normalized_label: 'pmd', type_id: pmd.id },
        ],
        preview_digest: preview.body.data.digest,
        expected_version: preview.body.data.expected_version,
      },
    });
    assert.equal(commit.status, 200, `the reviewer saw exactly these pickups, got ${JSON.stringify(commit.body)}`);
    assert.equal(commit.body.data.diff.added, 3);
  } finally {
    server.close();
  }
});

test('#1795 refresh: the same pickups under new UIDs are the same pickups - nothing added, nothing removed, the rows stay', async () => {
  const huisvuil = seedType({ name: 'Huisvuil' });
  const pmd = seedType({ name: 'Pmd' });
  const { server, url } = await startServer(volatileUidFeed());
  try {
    const created = await createUrlSource(get(), {
      name: 'Volatile-UID refresh source', url: url('/cal.ics'), refreshIntervalMinutes: 1440, userId: ALICE,
    });
    // The reviewed first commit, on the text of its own fetch (the route-level
    // way through two fetches is the test above).
    store.commitImport(get(), {
      sourceId: created.source.id,
      name: created.source.name,
      icsText: await (await fetch(url('/cal.ics'))).text(),
      mappingDecisions: [
        { normalized_label: 'huisvuil', type_id: huisvuil.id },
        { normalized_label: 'pmd', type_id: pmd.id },
      ],
      expectedVersion: created.source.version,
      previewDigest: created.preview.digest,
      userId: ALICE,
    });
    const rows = () => get().prepare('SELECT id, type_id, date_key, identity_key FROM waste_imported_pickups WHERE source_id = ? ORDER BY id').all(created.source.id);
    const before = rows();
    assert.equal(before.length, 3);

    const refreshed = await apiCall('POST', `/waste/sources/${created.source.id}/refresh`, { body: {} });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.data.outcome, 'committed');
    assert.deepEqual(
      { added: refreshed.body.data.diff.added, changed: refreshed.body.data.diff.changed, removed: refreshed.body.data.diff.removed },
      { added: 0, changed: 0, removed: 0 },
      'a refresh that brings the same pickups must not report a full turnover',
    );
    const after = rows();
    assert.deepEqual(after.map((r) => [r.id, r.type_id, r.date_key]), before.map((r) => [r.id, r.type_id, r.date_key]));
    assert.ok(after.every((r, i) => r.identity_key !== before[i].identity_key), 'each row follows the UID the feed uses now, so the next refresh with stable UIDs matches by identity again');
  } finally {
    server.close();
  }
});

/**
 * A feed for the pairing tests below: `feeds(call)` returns the `[summary, yyyymmdd]`
 * pairs of that request, and every request gets UIDs of its own.
 */
function feedPerCall(feeds) {
  let call = 0;
  return (req, res) => {
    call += 1;
    const events = feeds(call).map(([summary, date], index) => (
      `BEGIN:VEVENT\r\nUID:pair${call}x${index}\r\nDTSTART;VALUE=DATE:${date}\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\n`
    )).join('');
    res.writeHead(200);
    res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n`);
  };
}

/** Creates a URL source (fetch 1) and applies the reviewed first commit on a fetch of its own (fetch 2). */
async function createAndCommit(url, name, mappingDecisions) {
  const created = await createUrlSource(get(), { name, url, refreshIntervalMinutes: 1440, userId: ALICE });
  assert.equal(created.outcome, 'needs_mapping');
  store.commitImport(get(), {
    sourceId: created.source.id,
    name,
    icsText: await (await fetch(url)).text(),
    mappingDecisions,
    expectedVersion: created.source.version,
    previewDigest: created.preview.digest,
    userId: ALICE,
  });
  return created.source.id;
}

function pickupRows(sourceId) {
  return get().prepare('SELECT id, type_id, date_key, original_summary FROM waste_imported_pickups WHERE source_id = ? ORDER BY id').all(sourceId);
}

test('#1795 refresh: a row of ANOTHER type on the same day is no partner - it is removed and the new type added', async () => {
  const huisvuil = seedType({ name: 'Huisvuil' });
  const pmd = seedType({ name: 'Pmd' });
  const gft = seedType({ name: 'Gft' });
  // Fetches 1 and 2: Huisvuil + Pmd on 13 Jan. Fetch 3 maps the new label,
  // fetch 4 (the refresh) brings Huisvuil + Gft on 13 Jan.
  const { server, url } = await startServer(feedPerCall((call) => (
    call <= 2 ? [['Huisvuil', '20260113'], ['Pmd', '20260113']] : [['Huisvuil', '20260113'], ['Gft', '20260113']]
  )));
  try {
    const sourceId = await createAndCommit(url('/cal.ics'), 'Type-half source', [
      { normalized_label: 'huisvuil', type_id: huisvuil.id },
      { normalized_label: 'pmd', type_id: pmd.id },
    ]);
    const before = pickupRows(sourceId);
    const pmdRow = before.find((r) => r.type_id === pmd.id);
    const huisvuilRow = before.find((r) => r.type_id === huisvuil.id);
    // "Gft" is a label this source has no decision for yet - remember one, the
    // way the mapping sheet of a source does, so the refresh may auto-commit.
    get().prepare('INSERT INTO waste_source_mappings (source_id, original_label, normalized_label, type_id, ignored) VALUES (?, ?, ?, ?, 0)')
      .run(sourceId, 'Gft', 'gft', gft.id);

    const refreshed = await refreshUrlSource(get(), sourceId);
    assert.equal(refreshed.outcome, 'committed');
    assert.deepEqual(
      { added: refreshed.diff.added, changed: refreshed.diff.changed, removed: refreshed.diff.removed },
      { added: 1, changed: 0, removed: 1 },
    );
    const after = pickupRows(sourceId);
    assert.ok(!after.some((r) => r.id === pmdRow.id), 'the Pmd row is gone, not handed to Gft');
    assert.ok(after.some((r) => r.id === huisvuilRow.id && r.type_id === huisvuil.id), 'the Huisvuil row stays');
    assert.deepEqual(after.map((r) => r.type_id).sort(), [huisvuil.id, gft.id].sort());
    assert.ok(!after.some((r) => r.type_id === pmd.id));
  } finally {
    server.close();
  }
});

test('#1795 refresh: two labels on one type and day are paired by their wording, not by their position in the feed', async () => {
  const rest = seedType({ name: 'Restafval' });
  const both = [['Rest 2w', '20260210'], ['Rest 4w', '20260210']];
  // Fetches 1 and 2 in one order, fetch 3 (the refresh) in the other. Fetch 4
  // drops "Rest 2w" for "Rest 6w" and lists the newcomer FIRST: it has no
  // namesake and must not take the row "Rest 4w" matches.
  const { server, url } = await startServer(feedPerCall((call) => {
    if (call <= 2) return both;
    if (call === 3) return [both[1], both[0]];
    return [['Rest 6w', '20260210'], both[1]];
  }));
  try {
    const sourceId = await createAndCommit(url('/cal.ics'), 'Two-labels-one-type source', [
      { normalized_label: 'rest 2w', type_id: rest.id },
      { normalized_label: 'rest 4w', type_id: rest.id },
    ]);
    const before = pickupRows(sourceId);
    assert.equal(before.length, 2);

    const reordered = await refreshUrlSource(get(), sourceId);
    assert.equal(reordered.outcome, 'committed');
    assert.deepEqual(
      { added: reordered.diff.added, changed: reordered.diff.changed, removed: reordered.diff.removed },
      { added: 0, changed: 0, removed: 0 },
      'the same two pickups in another order are no change',
    );
    assert.deepEqual(pickupRows(sourceId).map((r) => [r.id, r.original_summary]), before.map((r) => [r.id, r.original_summary]));

    get().prepare('INSERT INTO waste_source_mappings (source_id, original_label, normalized_label, type_id, ignored) VALUES (?, ?, ?, ?, 0)')
      .run(sourceId, 'Rest 6w', 'rest 6w', rest.id);
    const renamed = await refreshUrlSource(get(), sourceId);
    assert.equal(renamed.outcome, 'committed');
    assert.deepEqual(
      { added: renamed.diff.added, changed: renamed.diff.changed, removed: renamed.diff.removed },
      { added: 0, changed: 1, removed: 0 },
      'one pickup was reworded, the other is untouched',
    );
    const fourWeekly = before.find((r) => r.original_summary === 'Rest 4w');
    assert.equal(pickupRows(sourceId).find((r) => r.id === fourWeekly.id).original_summary, 'Rest 4w');
  } finally {
    server.close();
  }
});

test('commitImport: a writer that lands between the version check and the write is refused as source_changed, and nothing of the loser is kept', async () => {
  const type = seedType({ name: 'Papier' });
  const { server, url } = await startServer(feedPerCall(() => [['Papier', '20260410']]));
  try {
    const sourceId = await createAndCommit(url('/cal.ics'), 'Compare-and-swap source', [{ normalized_label: 'papier', type_id: type.id }]);
    const source = store.getSource(get(), sourceId);
    // The check outside the transaction passes (the version is still the one
    // previewed); the rival bumps it right before the transaction body runs.
    // Only the handle is wrapped - the statements are the real ones.
    const real = get();
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (fn) => {
            const run = target.transaction(fn);
            return (...args) => {
              target.prepare('UPDATE waste_sources SET version = version + 1 WHERE id = ?').run(sourceId);
              return run(...args);
            };
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.throws(() => store.commitImport(racing, {
      sourceId,
      name: 'Renamed by the loser',
      icsText: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:loser\r\nDTSTART;VALUE=DATE:20260417\r\nSUMMARY:Papier\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      mappingDecisions: [{ normalized_label: 'papier', type_id: type.id }],
      expectedVersion: source.version,
      userId: ALICE,
    }), (err) => err.name === 'WasteConflictError' && err.reason === 'source_changed');
    assert.equal(store.getSource(get(), sourceId).name, 'Compare-and-swap source');
    assert.deepEqual(pickupRows(sourceId).map((r) => r.date_key), ['2026-04-10']);
  } finally {
    server.close();
  }
});

test('#1795 refresh: a pickup that really left the feed is still removed, and a new one added, next to the re-keyed rest', async () => {
  const type = seedType({ name: 'Gft' });
  let call = 0;
  const { server, url } = await startServer((req, res) => {
    call += 1;
    // Calls 1 and 2 (create, reviewed commit) carry 3 and 10 March; call 3 (the
    // refresh) keeps 3 March and replaces 10 March with 17 March.
    const dates = call <= 2 ? ['20260303', '20260310'] : ['20260303', '20260317'];
    res.writeHead(200);
    res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${dates.map((date, index) => `BEGIN:VEVENT\r\nUID:gft${call}x${index}\r\nDTSTART;VALUE=DATE:${date}\r\nSUMMARY:Gft\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`);
  });
  try {
    const created = await createUrlSource(get(), {
      name: 'Volatile-UID changing source', url: url('/cal.ics'), refreshIntervalMinutes: 1440, userId: ALICE,
    });
    store.commitImport(get(), {
      sourceId: created.source.id,
      name: created.source.name,
      icsText: await (await fetch(url('/cal.ics'))).text(),
      mappingDecisions: [{ normalized_label: 'gft', type_id: type.id }],
      expectedVersion: created.source.version,
      previewDigest: created.preview.digest,
      userId: ALICE,
    });
    const refreshed = await refreshUrlSource(get(), created.source.id);
    assert.equal(refreshed.outcome, 'committed');
    assert.deepEqual(
      { added: refreshed.diff.added, changed: refreshed.diff.changed, removed: refreshed.diff.removed },
      { added: 1, changed: 0, removed: 1 },
    );
    const dates = get().prepare('SELECT date_key FROM waste_imported_pickups WHERE source_id = ? ORDER BY date_key').all(created.source.id).map((r) => r.date_key);
    assert.deepEqual(dates, ['2026-03-03', '2026-03-17']);
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

// -------------------------------------------------------------------------
// runDueWasteSourceRefreshes: the scheduler must respect the same household
// module switch waste-reminders.js already does - a disabled module still
// having its URL sources quietly fetched/committed in the background would
// be the one exception to "Waste never acts when switched off".
// -------------------------------------------------------------------------

test('runDueWasteSourceRefreshes: a due source is skipped entirely while the Waste module is disabled for the household', async () => {
  // The scheduler fetches EVERY due source in the database, and this suite
  // shares one long-lived DB across tests (see listDueUrlSources above, which
  // leaves its own https://example.com/* placeholder sources behind). Isolate
  // this test from that leftover state - otherwise the scheduler would make a
  // real network call to example.com here, unrelated to what this test checks.
  get().prepare("DELETE FROM waste_sources WHERE kind = 'url'").run();

  let fetched = false;
  const { server, url } = await startServer((req, res) => {
    fetched = true;
    res.writeHead(200);
    res.end(ICS_ONE_EVENT('Bio', '2026-06-01'));
  });
  try {
    const due = store.createUrlSourcePlaceholder(get(), {
      name: 'Disabled-household source', url: url('/cal.ics'), refreshIntervalMinutes: 60, userId: ALICE,
    });
    get().prepare(`
      INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '["waste"]')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    try {
      await runDueWasteSourceRefreshes();
      assert.equal(fetched, false, 'a disabled Waste module must not trigger a background fetch');
      const after = store.getSource(get(), due.id);
      assert.equal(after.version, 0, 'nothing was committed');
      assert.equal(after.last_error, null, 'not even an error was recorded - the scan never touched this source');
    } finally {
      get().prepare("DELETE FROM sync_config WHERE key = 'disabled_modules'").run();
    }

    // Re-enabled: the very next scan picks the same source back up.
    await runDueWasteSourceRefreshes();
    assert.equal(fetched, true, 'once Waste is enabled again, the same due source is refreshed normally');
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------------------
// #1938: an answer without a single calendar entry is a FAILED attempt of the
// source, never a calendar with zero pickups. Every case below starts from the
// same household: a URL source with 6 imported pickups (4 + 2 of two types)
// and 6 pending reminders, and drives the real callers - the scheduler
// function, the routes - against a local stand-in for the other side.
// -------------------------------------------------------------------------

const { syncAllWasteReminders } = await import('../server/services/waste-reminders.js');
const { todayKey, shiftDateKey } = await import('../server/utils/timezone.js');

const HTML_PAGE = '<html><head><title>Wartung</title></head><body><h1>Wartung</h1><p>Wir sind gleich wieder da.</p></body></html>';
const EMPTY_VCALENDAR = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//probe//EN\r\nEND:VCALENDAR\r\n';
const NO_EVENTS_ERROR = 'No calendar entries in the response';

/** The household from the issue. `feed.serve` is swapped between requests; every request is counted and kept. */
async function emptyFeedHousehold() {
  const d = get();
  // The scheduler fetches EVERY due source and honours the module switch: the
  // module ships switched OFF, and a test that leaves it off fetches nothing
  // and is green. Leftover sources of earlier tests would be fetched too.
  d.prepare("DELETE FROM waste_sources WHERE kind = 'url'").run();
  d.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]') ON CONFLICT(key) DO UPDATE SET value = '[]'").run();

  const today = todayKey(d);
  const compact = (offset) => shiftDateKey(today, offset).replace(/-/g, '');
  const tag = randomUUID().slice(0, 8);
  const labels = { rest: `Rest-${tag}`, bio: `Bio-${tag}` };
  const vevent = (label, offset) => `BEGIN:VEVENT\r\nUID:${label}-${compact(offset)}@probe\r\nDTSTART;VALUE=DATE:${compact(offset)}\r\nSUMMARY:${label}\r\nEND:VEVENT\r\n`;
  const calendar = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//probe//EN\r\n${events.join('')}END:VCALENDAR\r\n`;
  const rest = [3, 10, 17, 24].map((o) => vevent(labels.rest, o));
  const bio = [5, 19].map((o) => vevent(labels.bio, o));

  const feed = {
    hits: [],
    valid: { status: 200, headers: { 'Content-Type': 'text/calendar', ETag: '"good-1"', 'Last-Modified': 'Mon, 05 Oct 2026 08:00:00 GMT' }, body: calendar([...rest, ...bio]) },
    fewer: { status: 200, headers: { 'Content-Type': 'text/calendar', ETag: '"good-2"' }, body: calendar(rest) },
    more: { status: 200, headers: { 'Content-Type': 'text/calendar', ETag: '"good-3"' }, body: calendar([...rest, ...bio, vevent(labels.bio, 33)]) },
    // Entries, but every one of them years outside the import window.
    outside: { status: 200, headers: { 'Content-Type': 'text/calendar', ETag: '"far"' }, body: calendar([vevent(labels.rest, 2000), vevent(labels.bio, 2001)]) },
    html: { status: 200, headers: { 'Content-Type': 'text/html', ETag: '"maintenance"', 'Last-Modified': 'Tue, 06 Oct 2026 09:00:00 GMT' }, body: HTML_PAGE },
    emptyCalendar: { status: 200, headers: { 'Content-Type': 'text/calendar', ETag: '"empty"' }, body: EMPTY_VCALENDAR },
    emptyBody: { status: 200, headers: { 'Content-Type': 'text/calendar' }, body: '' },
    unavailable: { status: 503, headers: { 'Content-Type': 'text/html' }, body: '<html>Service Unavailable</html>' },
  };
  feed.serve = feed.valid;
  const { server, url } = await startServer((req, res) => {
    feed.hits.push({ ifNoneMatch: req.headers['if-none-match'] ?? null });
    const answer = feed.serve;
    // An honest remote: the validator it handed out last is answered with 304.
    if (answer.status === 200 && answer.headers.ETag && req.headers['if-none-match'] === answer.headers.ETag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });

  const created = await apiCall('POST', '/waste/sources', { body: { name: `Feed ${tag}`, url: url('/cal.ics'), refresh_interval_minutes: 1440 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.source.id;
  const preview = await apiCall('POST', `/waste/sources/${id}/reimport/preview`, { body: {} });
  const committed = await apiCall('POST', `/waste/sources/${id}/reimport/commit`, {
    body: {
      preview_digest: preview.body.data.digest, expected_version: preview.body.data.expected_version,
      mappings: preview.body.data.labels.map((l) => ({ normalized_label: l.normalized_label, new_type: { name: l.original_label } })),
    },
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const typeIds = d.prepare('SELECT DISTINCT type_id FROM waste_source_mappings WHERE source_id = ?').all(id).map((r) => r.type_id);
  for (const typeId of typeIds) {
    const set = await apiCall('PUT', `/waste/reminder-settings/${typeId}`, { body: { enabled: true, offset_days: 1, delivery_time: '18:00' } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }

  const reminderCount = () => {
    syncAllWasteReminders(d);
    const marks = typeIds.map(() => '?').join(',');
    return d.prepare(`
      SELECT COUNT(*) AS n FROM reminders r
      JOIN waste_reminder_entries e ON e.id = r.entity_id
      WHERE r.entity_type = 'waste_pickup' AND e.type_id IN (${marks})
    `).get(...typeIds).n;
  };
  const snapshot = () => {
    const row = d.prepare('SELECT * FROM waste_sources WHERE id = ?').get(id);
    return {
      pickups: d.prepare('SELECT COUNT(*) AS n FROM waste_imported_pickups WHERE source_id = ?').get(id).n,
      mappings: d.prepare('SELECT COUNT(*) AS n FROM waste_source_mappings WHERE source_id = ?').get(id).n,
      reminders: reminderCount(),
      version: row.version, etag: row.etag, last_modified: row.last_modified, last_success_at: row.last_success_at,
      last_error: row.last_error, consecutive_failures: row.consecutive_failures,
      needs_mapping: row.needs_mapping, next_attempt_at: row.next_attempt_at,
    };
  };
  // "The refresh interval has elapsed" - the one thing these tests set by hand.
  const makeDue = () => d.prepare("UPDATE waste_sources SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);
  const runScheduler = async () => {
    makeDue();
    const before = feed.hits.length;
    await runDueWasteSourceRefreshes();
    assert.equal(feed.hits.length - before, 1, 'control: the scheduler really fetched this source (module on, source due)');
  };

  const before = snapshot();
  assert.deepEqual(
    { pickups: before.pickups, mappings: before.mappings, reminders: before.reminders, etag: before.etag, last_error: before.last_error, failures: before.consecutive_failures },
    { pickups: 6, mappings: 2, reminders: 6, etag: '"good-1"', last_error: null, failures: 0 },
    'control: the start state of every case',
  );
  assert.ok(before.last_success_at, 'control: a success is on record');
  return { id, feed, before, snapshot, runScheduler, makeDue, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** What a failed attempt must leave exactly as it was. */
const KEPT = ['pickups', 'mappings', 'reminders', 'version', 'etag', 'last_modified', 'last_success_at', 'needs_mapping'];
const pick = (state, keys) => Object.fromEntries(keys.map((k) => [k, state[k]]));
const minutesUntil = (iso) => (Date.parse(iso) - Date.now()) / 60_000;

for (const [name, key] of [['an HTML page with 200', 'html'], ['an empty VCALENDAR with 200', 'emptyCalendar']]) {
  test(`#1938 scheduler: ${name} is a failed attempt - pickups, mappings, version, validators, last success and reminders stay; error, count and backoff are recorded`, async () => {
    const h = await emptyFeedHousehold();
    try {
      h.feed.serve = h.feed[key];
      await h.runScheduler();
      const after = h.snapshot();
      assert.deepEqual(pick(after, KEPT), pick(h.before, KEPT), 'nothing of the last good snapshot moved (6 -> 6 pickups and reminders)');
      assert.equal(after.last_error, NO_EVENTS_ERROR);
      assert.equal(after.consecutive_failures, 1);
      const wait = minutesUntil(after.next_attempt_at);
      assert.ok(wait > 25 && wait < 35, `the backoff of a first failure (30 min), not the 24 h cadence: ${wait}`);

      // The answer carried its own ETag. Stored, the next attempt would be a
      // 304, read as "unchanged", and clear the error after one round.
      await h.runScheduler();
      assert.equal(h.feed.hits.at(-1).ifNoneMatch, '"good-1"', 'the next attempt still asks with the validator of the last GOOD answer');
      const second = h.snapshot();
      assert.equal(second.consecutive_failures, 2, 'the same answer again is the second failure, not "unchanged"');
      assert.equal(second.last_error, NO_EVENTS_ERROR);
      assert.deepEqual(pick(second, KEPT), pick(h.before, KEPT));

      // Recovery: the remote serves a calendar again, here one pickup longer.
      h.feed.serve = h.feed.more;
      await h.runScheduler();
      const recovered = h.snapshot();
      assert.deepEqual(
        pick(recovered, ['pickups', 'reminders', 'last_error', 'consecutive_failures', 'etag']),
        { pickups: 7, reminders: 7, last_error: null, consecutive_failures: 0, etag: '"good-3"' },
        'a calendar is applied as always and the failure state is gone',
      );
      assert.equal(recovered.version, h.before.version + 1);
      const cadence = minutesUntil(recovered.next_attempt_at);
      assert.ok(cadence > 1400 && cadence < 1445, `back at the normal cadence: ${cadence}`);
    } finally {
      await h.close();
    }
  });

  test(`#1938 manual refresh: ${name} answers 200 with outcome "error" and the reason waste_source_fetch_no_events, and applies nothing`, async () => {
    const h = await emptyFeedHousehold();
    try {
      h.feed.serve = h.feed[key];
      const r = await apiCall('POST', `/waste/sources/${h.id}/refresh`, { body: {} });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.outcome, 'error', JSON.stringify(r.body.data));
      assert.equal(r.body.data.reason, 'waste_source_fetch_no_events');
      assert.equal('params' in r.body.data, false);
      assert.equal('diff' in r.body.data, false, 'nothing was applied, so there is no diff');
      assert.equal(r.body.data.source.last_error, NO_EVENTS_ERROR);
      const after = h.snapshot();
      assert.deepEqual(pick(after, KEPT), pick(h.before, KEPT));
      assert.equal(after.consecutive_failures, 1);
    } finally {
      await h.close();
    }
  });

  test(`#1938 reviewed re-import of a URL source: ${name} is refused at the PREVIEW and at the commit with 502 and the same reason`, async () => {
    const h = await emptyFeedHousehold();
    try {
      h.feed.serve = h.feed[key];
      const preview = await apiCall('POST', `/waste/sources/${h.id}/reimport/preview`, { body: {} });
      assert.equal(preview.status, 502, `the preview refuses, it does not show "0 pickups": ${JSON.stringify(preview.body)}`);
      assert.equal(preview.body.reason, 'waste_source_fetch_no_events');
      assert.equal(preview.body.error, `Fetching the source URL failed: ${NO_EVENTS_ERROR}`);
      // A client that commits without a preview, with everything a commit needs.
      const commit = await apiCall('POST', `/waste/sources/${h.id}/reimport/commit`, { body: { expected_version: h.before.version, mappings: [] } });
      assert.equal(commit.status, 502, JSON.stringify(commit.body));
      assert.equal(commit.body.reason, 'waste_source_fetch_no_events');
      const after = h.snapshot();
      assert.deepEqual(pick(after, KEPT), pick(h.before, KEPT));
      assert.equal(after.last_error, null, 'like every failed fetch of the reviewed path, it is not an attempt of the schedule');
    } finally {
      await h.close();
    }
  });

  test(`#1938 a NEW URL source whose first answer is ${name}: 201 with outcome "error" and the reason, in the shape of a failed first fetch - never "committed"`, async () => {
    const h = await emptyFeedHousehold();
    try {
      const firstFetch = async (serve) => {
        h.feed.serve = serve;
        const r = await apiCall('POST', '/waste/sources', { body: { name: `New ${randomUUID()}`, url: h.feed.url ?? null, refresh_interval_minutes: 1440 } });
        return r;
      };
      // The same remote, another path: startServer answers every path alike.
      h.feed.url = get().prepare('SELECT url FROM waste_sources WHERE id = ?').get(h.id).url.replace('/cal.ics', '/other.ics');
      const empty = await firstFetch(h.feed[key]);
      const failed = await firstFetch(h.feed.unavailable);
      assert.equal(empty.status, 201, JSON.stringify(empty.body));
      assert.equal(empty.body.data.outcome, 'error', 'not a working subscription with a diff of zeros');
      assert.equal(empty.body.data.reason, 'waste_source_fetch_no_events');
      assert.equal(empty.body.data.source.last_error, NO_EVENTS_ERROR);
      // What a failed first fetch stores today (503) is the shape to stay in.
      assert.equal(failed.body.data.outcome, 'error');
      const stored = (r) => {
        const row = get().prepare('SELECT * FROM waste_sources WHERE id = ?').get(r.body.data.source.id);
        return {
          version: row.version, etag: row.etag, last_modified: row.last_modified, last_success_at: row.last_success_at,
          consecutive_failures: row.consecutive_failures, needs_mapping: row.needs_mapping, has_error: row.last_error !== null,
          pickups: get().prepare('SELECT COUNT(*) AS n FROM waste_imported_pickups WHERE source_id = ?').get(row.id).n,
        };
      };
      assert.deepEqual(stored(empty), stored(failed));
      assert.deepEqual(stored(empty), { version: 0, etag: null, last_modified: null, last_success_at: null, consecutive_failures: 1, needs_mapping: 0, has_error: true, pickups: 0 });
      assert.deepEqual(Object.keys(empty.body.data).sort(), Object.keys(failed.body.data).filter((k) => k !== 'params').sort(), 'the same fields as a failed first fetch');
    } finally {
      await h.close();
    }
  });
}

test('#1938 what stays as it was: fewer entries are applied (6 -> 4), an empty body and a 503 fail as before, a 304 is unchanged', async () => {
  const h = await emptyFeedHousehold();
  try {
    // 503: a failed fetch.
    h.feed.serve = h.feed.unavailable;
    await h.runScheduler();
    let state = h.snapshot();
    assert.deepEqual(pick(state, KEPT), pick(h.before, KEPT));
    assert.equal(state.last_error, 'HTTP 503');
    assert.equal(state.consecutive_failures, 1);

    // 304: unchanged, and the failure state is cleared.
    h.feed.serve = h.feed.valid;
    await h.runScheduler();
    state = h.snapshot();
    assert.deepEqual(pick(state, KEPT), pick(h.before, KEPT));
    assert.deepEqual([state.last_error, state.consecutive_failures], [null, 0]);
    const unchanged = await apiCall('POST', `/waste/sources/${h.id}/refresh`, { body: {} });
    assert.equal(unchanged.body.data.outcome, 'unchanged');

    // A body of nothing: the importer's own refusal, 400 at the manual refresh.
    h.feed.serve = h.feed.emptyBody;
    await h.runScheduler();
    state = h.snapshot();
    assert.deepEqual(pick(state, KEPT), pick(h.before, KEPT));
    assert.equal(state.last_error, 'An ICS file is required.');
    const emptyBody = await apiCall('POST', `/waste/sources/${h.id}/refresh`, { body: {} });
    assert.equal(emptyBody.status, 400, JSON.stringify(emptyBody.body));
    assert.equal(emptyBody.body.reason, 'waste_import_empty_file');
    const emptyReview = await apiCall('POST', `/waste/sources/${h.id}/reimport/preview`, { body: {} });
    assert.deepEqual([emptyReview.status, emptyReview.body.reason], [400, 'waste_import_empty_file']);

    // A valid calendar with one of the two types gone: a legitimate change.
    h.feed.serve = h.feed.fewer;
    await h.runScheduler();
    state = h.snapshot();
    assert.deepEqual(
      pick(state, ['pickups', 'reminders', 'last_error', 'consecutive_failures', 'etag', 'version']),
      { pickups: 4, reminders: 4, last_error: null, consecutive_failures: 0, etag: '"good-2"', version: h.before.version + 1 },
    );
  } finally {
    await h.close();
  }
});

test('#1938 the rule asks what was SENT, not what remains: a calendar whose entries all lie outside the import window is applied', async () => {
  const h = await emptyFeedHousehold();
  try {
    h.feed.serve = h.feed.outside;
    const preview = await apiCall('POST', `/waste/sources/${h.id}/reimport/preview`, { body: {} });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.data.counts, { events: 2, candidates: 0, distinct_labels: 0 });
    await h.runScheduler();
    const state = h.snapshot();
    assert.deepEqual(
      pick(state, ['pickups', 'last_error', 'consecutive_failures', 'etag', 'version']),
      { pickups: 0, last_error: null, consecutive_failures: 0, etag: '"far"', version: h.before.version + 1 },
      'entries arrived, none of them in the window: applied as before',
    );
  } finally {
    await h.close();
  }
});

test('#1938 the scheduler path is still off while the module is off - the cases above measure nothing unless they switch it on', async () => {
  const h = await emptyFeedHousehold();
  try {
    get().prepare("UPDATE sync_config SET value = '[\"waste\"]' WHERE key = 'disabled_modules'").run();
    h.feed.serve = h.feed.html;
    h.makeDue();
    const hits = h.feed.hits.length;
    await runDueWasteSourceRefreshes();
    assert.equal(h.feed.hits.length, hits, 'no fetch');
    assert.equal(h.snapshot().last_error, null);
  } finally {
    get().prepare("DELETE FROM sync_config WHERE key = 'disabled_modules'").run();
    await h.close();
  }
});
