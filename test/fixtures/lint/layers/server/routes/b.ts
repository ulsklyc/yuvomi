import type { Thing } from '../services/types.ts';  // a type-only import is an edge as well
import { helper } from '../services/a.ts';
export function route(x: Thing): number { return helper(x.n); }
export const formatX = (n: number): string => String(n);
