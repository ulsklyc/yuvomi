// SYNC-ONLY fixture: a read slice of the overview (server/services/*-slices.ts) stays synchronous.
export async function weekSlice(): Promise<number> { return 1; } // sync-7
