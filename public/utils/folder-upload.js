/**
 * Module: Document folder upload
 * Purpose: Turn a browser directory selection into deterministic folder and
 *          document operations without coupling the rules to modal DOM code.
 */

import { folderPath, MAX_FOLDER_DEPTH } from './folder-tree.js';

const pad2 = (value) => String(value).padStart(2, '0');

export function formatFolderUploadTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}-${pad2(date.getMinutes())}`;
}

function comparableFileName(value) {
  return String(value || '').normalize('NFC').toLocaleLowerCase('en-US');
}

function serverFolderName(value) {
  return String(value || '').trim().normalize('NFC');
}

/**
 * Return whether the browser exposes a directory picker we can safely offer.
 *
 * The DOM probe belongs to the Documents page. Keeping this decision pure
 * makes the conservative iOS/iPadOS guard executable in Node as well.
 */
export function supportsDirectoryUpload({
  hasWebkitDirectory = false,
  platform = '',
  userAgent = '',
  maxTouchPoints = 0,
} = {}) {
  if (!hasWebkitDirectory) return false;
  const device = `${platform} ${userAgent}`;
  const isIOS = /iPad|iPhone|iPod|iOS/i.test(device)
    || (platform === 'MacIntel' && Number(maxTouchPoints) > 1);
  return !isIOS;
}

/**
 * Classify a completed executor result without treating partial work as a
 * successful upload. The page owns the localized copy for these keys.
 */
export function folderUploadOutcome(result = {}) {
  if (result.cancelled) return { heading: 'cancelled', toast: 'cancelled', tone: 'warning' };
  if ((result.failed || []).length) {
    return { heading: 'completedWithErrors', toast: 'completedWithErrors', tone: 'warning' };
  }
  return { heading: 'completed', toast: 'uploadedToast', tone: 'success' };
}

function refForFolderId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? `id:${id}` : 'root';
}

function fitName(base, suffix, limit = 200) {
  return `${base.slice(0, Math.max(1, limit - suffix.length))}${suffix}`;
}

function uniqueTimestampedFolderName(name, timestamp, occupiedNames) {
  const occupied = new Set(Array.from(occupiedNames || [], serverFolderName));
  const dated = fitName(String(name), ` - ${timestamp}`);
  if (!occupied.has(serverFolderName(dated))) return dated;
  for (let copy = 2; copy < 10_000; copy += 1) {
    const candidate = fitName(String(name), ` - ${timestamp} (${copy})`);
    if (!occupied.has(serverFolderName(candidate))) return candidate;
  }
  throw new Error('Unable to create a unique upload name.');
}

function splitExtension(name) {
  const value = String(name || '');
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return { base: value, extension: '' };
  return { base: value.slice(0, dot), extension: value.slice(dot) };
}

function uniqueTimestampedFileName(name, timestamp, occupiedNames) {
  const { base, extension } = splitExtension(name);
  const occupied = new Set(Array.from(occupiedNames || [], comparableFileName));
  const dated = fitName(base, ` - ${timestamp}${extension}`);
  if (!occupied.has(comparableFileName(dated))) return dated;
  for (let copy = 2; copy < 10_000; copy += 1) {
    const candidate = fitName(base, ` - ${timestamp} (${copy})${extension}`);
    if (!occupied.has(comparableFileName(candidate))) return candidate;
  }
  throw new Error('Unable to create a unique upload filename.');
}

function overrideChoice(overrides, key, fallback) {
  if (overrides instanceof Map) return overrides.get(key) || fallback;
  if (overrides && Object.hasOwn(overrides, key)) return overrides[key] || fallback;
  return fallback;
}

/**
 * Build the first, conflict-free shape of a directory upload.
 *
 * The first path component is the local directory the user selected. It is
 * preserved as the first Yuvomi folder so the uploaded tree matches the tree
 * the user picked.
 *
 * @param {ArrayLike<File>} inputFiles
 * @param {{targetFolderId?: number|null}} options
 */
export function buildFolderUploadPlan(inputFiles, options = {}) {
  const files = Array.from(inputFiles || []);
  const targetId = Number(options.targetFolderId);
  const baseRef = Number.isInteger(targetId) && targetId > 0 ? `id:${targetId}` : 'root';
  const targetDepth = baseRef === 'root' ? 0 : folderPath(options.folders || [], targetId).length;
  const timestamp = options.timestamp || formatFolderUploadTimestamp();
  const firstRelativePath = files.find((file) => String(file?.webkitRelativePath || '').includes('/'))
    ?.webkitRelativePath;
  const rootName = serverFolderName(String(firstRelativePath || '').split('/')[0]);
  const folderKeys = new Set();
  const allowedMimeTypes = new Set(
    Array.from(options.allowedMimeTypes || [], (mime) => String(mime).split(';')[0].trim().toLowerCase()),
  );

  const plannedFiles = files.map((file) => {
    const rawPath = String(file?.webkitRelativePath || '');
    const parts = rawPath.split('/');
    const reject = (reason) => {
      return {
        id: rawPath || String(file?.name || ''),
        file,
        relativePath: rawPath || String(file?.name || ''),
        targetRef: baseRef,
        originalName: file?.name || '',
        uploadOriginalName: file?.name || '',
        uploadName: String(file?.name || '').replace(/\.[^.]+$/, ''),
        action: 'reject',
        reason,
      };
    };
    if (!rawPath) return reject('missing-relative-path');
    if (rawPath.includes('\\') || rawPath.startsWith('/') || parts.length < 2) return reject('unsafe-path');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) return reject('unsafe-path');
    const rawFolderParts = parts.slice(0, -1);
    const folderParts = rawFolderParts.map(serverFolderName);
    if (folderParts.some((part) => !part)) return reject('unsafe-path');
    const originalName = String(file?.name || '').trim();
    const uploadName = originalName.replace(/\.[^.]+$/, '').trim();
    if (!originalName || !uploadName || !serverFolderName(parts.at(-1))) return reject('unsafe-path');
    if (folderParts.some((part) => part.length > 200)) return reject('name-too-long');
    if (targetDepth + folderParts.length > MAX_FOLDER_DEPTH) return reject('too-deep');
    for (let depth = 1; depth <= folderParts.length; depth += 1) {
      folderKeys.add(folderParts.slice(0, depth).join('/'));
    }
    if (originalName.length > 200) return reject('name-too-long');
    if (!Number.isFinite(Number(file?.size)) || Number(file.size) <= 0) return reject('empty-file');
    const mime = String(file?.type || '').split(';')[0].trim().toLowerCase();
    if (!mime || !allowedMimeTypes.has(mime)) return reject('unsupported-type');
    const maxFileSize = Number(options.maxFileSize);
    if (Number.isFinite(maxFileSize) && maxFileSize > 0 && Number(file.size) > maxFileSize) {
      return reject('too-large');
    }
    const directoryKey = folderParts.join('/');
    return {
      id: rawPath,
      file,
      relativePath: [...folderParts, originalName].join('/'),
      directoryKey,
      targetRef: directoryKey ? `plan:${directoryKey}` : baseRef,
      originalName,
      uploadOriginalName: originalName,
      uploadName,
      action: 'upload',
      reason: null,
    };
  });

  const existingChildren = new Map();
  for (const folder of options.folders || []) {
    const ref = refForFolderId(folder.parent_id);
    if (!existingChildren.has(ref)) existingChildren.set(ref, []);
    existingChildren.get(ref).push(folder);
  }
  const occupiedFolderNames = new Map(
    [...existingChildren].map(([ref, children]) => [ref, new Set(children.map((folder) => folder.name))]),
  );

  const folders = [];
  const resolvedFolderRefs = new Map();
  const folderConflicts = [];
  const sortedFolderKeys = [...folderKeys]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  for (const key of sortedFolderKeys) {
    const parts = key.split('/');
    const parentKey = parts.slice(0, -1).join('/');
    const sourceName = parts.at(-1);
    const parentRef = parentKey ? resolvedFolderRefs.get(parentKey) : baseRef;
    const existing = (existingChildren.get(parentRef) || [])
      .find((folder) => serverFolderName(folder.name) === sourceName);
    const resolution = existing
      ? overrideChoice(options.folderOverrides, key, options.folderDefault || 'merge')
      : null;
    const occupied = occupiedFolderNames.get(parentRef) || new Set();
    const resolvedName = existing && resolution === 'duplicate'
      ? uniqueTimestampedFolderName(sourceName, timestamp, occupied)
      : sourceName;
    const item = existing && resolution === 'merge'
      ? {
        key,
        sourceName,
        name: existing.name,
        parentRef,
        targetRef: `id:${existing.id}`,
        action: 'reuse',
        targetId: existing.id,
        conflict: true,
        resolution: 'merge',
      }
      : {
        key,
        sourceName,
        name: resolvedName,
        parentRef,
        targetRef: `plan:${key}`,
        action: 'create',
        targetId: null,
        conflict: Boolean(existing),
        resolution,
      };
    folders.push(item);
    if (item.action === 'create') {
      if (!occupiedFolderNames.has(parentRef)) occupiedFolderNames.set(parentRef, occupied);
      occupied.add(item.name);
    }
    resolvedFolderRefs.set(key, item.targetRef);
    if (item.conflict) folderConflicts.push(item);
  }

  for (const item of plannedFiles) {
    if (item.action !== 'upload') continue;
    item.targetRef = item.directoryKey ? resolvedFolderRefs.get(item.directoryKey) : baseRef;
  }

  const occupiedFileNames = new Map();
  for (const document of options.documents || []) {
    const ref = refForFolderId(document.folder_id);
    if (!occupiedFileNames.has(ref)) occupiedFileNames.set(ref, new Set());
    occupiedFileNames.get(ref).add(document.original_name);
  }

  const fileConflicts = [];
  for (const item of plannedFiles) {
    item.conflict = false;
    item.resolution = null;
    if (item.action !== 'upload') continue;
    const occupied = occupiedFileNames.get(item.targetRef) || new Set();
    const conflicts = [...occupied].some(
      (name) => comparableFileName(name) === comparableFileName(item.uploadOriginalName),
    );
    if (conflicts) {
      item.conflict = true;
      item.resolution = options.fileDefault || 'skip';
      if (item.resolution === 'skip') {
        item.action = 'skip';
      } else {
        item.uploadOriginalName = uniqueTimestampedFileName(
          item.originalName,
          timestamp,
          occupied,
        );
        item.uploadName = splitExtension(item.uploadOriginalName).base;
        occupied.add(item.uploadOriginalName);
      }
      fileConflicts.push(item);
    } else {
      occupied.add(item.uploadOriginalName);
    }
    if (!occupiedFileNames.has(item.targetRef)) occupiedFileNames.set(item.targetRef, occupied);
  }

  const rejected = plannedFiles.filter((file) => file.action === 'reject');
  const uploading = plannedFiles.filter((file) => file.action === 'upload');
  const skipped = plannedFiles.filter((file) => file.action === 'skip');

  return {
    rootName,
    folders,
    files: plannedFiles,
    folderConflicts,
    fileConflicts,
    rejected,
    counts: {
      total: files.length,
      upload: uploading.length,
      skipped: skipped.length,
      rejected: rejected.length,
      createFolders: folders.filter((folder) => folder.action === 'create').length,
      reuseFolders: folders.filter((folder) => folder.action === 'reuse').length,
    },
  };
}

function existingIdFromRef(ref) {
  if (ref === 'root') return null;
  if (!String(ref).startsWith('id:')) return undefined;
  const id = Number(String(ref).slice(3));
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

const RATE_LIMIT_CANCELLED = Symbol('rate-limit-cancelled');

function retryAfterDelayMs(error, retryIndex) {
  const raw = String(error?.retryAfter ?? '').trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(0, timestamp - Date.now()), 60_000);
  }
  return Math.min(1_000 * (2 ** retryIndex), 10_000);
}

async function cancellableRetryWait(delayMs, shouldCancel) {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (shouldCancel()) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
  return !shouldCancel();
}

export async function runRateLimitedOperation(operation, {
  maxRetries = 3,
  shouldCancel = () => false,
  waitForRetry = cancellableRetryWait,
} = {}) {
  const retryLimit = Math.max(0, Math.floor(Number(maxRetries) || 0));
  let retries = 0;
  while (true) {
    if (shouldCancel()) throw RATE_LIMIT_CANCELLED;
    try {
      return await operation();
    } catch (error) {
      if (error?.status !== 429 || retries >= retryLimit) throw error;
      const waited = await waitForRetry(retryAfterDelayMs(error, retries), shouldCancel);
      if (waited === false || shouldCancel()) throw RATE_LIMIT_CANCELLED;
      retries += 1;
    }
  }
}

/**
 * Execute one resolved upload plan without parallel reads or writes.
 *
 * Callbacks are injected so the planner remains usable in Node tests and the
 * Documents page remains the only owner of API and FileReader details.
 */
export async function executeFolderUploadPlan(plan, {
  createFolder,
  uploadFile,
  onProgress = () => {},
  shouldCancel = () => false,
  waitForRetry = cancellableRetryWait,
  maxRateLimitRetries = 3,
} = {}) {
  const retryOptions = {
    maxRetries: Math.max(0, Math.floor(Number(maxRateLimitRetries) || 0)),
    shouldCancel,
    waitForRetry,
  };
  const result = {
    createdFolders: [],
    uploaded: [],
    skipped: (plan.files || []).filter((item) => item.action === 'skip'),
    rejected: (plan.files || []).filter((item) => item.action === 'reject'),
    failed: [],
    cancelled: false,
  };
  const resolvedIds = new Map([['root', null]]);
  const failedRefs = new Set();

  for (const folder of plan.folders || []) {
    if (shouldCancel()) {
      result.cancelled = true;
      return result;
    }
    if (folder.action === 'reuse') {
      resolvedIds.set(folder.targetRef, folder.targetId);
      continue;
    }
    const parentId = resolvedIds.has(folder.parentRef)
      ? resolvedIds.get(folder.parentRef)
      : existingIdFromRef(folder.parentRef);
    if (failedRefs.has(folder.parentRef) || parentId === undefined) {
      failedRefs.add(folder.targetRef);
      result.failed.push({ kind: 'folder', item: folder, reason: 'parent-failed' });
      onProgress({ phase: 'folder', status: 'failed', item: folder, reason: 'parent-failed' });
      continue;
    }
    onProgress({ phase: 'folder', status: 'started', item: folder });
    try {
      const created = await runRateLimitedOperation(
        () => createFolder({ name: folder.name, parentId, source: folder }),
        retryOptions,
      );
      const createdId = Number(created?.id ?? created);
      if (!Number.isInteger(createdId) || createdId <= 0) throw new Error('Folder creation returned no id.');
      resolvedIds.set(folder.targetRef, createdId);
      result.createdFolders.push({ ...folder, id: createdId });
      onProgress({ phase: 'folder', status: 'succeeded', item: folder, id: createdId });
    } catch (error) {
      if (error === RATE_LIMIT_CANCELLED) {
        result.cancelled = true;
        return result;
      }
      failedRefs.add(folder.targetRef);
      const reason = error?.status === 429 ? 'rate-limited' : (error?.message || String(error));
      // `error` mit, damit die Seite den Satz der App sagt (#1909): `reason`
      // traegt sonst den Text des Servers oder eine Entwicklermeldung.
      result.failed.push({ kind: 'folder', item: folder, reason, error });
      onProgress({ phase: 'folder', status: 'failed', item: folder, reason });
    }
  }

  for (const item of plan.files || []) {
    if (shouldCancel()) {
      result.cancelled = true;
      return result;
    }
    if (item.action !== 'upload') continue;
    const folderId = resolvedIds.has(item.targetRef)
      ? resolvedIds.get(item.targetRef)
      : existingIdFromRef(item.targetRef);
    if (failedRefs.has(item.targetRef) || folderId === undefined) {
      result.failed.push({ kind: 'file', item, reason: 'parent-failed' });
      onProgress({ phase: 'file', status: 'failed', item, reason: 'parent-failed' });
      continue;
    }
    onProgress({ phase: 'file', status: 'started', item });
    try {
      const uploaded = await runRateLimitedOperation(
        () => uploadFile({
          file: item.file,
          folderId,
          name: item.uploadName,
          originalName: item.uploadOriginalName,
          source: item,
        }),
        retryOptions,
      );
      result.uploaded.push({ ...item, result: uploaded });
      onProgress({ phase: 'file', status: 'succeeded', item, result: uploaded });
    } catch (error) {
      if (error === RATE_LIMIT_CANCELLED) {
        result.cancelled = true;
        return result;
      }
      const reason = error?.status === 429 ? 'rate-limited' : (error?.message || String(error));
      // `error` mit, damit die Seite den Satz der App sagt (#1909): `reason`
      // traegt sonst den Text des Servers oder eine Entwicklermeldung.
      result.failed.push({ kind: 'file', item, reason, error });
      onProgress({ phase: 'file', status: 'failed', item, reason });
    }
  }

  return result;
}
