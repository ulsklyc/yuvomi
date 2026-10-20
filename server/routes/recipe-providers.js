/**
 * Modul: Recipe-Provider Routen
 * Zweck: Recipe-Provider-Accounts verwalten (Admin) und Rezept-Sync anstoßen/beobachten.
 *        Providerspezifische Details stecken im jeweiligen Adapter
 *        (server/services/recipe-providers/{mealie,tandoor}.js); diese Route kennt
 *        nur `provider` als Feld und validiert ihn gegen SUPPORTED_PROVIDERS, exakt
 *        wie server/routes/dms.js es für paperless/papra tut.
 * Abhängigkeiten: express, server/db.js, server/services/recipe-providers/index.js,
 *                 server/services/recipe-provider-sync.js
 */
import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, MAX_TITLE, MAX_URL } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { getAdapter, SUPPORTED_PROVIDERS } from '../services/recipe-providers/index.js';
import {
  isBlockedBaseUrl, isPrivateNetworkRefusal, withPrivateNetworkHint, PRIVATE_NETWORK_MESSAGE,
} from '../services/recipe-providers/private-network.js';
import { classifyProbe } from '../services/recipe-providers/failure.js';
import {
  sync, syncOne, getStatus, recordAccountFailure,
} from '../services/recipe-provider-sync.js';

const log = createLogger('RecipeProviders');
const router = express.Router();

function userId(req) { return req.authUserId || req.session?.userId; }

function publicAccount(row) {
  if (!row) return null;
  const { api_token, ...rest } = row;
  return { ...rest, has_token: Boolean(api_token) };
}

function getAccount(id) {
  return db.get().prepare('SELECT * FROM recipe_provider_accounts WHERE id = ?').get(id);
}

// #1909: die Faelle, die ein Admin im Formular erreicht, tragen einen `reason`
// neben dem englischen `error` - den Satz dazu sagt die App in der Sprache der
// Oberflaeche (public/utils/friendly-error.js). Text und Status bleiben.
function accountGone(res) {
  return res.status(404).json({ error: 'Recipe provider account not found.', code: 404, reason: 'recipe_providers_account_not_found' });
}

function externalUrlInvalid(res) {
  return res.status(400).json({ error: 'External URL must start with http(s)://', code: 400, reason: 'recipe_providers_external_url_invalid' });
}

