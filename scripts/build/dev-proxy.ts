/**
 * Module: the proxy of `npm run dev` (Phase 1a, section D8)
 * Purpose: Vite serves public/ on 5173; what the Express server answers itself
 *          goes through to it. Vite reads a plain key as a PREFIX, so `/api`
 *          also took the facade `/api.js` that index.html loads, and the app
 *          did not start (review on #2631). Every key here is a regular
 *          expression (Vite: a key starting with `^`) that ends at a path
 *          boundary: the root itself, a `/` below it, or a query string.
 *          test:dev-server checks the keys against every file under public/.
 *          Not /health: without an HTML Accept it is the container probe, with
 *          one it is the health module page.
 * Abhaengigkeiten: server/utils/bind-address.js
 */

import { readBindAddress, selfCallHost } from '../../server/utils/bind-address.js';

/** Path roots the Express server answers itself. `/sw.js` on purpose: Vite must not serve the unbuilt worker. */
export const PROXIED_ROOTS: readonly string[] = [
  '/api', '/auth', '/sw.js', '/openapi.json', '/docs', '/modules', '/feed', '/mcp', '/manifest.webmanifest',
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `server.proxy` for vite.config.ts, aimed at the Express server on `port` and
 * the address it listens on (`app.listen(PORT, BIND_ADDRESS)`): unset ->
 * localhost, a wildcard -> loopback, IPv6 in brackets, a host name refused like
 * the server refuses it (server/utils/bind-address.js).
 */
export function devProxy(port: number | string, bindAddress?: string): Record<string, { target: string }> {
  const bind = readBindAddress(bindAddress);
  const target = `http://${bind ? selfCallHost(bind) : 'localhost'}:${port}`;
  return Object.fromEntries(PROXIED_ROOTS.map((root) => [`^${escapeRegExp(root)}(?:[/?]|$)`, { target }]));
}
