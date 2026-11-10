// API probe against the running probe container, signed in as the demo admin.
// Usage: node api.mjs snap <label> | backup | restore <file> | write <note-title>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, signIn, snapshot } from './api-probe.mjs';
import { inProbeDir, probeBase, probeDir } from './probe-env.mjs';

const base = probeBase();
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
  console.log('backup trigger', r.status, r.text.slice(0, 300));
} else if (cmd === 'restore' && arg) {
  const client = createClient(base);
  await signIn(client);
  const r = await client.call('POST', '/api/v1/backup/restore', {
    body: readFileSync(inProbeDir(arg)), raw: true, headers: { 'content-type': 'application/octet-stream' },
  });
  console.log('restore', r.status, r.text.slice(0, 300));
} else if (cmd === 'write' && arg) {
  // One write, so a later restore has a difference to turn back.
  const client = createClient(base);
  await signIn(client);
  const r = await client.call('POST', '/api/v1/notes', { body: { title: arg, content: 'rollback probe' } });
  console.log('note', r.status, r.text.slice(0, 160));
} else {
  console.error('Usage: node api.mjs snap <label> | backup | restore <file> | write <note-title>');
  process.exit(2);
}