router.get('/accounts', (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const rows = db.get().prepare('SELECT * FROM recipe_provider_accounts ORDER BY name COLLATE NOCASE').all();
    res.json({ data: rows.map(publicAccount) });
  } catch (err) {
    log.error('GET /accounts error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/accounts', async (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const provider = SUPPORTED_PROVIDERS.includes(req.body.provider) ? req.body.provider : 'mealie';
    const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
    const vUrl = str(req.body.base_url, 'Base URL', { max: MAX_URL });
    const vToken = str(req.body.api_token, 'API token', { max: 500 });
    for (const v of [vName, vUrl, vToken]) if (v.error) return res.status(400).json({ error: v.error, code: 400 });
    if (!/^https?:\/\//i.test(vUrl.value)) {
      return res.status(400).json({ error: 'Base URL must start with http(s)://', code: 400, reason: 'recipe_providers_url_invalid' });
    }

    // Optional: eine von außen erreichbare Adresse für "Im Provider öffnen"-Links,
    // falls base_url (z. B. ein Docker-internes Compose-Hostname) für den
    // Browser des Nutzers nicht erreichbar ist. Leer = base_url dient auch dafür.
    let externalUrl = null;
    if (req.body.external_url) {
      const vExternal = str(req.body.external_url, 'External URL', { max: MAX_URL });
      if (vExternal.error) return res.status(400).json({ error: vExternal.error, code: 400 });
      if (!/^https?:\/\//i.test(vExternal.value)) return externalUrlInvalid(res);
      externalUrl = vExternal.value.replace(/\/+$/, '');
    }

    const baseUrl = vUrl.value.replace(/\/+$/, '');
    // Was sich ohne DNS entscheiden laesst, faellt schon hier (#1053): localhost,
    // reservierte Suffixe und ein IP-Literal aus einem privaten Netz. Die Antwort
    // auf das Formular ist der Ort, an dem ein Admin den Schalter erfaehrt - im
    // Sync-Log Stunden spaeter liest sie niemand. Einen Namen prueft erst der
    // Lookup-Hook im Adapter, je Verbindung.
    if (isBlockedBaseUrl(baseUrl)) {
      return res.status(400).json({ error: PRIVATE_NETWORK_MESSAGE, code: 400, reason: 'recipe_providers_private_network' });
    }
    const test = await getAdapter({ provider, base_url: baseUrl, api_token: vToken.value }).testConnection();
    if (!test.ok) {
      // Der Hook lehnt einen Namen ab, der privat aufloest. Das ist keine
      // Credential-Frage - bis #1053 hiess die Antwort trotzdem so.
      if (isPrivateNetworkRefusal(test.error)) {
        return res.status(400).json({ error: withPrivateNetworkHint(test.error), code: 400, reason: 'recipe_providers_private_network' });
      }
      return res.status(502).json({
        error: 'Could not connect to the recipe provider with these credentials.', code: 502, reason: 'recipe_providers_connection_failed',
      });
    }

    if (!process.env.DB_ENCRYPTION_KEY) {
      log.warn('WARNING: DB_ENCRYPTION_KEY is not set - the recipe provider API token will be stored unencrypted.');
    }

    const result = db.get().prepare(`
      INSERT INTO recipe_provider_accounts (provider, name, base_url, external_url, api_token, created_by) VALUES (?, ?, ?, ?, ?, ?)
    `).run(provider, vName.value, baseUrl, externalUrl, vToken.value, userId(req));
    res.status(201).json({ data: publicAccount(getAccount(result.lastInsertRowid)) });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({
        error: 'A recipe provider account with this URL already exists.', code: 409, reason: 'recipe_providers_account_exists',
      });
    }
    log.error('POST /accounts error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.patch('/accounts/:id', (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const account = getAccount(Number(req.params.id));
    if (!account) return accountGone(res);

    const enabled = req.body.enabled === undefined ? account.enabled : (req.body.enabled ? 1 : 0);
    let name = account.name;
    if (req.body.name !== undefined) {
      const vName = str(req.body.name, 'Name', { max: MAX_TITLE });
      if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });
      name = vName.value;
    }

    let externalUrl = account.external_url;
    if (req.body.external_url !== undefined) {
      if (!req.body.external_url) {
        externalUrl = null;
      } else {
        const vExternal = str(req.body.external_url, 'External URL', { max: MAX_URL });
        if (vExternal.error) return res.status(400).json({ error: vExternal.error, code: 400 });
        if (!/^https?:\/\//i.test(vExternal.value)) return externalUrlInvalid(res);
        externalUrl = vExternal.value.replace(/\/+$/, '');
      }
    }

    db.get().prepare('UPDATE recipe_provider_accounts SET name = ?, enabled = ?, external_url = ? WHERE id = ?')
      .run(name, enabled, externalUrl, account.id);
    res.json({ data: publicAccount(getAccount(account.id)) });
  } catch (err) {
    log.error('PATCH /accounts/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.delete('/accounts/:id', (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const id = Number(req.params.id);
    const existing = getAccount(id);
    if (!existing) return accountGone(res);
    // Löscht per FK-Kaskade auch alle von diesem Account gespiegelten Rezepte
    // (recipes.provider_account_id ON DELETE CASCADE) - ein Mirror-Rezept hat ohne
    // seinen Quell-Account keinen eigenständigen Inhalt mehr.
    db.get().prepare('DELETE FROM recipe_provider_accounts WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /accounts/:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/accounts/:id/test', async (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const account = getAccount(Number(req.params.id));
    if (!account) return accountGone(res);
    const probe = await getAdapter(account).testConnection();
    if (probe.ok) return res.json({ data: probe });
    // Die Lookup-Ablehnung bekommt den Schalter angehaengt (#1053), fuer Log
    // und API. Die Konto-Karte sagt den Satz zum FALL (#1909): er steht neben
    // dem Text am Konto und geht mit dieser Antwort hinaus (`reason`, `params`).
    const failure = classifyProbe(probe);
    // recordAccountFailure haengt den Schalter selbst an - hier der rohe Text.
    recordAccountFailure(account.id, {
      error: probe.error || `HTTP ${probe.status}`, reason: failure?.reason ?? null, params: failure?.params ?? null,
    });
    res.json({
      data: {
        ...probe,
        error: withPrivateNetworkHint(probe.error),
        reason: failure?.reason ?? null,
        ...(failure?.params && { params: failure.params }),
      },
    });
  } catch (err) {
    log.error('POST /accounts/:id/test error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/accounts/:id/sync', async (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const account = getAccount(Number(req.params.id));
    if (!account) return accountGone(res);
    const result = await syncOne(account.id);
    res.json({ data: result });
  } catch (err) {
    log.error('POST /accounts/:id/sync error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

router.post('/sync', async (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ error: 'Not authorized.', code: 403 });
    const result = await sync();
    res.json({ data: result });
  } catch (err) {
    log.error('POST /sync error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// Auch für Nicht-Admins lesbar: die Rezepte-Seite zeigt "zuletzt synchronisiert"
// pro Account, ohne den API-Token selbst offenzulegen (publicAccount-Strip greift
// hier ohnehin nicht, getStatus() liefert nie den Token).
router.get('/status', (_req, res) => {
  try {
    res.json({ data: getStatus() });
  } catch (err) {
    log.error('GET /status error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
