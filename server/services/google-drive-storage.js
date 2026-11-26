import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import * as db from '../db.js';
import { withTx } from '../db/tx.ts';
import { createLogger } from '../logger.js';
import { MAX_UPLOAD_BYTES } from '../utils/upload-limit.js';

const log = createLogger('GoogleDriveStorage');
const CONFIG_PREFIX = 'document_storage_google_drive_';
const SELECTED_BACKEND_KEY = 'document_storage_selected_backend';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const APP_FOLDER_NAME = 'Yuvomi';
const DOCUMENTS_FOLDER_NAME = 'Documents';
const DISPLAY_FOLDER_NAME = `${APP_FOLDER_NAME}/${DOCUMENTS_FOLDER_NAME}`;
const MAX_READ_BYTES = MAX_UPLOAD_BYTES;

const defaultGoogleApiFactory = {
  createOAuth2: (clientId, clientSecret, redirectUri) => (
    new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  ),
  createDrive: (auth) => google.drive({ version: 'v3', auth }),
};
let googleApiFactory = defaultGoogleApiFactory;

export class GoogleDriveStorageError extends Error {
  constructor(storageCode, message, options = {}) {
    super(message, options);
    this.name = 'GoogleDriveStorageError';
    this.storageCode = storageCode;
  }
}

function cfgGet(field) {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?')
    .get(`${CONFIG_PREFIX}${field}`)?.value ?? null;
}

function cfgSet(field, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(`${CONFIG_PREFIX}${field}`, String(value));
}

function cfgDel(field) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?')
    .run(`${CONFIG_PREFIX}${field}`);
}

const PARTIAL_CREDENTIAL_MESSAGE = 'GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET must both be set or both be empty.';

function credentialConfig() {
  const driveClientId = String(process.env.GOOGLE_DRIVE_CLIENT_ID || '').trim();
  const driveClientSecret = String(process.env.GOOGLE_DRIVE_CLIENT_SECRET || '').trim();
  const fallbackClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const fallbackClientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.GOOGLE_DRIVE_REDIRECT_URI || '').trim();
  const hasDriveClientId = Boolean(driveClientId);
  const hasDriveClientSecret = Boolean(driveClientSecret);
  if (hasDriveClientId !== hasDriveClientSecret) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_INVALID_CONFIG',
      PARTIAL_CREDENTIAL_MESSAGE
    );
  }
  return {
    clientId: hasDriveClientId ? driveClientId : fallbackClientId,
    clientSecret: hasDriveClientSecret ? driveClientSecret : fallbackClientSecret,
    redirectUri,
  };
}

function createClient() {
  const config = credentialConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_NOT_CONFIGURED',
      'Google Drive OAuth credentials and GOOGLE_DRIVE_REDIRECT_URI must be configured.'
    );
  }
  return googleApiFactory.createOAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri
  );
}

/**
 * @param {any} client
 * @param {string} refreshToken the grant this client was loaded with
 */
function attachTokenPersistence(client, refreshToken) {
  client.on?.('tokens', (/** @type {any} */ tokens) => {
    // A client kept from before another account was connected (the cleanup
    // of a staged upload, #2946) must not write its access token over the
    // new account's.
    if (cfgGet('refresh_token') !== refreshToken) return;
    if (tokens.access_token) cfgSet('access_token', tokens.access_token);
    if (tokens.expiry_date) cfgSet('token_expiry', tokens.expiry_date);
  });
}

function loadAuthorizedClient() {
  const refreshToken = cfgGet('refresh_token');
  if (!refreshToken) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_NOT_CONFIGURED',
      'Google Drive is not connected.'
    );
  }
  const client = createClient();
  client.setCredentials({
    access_token: cfgGet('access_token') || undefined,
    refresh_token: refreshToken,
    expiry_date: cfgGet('token_expiry')
      ? Number.parseInt(cfgGet('token_expiry'), 10)
      : undefined,
  });
  attachTokenPersistence(client, refreshToken);
  return client;
}

function createDrive(client = loadAuthorizedClient()) {
  return googleApiFactory.createDrive(client);
}

function isNotFound(error) {
  return error?.code === 404
    || error?.status === 404
    || error?.response?.status === 404;
}

function driveQueryLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolder(drive, name, parentId = null) {
  const parentClause = parentId ? ` and '${driveQueryLiteral(parentId)}' in parents` : '';
  const response = await drive.files.list({
    q: `name = '${driveQueryLiteral(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false${parentClause}`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1,
  });
  return response.data.files?.[0] ?? null;
}

async function createFolder(drive, name, parentId = null) {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id,name',
  });
  return response.data;
}

/**
 * @param {any} drive
 * @param {{ persist?: boolean, accountId?: string | null }} [options]
 *   `accountId`: the account `drive` belongs to; without it the stored one,
 *   read here before the first await
 */
async function ensureAppFolder(drive, { persist = true, accountId = cfgGet('account_id') } = {}) {
  const storedId = cfgGet('folder_id');
  if (storedId) {
    try {
      const response = await drive.files.get({
        fileId: storedId,
        fields: 'id,name,mimeType,trashed',
      });
      if (response.data.mimeType === FOLDER_MIME && response.data.trashed !== true) {
        return { id: response.data.id, name: DISPLAY_FOLDER_NAME };
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  const appFolder = await findFolder(drive, APP_FOLDER_NAME)
    || await createFolder(drive, APP_FOLDER_NAME);
  const documentsFolder = await findFolder(drive, DOCUMENTS_FOLDER_NAME, appFolder.id)
    || await createFolder(drive, DOCUMENTS_FOLDER_NAME, appFolder.id);
  // The folder belongs to the account of `drive`. Another account connected
  // during the awaits above has its own folder; this one is not written over
  // it (#2946).
  if (persist && cfgGet('account_id') === accountId) {
    cfgSet('folder_id', documentsFolder.id);
    cfgSet('folder_name', DISPLAY_FOLDER_NAME);
  }
  return { id: documentsFolder.id, name: DISPLAY_FOLDER_NAME };
}

async function streamToBuffer(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length > MAX_READ_BYTES) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_READ_FAILED',
        'The Google Drive document exceeds the maximum readable size.'
      );
    }
    return value;
  }
  if (value instanceof Uint8Array || typeof value === 'string') {
    return streamToBuffer(Buffer.from(value));
  }
  if (!value || typeof value[Symbol.asyncIterator] !== 'function') {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_READ_FAILED',
      'Google Drive returned an unreadable document response.'
    );
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of value) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_READ_BYTES) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_READ_FAILED',
        'The Google Drive document exceeds the maximum readable size.'
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function safeOriginalName(value) {
  const basename = String(value || 'document').split(/[\\/]/).pop() || 'document';
  return basename.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'document';
}

function driveDocumentCount() {
  return db.get().prepare(`
    SELECT COUNT(*) AS count
    FROM family_documents
    WHERE storage_backend = 'google_drive'
  `).get().count;
}

function selectedBackend() {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?')
    .get(SELECTED_BACKEND_KEY)?.value ?? null;
}

export function getAuthUrl(session) {
  const client = createClient();
  const state = randomBytes(32).toString('hex');
  if (session) session.googleDriveOAuthState = state;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [DRIVE_SCOPE],
    state,
  });
}

function firstDriveDocument() {
  return db.get().prepare(`
    SELECT storage_key
    FROM family_documents
    WHERE storage_backend = 'google_drive'
    ORDER BY id
    LIMIT 1
  `).get();
}

// Documents already in Drive belong to the stored account; another account
// would cut them off.
/** @param {{ permissionId?: string | null }} account */
function assertStoringAccount(account) {
  const storedAccountId = cfgGet('account_id');
  if (!storedAccountId || storedAccountId !== account.permissionId) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONFIG_PROTECTED',
      'The connected Google account does not match the account that stores existing documents.'
    );
  }
}

/** The account new uploads go to; no secret (#2946, upload target stamp). */
export function connectedAccountId() {
  return cfgGet('account_id');
}

/**
 * The connection an upload goes through, opened in one synchronous step: the
 * authorized client of the stored grant and the account it belongs to
 * (#2946). The caller keeps it in memory for the request only, to stamp the
 * upload and to remove the file again through the same account if the write
 * is refused; it is never stored or logged.
 */
export function openUploadConnection() {
  return { accountId: cfgGet('account_id'), drive: createDrive() };
}

