/**
 * Folder-directory upload planning and execution.
 * The planner is a client-side preflight only: route validation and storage
 * remain covered by the document-route suites, so this file deliberately does
 * not duplicate server-side upload tests.
 *
 * Run: node --test test/test-folder-upload.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFolderUploadPlan,
  executeFolderUploadPlan,
  formatFolderUploadTimestamp,
  folderUploadOutcome,
  runRateLimitedOperation,
  supportsDirectoryUpload,
} from '../public/utils/folder-upload.js';

function file(path, {
  size = 128,
  type = 'application/pdf',
  name = path.split('/').at(-1),
} = {}) {
  return { name, size, type, webkitRelativePath: path };
}

const baseOptions = {
  folders: [
    { id: 10, name: 'Projects', parent_id: null },
  ],
  documents: [],
  targetFolderId: 10,
  maxFileSize: 5 * 1024 * 1024,
  allowedMimeTypes: ['application/pdf'],
  timestamp: '2026-08-31 22-30',
};

test('formats the duplicate suffix without locale-dependent punctuation', () => {
  assert.equal(
    formatFolderUploadTimestamp(new Date(2026, 7, 31, 22, 30, 45)),
    '2026-08-31 22-30',
  );
});

test('creates the selected root and nests its files and child folders below it', () => {
  const plan = buildFolderUploadPlan([
    file('House/permit.pdf'),
    file('House/Drawings/floor.pdf'),
    file('House/Drawings/Electrical/wiring.pdf'),
  ], baseOptions);

  assert.equal(plan.rootName, 'House');
  assert.deepEqual(
    plan.folders.map(({ key, parentRef, action }) => ({ key, parentRef, action })),
    [
      { key: 'House', parentRef: 'id:10', action: 'create' },
      { key: 'House/Drawings', parentRef: 'plan:House', action: 'create' },
      { key: 'House/Drawings/Electrical', parentRef: 'plan:House/Drawings', action: 'create' },
    ],
  );
  assert.deepEqual(
    plan.files.map(({ relativePath, targetRef, action }) => ({ relativePath, targetRef, action })),
    [
      { relativePath: 'House/permit.pdf', targetRef: 'plan:House', action: 'upload' },
      { relativePath: 'House/Drawings/floor.pdf', targetRef: 'plan:House/Drawings', action: 'upload' },
      { relativePath: 'House/Drawings/Electrical/wiring.pdf', targetRef: 'plan:House/Drawings/Electrical', action: 'upload' },
    ],
  );
});

test('rejects entries without a directory-relative path', () => {
  const orphan = file('', { name: 'orphan.pdf' });
  const plan = buildFolderUploadPlan([orphan], baseOptions);

  assert.equal(plan.files[0].action, 'reject');
  assert.equal(plan.files[0].reason, 'missing-relative-path');
  assert.equal(plan.counts.rejected, 1);
  assert.deepEqual(plan.folders, []);
});

test('rejects traversal and empty path segments before planning folders', () => {
  const plan = buildFolderUploadPlan([
    file('House/../secret.pdf'),
    file('House//blank.pdf'),
  ], baseOptions);

  assert.deepEqual(plan.files.map((entry) => entry.reason), ['unsafe-path', 'unsafe-path']);
  assert.deepEqual(plan.folders, []);
});

test('rejects absolute, dot and Windows-style paths before creating folders', () => {
  const plan = buildFolderUploadPlan([
    file('/House/permit.pdf'),
    file('./House/permit.pdf'),
    file('House/./permit.pdf'),
    file('C:\\House\\permit.pdf'),
  ], baseOptions);

  assert.deepEqual(plan.files.map((entry) => entry.reason), [
    'unsafe-path',
    'unsafe-path',
    'unsafe-path',
    'unsafe-path',
  ]);
  assert.deepEqual(plan.folders, []);
});

test('uses the server-trimmed folder name and rejects whitespace-only branches', () => {
  const plan = buildFolderUploadPlan([
    file('House /permit.pdf'),
    file('House/   /never-uploaded.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 19, name: 'House', parent_id: 10 },
    ],
  });

  assert.deepEqual(
    plan.folders.map(({ key, name, action, targetId }) => ({ key, name, action, targetId })),
    [{ key: 'House', name: 'House', action: 'reuse', targetId: 19 }],
  );
  assert.equal(plan.files[0].action, 'upload');
  assert.equal(plan.files[0].targetRef, 'id:19');
  assert.equal(plan.files[1].reason, 'unsafe-path');
  assert.equal(plan.folders.some((folder) => folder.key.includes('   ')), false);
});

test('normalizes NFD folder names to the existing NFC sibling without changing case', () => {
  const plan = buildFolderUploadPlan([
    file('Cafe\u0301/permit.pdf'),
    file('Café/second.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 19, name: 'Café', parent_id: 10 },
    ],
  });

  assert.deepEqual(
    plan.folders.map(({ key, name, action, targetId }) => ({ key, name, action, targetId })),
    [{ key: 'Café', name: 'Café', action: 'reuse', targetId: 19 }],
  );
  assert.deepEqual(plan.files.map((entry) => entry.targetRef), ['id:19', 'id:19']);
});

test('requires a proven directory picker and excludes iPhone, iPad and iPadOS desktop mode', () => {
  assert.equal(supportsDirectoryUpload({ hasWebkitDirectory: false }), false);
  assert.equal(supportsDirectoryUpload({ hasWebkitDirectory: true, platform: 'MacIntel', maxTouchPoints: 0 }), true);
  assert.equal(supportsDirectoryUpload({ hasWebkitDirectory: true, platform: 'iPhone', maxTouchPoints: 5 }), false);
  assert.equal(supportsDirectoryUpload({ hasWebkitDirectory: true, platform: 'iPad', maxTouchPoints: 5 }), false);
  assert.equal(supportsDirectoryUpload({ hasWebkitDirectory: true, platform: 'MacIntel', maxTouchPoints: 5 }), false);
});

test('rejects empty files but preserves their safe folder path', () => {
  const plan = buildFolderUploadPlan([
    file('House/Empty/zero.pdf', { size: 0 }),
  ], baseOptions);

  assert.equal(plan.files[0].reason, 'empty-file');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/Empty']);
});

test('rejects MIME types outside the server-provided allowlist but preserves their safe folder path', () => {
  const plan = buildFolderUploadPlan([
    file('House/Source/model.dwg', { type: 'image/vnd.dwg' }),
  ], baseOptions);

  assert.equal(plan.files[0].reason, 'unsupported-type');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/Source']);
});

test('rejects files above the effective server byte limit but preserves their safe folder path', () => {
  const plan = buildFolderUploadPlan([
    file('House/Large/scan.pdf', { size: baseOptions.maxFileSize + 1 }),
  ], baseOptions);

  assert.equal(plan.files[0].reason, 'too-large');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/Large']);
});

test('recreates a subfolder whose only file is rejected when a sibling is uploadable', () => {
  const plan = buildFolderUploadPlan([
    file('House/Accepted/ok.pdf'),
    file('House/RejectedOnly/model.dwg', { type: 'image/vnd.dwg' }),
  ], baseOptions);

  assert.deepEqual(
    plan.folders.map((folder) => folder.key),
    ['House', 'House/Accepted', 'House/RejectedOnly'],
  );
  assert.equal(plan.counts.upload, 1);
  assert.equal(plan.counts.rejected, 1);
});

test('executes a safe folder tree even when every selected file is rejected', async () => {
  const plan = buildFolderUploadPlan([
    file('House/RejectedOnly/model.dwg', { type: 'image/vnd.dwg' }),
  ], baseOptions);
  const created = [];

  const result = await executeFolderUploadPlan(plan, {
    createFolder: async ({ name, parentId }) => {
      created.push([name, parentId]);
      return { id: 500 + created.length };
    },
    uploadFile: async () => {
      throw new Error('a rejected file must never reach uploadFile');
    },
  });

  assert.deepEqual(created, [['House', 10], ['RejectedOnly', 501]]);
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.rejected.length, 1);
});

test('rejects overlong names but still preserves safe parent folders', () => {
  const longName = `${'a'.repeat(201)}.pdf`;
  const plan = buildFolderUploadPlan([
    file(`House/${longName}`),
    file(`House/${'b'.repeat(201)}/ok.pdf`),
  ], baseOptions);

  assert.deepEqual(plan.files.map((entry) => entry.reason), ['name-too-long', 'name-too-long']);
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House']);
});

test('counts the selected target depth against the five-level folder limit', () => {
  const plan = buildFolderUploadPlan([
    file('House/A/B/ok.pdf'),
    file('House/A/B/C/too-deep.pdf'),
  ], {
    ...baseOptions,
    folders: [
      { id: 10, name: 'Projects', parent_id: null },
      { id: 11, name: 'House', parent_id: 10 },
    ],
    targetFolderId: 11,
  });

  assert.equal(plan.files[0].action, 'upload');
  assert.equal(plan.files[1].reason, 'too-deep');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/A', 'House/A/B']);
});

test('merges exact sibling folder conflicts and follows reused descendants', () => {
  const plan = buildFolderUploadPlan([
    file('HOUSE/Drawings/Electrical/wiring.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 19, name: 'HOUSE', parent_id: 10 },
      { id: 20, name: 'Drawings', parent_id: 19 },
      { id: 21, name: 'Electrical', parent_id: 20 },
    ],
    folderDefault: 'merge',
  });

  assert.deepEqual(
    plan.folders.map(({ key, action, targetId, conflict, resolution }) => ({
      key, action, targetId, conflict, resolution,
    })),
    [
      { key: 'HOUSE', action: 'reuse', targetId: 19, conflict: true, resolution: 'merge' },
      { key: 'HOUSE/Drawings', action: 'reuse', targetId: 20, conflict: true, resolution: 'merge' },
      { key: 'HOUSE/Drawings/Electrical', action: 'reuse', targetId: 21, conflict: true, resolution: 'merge' },
    ],
  );
  assert.equal(plan.files[0].targetRef, 'id:21');
  assert.equal(plan.folderConflicts.length, 3);
});

test('creates a differently cased sibling just like the folder dialog and database', () => {
  const plan = buildFolderUploadPlan([
    file('house/permit.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 19, name: 'HOUSE', parent_id: 10 },
    ],
  });

  assert.deepEqual(
    plan.folders.map(({ key, name, action, conflict }) => ({ key, name, action, conflict })),
    [{ key: 'house', name: 'house', action: 'create', conflict: false }],
  );
  assert.equal(plan.files[0].targetRef, 'plan:house');
});

test('duplicates a conflicting folder with one fixed timestamp and numeric fallback', () => {
  const plan = buildFolderUploadPlan([
    file('House/Drawings/Electrical/wiring.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 20, name: 'House', parent_id: 10 },
      { id: 22, name: 'House - 2026-08-31 22-30', parent_id: 10 },
    ],
    folderDefault: 'duplicate',
  });

  assert.equal(plan.folders[0].name, 'House - 2026-08-31 22-30 (2)');
  assert.equal(plan.folders[0].resolution, 'duplicate');
  assert.equal(plan.folders[0].action, 'create');
  assert.equal(plan.folders[1].parentRef, 'plan:House');
  assert.equal(plan.folders[1].conflict, false);
});

test('a per-folder duplicate override replans descendants below the new parent', () => {
  const plan = buildFolderUploadPlan([
    file('House/Drawings/Electrical/wiring.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 20, name: 'House', parent_id: 10 },
      { id: 21, name: 'Drawings', parent_id: 20 },
    ],
    folderDefault: 'merge',
    folderOverrides: { House: 'duplicate' },
  });

  assert.equal(plan.folders[0].resolution, 'duplicate');
  assert.equal(plan.folders[0].action, 'create');
  assert.equal(plan.folders[1].conflict, false);
  assert.equal(plan.folders[1].action, 'create');
  assert.equal(plan.folderConflicts.length, 1);
});

test('applies one global resolution to every file conflict', () => {
  const files = [
    file('House/permit.pdf'),
    file('House/Drawings/wire.pdf'),
    file('House/Drawings/new.pdf'),
  ];
  const options = {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 19, name: 'House', parent_id: 10 },
      { id: 20, name: 'Drawings', parent_id: 19 },
    ],
    documents: [
      { id: 101, original_name: 'PERMIT.PDF', folder_id: 19 },
      { id: 102, original_name: 'wire.pdf', folder_id: 20 },
    ],
    folderDefault: 'merge',
    fileDefault: 'skip',
  };
  const skippedPlan = buildFolderUploadPlan(files, options);

  assert.deepEqual(
    skippedPlan.files.map(({ relativePath, action, resolution, uploadOriginalName }) => ({
      relativePath, action, resolution, uploadOriginalName,
    })),
    [
      { relativePath: 'House/permit.pdf', action: 'skip', resolution: 'skip', uploadOriginalName: 'permit.pdf' },
      { relativePath: 'House/Drawings/wire.pdf', action: 'skip', resolution: 'skip', uploadOriginalName: 'wire.pdf' },
      { relativePath: 'House/Drawings/new.pdf', action: 'upload', resolution: null, uploadOriginalName: 'new.pdf' },
    ],
  );
  assert.equal(skippedPlan.fileConflicts.length, 2);
  assert.equal(skippedPlan.counts.skipped, 2);

  const duplicatePlan = buildFolderUploadPlan(files, { ...options, fileDefault: 'duplicate' });
  assert.deepEqual(
    duplicatePlan.fileConflicts.map(({ action, resolution, uploadOriginalName }) => ({
      action, resolution, uploadOriginalName,
    })),
    [
      { action: 'upload', resolution: 'duplicate', uploadOriginalName: 'permit - 2026-08-31 22-30.pdf' },
      { action: 'upload', resolution: 'duplicate', uploadOriginalName: 'wire - 2026-08-31 22-30.pdf' },
    ],
  );
});

test('executes folders parent-first and never overlaps folder or file writes', async () => {
  const plan = buildFolderUploadPlan([
    file('House/Drawings/floor.pdf'),
    file('House/Drawings/Electrical/wiring.pdf'),
  ], baseOptions);
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let nextFolderId = 100;
  const operation = async (label, result) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(label);
    await Promise.resolve();
    active -= 1;
    return result;
  };

  const result = await executeFolderUploadPlan(plan, {
    createFolder: ({ name, parentId }) => operation(`folder:${name}:${parentId}`, { id: nextFolderId++ }),
    uploadFile: ({ originalName, folderId }) => operation(`file:${originalName}:${folderId}`, { id: 200 }),
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [
    'folder:House:10',
    'folder:Drawings:100',
    'folder:Electrical:101',
    'file:floor.pdf:101',
    'file:wiring.pdf:102',
  ]);
  assert.equal(result.createdFolders.length, 3);
  assert.equal(result.uploaded.length, 2);
  assert.equal(result.failed.length, 0);
});

test('a failed folder blocks only its branch while a sibling still uploads', async () => {
  const plan = buildFolderUploadPlan([
    file('House/Broken/Child/no.pdf'),
    file('House/Working/yes.pdf'),
  ], baseOptions);
  let nextId = 300;
  const uploaded = [];

  const result = await executeFolderUploadPlan(plan, {
    createFolder: async ({ name }) => {
      if (name === 'Broken') throw new Error('storage unavailable');
      return { id: nextId++ };
    },
    uploadFile: async ({ originalName }) => {
      uploaded.push(originalName);
      return { id: 400 };
    },
  });

  assert.deepEqual(uploaded, ['yes.pdf']);
  assert.deepEqual(
    result.failed.map(({ kind, item, reason }) => [kind, item.key || item.relativePath, reason]),
    [
      ['folder', 'House/Broken', 'storage unavailable'],
      ['folder', 'House/Broken/Child', 'parent-failed'],
      ['file', 'House/Broken/Child/no.pdf', 'parent-failed'],
    ],
  );
  assert.equal(result.uploaded.length, 1);
});

test('stops additional writes when the user cancels a long-running upload', async () => {
  const plan = buildFolderUploadPlan([
    file('House/first.pdf'),
    file('House/second.pdf'),
  ], baseOptions);
  const uploaded = [];
  let cancelled = false;

  const result = await executeFolderUploadPlan(plan, {
    createFolder: async () => ({ id: 500 }),
    uploadFile: async ({ originalName }) => {
      uploaded.push(originalName);
      cancelled = true;
      return { id: 600 };
    },
    shouldCancel: () => cancelled,
  });

  assert.deepEqual(uploaded, ['first.pdf']);
  assert.equal(result.cancelled, true);
  assert.equal(result.uploaded.length, 1);
});

test('retries a rate-limited write after the server Retry-After delay', async () => {
  const plan = {
    folders: [],
    files: [{ action: 'upload', targetRef: 'root', relativePath: 'House/file.pdf' }],
  };
  const waits = [];
  let attempts = 0;

  const result = await executeFolderUploadPlan(plan, {
    uploadFile: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('Too many requests.'), {
        status: 429,
        retryAfter: '2',
      });
      return { id: 700 };
    },
    waitForRetry: async (delayMs) => {
      waits.push(delayMs);
      return true;
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
  assert.equal(result.uploaded.length, 1);
  assert.deepEqual(result.failed, []);
});

test('cancels during a rate-limit wait without starting another write', async () => {
  const plan = {
    folders: [],
    files: [{ action: 'upload', targetRef: 'root', relativePath: 'House/file.pdf' }],
  };
  let attempts = 0;
  let cancelled = false;

  const result = await executeFolderUploadPlan(plan, {
    uploadFile: async () => {
      attempts += 1;
      throw Object.assign(new Error('Too many requests.'), { status: 429, retryAfter: '30' });
    },
    waitForRetry: async (_delayMs, shouldCancel) => {
      cancelled = true;
      return !shouldCancel();
    },
    shouldCancel: () => cancelled,
  });

  assert.equal(attempts, 1);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.failed, []);
});

test('bounds rate-limit retries and reports a stable reason', async () => {
  const plan = {
    folders: [],
    files: [{ action: 'upload', targetRef: 'root', relativePath: 'House/file.pdf' }],
  };
  let attempts = 0;

  const result = await executeFolderUploadPlan(plan, {
    uploadFile: async () => {
      attempts += 1;
      throw Object.assign(new Error('Too many requests.'), { status: 429, retryAfter: '0' });
    },
    waitForRetry: async () => true,
    maxRateLimitRetries: 2,
  });

  assert.equal(attempts, 3);
  assert.deepEqual(result.failed.map((failure) => failure.reason), ['rate-limited']);
});

test('does not retry errors other than rate limiting', async () => {
  const plan = {
    folders: [],
    files: [{ action: 'upload', targetRef: 'root', relativePath: 'House/file.pdf' }],
  };
  let attempts = 0;

  const result = await executeFolderUploadPlan(plan, {
    uploadFile: async () => {
      attempts += 1;
      throw Object.assign(new Error('storage unavailable'), { status: 503 });
    },
    waitForRetry: async () => assert.fail('503 must not be retried'),
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result.failed.map((failure) => failure.reason), ['storage unavailable']);
});

test('retries a rate-limited refresh after the final upload write succeeded', async () => {
  let refreshAttempts = 0;
  const waits = [];

  const refreshed = await runRateLimitedOperation(async () => {
    refreshAttempts += 1;
    if (refreshAttempts === 1) {
      throw Object.assign(new Error('Too many requests.'), {
        status: 429,
        retryAfter: '3',
      });
    }
    return 'fresh';
  }, {
    maxRetries: 1,
    waitForRetry: async (delay) => {
      waits.push(delay);
      return true;
    },
  });

  assert.equal(refreshed, 'fresh');
  assert.equal(refreshAttempts, 2);
  assert.deepEqual(waits, [3_000]);
});

test('reports cancelled and partial upload outcomes without success semantics', () => {
  assert.deepEqual(folderUploadOutcome({ cancelled: true, failed: [], uploaded: [] }), {
    heading: 'cancelled',
    toast: 'cancelled',
    tone: 'warning',
  });
  assert.deepEqual(folderUploadOutcome({ cancelled: false, failed: [{}], uploaded: [] }), {
    heading: 'completedWithErrors',
    toast: 'completedWithErrors',
    tone: 'warning',
  });
  assert.deepEqual(folderUploadOutcome({ cancelled: false, failed: [], uploaded: [{}] }), {
    heading: 'completed',
    toast: 'uploadedToast',
    tone: 'success',
  });
});

// #1995: "the chosen folder is gone" is one outcome of the whole upload, not a
// failure per entry. The executor stops at the first such answer and names the
// folder that vanished, so the dialog can reload and let the user start again.
const folderGone = () => Object.assign(new Error('Parent folder not found.'), {
  status: 400, data: { reason: 'documents_selected_folder_not_found' },
});
const isFolderGone = (error) => error?.data?.reason === 'documents_selected_folder_not_found';

test('#1995: the target folder deleted before the first write stops the upload at once', async () => {
  const plan = buildFolderUploadPlan([
    file('House/Drawings/floor.pdf'),
    file('House/notes.pdf'),
  ], baseOptions);
  const calls = [];
  const result = await executeFolderUploadPlan(plan, {
    createFolder: async ({ name, parentId }) => { calls.push(`folder:${name}:${parentId}`); throw folderGone(); },
    uploadFile: async ({ originalName }) => { calls.push(`file:${originalName}`); return { id: 1 }; },
    isFolderGone,
  });
  assert.deepEqual(calls, ['folder:House:10'], 'no further write after the first "gone" answer');
  assert.equal(result.folderGone?.ref, 'id:10', 'the chosen target is the folder that vanished');
  assert.equal(isFolderGone(result.folderGone?.error), true, 'the answer travels along for the page');
  assert.deepEqual(result.failed, [], 'no failure per entry');
  assert.equal(result.cancelled, false);
});

test('#1995: a merged folder deleted mid-way stops before the next file and names that folder', async () => {
  const plan = buildFolderUploadPlan([
    file('House/a.pdf'),
    file('House/b.pdf'),
    file('House/c.pdf'),
  ], { ...baseOptions, folders: [...baseOptions.folders, { id: 11, name: 'House', parent_id: 10 }] });
  const uploaded = [];
  let deleted = false;
  const result = await executeFolderUploadPlan(plan, {
    createFolder: async () => { throw new Error('no folder to create'); },
    uploadFile: async ({ originalName, folderId }) => {
      if (deleted) throw folderGone();
      uploaded.push(`${originalName}:${folderId}`);
      deleted = true; // someone else deletes House right after the first file
      return { id: 1 };
    },
    isFolderGone,
  });
  assert.deepEqual(uploaded, ['a.pdf:11']);
  assert.equal(result.uploaded.length, 1, 'what went through before stays reported');
  assert.equal(result.folderGone?.ref, 'id:11');
  assert.deepEqual(result.failed, []);
});

test('#1995: without the predicate a "gone" answer stays a failure per entry, as before', async () => {
  const plan = buildFolderUploadPlan([file('House/a.pdf')], baseOptions);
  const result = await executeFolderUploadPlan(plan, {
    createFolder: async () => { throw folderGone(); },
    uploadFile: async () => ({ id: 1 }),
  });
  assert.equal(result.folderGone, undefined);
  assert.deepEqual(result.failed.map(({ kind, reason }) => [kind, reason]), [
    ['folder', 'Parent folder not found.'],
    ['file', 'parent-failed'],
  ]);
});
