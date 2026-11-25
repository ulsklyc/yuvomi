// DB-SINGLETON fixture (phase 2, F6c): every line marked `handle-N` must be reported once,
// every other line must stay silent. A service takes the connection as a parameter.
import * as db from '../db.js';
import * as dbModule from '../db.js';

export function reads() {
  const a = db.get(); // handle-1
  const b = dbModule.get(); // handle-2
  return db.get().prepare('SELECT 1').get() ?? [a, b]; // handle-3
}

/** @param {Map<string, number>} map @param {any} calendar @param {any} database */
export function silent(map, calendar, database) {
  // db.get() in a comment, and in a string: 'db.get()'
  return [map.get('key'), db.get(1), calendar.colors.get(), database.prepare('SELECT 1').get(), 'db.get()'];
}
