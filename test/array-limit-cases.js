/**
 * One boundary case per array limit class (Refs #2810, follow-up 5b): a body
 * with exactly `limit` entries passes the schema, one more is a 400 of
 * validateRequest() with `reason: 'validation'` and the rule `maxItems` at the
 * field. The limits come from server/openapi/array-limits.js, the same
 * constants the schema reads, so a changed limit moves the case with it.
 *
 * "Passes the schema" is asserted, not a 2xx: an answer at the limit may still
 * be the route's own 400 or 404 (an unknown id, a route cap that counts
 * distinct entries), but never a refusal with `fields`. Where the route answers
 * 2xx at the limit, the caller asserts that on top.
 */
import assert from 'node:assert/strict';

/**
 * @param {(body: unknown) => Promise<{ status: number, body: any }>} send
 * @param {(n: number) => unknown} build the request body with n entries
 * @param {number} limit
 * @param {string} field the pointer validateRequest() names, e.g. `body/ids`
 * @returns {Promise<{ status: number, body: any }>} the answer at the limit
 */
export async function assertArrayLimit(send, build, limit, field) {
  assert.ok(Number.isInteger(limit) && limit > 0, `${field}: limit ${limit}`);
  const at = await send(build(limit));
  assert.ok(!(at.status === 400 && Array.isArray(at.body?.fields)),
    `${field}: ${limit} entries pass the schema, got ${at.status} ${JSON.stringify(at.body)?.slice(0, 300)}`);
  const over = await send(build(limit + 1));
  assert.equal(over.status, 400, `${field}: ${limit + 1} entries are refused`);
  assert.equal(over.body?.reason, 'validation', `${field}: reason`);
  assert.ok(over.body.fields.some((/** @type {{ path: string, rule: string }} */ f) => f.path === field && f.rule === 'maxItems'),
    `${field}: maxItems named, got ${JSON.stringify(over.body.fields)}`);
  return at;
}
