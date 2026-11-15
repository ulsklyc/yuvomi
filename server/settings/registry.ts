/**
 * Module: the settings registry (phase 2, C3)
 * Purpose: every setting of GET and PUT /api/v1/preferences in one place - its
 *          storage in `sync_config`, its scope, its write right, its default and
 *          its check. A leaf under the services: it never imports a service, a
 *          route or server/db.js; the connection is a parameter.
 *
 * Skeleton: the catalog is empty until the entries move in.
 */

import type { Actor, Database } from '../authorize/index.ts';

export type Scope = 'household' | 'household-default' | 'personal';
export type WriteRight = 'admin' | 'member' | 'none';

export type CatalogEntry = Readonly<{
  field: string;
  storage: readonly string[];
  scope: Scope;
  write: WriteRight;
}>;

export type Refusal =
  | { kind: 'forbidden' }
  | { kind: 'invalid'; message: string }
  | { kind: 'unauthenticated' };

export type Effects = Readonly<{
  householdZoneChanged(db: Database, zoneBefore: string, zoneAfter: string): void;
  healthModuleToggled(db: Database): void;
  preventionCaregiversChanged(db: Database, userId: number): void;
}>;

export function readSettings(_db: Database, _userId: number | null): Record<string, unknown> {
  return {};
}

export function readSetting(_db: Database, _field: string, _userId?: number | null): unknown {
  return undefined;
}

export function writeSettings(_db: Database, _actor: Actor, _patch: unknown, _effects: Effects): Refusal | null {
  return null;
}

export function settingsCatalog(): readonly CatalogEntry[] {
  return [];
}
