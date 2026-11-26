// SYNC-ONLY fixture: server/db/backup.ts works on files and is asynchronous by nature; silent.
export async function copy(p: Promise<void>): Promise<void> { await p; }
