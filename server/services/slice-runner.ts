/**
 * Module: the error isolation of a mixed answer (phase 2, section D, contract E10)
 * Purpose: one runSlice() per route instead of a try/catch per block. A read that
 *          throws is logged as `<name> error: <message>` on the route's logger and
 *          answers with its failure value; the rest of the answer goes on.
 *
 * Dependencies: none (the logger is the route's). Erasable TS syntax only.
 */

/** The logger surface runSlice() uses (server/logger.js createLogger()). */
export type SliceLogger = { error(...args: unknown[]): void };

/** runSlice(name, read, failed): `read()`, or `failed` after logging a throw. */
export type SliceRunner = <T>(name: string, read: () => T, failed: T) => T;

/** The runSlice() of a route, bound to that route's logger. */
export function sliceRunner(log: SliceLogger): SliceRunner {
  return function runSlice<T>(name: string, read: () => T, failed: T): T {
    try {
      return read();
    } catch (err) {
      log.error(`${name} error:`, (err as Error).message);
      return failed;
    }
  };
}
