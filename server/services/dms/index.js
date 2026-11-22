/**
 * Module: DMS Adapter Factory
 * Purpose: Resolve a configured dms_accounts row to its concrete adapter instance.
 * Dependencies: ./paperless.js
 */
import { PaperlessAdapter } from './paperless.js';
import { PapraAdapter } from './papra.js';

const ADAPTERS = {
  paperless: PaperlessAdapter,
  papra: PapraAdapter,
};

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS);

export function getAdapter(account) {
  if (!account?.provider) throw new Error('getAdapter: account.provider is required');
  // Nur eigene Schluessel (#2810): `provider` steht in der Datenbank, und ein
  // Wert wie `constructor` faende sonst `Object` - `new Object(account)` gaebe
  // das Konto selbst zurueck, und jede Suche liefe auf einen Wurf in der Route.
  const Adapter = Object.hasOwn(ADAPTERS, account.provider) ? ADAPTERS[account.provider] : null;
  if (!Adapter) {
    throw new Error(`Unknown DMS provider: "${account.provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
  return new Adapter(account);
}
