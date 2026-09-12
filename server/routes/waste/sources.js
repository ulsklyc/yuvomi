/**
 * Module: Waste collection routes - import sources
 * Purpose: source lifecycle (list/create/rename/delete) and mapping
 *          management after commit, the two re-import endpoints (#1063 Phase
 *          3), and the URL-source creation/manual-refresh endpoints (#1063
 *          Phase 7). The two fresh-FILE-import endpoints live in ./import.js;
 *          all of these share server/services/waste-store.js's
 *          previewImport/commitImport and, for URL sources,
 *          server/services/waste-url-source.js's fetch/refresh logic.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import * as store from '../../services/waste-store.js';
import { id as validateId } from '../../middleware/validate.js';
import { wasteErrorResponse, currentUserId, hasWasteWriteAccess, redactSourceForReader } from './helpers.js';
import { MAX_ICS_BYTES } from '../../services/waste-import.js';
import { createUrlSource, refreshUrlSource, fetchIcsText, minutesFromNow } from '../../services/waste-url-source.js';

const log = createLogger('Waste');
const router = express.Router();

router.get('/', (req, res) => {
  try {
    const sources = store.listSources(db.get()).map((s) => redactSourceForReader(s, req));
    res.json({ data: sources });
  } catch (err) {
    log.error('GET /waste/sources error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const source = store.getSource(db.get(), vId.value);
    if (!source) return res.status(404).json({ error: 'Waste import source not found.', code: 404 });
    res.json({ data: { ...redactSourceForReader(source, req), mappings: store.listMappings(db.get(), vId.value) } });
  } catch (err) {
    log.error('GET /waste/sources/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// Creates a URL subscription source. Fresh FILE sources are still created via
// POST /waste/import/commit (./import.js) - a file upload has content to
// commit immediately, a URL source has only a URL until the first fetch this
// call performs synchronously.
router.post('/', async (req, res) => {
  try {
    const body = req.body ?? {};
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ error: 'name is required.', code: 400 });
    }
    const result = await createUrlSource(db.get(), {
      name: body.name,
      url: body.url,
      refreshIntervalMinutes: body.refresh_interval_minutes,
      userId: currentUserId(req),
    });
    res.status(201).json({ data: { ...result, source: redactSourceForReader(result.source, req) } });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/sources error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const source = store.renameSource(db.get(), vId.value, req.body?.name);
    res.json({ data: redactSourceForReader(source, req) });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('PUT /waste/sources/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    store.deleteSource(db.get(), vId.value);
    res.status(204).end();
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('DELETE /waste/sources/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// Manual, on-demand refresh of a URL source (outside its own schedule). Runs
// the exact same fetch/auto-commit/needs-mapping logic the scheduler uses;
// the response's `outcome` tells the client whether to show a mapping wizard
// (see .../reimport/preview|commit below, which a URL source also drives).
router.post('/:id/refresh', async (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const source = store.getSource(db.get(), vId.value);
    if (!source) return res.status(404).json({ error: 'Waste import source not found.', code: 404 });
    if (source.kind !== 'url') {
      return res.status(400).json({ error: 'Manual refresh only applies to URL sources; use re-import for file sources.', code: 400 });
    }
    const result = await refreshUrlSource(db.get(), vId.value);
    res.json({ data: { ...result, source: redactSourceForReader(result.source, req) } });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/sources/:id/refresh error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// GET /api/v1/waste/sources/:id/mapping-profile/export -> portable {pattern, type_name} snapshot (#1063 Phase 10)
router.get('/:id/mapping-profile/export', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    res.json({ data: store.exportMappingProfile(db.get(), vId.value) });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('GET /waste/sources/:id/mapping-profile/export error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/:id/mapping-profile/import/preview', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const preview = store.previewMappingProfileImport(db.get(), vId.value, req.body?.profile);
    res.json({ data: preview });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/sources/:id/mapping-profile/import/preview error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/:id/mapping-profile/import/commit', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const body = req.body ?? {};
    const result = store.commitMappingProfileImport(db.get(), vId.value, body.profile, body.profile_digest ?? null);
    res.json({ data: result });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/sources/:id/mapping-profile/import/commit error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/:id/mappings/:mappingId', (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const vMappingId = validateId(req.params.mappingId, 'mappingId');
    if (vMappingId.error) return res.status(400).json({ error: vMappingId.error, code: 400 });
    const mapping = store.updateMapping(db.get(), vId.value, vMappingId.value, req.body ?? {});
    res.json({ data: mapping });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('PUT /waste/sources/:id/mappings/:mappingId error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

function icsFromBody(req, res) {
  const ics = req.body?.ics;
  if (typeof ics !== 'string' || !ics.trim()) {
    res.status(400).json({ error: 'An ICS file is required.', code: 400 });
    return null;
  }
  if (Buffer.byteLength(ics, 'utf8') > MAX_ICS_BYTES) {
    res.status(400).json({ error: `The file exceeds the ${Math.round(MAX_ICS_BYTES / (1024 * 1024))} MB upload limit.`, code: 400 });
    return null;
  }
  return ics;
}

/**
 * Resolves the ICS text a re-import preview/commit reparses. A FILE source
 * takes it from the request body (existing Phase 3 behavior, unchanged); a
 * URL source always re-fetches server-side from its own stored URL and
 * ignores any client-supplied `ics` - invariant #9 ("never trusts a
 * client-supplied candidate list") extends naturally to "never trusts a
 * client-supplied file body for a source whose whole point is that the
 * server is the fetcher." Conditional GET against the source's last
 * COMMITTED etag/last_modified: if the pending content already reverted to
 * exactly what's committed, there's honestly nothing left to review.
 */
