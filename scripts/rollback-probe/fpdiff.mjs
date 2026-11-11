// Compares two fingerprints written by fp.mjs.
// Usage: node fpdiff.mjs <label-a> <label-b>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffFingerprints } from './fingerprint.mjs';
import { probeDir } from './probe-env.mjs';

const labels = process.argv.slice(2, 4);
if (labels.length !== 2) {
  console.error('Usage: node fpdiff.mjs <label-a> <label-b>');
  process.exit(2);
}
const [a, b] = labels.map((l) => JSON.parse(readFileSync(join(probeDir(), `fp-${l}.json`), 'utf8')));
const diffs = diffFingerprints(a, b);
console.log(`${a.label} -> ${b.label}: ${diffs.length ? diffs.join('; ') : 'identical'}`);
