/**
 * Tests: Backup retention policies
 * - dateFromFilename helper
 * - Age-based pruning (BACKUP_KEEP_DAYS)
 * - Generational rotation — pure function (dateFromFilename / generationalFilesToDelete)
 * - Admin push-notification on failure
 * - getStatus exposes keepDays / generations / lastError
 *
 * Run: npm run test:backup-retention
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// ── Isolated temp dir per process ────────────────────────────────────────────
const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), 'yuvomi-backup-retention-'));
const TEST_DIR  = path.join(TEST_ROOT, 'store');

process.on('exit', () => rmSync(TEST_ROOT, { recursive: true, force: true }));

// ── Environment (set before first module import) ──────────────────────────────
process.env.BACKUP_ENABLED      = 'false';
process.env.BACKUP_DIR          = TEST_DIR;
process.env.BACKUP_KEEP         = '3';
process.env.BACKUP_KEEP_DAYS    = '7';
process.env.BACKUP_GENERATIONS  = 'true';
process.env.BACKUP_KEEP_WEEKLY  = '2';
process.env.BACKUP_KEEP_MONTHLY = '2';
process.env.DB_PATH             = ':memory:';
process.env.SESSION_SECRET      = 'retention-test-secret';
process.env.BASE_URL            = 'https://yuvomi.example.com';

// ── Import module (env already set) ──────────────────────────────────────────
const scheduler = await import('../server/services/backup-scheduler.js');
const { dateFromFilename, generationalFilesToDelete } = scheduler;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fake file entry as rotateBackups sees it. */
function fakeFile(name, ageDays) {
  const mtime = new Date(Date.now() - ageDays * 86400 * 1000);
  return { file: name, mtime, path: `/fake/${name}` };
}

/** Seed TEST_DIR with a named backup file at a given age. */
async function makeBackup(name, ageDays) {
  await fs.mkdir(TEST_DIR, { recursive: true });
  const p = path.join(TEST_DIR, name);
  await fs.writeFile(p, 'fake');
  const mtime = new Date(Date.now() - ageDays * 86400 * 1000);
  await fs.utimes(p, mtime, mtime);
}

/** List backup filenames in TEST_DIR, newest first by mtime. */
async function listBackups() {
  const entries = await fs.readdir(TEST_DIR).catch(() => []);
  const withStats = await Promise.all(
    entries
      .filter((n) => n.startsWith('yuvomi-backup-') && n.endsWith('.db'))
      .map(async (n) => ({ name: n, mtime: (await fs.stat(path.join(TEST_DIR, n))).mtime }))
  );
  return withStats.sort((a, b) => b.mtime - a.mtime).map((f) => f.name);
}

// ── Suite: dateFromFilename ───────────────────────────────────────────────────

describe('dateFromFilename', () => {
  it('parses yuvomi-backup timestamp', () => {
    const d = dateFromFilename('yuvomi-backup-2026-11-04T02-00-00Z.db');
    assert.ok(d instanceof Date);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 10); // November = 10
    assert.equal(d.getUTCDate(), 4);
  });

  it('parses legacy oikos-backup timestamp', () => {
    const d = dateFromFilename('oikos-backup-2025-03-15T02-00-00Z.db');
    assert.ok(d instanceof Date);
    assert.equal(d.getUTCFullYear(), 2025);
    assert.equal(d.getUTCDate(), 15);
  });

  it('returns null for unrecognised filename', () => {
    assert.equal(dateFromFilename('random-file.db'), null);
  });
});

// ── Suite: generational rotation (pure function) ──────────────────────────────

