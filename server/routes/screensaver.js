/** Immich-backed photo screensaver. Credentials never leave the server. */
import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';

const router = express.Router();
const log = createLogger('Screensaver');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function config() {
  const cfgGet = (key) => db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value || '';
  const baseUrl = String(process.env.IMMICH_URL || cfgGet('immich_url')).trim().replace(/\/+$/, '');
  const apiKey = String(process.env.IMMICH_API_KEY || cfgGet('immich_api_key')).trim();
  const albumId = String(process.env.IMMICH_SCREENSAVER_ALBUM_ID || cfgGet('immich_screensaver_album_id')).trim();
  return {
    baseUrl,
    apiKey,
    albumId: UUID_RE.test(albumId) ? albumId : '',
    enabled: Boolean(baseUrl && apiKey && /^https?:\/\//i.test(baseUrl)),
  };
}

function requireAdmin(req, res, next) {
  if (req.authRole !== 'admin') return res.status(403).json({ error: 'Admin access required.', code: 403 });
  next();
}

function cfgSet(key, value) {
  db.get().prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`).run(key, value);
}

function immichUrl(baseUrl, path) {
  // Accept both the server root and the commonly copied URL ending in /api.
  return `${baseUrl.replace(/\/api$/i, '')}/api${path}`;
}

async function immichFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

router.get('/config', requireAdmin, (_req, res) => {
  const cfg = config();
  res.json({ data: {
    url: cfg.baseUrl,
    albumId: cfg.albumId,
    apiKeySet: Boolean(cfg.apiKey),
    enabled: cfg.enabled,
    envControlled: {
      url: Boolean(process.env.IMMICH_URL),
      apiKey: Boolean(process.env.IMMICH_API_KEY),
      albumId: Boolean(process.env.IMMICH_SCREENSAVER_ALBUM_ID),
    },
  } });
});

router.put('/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (body.url !== undefined && !process.env.IMMICH_URL) {
    const url = String(body.url).trim().replace(/\/+$/, '');
    if (url && (!/^https?:\/\//i.test(url) || url.length > 2048)) {
      return res.status(400).json({ error: 'Invalid Immich URL.', code: 400 });
    }
    cfgSet('immich_url', url);
  }
  if (body.albumId !== undefined && !process.env.IMMICH_SCREENSAVER_ALBUM_ID) {
    const albumId = String(body.albumId).trim();
    if (albumId && !UUID_RE.test(albumId)) {
      return res.status(400).json({ error: 'Invalid album ID.', code: 400 });
    }
    cfgSet('immich_screensaver_album_id', albumId);
  }
  if (typeof body.apiKey === 'string' && body.apiKey && !process.env.IMMICH_API_KEY) {
    if (body.apiKey.length > 1000) return res.status(400).json({ error: 'Invalid API key.', code: 400 });
    cfgSet('immich_api_key', body.apiKey);
    if (!process.env.DB_ENCRYPTION_KEY) {
      log.warn('DB_ENCRYPTION_KEY is not set - the Immich API key is stored in an unencrypted database.');
    }
  } else if (body.clearApiKey === true && !process.env.IMMICH_API_KEY) {
    cfgSet('immich_api_key', '');
  }
  const cfg = config();
  res.json({ data: { enabled: cfg.enabled, apiKeySet: Boolean(cfg.apiKey) } });
});

router.post('/test', requireAdmin, async (_req, res) => {
  const cfg = config();
  if (!cfg.enabled) return res.status(400).json({ error: 'Immich is not configured.', code: 400 });
  try {
    const response = await immichFetch(immichUrl(cfg.baseUrl, '/search/random'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
      body: JSON.stringify({ size: 1, type: 'IMAGE', ...(cfg.albumId ? { albumIds: [cfg.albumId] } : {}) }),
    });
    if (!response.ok) return res.status(502).json({ error: `Immich returned ${response.status}.`, code: 502 });
    const assets = await response.json();
    res.json({ data: { ok: true, photoCount: Array.isArray(assets) ? assets.length : 0 } });
  } catch (error) {
    log.warn('Immich connection test failed:', error.message);
    res.status(502).json({ error: 'Could not connect to Immich.', code: 502 });
  }
});

router.get('/photos', async (_req, res) => {
  const cfg = config();
  if (!cfg.enabled) return res.json({ data: { enabled: false, photos: [] } });

  try {
    const body = { size: 30, type: 'IMAGE' };
    if (cfg.albumId) body.albumIds = [cfg.albumId];
    const response = await immichFetch(immichUrl(cfg.baseUrl, '/search/random'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Immich returned ${response.status}`);
    const assets = await response.json();
    const photos = (Array.isArray(assets) ? assets : [])
      .filter((asset) => UUID_RE.test(asset?.id))
      .map((asset) => ({
        id: asset.id,
        takenAt: asset.localDateTime || asset.fileCreatedAt || null,
        city: asset.exifInfo?.city || null,
        country: asset.exifInfo?.country || null,
      }));
    res.json({ data: { enabled: true, photos } });
  } catch (error) {
    log.warn('Could not load Immich screensaver photos:', error.message);
    res.status(502).json({ error: 'Immich is unavailable.', code: 502 });
  }
});

router.get('/photos/:id', async (req, res) => {
  const cfg = config();
  if (!cfg.enabled) return res.status(404).end();
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid asset ID.', code: 400 });

  try {
    // Preview avoids Immich's fullsize redirect, which would additionally require
    // asset.download permission and is unnecessarily large for a tablet display.
    const response = await immichFetch(immichUrl(cfg.baseUrl, `/assets/${req.params.id}/thumbnail?size=preview`), {
      headers: { 'x-api-key': cfg.apiKey },
    });
    if (!response.ok) throw new Error(`Immich returned ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('Immich returned a non-image response');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    const bytes = await response.arrayBuffer();
    res.send(Buffer.from(bytes));
  } catch (error) {
    log.warn('Could not proxy Immich thumbnail:', error.message);
    res.status(502).end();
  }
});

export const __test = { config, immichUrl };
export default router;
