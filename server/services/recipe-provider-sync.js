/**
 * Modul: Recipe-Provider-Sync
 * Zweck: Rezepte eines selbst gehosteten Recipe-Providers (Mealie, Tandoor, ...)
 *        read-only in die lokale recipes/recipe_ingredients-Tabelle spiegeln. Der
 *        Provider bleibt Quelle der Wahrheit für Rezeptinhalte; hier passiert nur
 *        Import, nie Schreibzugriff zurück zum Provider. Providerspezifische
 *        Details stecken ausschließlich im jeweiligen Adapter
 *        (./recipe-providers/{mealie,tandoor}.js) - dieses Modul kennt nur das
 *        gemeinsame Adapter-Interface aus ./recipe-providers/index.js.
 *
 *        Löschungen werden nur übernommen, wenn der Abruf dieses Laufs tatsächlich
 *        erfolgreich war und Rezepte zurückgeliefert hat - ein Netzwerkfehler, ein
 *        abgelaufener Token oder eine leere Antwort dürfen den lokalen Spiegel nie
 *        leeren (gleicher Leer-Guard wie calendar-prune.js für CalDAV/Apple).
 *
 * Dependencies: server/db.js, ./recipe-providers/index.js
 */
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { getAdapter } from './recipe-providers/index.js';

const log = createLogger('RecipeProviderSync');

// Rezepte ändern sich weit seltener als Kalendertermine - eine stündliche
// Auto-Sync reicht, "Sync now" in den Einstellungen deckt den ungeduldigen Fall ab.
const SYNC_INTERVAL_MS = 60 * 60_000;

function getEnabledAccounts() {
  return db.get().prepare('SELECT * FROM recipe_provider_accounts WHERE enabled = 1').all();
}

function getAccountById(id) {
  return db.get().prepare('SELECT * FROM recipe_provider_accounts WHERE id = ?').get(id);
}

/**
 * Ein Account-Durchlauf: Rezeptliste abrufen, geänderte Rezepte im Detail
 * nachladen, upserten, dann lokale Mirror-Rezepte löschen, die der Provider nicht
 * mehr liefert. Wirft nie - ein Fehler wird als { failed: true } gemeldet,
 * damit ein kaputter Account den Sync-Lauf anderer Accounts nicht abbricht.
 */
async function syncAccount(account) {
  const adapter = getAdapter(account);
  const conn = db.get();

  let summaries;
  let linkContext = null;
  try {
    const test = await adapter.testConnection();
    linkContext = test.linkContext || null;
    summaries = await adapter.listRecipeSummaries();
  } catch (err) {
    log.error(`Account ${account.id} ("${account.name}"): fetch failed, skipping this pass:`, err.message);
    return { imported: 0, updated: 0, deleted: 0, failed: true, error: err.message };
  }

  const existing = conn.prepare(
    'SELECT id, provider_recipe_id, provider_updated_at, provider_slug, recipe_url FROM recipes WHERE provider_account_id = ?'
  ).all(account.id);
  const existingByProviderId = new Map(existing.map((r) => [r.provider_recipe_id, r]));

  // Fetch-Phase zuerst (sequentielle awaits, kein DB-Schreibzugriff), danach EIN
  // gebündelter Schreib-Durchlauf in einer einzigen Transaktion (Konvention:
  // ics-subscription.js) statt einer eigenen Transaktion pro Rezept.
  const seenIds = new Set();
  const toUpsert = [];
  const urlRefresh = [];

  for (const summary of summaries) {
    // Providers stabiler Schlüssel (summary.id), NICHT summary.ref: der Ref
    // (Mealies Slug, Tandoors Id-als-String) kann sich bei manchen Providern mit
    // einer Umbenennung ändern. Mit dem Ref als Schlüssel würde ein Umbenennen als
    // Löschen+Neuanlegen erscheinen und jede Essensplan-Verknüpfung zu diesem
    // Rezept stumm verlieren (meals.recipe_id ON DELETE SET NULL). Der Ref wird
    // weiterhin für den Detail-Abruf gebraucht (adapter.getRecipe(ref)).
    seenIds.add(summary.id);
    const current = existingByProviderId.get(summary.id);
    if (current && current.provider_updated_at === summary.updatedAt) {
      // Unverändert beim Provider - den vollen Detail-Abruf sparen, aber
      // recipe_url trotzdem aus den gespeicherten Feldern neu bauen: ein Sync ist
      // der einzige Moment, in dem eine nachträgliche external_url/base_url-
      // Änderung am Account auf schon gespiegelte Rezepte durchschlägt. Ohne das
      // bliebe der alte (evtl. Docker-interne, im Browser blackholed) Link
      // stehen, bis sich das Rezept beim Provider selbst wieder ändert - und
      // genau das war der Grund, external_url überhaupt einzuführen.
      //
      // Truthy-Guard auf freshUrl statt eines Vorab-Checks, welche Felder
      // existieren: adapter.recipeUrl() liefert null, wenn ihm ein Provider (z.B.
      // Mealie ohne linkContext) den Link nicht bauen kann - dann lieber den
      // alten Link stehen lassen, statt ihn mit null zu überschreiben. Diese eine
      // Prüfung deckt jeden Adapter ab, unabhängig davon, ob er slug, id oder
      // beides für seinen Link braucht.
      const freshUrl = adapter.recipeUrl(linkContext, { id: current.provider_recipe_id, slug: current.provider_slug });
      if (freshUrl && freshUrl !== current.recipe_url) urlRefresh.push({ id: current.id, recipeUrl: freshUrl });
      continue;
    }

    let detail;
    try {
      detail = await adapter.getRecipe(summary.ref);
    } catch (err) {
      log.error(`Account ${account.id}: failed to fetch recipe "${summary.ref}":`, err.message);
      continue; // nur dieses eine Rezept überspringen, Rest des Laufs weitermachen
    }

    const recipeUrl = adapter.recipeUrl(linkContext, { id: detail.id, slug: detail.slug });
    toUpsert.push({ current, detail, recipeUrl });
  }

  // Leer-Guard: existieren lokal Mirror-Rezepte, aber der Provider liefert
  // diesmal gar keine Summaries, ist das eher ein stiller Server-/Auth-Fehler
  // als eine tatsächlich geleerte Sammlung - nicht löschen (vgl. calendar-prune.js).
  let stale = [];
  if (summaries.length > 0 || existing.length === 0) {
    stale = existing.filter((r) => !seenIds.has(r.provider_recipe_id));
  } else if (existing.length > 0) {
    log.warn(`Account ${account.id} ("${account.name}"): provider returned no recipes, but ${existing.length} exist locally. Skipping deletion.`);
  }

  const insRecipe = conn.prepare(`
    INSERT INTO recipes (title, notes, recipe_url, created_by, provider_account_id, provider_recipe_id, provider_updated_at, provider_slug, provider_has_image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updRecipe = conn.prepare(`
    UPDATE recipes SET title = ?, notes = ?, recipe_url = ?, provider_updated_at = ?, provider_slug = ?, provider_has_image = ? WHERE id = ?
  `);
  const updUrl = conn.prepare('UPDATE recipes SET recipe_url = ? WHERE id = ?');
  const delIngredients = conn.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?');
  const insIngredient = conn.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, ?, ?, ?)
  `);
  const delRecipe = conn.prepare('DELETE FROM recipes WHERE id = ?');

  let imported = 0;
  let updated = 0;

  db.transaction(() => {
    for (const { current, detail, recipeUrl } of toUpsert) {
      const hasImage = detail.hasImage ? 1 : 0;
      let id;
      if (current) {
        updRecipe.run(detail.title, detail.notes || null, recipeUrl, detail.updatedAt, detail.slug, hasImage, current.id);
        id = current.id;
        updated++;
      } else {
        const result = insRecipe.run(
          detail.title, detail.notes || null, recipeUrl,
          account.created_by, account.id, detail.id, detail.updatedAt, detail.slug, hasImage,
        );
        id = Number(result.lastInsertRowid);
        imported++;
      }
      delIngredients.run(id);
      for (const ing of detail.ingredients) insIngredient.run(id, ing.name, ing.quantity, ing.category);
    }
    for (const r of urlRefresh) updUrl.run(r.recipeUrl, r.id);
    for (const r of stale) delRecipe.run(r.id);
  });

  return { imported, updated, deleted: stale.length, failed: false };
}