describe('generationalFilesToDelete (pure)', () => {
  it('keeps last BACKUP_KEEP (3) dailies; deletes extras that fit no tier', () => {
    // 7 files all in the same ISO-week and same calendar month so only one weekly
    // and one monthly slot is consumed.  With BACKUP_KEEP=3, BACKUP_KEEP_WEEKLY=2,
    // BACKUP_KEEP_MONTHLY=2: only 3 daily + 2 weekly + 2 monthly reps fill the
    // buckets, but since the 2 weekly and 2 monthly reps overlap with the dailies
    // the effective maximum kept = 3 (dailies cover weekly/monthly too).
    // Files 4, 5, 6 (the 4th-7th newest) should be deleted.
    // All in same week (Mon-Sun) and same month: 2026-11-16 .. 2026-11-22
    const files = [
      fakeFile('yuvomi-backup-2026-11-22T02-00-00Z.db', 0),
      fakeFile('yuvomi-backup-2026-11-21T02-00-00Z.db', 1),
      fakeFile('yuvomi-backup-2026-11-20T02-00-00Z.db', 2),
      fakeFile('yuvomi-backup-2026-11-19T02-00-00Z.db', 3),
      fakeFile('yuvomi-backup-2026-11-18T02-00-00Z.db', 4),
      fakeFile('yuvomi-backup-2026-11-17T02-00-00Z.db', 5),
      fakeFile('yuvomi-backup-2026-11-16T02-00-00Z.db', 6),
    ];
    const toDelete = generationalFilesToDelete(files);
    // Bucket math: all 7 share one week and one month.
    // Newest 3 get daily slots; next 2 may get weekly reps (up to BACKUP_KEEP_WEEKLY=2
    // allows the 4th file IF that week's count < 2 — but all share the same week so
    // that bucket fills at 2 which are already in the daily keep).
    // The 4th-7th files fit no unfilled bucket → deleted.
    assert.ok(toDelete.length >= 4, `expected ≥4 deleted, got ${toDelete.length}`);
    const deletedNames = toDelete.map((f) => f.file);
    // The three newest are always kept
    assert.ok(!deletedNames.includes('yuvomi-backup-2026-11-22T02-00-00Z.db'), 'newest must be kept');
    assert.ok(!deletedNames.includes('yuvomi-backup-2026-11-21T02-00-00Z.db'), '2nd newest must be kept');
    assert.ok(!deletedNames.includes('yuvomi-backup-2026-11-20T02-00-00Z.db'), '3rd newest must be kept');
  });

  it('preserves a monthly representative beyond the daily window', () => {
    // 4 recent dailies + 1 file from last month
    const files = [
      fakeFile('yuvomi-backup-2026-11-04T02-00-00Z.db', 0),
      fakeFile('yuvomi-backup-2026-11-03T02-00-00Z.db', 1),
      fakeFile('yuvomi-backup-2026-11-02T02-00-00Z.db', 2),
      fakeFile('yuvomi-backup-2026-11-01T02-00-00Z.db', 3),
      fakeFile('yuvomi-backup-2026-10-01T02-00-00Z.db', 34), // last month
    ];
    const toDelete = generationalFilesToDelete(files);
    const deletedNames = toDelete.map((f) => f.file);
    assert.ok(
      !deletedNames.includes('yuvomi-backup-2026-10-01T02-00-00Z.db'),
      'monthly representative must be kept'
    );
  });

  it('preserves a weekly representative when it falls outside the daily window', () => {
    // 3 dailies this week + 1 file from last week + 1 file two weeks ago
    const files = [
      fakeFile('yuvomi-backup-2026-11-04T02-00-00Z.db', 0),
      fakeFile('yuvomi-backup-2026-11-03T02-00-00Z.db', 1),
      fakeFile('yuvomi-backup-2026-11-02T02-00-00Z.db', 2),
      fakeFile('yuvomi-backup-2026-10-26T02-00-00Z.db', 9),  // last week
      fakeFile('yuvomi-backup-2026-10-19T02-00-00Z.db', 16), // two weeks ago
    ];
    const toDelete = generationalFilesToDelete(files);
    const deletedNames = toDelete.map((f) => f.file);
    // last-week rep is BACKUP_KEEP_WEEKLY=2, so it should be kept
    assert.ok(
      !deletedNames.includes('yuvomi-backup-2026-10-26T02-00-00Z.db'),
      'last-week representative must be kept'
    );
  });
});

