/**
 * Test: Undo orchestration for destructive document-folder deletion.
 * Purpose: exercise state overlays, concurrent pending operations and the
 * delayed scheduler/API boundary without a DOM or server.
 * Run: npm run test:document-folder-delete
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const undoModule = await import('../public/utils/document-folder-delete.js');
const {
  applyPendingFolderDeleteOverlay,
  beginOptimisticFolderDelete,
  createLatestResponseApplier,
  delayedFolderDeleteErrorToast,
  handleFolderDeleteFailure,
  scheduleFolderDeleteWithUndo,
} = undoModule;

function makeState() {
  return {
    folders: [
      { id: 1, name: 'First' },
      { id: 2, name: 'Second' },
      { id: 3, name: 'Third' },
    ],
    allDocuments: [
      { id: 10, folder_id: 1 },
      { id: 20, folder_id: 2 },
      { id: 30, folder_id: 3 },
    ],
    selected: new Set([10, 20]),
    expanded: new Set([1, 2, 3]),
    folderId: '1',
  };
}

test('Undo restores only removed data and preserves explicit navigation and selection changes', () => {
  assert.equal(typeof beginOptimisticFolderDelete, 'function');
  const state = makeState();
  const transition = beginOptimisticFolderDelete(state, new Set([1]));

  assert.deepEqual(state.folders.map(({ id }) => id), [2, 3]);
  assert.deepEqual(state.allDocuments.map(({ id }) => id), [20, 30]);
  assert.deepEqual([...state.selected], [20]);
  assert.equal(state.folderId, '');

  state.folderId = '';
  state.selected.clear();
  state.expanded.clear();
  state.folders.push({ id: 4, name: 'Fourth' });
  state.allDocuments.push({ id: 40, folder_id: 4 });
  transition.restore();

  assert.deepEqual(state.folders.map(({ id }) => id), [1, 2, 3, 4]);
  assert.deepEqual(state.allDocuments.map(({ id }) => id), [10, 20, 30, 40]);
  assert.deepEqual([...state.selected], [], 'Undo must not recreate an explicitly cleared selection');
  assert.deepEqual([...state.expanded], [], 'Undo must not recreate explicitly cleared expansion');
  assert.equal(state.folderId, '', 'Undo must not navigate away from an explicit All view');
});

test('pending deletion preserves expansion state that render persists across reloads', () => {
  const state = makeState();
  const transition = beginOptimisticFolderDelete(state, new Set([1]));

  assert.deepEqual(
    [...state.expanded],
    [1, 2, 3],
    'hiding a pending subtree must not persist it as collapsed',
  );

  transition.restore();
  assert.deepEqual([...state.expanded], [1, 2, 3]);
});

test('a delayed content conflict becomes a warning toast instead of a reopened dialog', () => {
  assert.equal(typeof delayedFolderDeleteErrorToast, 'function');
  assert.deepEqual(
    delayedFolderDeleteErrorToast({ status: 409, data: { reason: 'FOLDER_CONTENT_CHANGED' } }),
    {
      key: 'documents.folderDeleteContentsChangedBeforeCommitToast',
      type: 'warning',
    },
  );
});

test('delayed content conflict shows exactly one warning and never reopens the impact dialog', async () => {
  const toasts = [];
  let refreshes = 0;
  await handleFolderDeleteFailure({
    err: { status: 409, data: { reason: 'FOLDER_CONTENT_CHANGED' } },
    delayed: true,
    translate: (key) => `translated:${key}`,
    showToast: (...args) => { toasts.push(args); },
    refreshImpact: async () => { refreshes += 1; },
  });

  assert.deepEqual(toasts, [[
    'translated:documents.folderDeleteContentsChangedBeforeCommitToast',
    'warning',
  ]]);
  assert.equal(refreshes, 0);
});

test('immediate content conflict refreshes the impact dialog without a delayed warning', async () => {
  const toasts = [];
  let refreshes = 0;
  await handleFolderDeleteFailure({
    err: { status: 409, data: { reason: 'FOLDER_CONTENT_CHANGED' } },
    delayed: false,
    translate: (key) => key,
    showToast: (...args) => { toasts.push(args); },
    refreshImpact: async () => { refreshes += 1; },
  });

  assert.equal(refreshes, 1);
  assert.deepEqual(toasts, []);
});

test('a 403 for a branch the caller may not delete becomes a translated warning, never the server text (#1355)', async () => {
  for (const delayed of [true, false]) {
    const toasts = [];
    let refreshes = 0;
    await handleFolderDeleteFailure({
      err: {
        status: 403,
        data: {
          error: 'Not authorized to delete every document in this folder.',
          reason: 'FOLDER_DOCUMENTS_NOT_MANAGEABLE',
        },
      },
      delayed,
      translate: (key) => `translated:${key}`,
      showToast: (...args) => { toasts.push(args); },
      refreshImpact: async () => { refreshes += 1; },
    });

    assert.deepEqual(toasts, [[
      'translated:documents.folderDeleteNotManageableToast',
      'warning',
    ]], `delayed=${delayed}`);
    assert.equal(refreshes, 0, 'a permission refusal must not reopen the impact dialog');
  }
});

test('two pending deletes restore in canonical order in both Undo permutations', () => {
  for (const undoOrder of [[0, 1], [1, 0]]) {
    const state = makeState();
    const transitions = [
      beginOptimisticFolderDelete(state, new Set([1])),
      beginOptimisticFolderDelete(state, new Set([2])),
    ];

    for (const index of undoOrder) transitions[index].restore();

    assert.deepEqual(state.folders.map(({ id }) => id), [1, 2, 3]);
    assert.deepEqual(state.allDocuments.map(({ id }) => id), [10, 20, 30]);
  }
});

test('latest response applier rejects a stale pre-delete GET that resolves last', async () => {
  assert.equal(typeof createLatestResponseApplier, 'function');
  const applyLatestFolders = createLatestResponseApplier();
  const applyLatestDocuments = createLatestResponseApplier();
  const state = { folders: [], documents: [] };
  let resolveStaleFolders;
  let resolveFreshFolders;
  let resolveStaleDocuments;
  let resolveFreshDocuments;
  const staleFolders = applyLatestFolders(
    () => new Promise((resolve) => { resolveStaleFolders = resolve; }),
    (folders) => { state.folders = folders; },
  );
  const staleDocuments = applyLatestDocuments(
    () => new Promise((resolve) => { resolveStaleDocuments = resolve; }),
    (documents) => { state.documents = documents; },
  );
  const freshFolders = applyLatestFolders(
    () => new Promise((resolve) => { resolveFreshFolders = resolve; }),
    (folders) => { state.folders = folders; },
  );
  const freshDocuments = applyLatestDocuments(
    () => new Promise((resolve) => { resolveFreshDocuments = resolve; }),
    (documents) => { state.documents = documents; },
  );

  resolveFreshFolders([{ id: 2 }]);
  resolveFreshDocuments([]);
  assert.equal(await freshFolders, true);
  assert.equal(await freshDocuments, true);
  resolveStaleFolders([{ id: 1 }, { id: 2 }]);
  resolveStaleDocuments([{ id: 10, folder_id: 1 }]);
  assert.equal(await staleFolders, false);
  assert.equal(await staleDocuments, false);
  assert.deepEqual(state.folders.map(({ id }) => id), [2]);
  assert.deepEqual(state.documents, []);
});

test('latest response applier ignores a stale request failure after a newer success', async () => {
  const applyLatest = createLatestResponseApplier();
  let rejectStale;
  const stale = applyLatest(
    () => new Promise((resolve, reject) => { rejectStale = reject; }),
    () => { throw new Error('stale response must not apply'); },
  );
  const fresh = applyLatest(
    async () => [{ id: 2 }],
    () => {},
  );

  assert.equal(await fresh, true);
  rejectStale(new Error('old request failed'));
  assert.equal(await stale, false);
});

test('pending overlays keep a re-entered view hidden and retain its fresh canonical data for Undo', () => {
  assert.equal(typeof applyPendingFolderDeleteOverlay, 'function');
  const state = makeState();
  const transition = beginOptimisticFolderDelete(state, new Set([1]));

  state.folders = [
    { id: 3, name: 'Third' },
    { id: 1, name: 'Renamed remotely' },
    { id: 2, name: 'Second' },
  ];
  state.allDocuments = [
    { id: 30, folder_id: 3 },
    { id: 11, folder_id: 1 },
    { id: 20, folder_id: 2 },
  ];
  applyPendingFolderDeleteOverlay(state, { freshFolders: true, freshDocuments: true });
  assert.deepEqual(state.folders.map(({ id }) => id), [3, 2]);
  assert.deepEqual(state.allDocuments.map(({ id }) => id), [30, 20]);

  transition.restore();
  assert.deepEqual(state.folders.map(({ id }) => id), [3, 1, 2]);
  assert.equal(state.folders[1].name, 'Renamed remotely');
  assert.deepEqual(state.allDocuments.map(({ id }) => id), [30, 11, 20]);
});

test('scheduler Undo restores state without calling DELETE', () => {
  assert.equal(typeof scheduleFolderDeleteWithUndo, 'function');
  const state = makeState();
  let scheduled;
  let requests = 0;
  scheduleFolderDeleteWithUndo({
    state,
    folderIds: new Set([1]),
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async () => { requests += 1; },
    isViewActive: () => true,
    applyResult: async () => {},
    handleError: async () => {},
    render: () => {},
  });

  scheduled.restore();
  assert.equal(requests, 0);
  assert.deepEqual(state.folders.map(({ id }) => id), [1, 2, 3]);
});

test('successful delayed commit forwards keepalive and reconciles a replacement active view', async () => {
  const state = makeState();
  let scheduled;
  let receivedKeepalive = null;
  let applied = null;
  scheduleFolderDeleteWithUndo({
    state,
    folderIds: new Set([1]),
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async ({ keepalive }) => {
      receivedKeepalive = keepalive;
      return { folder_deleted: true };
    },
    isViewActive: () => true,
    applyResult: async (result) => { applied = result; },
    handleError: async () => {},
    render: () => {},
  });

  await scheduled.commit({ keepalive: false });
  assert.equal(receivedKeepalive, false);
  assert.deepEqual(applied, { folder_deleted: true });
});

test('pagehide commit forwards keepalive without touching an inactive view', async () => {
  const state = makeState();
  let scheduled;
  let receivedKeepalive = null;
  let applies = 0;
  scheduleFolderDeleteWithUndo({
    state,
    folderIds: new Set([1]),
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async ({ keepalive }) => {
      receivedKeepalive = keepalive;
      return { folder_deleted: true };
    },
    isViewActive: () => false,
    applyResult: async () => { applies += 1; },
    handleError: async () => {},
    render: () => {},
  });

  assert.equal(scheduled.restoreOnKeepaliveError, true);
  await scheduled.commit({ keepalive: true });
  assert.equal(receivedKeepalive, true);
  assert.equal(applies, 0);
});

for (const [label, result] of [
  ['storage failure', {
    folder_deleted: false,
    contents_changed: false,
    failed_documents: [{ id: 10, failure_stage: 'storage' }],
  }],
  ['database failure', {
    folder_deleted: false,
    contents_changed: false,
    failed_documents: [{ id: 10, failure_stage: 'database' }],
  }],
  ['concurrent content change', {
    folder_deleted: false,
    contents_changed: true,
    failed_documents: [{ id: 11, failure_stage: 'concurrency' }],
  }],
]) {
  test(`inactive view reconciles a partial folder deletion after ${label}`, async () => {
    const state = makeState();
    let scheduled;
    let applied = null;
    scheduleFolderDeleteWithUndo({
      state,
      folderIds: new Set([1]),
      message: 'Deleted',
      schedule: (options) => { scheduled = options; },
      requestDelete: async () => result,
      isViewActive: () => false,
      applyResult: async (response, context) => { applied = { response, context }; },
      handleError: async () => {},
      render: () => {},
    });

    await scheduled.commit({ keepalive: false });

    assert.deepEqual(applied, {
      response: result,
      context: { viewActive: false, keepalive: false },
    });
  });
}

test('pagehide reconciles a partial result without rendering the detached view', async () => {
  const state = makeState();
  const result = {
    folder_deleted: false,
    contents_changed: true,
    failed_documents: [{ id: 10, failure_stage: 'concurrency' }],
  };
  let scheduled;
  let applied = null;
  let renders = 0;
  scheduleFolderDeleteWithUndo({
    state,
    folderIds: new Set([1]),
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async ({ keepalive }) => {
      assert.equal(keepalive, true);
      return result;
    },
    isViewActive: () => false,
    applyResult: async (response, context) => { applied = { response, context }; },
    handleError: async () => {},
    render: () => { renders += 1; },
  });

  await scheduled.commit({ keepalive: true });

  assert.deepEqual(applied, {
    response: result,
    context: { viewActive: false, keepalive: true },
  });
  assert.equal(renders, 1, 'only the initial optimistic render may touch the active view');
});

test('a refresh failure after server success reports separately and never restores deleted data', async () => {
  const state = makeState();
  let scheduled;
  const failure = new Error('refresh failed');
  let handled = null;
  scheduleFolderDeleteWithUndo({
    state,
    folderIds: new Set([1]),
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async () => ({ folder_deleted: true }),
    isViewActive: () => true,
    applyResult: async () => { throw failure; },
    handleError: async () => { throw new Error('request handler must not run'); },
    handleApplyError: async (error) => { handled = error; },
    render: () => {},
  });

  await scheduled.commit({ keepalive: false });
  scheduled.restore(failure);
  assert.deepEqual(state.folders.map(({ id }) => id), [2, 3]);
  assert.equal(handled, failure);
});

test('failed delayed commit restores state and delegates the error', async () => {
  const state = makeState();
  let scheduled;
  const failure = new Error('offline');
  let handled = null;
  scheduleFolderDeleteWithUndo({
    state,
    folderIds: new Set([1]),
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async () => { throw failure; },
    isViewActive: () => true,
    applyResult: async () => {},
    handleError: async (error) => { handled = error; },
    render: () => {},
  });

  await assert.rejects(() => scheduled.commit({ keepalive: false }), failure);
  scheduled.restore(failure);
  assert.deepEqual(state.folders.map(({ id }) => id), [1, 2, 3]);
  assert.equal(handled, failure);
});

test('failed delayed commit reports globally after the Documents view is left', async () => {
  const state = makeState();
  let scheduled;
  const failure = new Error('offline');
  let handled = null;
  let renders = 0;
  scheduleFolderDeleteWithUndo({
    state,
    folderIds: new Set([1]),
    message: 'Deleted',
    schedule: (options) => { scheduled = options; },
    requestDelete: async () => { throw failure; },
    isViewActive: () => false,
    applyResult: async () => {},
    handleError: (error) => { handled = error; },
    render: () => { renders += 1; },
  });

  await assert.rejects(() => scheduled.commit({ keepalive: false }), failure);
  scheduled.restore(failure);

  assert.deepEqual(state.folders.map(({ id }) => id), [1, 2, 3]);
  assert.equal(renders, 1, 'an inactive Documents view must not be rendered during restore');
  assert.equal(handled, failure, 'the global error notification must still run');
});
