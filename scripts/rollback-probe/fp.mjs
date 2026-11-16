// Fingerprint of the probe database from the host (the container must be stopped).
// Usage: node fp.mjs <label> [db-file, default data/yuvomi.db]  -> $PROBE_DIR/fp-<label>.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintFile } from './fingerprint.mjs';
import { inProbeDir, probeDir, probeKey } from './probe-env.mjs';

const label = process.argv[2];
if (!label) {
  console.error('Usage: node fp.mjs <label> [db-file]');
  process.exit(2);
}
const fp = { label, ...fingerprintFile(inProbeDir(process.argv[3] || 'data/yuvomi.db'), probeKey()) };
writeFileSync(join(probeDir(), `fp-${label}.json`), JSON.stringify(fp, null, 1));
const total = Object.values(fp.tables).reduce((a, t) => a + ('n' in t ? t.n : 0), 0);
console.log(`${label}: schema_version ${fp.schema_version}, ${fp.migrations} migrations, schema_hash ${fp.schema_hash}, ${Object.keys(fp.tables).length} tables, ${total} rows, journal ${fp.journal}`);
