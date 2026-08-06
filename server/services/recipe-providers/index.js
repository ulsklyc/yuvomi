/**
 * Modul: Recipe-Provider Adapter Factory
 * Zweck: Löst eine konfigurierte recipe_provider_accounts-Zeile auf ihre
 *        konkrete Adapter-Instanz auf. Jeder Adapter implementiert dasselbe
 *        Interface, damit recipe-provider-sync.js/recipe-providers.js keinen
 *        einzigen Provider-spezifischen Codepfad brauchen:
 *
 *          constructor(account)                  account-Zeile: { base_url, external_url, api_token, ... }
 *          async testConnection()                -> { ok, status, error?, linkContext? }
 *          async listRecipeSummaries()            -> Array<{ id, ref, updatedAt }>
 *                                                     id  = stabiler Provider-Schlüssel (Upsert-Key,
 *                                                           überlebt Umbenennungen)
 *                                                     ref = Schlüssel für den Detail-Abruf via getRecipe()
 *          async getRecipe(ref)                   -> { id, updatedAt, slug, title, notes, hasImage,
 *                                                       ingredients: [{ name, quantity, category }] }
 *                                                     slug: opak, adapterdefiniert, wird in
 *                                                     recipes.provider_slug persistiert, damit
 *                                                     recipeUrl()/fetchThumbnail() ohne erneuten
 *                                                     Detail-Abruf rekonstruieren können
 *          recipeUrl(linkContext, { id, slug })   -> string | null   (Deep-Link zum Quell-Rezept)
 *          async fetchThumbnail({ id, slug })     -> { buffer: Buffer, mime: string }
 *
 *        `recipeUrl`/`fetchThumbnail` nehmen ein { id, slug }-Objekt statt zweier
 *        positionaler Argumente an, weil jeder Adapter sich das Feld greift, das
 *        er tatsächlich braucht: Mealies Link braucht slug, Tandoors id; Mealies
 *        Thumbnail braucht id, Tandoors slug (der gespeicherte Bildpfad). Eine
 *        einzige positionale Konvention würde bei einem der beiden Adapter
 *        stillschweigend das falsche Feld übergeben.
 * Dependencies: ./mealie.js, ./tandoor.js
 */
import { MealieAdapter } from './mealie.js';
import { TandoorAdapter } from './tandoor.js';

const ADAPTERS = {
  mealie: MealieAdapter,
  tandoor: TandoorAdapter,
};

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS);

function defaultAdapterFactory(account) {
  if (!account?.provider) throw new Error('getAdapter: account.provider is required');
  const Adapter = ADAPTERS[account.provider];
  if (!Adapter) throw new Error(`Unknown recipe provider: "${account.provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
  return new Adapter(account);
}

let adapterFactory = defaultAdapterFactory;

/** Test-Hook: injiziert einen Fake-Adapter statt echter HTTP-Requests. */
export function _setAdapterFactory(fn) {
  adapterFactory = fn || defaultAdapterFactory;
}

export function getAdapter(account) {
  return adapterFactory(account);
}