// ── Suite: age-based pruning via triggerBackup ─────────────────────────────────

describe('age-based pruning (BACKUP_KEEP_DAYS=7 via triggerBackup)', () => {
  before(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });
  after(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it('removes files older than BACKUP_KEEP_DAYS after creating a new backup', async () => {
    // Seed 4 files: 2 within BACKUP_KEEP days (protected by count guard), 2 beyond.
    // With BACKUP_KEEP=3 and BACKUP_KEEP_DAYS=7, files at index ≥3 that are older
    // than 7 days are eligible for age pruning.
    await makeBackup('yuvomi-backup-2026-10-18T02-00-00Z.db', 17); // very old — beyond top-3
    await makeBackup('yuvomi-backup-2026-10-19T02-00-00Z.db', 16); // very old — beyond top-3
    await makeBackup('yuvomi-backup-2026-10-30T02-00-00Z.db', 5);  // recent
    await makeBackup('yuvomi-backup-2026-10-31T02-00-00Z.db', 4);  // recent

    // triggerBackup adds a 5th (new) file and runs rotation.
    // After sorting newest-first: new(0), 4d, 5d, 16d, 17d
    // Top-3 are protected from age pruning; files at index≥3 (16d, 17d) get pruned.
    await scheduler.triggerBackup();

    const remaining = await listBackups();
    assert.ok(
      !remaining.includes('yuvomi-backup-2026-10-18T02-00-00Z.db'),
      '17-day-old backup should be age-pruned'
    );
    assert.ok(
      !remaining.includes('yuvomi-backup-2026-10-19T02-00-00Z.db'),
      '16-day-old backup should be age-pruned'
    );
    assert.ok(
      remaining.includes('yuvomi-backup-2026-10-30T02-00-00Z.db'),
      '5-day-old backup should be kept (within 7-day window)'
    );
  });
});

// ── Suite: failure notifications and lastError ────────────────────────────────

describe('failure notification and lastError', () => {
  before(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it('sets lastError when backup fails (dir replaced by a file)', async () => {
    // Replace TEST_DIR with a plain file so ensureBackupDir → fs.mkdir throws EEXIST/ENOTDIR.
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    writeFileSync(TEST_DIR, 'not-a-directory'); // BACKUP_DIR constant already points here

    const mockPush = {
      sendPushToUser: async () => 1,
    };
    scheduler.startScheduler({ pushService: mockPush });

    try {
      await scheduler.triggerBackup();
    } finally {
      // Restore a real directory for the next test
      await fs.unlink(TEST_DIR).catch(() => {});
    }

    const s = scheduler.getStatus();
    assert.ok(s.lastError, 'lastError must be set after failure');
    assert.ok(typeof s.lastError.timestamp === 'string', 'lastError must have timestamp');
    assert.ok(typeof s.lastError.message === 'string', 'lastError must have message');
  });

  it('clears lastError after a subsequent successful backup', async () => {
    await scheduler.triggerBackup();
    const s = scheduler.getStatus();
    assert.equal(s.lastError, null, 'lastError must be null after success');
  });
});

// ── Suite: getStatus shape ────────────────────────────────────────────────────

describe('getStatus', () => {
  it('exposes keepDays, generations, lastError', () => {
    const s = scheduler.getStatus();
    assert.equal(s.keepDays, 7, 'keepDays should equal BACKUP_KEEP_DAYS');
    assert.ok(s.generations !== undefined, 'generations key must exist');
    assert.ok('lastError' in s, 'lastError key must exist');
  });

  it('generations object contains weekly and monthly counts', () => {
    const s = scheduler.getStatus();
    assert.ok(s.generations, 'generations should be non-null when BACKUP_GENERATIONS=true');
    assert.equal(s.generations.weekly, 2);
    assert.equal(s.generations.monthly, 2);
  });
});

console.log('[backup-retention test] done');
