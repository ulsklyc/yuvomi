// Compares two API snapshots written by `api.mjs snap`.
// Usage: node apidiff.mjs <label-a> <label-b>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffSnapshots } from './api-probe.mjs';
import { probeDir } from './probe-env.mjs';

const labels = process.argv.slice(2, 4);
if (labels.length !== 2) {
  console.error('Usage: node apidiff.mjs <label-a> <label-b>');
  process.exit(2);
}
const [a, b] = labels.map((l) => JSON.parse(readFileSync(join(probeDir(), `api-${l}.json`), 'utf8')));
const { hard, soft } = diffSnapshots(a, b);
console.log(`${a.label} -> ${b.label}: status/size ${hard.length ? hard.join('; ') : 'same'}; body differs at ${soft.length ? soft.join(', ') : 'none'}`);
