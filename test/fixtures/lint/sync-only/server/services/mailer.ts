// SYNC-ONLY fixture: an ordinary service is no synchronous area; silent.
export async function send(p: Promise<void>): Promise<void> { await p; }