async function icsTextForReimport(source, req, res) {
  if (source.kind === 'url') {
    try {
      const fetched = await fetchIcsText(source.url, { etag: source.etag, lastModified: source.last_modified });
      if (fetched.notModified) {
        res.json({ data: { source_id: source.id, unchanged: true } });
        return null;
      }
      return fetched;
    } catch (err) {
      res.status(502).json({ error: `Fetching the source URL failed: ${err.message}`, code: 502 });
      return null;
    }
  }
  const ics = icsFromBody(req, res);
  return ics === null ? null : { text: ics, etag: null, lastModified: null };
}

router.post('/:id/reimport/preview', async (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const source = store.getSource(db.get(), vId.value);
    if (!source) return res.status(404).json({ error: 'Waste import source not found.', code: 404 });
    const fetched = await icsTextForReimport(source, req, res);
    if (fetched === null) return;
    const preview = store.previewImport(db.get(), { sourceId: vId.value, icsText: fetched.text });
    res.json({ data: preview });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/sources/:id/reimport/preview error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/:id/reimport/commit', async (req, res) => {
  try {
    const vId = validateId(req.params.id, 'id');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const source = store.getSource(db.get(), vId.value);
    if (!source) return res.status(404).json({ error: 'Waste import source not found.', code: 404 });
    const fetched = await icsTextForReimport(source, req, res);
    if (fetched === null) return;
    const body = req.body ?? {};
    // One transaction for the commit AND the URL source's own attempt record
    // (nests via SAVEPOINT under commitImport's own transaction): these were
    // two separate writes before, so a failure recording the attempt after a
    // successful commit left the source pointing at a stale etag/last_modified
    // even though its data had already changed - harmless in the sense that
    // the next fetch just redoes work, but not the atomic "one commit, one
    // outcome" the rest of this file assumes.
    const result = db.get().transaction(() => {
      const committed = store.commitImport(db.get(), {
        sourceId: vId.value,
        name: body.name,
        icsText: fetched.text,
        mappingDecisions: Array.isArray(body.mappings) ? body.mappings : [],
        skipEventKeys: Array.isArray(body.skip_event_keys) ? body.skip_event_keys : [],
        expectedVersion: body.expected_version ?? null,
        previewDigest: body.preview_digest ?? null,
        userId: currentUserId(req),
      });
      // A reviewed, human-completed commit resolves "needs mapping" the same
      // way an auto-commit does, and refreshes the URL source's own
      // etag/last_modified/schedule (from the SAME fetch used to reparse above -
      // no second network round-trip) so the next automatic attempt doesn't
      // immediately re-fetch content that was just reviewed.
      if (source.kind === 'url') {
        store.recordUrlSourceAttempt(db.get(), vId.value, {
          etag: fetched.etag,
          lastModified: fetched.lastModified,
          needsMapping: false,
          errorMessage: null,
          consecutiveFailures: 0,
          nextAttemptAt: minutesFromNow(source.refresh_interval_minutes),
        });
      }
      return committed;
    })();
    res.json({ data: result });
  } catch (err) {
    if (wasteErrorResponse(res, err)) return;
    log.error('POST /waste/sources/:id/reimport/commit error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
export { icsFromBody };
