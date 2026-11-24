// Row by row comparison of one table between two database copies of the probe.
// Usage: node rowdiff.mjs <a.db> <b.db> <table>   (paths relative to $PROBE_DIR)
import { openDatabase } from './fingerprint.mjs';
import { inProbeDir, probeKey } from './probe-env.mjs';

const [fa, fb, table] = process.argv.slice(2);
if (!table) {
  console.error('Usage: node rowdiff.mjs <a.db> <b.db> <table>');
  process.exit(2);
}
const key = probeKey();
/** @param {string} file */
function rows(file) {
  const db = openDatabase(inProbeDir(file), key, { readonly: true });
  try {
    const all = /** @type {Record<string, unknown>[]} */ (db.prepare(`SELECT rowid AS __rid, * FROM "${table.replaceAll('"', '""')}"`).all());
    return new Map(all.map((x) => [x.__rid, x]));
  } finally {
    db.close();
  }
}
const a = rows(fa);
const b = rows(fb);
let n = 0;
for (const [id, y] of b) {
  const x = a.get(id);
  if (!x) {
    console.log(`+ ${id}: ${JSON.stringify(y).slice(0, 220)}`);
    n++;
    continue;
  }
  const cols = Object.keys(y).filter((c) => JSON.stringify(x[c]) !== JSON.stringify(y[c]));
  if (cols.length) {
    n++;
    const name = String(y.title ?? y.name ?? '').slice(0, 30);
    console.log(`~ ${id} (${name}): ${cols.map((c) => `${c}: ${JSON.stringify(x[c])} -> ${JSON.stringify(y[c])}`).join('; ').slice(0, 260)}`);
  }
}
for (const id of a.keys()) {
  if (!b.has(id)) {
    console.log(`- ${id}`);
    n++;
  }
}
console.log(`${table}: ${n} rows differ (${a.size} -> ${b.size})`);