/** Schreibt last_sync/last_error auf den Account nach einem Durchlauf. Gibt zurück, ob er erfolgreich war. */
function recordAccountResult(account, result) {
  if (result.failed) {
    db.get().prepare('UPDATE recipe_provider_accounts SET last_error = ? WHERE id = ?').run(result.error, account.id);
    return false;
  }
  db.get().prepare('UPDATE recipe_provider_accounts SET last_sync = ?, last_error = NULL WHERE id = ?')
    .run(new Date().toISOString(), account.id);
  return true;
}

/** Sync-Durchlauf über alle aktivierten Accounts, egal welchen Providers. */
export async function sync() {
  const accounts = getEnabledAccounts();
  if (accounts.length === 0) {
    log.debug('No enabled recipe provider accounts configured.');
    return { success: true, syncedAccounts: 0, imported: 0, updated: 0, deleted: 0 };
  }

  let totalImported = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let successfulAccounts = 0;

  for (const account of accounts) {
    const result = await syncAccount(account);
    if (recordAccountResult(account, result)) successfulAccounts++;
    totalImported += result.imported;
    totalUpdated += result.updated;
    totalDeleted += result.deleted;
  }

  const summary = `Recipe provider sync complete: ${successfulAccounts}/${accounts.length} accounts, `
    + `${totalImported} imported, ${totalUpdated} updated, ${totalDeleted} deleted.`;
  if (totalImported || totalUpdated || totalDeleted) log.info(summary);
  else log.debug(summary);

  return { success: true, syncedAccounts: successfulAccounts, imported: totalImported, updated: totalUpdated, deleted: totalDeleted };
}

/** Manueller Sync eines einzelnen Accounts (Settings-Seite "Sync now"). */
export async function syncOne(accountId) {
  const account = getAccountById(accountId);
  if (!account) throw new Error('Recipe provider account not found.');

  const result = await syncAccount(account);
  recordAccountResult(account, result);
  return result;
}

export function getStatus() {
  const accounts = db.get().prepare('SELECT * FROM recipe_provider_accounts ORDER BY name COLLATE NOCASE').all();
  const counts = db.get().prepare(`
    SELECT provider_account_id, COUNT(*) AS c FROM recipes
    WHERE provider_account_id IS NOT NULL GROUP BY provider_account_id
  `).all();
  const countByAccount = new Map(counts.map((row) => [row.provider_account_id, row.c]));
  return accounts.map((acc) => ({
    id: acc.id,
    provider: acc.provider,
    name: acc.name,
    baseUrl: acc.base_url,
    externalUrl: acc.external_url,
    enabled: !!acc.enabled,
    lastSync: acc.last_sync,
    lastError: acc.last_error,
    recipeCount: countByAccount.get(acc.id) ?? 0,
  }));
}

export function startScheduler() {
  const run = () => {
    sync().catch((err) => log.error('Recipe provider sync scheduler run failed:', err?.message || err));
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, SYNC_INTERVAL_MS).unref();
  log.info('Recipe provider sync scheduler active (every 60 min).');
}
