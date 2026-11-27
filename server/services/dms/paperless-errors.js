/** Fixed, locally chosen Paperless API failures. Never wrap upstream bodies or URLs. */
/** Read only an upstream status, never its text, body or URL. @param {unknown} error */
export function paperlessStatus(error) {
  return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}

export class PaperlessHttpError extends Error {
  /** @param {number} httpStatus @param {{reason: string}} options */
  constructor(httpStatus, { reason }) {
    super(reason);
    this.httpStatus = httpStatus;
    this.reason = reason;
  }
}
