/**
 * Module: an error that knows its HTTP answer
 * Purpose: a route or service throws it, and the central error handler
 *          (server/middleware/error-handler.js) answers with its status, its
 *          sentence and its `reason`. Only a 4xx is shown to the client
 *          (`expose`); anything else becomes the handler's fixed 500 sentence,
 *          the text stays in the log.
 *
 *          The message is the sentence the client sees: English, written by us,
 *          never the text of a foreign error (CONTRIBUTING, error contract).
 *          Pass the foreign error as `cause` so the log keeps it. The handler
 *          logs the cause's message, so a cause must not carry a secret (an
 *          upstream error that quotes a URL with a token, a password): wrap
 *          such an error in one of our own first.
 */

export class HttpError extends Error {
  /**
   * @param {number} status HTTP status, 4xx to reach the client
   * @param {string} message our own sentence for the client
   * @param {{ reason?: string, cause?: unknown }} [options]
   */
  constructor(status, message, { reason, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
    this.status = status;
    this.expose = Number.isInteger(status) && status >= 400 && status <= 499;
    if (reason !== undefined) this.reason = reason;
  }
}
