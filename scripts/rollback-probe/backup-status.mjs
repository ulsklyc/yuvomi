// The stored status of the last backup in a probe database copy (the container
// must be stopped). The new build writes three keys into sync_config after a
// backup run; the previous image does not know them and must start on a
// database that holds them without a word (Phase 1b section F, E12).
// Usage: node backup-status.mjs <db-file relative to $PROBE_DIR> [present]
//   present: exit 1 unless backup_last_attempt and backup_last_success are there
import { openDatabase } from './fingerprint.mjs';
import { inProbeDir, probeKey } from './probe-env.mjs';

const [file, expectation] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node backup-status.mjs <db-file> [present]');
  process.exit(2);
}
const db = openDatabase(inProbeDir(file), probeKey(), { readonly: true });
let rows;
try {
  rows = /** @type {{ key: string, value: string }[]} */ (db
    .prepare("SELECT key, value FROM sync_config WHERE key IN ('backup_last_attempt', 'backup_last_success', 'backup_last_reason') ORDER BY key")
    .all());
} finally {
  db.close();
}
const status = Object.fromEntries(rows.map((row) => [row.key, row.value]));
console.log(`backup status in ${file}: ${rows.length ? JSON.stringify(status) : 'none'}`);
if (expectation === 'present' && !(status.backup_last_attempt && status.backup_last_success)) {
  console.error(`EXPECTED the backup status in ${file}: the new build wrote a backup before this copy was taken.`);
  process.exit(1);
}
