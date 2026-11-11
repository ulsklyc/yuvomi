// Layer fixture (phase 1b, section D2): three violations dependency-cruiser must
// report, in TypeScript, so the tool is known to read .ts before phase 2 renames
// the first app file. test:lint-baseline expects exactly these three.
import { formatX } from '../routes/b.ts';            // lower-layers-not-to-routes, and a cycle with b.ts
import { send } from './push.js';                   // push-service-importers: a fifth importer; .js resolves to push.ts
import { shared } from '../../public/utils/s.js';   // allowed: the server may read public/utils/
export function helper(n: number): number { void formatX; void send; void shared; return n satisfies number; }
