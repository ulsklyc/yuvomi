// Rights fixture (phase 2, B5): migrations and seeds write visibility values.
export const MIGRATION = `UPDATE notes SET visibility = 'private' WHERE visibility IN ('x')`;
