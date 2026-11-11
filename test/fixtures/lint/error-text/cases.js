// Lint fixture (phase 1b, section E): the ways the text of an exception reaches
// a response, one finding of the ERROR-TEXT rule per line marked `et-N`, and the
// cases the rule must leave alone. test:lint-baseline lints this file with the
// real .oxlintrc.json and expects exactly the marked lines. The first ten are
// the self-test cases of test-client-error-text-guard.js, the text reader this
// rule replaced; et-11 and et-12 are its label test (a route's catch block, a
// helper's own body).
/** @type {{ error: (...args: unknown[]) => void }} */
const log = { error() {} };
/** @type {any} */
const router = {};
/** @type {(...args: unknown[]) => void} */
const sendStorageError = () => {};
/** @type {() => Promise<void>} */
const work = async () => {};

/**
 * @param {any} res
 * @param {any} err
 * @param {any} error
 * @param {any} e
 * @param {any} fetchErr
 */
export function spellings(res, err, error, e, fetchErr) {
  res.status(500).json({ error: err.message, code: 500 });           // et-1: behind res.status()
  res.json({ error: error?.message || 'x' });                        // et-2: optional chain
  res
    .status(400)
    .json({
      code: 400,
      error: e.message,                                              // et-3: a chain across lines
    });
  res.status(err.status || 500).json({ error: fetchErr.message });   // et-4: any name ending in err/error
  res.send(String(err));                                             // et-5: String(err)
  res.status(502).json({ error: `Fetch failed: ${err.message}` });   // et-6: inside a template
  res.status(502).json({ error: `Fetch failed: ${err}` });           // et-7: the error itself in a template
  sendStorageError(res, err, err.message);                           // et-8: a send helper (res first)
}

/**
 * @param {any} res
 * @param {any} err
 */
export function aliasInProperty(res, err) {
  const message = err.message || 'Invalid.';
  const status = 400;
  res.status(status).json({ error: message });                       // et-9: alias under error/message/detail
}

/**
 * @param {any} res
 * @param {any} err
 */
export function aliasAsBody(res, err) {
  const body = { error: err.message, code: 400 };
  res.status(400).json(body);                                        // et-10: the body is a variable
}

router.post('/webdav/test', async (/** @type {any} */ _req, /** @type {any} */ res) => {
  try { await work(); } catch (/** @type {any} */ err) {
    res.status(400).json({ error: err.message });                    // et-11: the catch parameter
  }
});
/**
 * @param {any} res
 * @param {any} err
 */
export function sendGoogleError(res, err) {
  return res.status(500).json({ error: err.message });               // et-12: a helper's own body
}

// Wider than the text reader was.
/**
 * @param {any} res
 * @param {any} err
 */
export function wider(res, err) {
  try { log.error(); } catch (/** @type {any} */ problem) {
    res.status(502).json({ error: problem.message });                // et-13: a catch parameter of any name
  }
  res.status(500).json({ error: 'Failed.', stack: err.stack });      // et-14: the stack
  res.end(err.toString());                                           // et-15: toString()
  const message = err.message;
  log.error(1);
  log.error(2);
  log.error(3);
  res.json({ error: message });                                      // et-16: an alias any distance above
}

// Not a finding: logged, compared, in a comment or in a string, or no response.
/**
 * @param {any} res
 * @param {any} err
 */
export function quiet(res, err) {
  log.error('failed:', err.message);
  res.status(500).json({ error: 'Failed.', code: 500 });
  if (err.message === 'x') return res.status(403).json({ error: 'No.' });
  res.json({ same: err.message === 'x', other: err?.message !== 'y' });
  // res.json({ error: err.message })
  res.json({ data: 1 });
  res.json({ error: 'see err.message in the log' });
  res.status(400).json({ error: '${err}' });
  if (err.code) return res.status(409).json({ error: 'Conflict.', code: 409, reason: err.code });
  throw new Error(`wrapped: ${err.message}`);
}
/**
 * @param {any} res
 * @param {any} err
 */
export function sendX(res, err) {
  log.error(err.message, res);
}
/**
 * A variable in the response, but no text was read into a variable before it.
 * @param {any} res
 * @param {any} err
 */
export function plainBody(res, err) {
  const status = err.status || 500;
  const body = { error: 'Failed.', code: status };
  log.error('failed:', err.message);
  return res.status(status).json(body);
}

// Blind spots (on purpose, a selector cannot follow a name): the alias is
// passed to a send helper, sits under another property name, or was assigned
// in a block the response is not in. A result object a service returns with
// the text in it, and text stored in a column and sent by a later GET, are
// invisible as they were to the text reader.
/**
 * @param {any} res
 * @param {any} err
 */
export function blindHelper(res, err) {
  const message = err.message;
  sendStorageError(res, 400, message);
}
/**
 * @param {any} res
 * @param {any} err
 */
export function blindOtherKey(res, err) {
  const message = err.message;
  res.json({ syncError: message });
}
/**
 * @param {any} res
 * @param {any} err
 */
export function blindOtherBlock(res, err) {
  let late;
  if (err.code) { late = err.message; }
  res.json({ error: late });
}