export async function handleCallback(code) {
  const candidate = createClient();
  const { tokens } = await candidate.getToken(code);
  if (!tokens.refresh_token) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_NOT_CONFIGURED',
      'Google did not return a refresh token. Revoke the previous grant and reconnect.'
    );
  }
  candidate.setCredentials(tokens);
  const drive = createDrive(candidate);
  const about = await drive.about.get({
    fields: 'user(displayName,emailAddress,permissionId)',
  });
  const account = about.data.user;
  if (!account?.permissionId) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED',
      'Google Drive did not return a stable account identity.'
    );
  }

  const existingDocument = firstDriveDocument();
  if (existingDocument) {
    assertStoringAccount(account);
    try {
      await drive.files.get({ fileId: existingDocument.storage_key, fields: 'id' });
    } catch (error) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_CONFIG_PROTECTED',
        'The proposed Google Drive connection cannot read an existing document.',
        { cause: error }
      );
    }
  }

  const folder = await ensureAppFolder(drive, { persist: false });
  withTx(db.get(), () => {
    // The Drive calls above let other requests run (#2946): a first document
    // may have been stored meanwhile. The account check is decided again on
    // the documents as they are at the write.
    if (firstDriveDocument()) assertStoringAccount(account);
    if (tokens.access_token) cfgSet('access_token', tokens.access_token);
    else cfgDel('access_token');
    cfgSet('refresh_token', tokens.refresh_token);
    if (tokens.expiry_date) cfgSet('token_expiry', tokens.expiry_date);
    else cfgDel('token_expiry');
    cfgSet('folder_id', folder.id);
    cfgSet('folder_name', folder.name);
    cfgSet('account_id', account.permissionId);
    if (account.emailAddress) cfgSet('account_email', account.emailAddress);
    else cfgDel('account_email');
    if (account.displayName) cfgSet('account_name', account.displayName);
    else cfgDel('account_name');
    cfgDel('last_error');
  });
  log.info('Google Drive OAuth connection saved.');
  return getStatus();
}

export function getStatus() {
  let config = null;
  let configurationError = null;
  try {
    config = credentialConfig();
  } catch (error) {
    if (
      error instanceof GoogleDriveStorageError
      && error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
    ) {
      configurationError = error;
    } else {
      throw error;
    }
  }
  const configured = Boolean(
    !configurationError
    && config?.clientId
    && config.clientSecret
    && config.redirectUri
  );
  const connected = Boolean(
    configured
    && cfgGet('refresh_token')
    && cfgGet('account_id')
    && cfgGet('folder_id')
  );
  const documentCount = driveDocumentCount();
  return {
    configured,
    connected,
    account_email: cfgGet('account_email'),
    account_name: cfgGet('account_name'),
    folder_name: cfgGet('folder_name') || DISPLAY_FOLDER_NAME,
    document_count: documentCount,
    last_test: cfgGet('last_test'),
    last_error: configurationError?.message || cfgGet('last_error'),
    can_disconnect: documentCount === 0 && selectedBackend() !== 'google_drive',
  };
}

/**
 * @param {{ buffer?: any, mime?: string, originalName?: string,
 *   connection?: { drive: any, accountId: string | null } }} [options]
 *   `connection` from openUploadConnection(); without it the stored grant
 */
export async function uploadFile({ buffer, mime = 'application/octet-stream', originalName, connection } = {}) {
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const { drive, accountId } = connection ?? openUploadConnection();
  const folder = await ensureAppFolder(drive, { accountId });
  try {
    const response = await drive.files.create({
      requestBody: {
        name: `${randomUUID()}-${safeOriginalName(originalName)}`,
        parents: [folder.id],
      },
      media: {
        mimeType: mime,
        body: Readable.from(content),
      },
      fields: 'id',
    });
    if (!response.data.id) throw new Error('Google Drive did not return a file ID.');
    return response.data.id;
  } catch (error) {
    if (error instanceof GoogleDriveStorageError) throw error;
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_UPLOAD_FAILED',
      'The document could not be uploaded to Google Drive.',
      { cause: error }
    );
  }
}

/**
 * @param {string} fileId
 * @param {{ connection?: { drive: any } }} [options] the connection to read
 *   through; without it the stored grant
 */
