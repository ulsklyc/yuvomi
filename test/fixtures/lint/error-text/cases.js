// Lint fixture (phase 1b, section E): the ways the text of an exception reaches
// a response, one finding of the ERROR-TEXT rule per line marked `et-N`, and the
// cases the rule must leave alone. test:lint-baseline lints this file with the
// real .oxlintrc.json and expects exactly the marked lines. et-1 to et-10 are
// the self-test cases of test-client-error-text-guard.js, the text reader this
// rule replaced; et-11 and et-12 are its label test (a route's catch block, a
// helper's own body); et-13 to et-18 are spellings that reader saw and the first
// version of the rule did not (review of #2691).
//
// Through a variable the rule cannot follow a name. It reports the place where
// the text is read into a variable (a declarator, an assignment, a parameter
// default, at most twelve nodes above the text) when the surrounding function,
// or the module's top level, sends a body at all. That is wider than the old
// reader, which looked for the name in a response up to three lines below.
/** @type {{ error: (...args: unknown[]) => void, warn: (...args: unknown[]) => void }} */
const log = { error() {}, warn() {} };
/** @type {any} */
const router = {};
/** @type {any} */
const Reply = class {};
/** @type {(...args: unknown[]) => void} */
const sendStorageError = () => {};
/** @type {(...args: unknown[]) => any} */
const run = () => ({});

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
  const message = err.message || 'Invalid.';                         // et-9: read into a variable ...
  const status = 400;
  res.status(status).json({ error: message });                       // ... that goes out as `error`
}

/**
 * @param {any} res
 * @param {any} err
 */
export function aliasAsBody(res, err) {
  const body = { error: err.message, code: 400 };                    // et-10: read into the body
  res.status(400).json(body);
}

router.post('/webdav/test', async (/** @type {any} */ _req, /** @type {any} */ res) => {
  try { await run(); } catch (/** @type {any} */ err) {
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

/**
 * The last name of a member chain counts like a plain name.
 * @this {any}
 * @param {any} res
 * @param {any} err
 * @param {any} result
 */
export function memberChains(res, err, result) {
  res.json({ error: result.error.message });                         // et-13: result.error
  res.json({ error: this.err.message });                             // et-14: this.err
  res.json({ error: err.cause.message });                            // et-15: err.cause
  res.json({ error: err?.cause?.message });                          // et-16: optional chain in the chain
  new Reply(res, err.message);                                       // et-17: a helper called with new
}

/**
 * @param {any} res
 * @param {any} err
 */
export function bodyWithACallback(res, err) {
  const body = { error: err.message, at: [1].find((i) => i) };       // et-18: a function elsewhere in the declaration
  res.json(body);
}

// Wider than the text reader was.
/**
 * @param {any} res
 * @param {any} err
 * @param {any[]} errs
 */
export function wider(res, err, errs) {
  try { run(); } catch (/** @type {any} */ problem) {
    res.status(502).json({ error: problem.message });                // et-19: a catch parameter of any name
  }
  res.status(500).json({ error: 'Failed.', stack: err.stack });      // et-20: the stack
  res.end(err.toString());                                           // et-21: toString()
  res.json({ error: err['message'] });                               // et-22: bracket access
  const message = err.message;                                       // et-23: an alias any distance above
  log.error(1);
  log.error(2);
  log.error(3);
  res.json({ error: message });
  const lines = errs.map((x) => x.cause.message);                    // et-24: read inside a callback
  res.json({ errors: lines });
}

// Through a variable, in every shape the old reader followed by name.
/**
 * @param {any} res
 * @param {any} err
 */
export function aliasToHelper(res, err) {
  const message = err.message;                                       // et-25: passed to a send helper
  sendStorageError(res, 400, message);
}
/**
 * @param {any} res
 * @param {any} err
 */
export function aliasUnderAnotherKey(res, err) {
  const text = String(err);                                          // et-26: under another key, inside an expression
  res.json({ syncError: text || 'x' });
}
/**
 * @param {any} res
 * @param {any} err
 */
export function aliasFromAnotherBlock(res, err) {
  let late;
  if (err.code) { late = err.message; }                              // et-27: assigned in a nested block
  res.json({ error: late });
}
/**
 * @param {any} res
 */
export function aliasFromACatch(res) {
  let caught;
  try { run(); } catch (/** @type {any} */ e) { caught = e.message; } // et-28: assigned in a catch block
  res.json({ error: caught });
}
/**
 * @param {any} res
 * @param {any} err
 */
export function aliasInOneStatement(res, err) {
  let now;
  if ((now = err.message)) res.json({ error: now });                 // et-29: assigned in the condition
}
/**
 * @param {any} res
 * @param {any} err
 */
export function aliasByDestructuring(res, err) {
  const { message } = err;                                           // et-30: destructured
  res.json({ error: message });
}
/**
 * @param {any} res
 * @param {any} err
 */
export function aliasAsParameterDefault(res, err) {
  const reply = (text = err.message) => res.json({ error: text });   // et-31: a parameter default
  reply();
}
/**
 * @param {any} res
 * @param {any} err
 */
export function aliasOnAProperty(res, err) {
  /** @type {{ code: number, error?: string }} */
  const body = { code: 400 };
  body.error = err.message;                                          // et-32: assigned to a property of the body
  res.json(body);
}

// A KNOWN FALSE ALARM, kept here so that it stays a decision: the text is read
// into a variable for the log only and the response carries none of it. The rule
// cannot tell (it does not follow the name), so the place needs a baseline entry
// with its reason, or the log call takes the error itself.
/**
 * @param {any} res
 * @param {any} err
 */
export function readForTheLogOnly(res, err) {
  const detail = String(err).slice(0, 80);                           // et-33: reported although nothing leaks
  log.warn(`upstream failed: ${detail}`);
  res.json({ data: null, reason: 'upstream_error' });
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
 * A variable in the response, but no text was read into a variable.
 * @param {any} res
 * @param {any} err
 */
export function plainBody(res, err) {
  const status = err.status || 500;
  const body = { error: 'Failed.', code: status };
  log.error('failed:', { detail: status === 500 ? err.message : undefined });
  return res.status(status).json(body);
}
/**
 * The text in a variable, but the function sends no body: `res` is a fetch
 * response here, `res.json()` reads it and `run(res)` only passes it on.
 * @param {any} res
 */
export async function fetchResponse(res) {
  const data = await res.json();
  const message = data.error?.message || `HTTP ${res.status}`;
  run(res);
  throw new Error(`request failed: ${message}`);
}
/**
 * The text in a variable in a function that answers nobody.
 * @param {any} err
 */
export function storesTheText(err) {
  const lastError = err.message;
  run(lastError);
}

// Blind spots, measured against the old reader (it saw both):
// - at module level, text that a callback reads or assigns (a function that
//   sends nothing itself), with the response in a later top-level statement;
// - text more than twelve nodes below the variable it is read into.
// Unchanged limits, as they were for the reader: a service that returns the text
// in a result object, and text stored in a column and sent by a later GET.
/** @type {any} */
let lastText;
router.errs.forEach((/** @type {any} */ e) => { lastText = e.message; });
router.res.json({ error: lastText });
/**
 * @param {any} res
 * @param {any} err
 */
export function blindDeepNesting(res, err) {
  const body = { a: { b: { c: { d: { e: { f: { g: err.message } } } } } } };
  res.json(body);
}
