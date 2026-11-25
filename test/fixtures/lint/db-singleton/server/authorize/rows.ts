// DB-SINGLETON fixture: the permission module counts as well.
import * as db from '../db.js';

export const rowsOf = () => db.get(); // handle-4
