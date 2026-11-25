// DB-SINGLETON fixture: a route is an entry point, db.get() is its facade; silent.
import * as db from '../db.js';

export const handler = () => db.get();
