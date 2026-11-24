// API probe against the running probe container, signed in as the demo admin.
// Usage: node api.mjs snap <label> | backup | restore <file> | write <note-title>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, signIn, snapshot } from './api-probe.mjs';
import { inProbeDir, probeBase, probeDir } from './probe-env.mjs';

const base = probeBase();

/**
 * Prints the answer and turns anything but 2xx into exit 1, so run.sh stops
 * at a refused backup or restore instead of finishing green.
 * @param {string} what
 * @param {{ status: number, text: string }} r
 * @param {number} [limit]
 */
function outcome(what, r, limit = 300) {
  console.log(what, r.status, r.text.slice(0, limit));
  if (r.status < 200 || r.status > 299) process.exitCode = 1;
}
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'snap' && arg) {
  const snap = { label: arg, ...(await snapshot(base)) };
  writeFileSync(join(probeDir(), `api-${arg}.json`), JSON.stringify(snap, null, 1));
  const ok = Object.values(snap.api).filter((x) => x.s === 200).length;
  console.log(`${arg}: sw.js ${snap.sw.status} release ${snap.sw.release} (${snap.sw.bytes} B), index ${snap.index.status} `
    + `(${snap.index.modulepreload} modulepreload, ${snap.index.assets} /assets/), API ${ok}/${Object.keys(snap.api).length} with 200`);
  console.log(`  ${Object.entries(snap.api).map(([k, v]) => `${k.replace('/api/v1/', '')}=${v.s}/${v.n}`).join(' ')}`);
} else if (cmd === 'backup') {
  const client = createClient(base);
  await signIn(client);
  const r = await client.call('POST', '/api/v1/backup/trigger', { body: {} });
  outcome('backup trigger', r);
} else if (cmd === 'restore' && arg) {
  const client = createClient(base);
  await signIn(client);
  const r = await client.call('POST', '/api/v1/backup/restore', {
    body: readFileSync(inProbeDir(arg)), raw: true, headers: { 'content-type': 'application/octet-stream' },
  });
  outcome('restore', r);
} else if (cmd === 'write' && arg) {
  // One write, so a later restore has a difference to turn back.
  const client = createClient(base);
  await signIn(client);
  const r = await client.call('POST', '/api/v1/notes', { body: { title: arg, content: 'rollback probe' } });
  outcome('note', r, 160);
} else {
  console.error('Usage: node api.mjs snap <label> | backup | restore <file> | write <note-title>');
  process.exit(2);
}
