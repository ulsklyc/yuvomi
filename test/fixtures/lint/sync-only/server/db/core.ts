// SYNC-ONLY fixture (phase 2, F6c): every line marked `sync-N` must be reported once, every
// other line must stay silent. server/db/ is one of the synchronous areas.
export async function fn(): Promise<void> {} // sync-1
export const arrow = async () => 1; // sync-2
export function outer(p: Promise<number>) {
  return (async () => { // sync-3
    await p; // sync-4
    for await (const x of [p]) void x; // sync-5
  })();
}
export class Store {
  async load() { return 1; } // sync-6
}

// Silent: a promise built without async, a Promise type, the words in a comment
// (async, await, for await) or in a string.
export function quiet(): Promise<number> {
  const words = 'async function f() { await g(); }';
  return Promise.resolve(words.length);
}
export type Later = () => Promise<string>;
