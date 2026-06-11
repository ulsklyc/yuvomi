/**
 * Module: DMS Adapter Factory
 * Purpose: Resolve a configured dms_accounts row to its concrete adapter instance.
 * Dependencies: ./paperless.js
 */
import { PaperlessAdapter } from './paperless.js';

const ADAPTERS = {
  paperless: PaperlessAdapter,
};

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS);

export function getAdapter(account) {
  if (!account?.provider) throw new Error('getAdapter: account.provider is required');
  const Adapter = ADAPTERS[account.provider];
  if (!Adapter) {
    throw new Error(`Unknown DMS provider: "${account.provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
  return new Adapter(account);
}
