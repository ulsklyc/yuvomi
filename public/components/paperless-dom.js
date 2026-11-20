/** Required controls in markup created by the Paperless controllers. */
/** @template {Element} T @param {ParentNode} root @param {string} selector @returns {T} */
export function paperlessControl(root, selector) {
  const control = root.querySelector(selector);
  if (!control) throw new Error(`Missing Paperless control: ${selector}`);
  return /** @type {T} */ (control);
}

/** API error fields are untrusted; UI messages use only fixed reason/status maps. @param {unknown} error */
export function paperlessApiError(error) {
  return /** @type {{status?: number, data?: {reason?: string}} | null | undefined} */ (error);
}