export async function readFile(fileId, { connection } = {}) {
  const drive = connection?.drive ?? createDrive();
  try {
    const metadata = await drive.files.get({
      fileId,
      fields: 'id,size,mimeType',
    });
    const size = Number(metadata.data.size);
    if (Number.isFinite(size) && size > MAX_READ_BYTES) {
      throw new GoogleDriveStorageError(
        'DOCUMENT_STORAGE_READ_FAILED',
        'The Google Drive document exceeds the maximum readable size.'
      );
    }
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    return {
      buffer: await streamToBuffer(response.data),
      mime: metadata.data.mimeType || 'application/octet-stream',
    };
  } catch (error) {
    if (error instanceof GoogleDriveStorageError) throw error;
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_READ_FAILED',
      'The Google Drive document could not be read.',
      { cause: error }
    );
  }
}

/**
 * @param {string} fileId
 * @param {{ connection?: { drive: any } }} [options] the connection the file
 *   was uploaded through; without it the stored grant
 */
export async function deleteFile(fileId, { connection } = {}) {
  const drive = connection?.drive ?? createDrive();
  try {
    await drive.files.delete({ fileId });
  } catch (error) {
    if (isNotFound(error)) return;
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_DELETE_FAILED',
      'The Google Drive document could not be deleted.',
      { cause: error }
    );
  }
}

export async function testConnection() {
  const expected = Buffer.from(`yuvomi-google-drive-test:${randomUUID()}`);
  let fileId = null;
  // The whole roundtrip goes through one account, and its result is written
  // only while that account is still the connected one: another account
  // connected during the test has not been tested (#2946).
  /** @type {{ drive: any, accountId: string | null } | null} */
  let connection = null;
  const stillConnected = () => connection !== null && cfgGet('account_id') === connection.accountId;
  try {
    connection = openUploadConnection();
    fileId = await uploadFile({
      buffer: expected,
      mime: 'application/octet-stream',
      originalName: '.connection-test.bin',
      connection,
    });
    const actual = await readFile(fileId, { connection });
    if (!actual.buffer.equals(expected)) {
      throw new Error('Google Drive roundtrip verification failed.');
    }
    await deleteFile(fileId, { connection });
    fileId = null;
    if (stillConnected()) {
      cfgSet('last_test', new Date().toISOString());
      cfgDel('last_error');
    }
    return { ok: true };
  } catch (error) {
    if (fileId) {
      try {
        await deleteFile(fileId, { connection: connection ?? undefined });
      } catch {
        // Preserve the primary test failure.
      }
    }
    if (
      error instanceof GoogleDriveStorageError
      && (
        error.storageCode === 'DOCUMENT_STORAGE_INVALID_CONFIG'
        || error.storageCode === 'DOCUMENT_STORAGE_NOT_CONFIGURED'
      )
    ) {
      throw error;
    }
    if (stillConnected()) cfgSet('last_error', 'Google Drive connection test failed.');
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONNECTION_TEST_FAILED',
      'The Google Drive connection test failed.',
      { cause: error }
    );
  }
}

export function disconnect() {
  const count = driveDocumentCount();
  if (count > 0) {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONFIG_PROTECTED',
      'Google Drive cannot be disconnected while Drive-backed documents exist.'
    );
  }
  if (selectedBackend() === 'google_drive') {
    throw new GoogleDriveStorageError(
      'DOCUMENT_STORAGE_CONFIG_PROTECTED',
      'Select another upload destination before disconnecting Google Drive.'
    );
  }
  // Escape LIKE wildcards in the prefix so each literal underscore stays literal;
  // otherwise the sweep could widen to unrelated document_storage_* keys.
  const escapedPrefix = CONFIG_PREFIX.replace(/[\\%_]/g, '\\$&');
  db.get().prepare("DELETE FROM sync_config WHERE key LIKE ? ESCAPE '\\'")
    .run(`${escapedPrefix}%`);
  log.info('Google Drive disconnected without revoking shared OAuth credentials.');
}

export function __setGoogleApiFactoryForTests(factory) {
  googleApiFactory = factory || defaultGoogleApiFactory;
}

export const __test = {
  DRIVE_SCOPE,
  MAX_READ_BYTES,
  createClient,
  loadAuthorizedClient,
  ensureAppFolder,
  streamToBuffer,
};
