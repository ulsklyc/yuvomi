/**
 * Module: the value lists of the contacts input (#2810)
 * Purpose: ONE source for what a contacts request may carry, read by two
 *          sides that must not drift apart: the route handlers in
 *          server/routes/contacts.js and the OpenAPI document
 *          (server/openapi/paths/contacts.js), whose schemas validateRequest()
 *          checks before the handler runs. Up to #2810 the colour list stood
 *          in the route alone and the document named none.
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and the route file reaches
 *          the database.
 */

/**
 * Die kuratierten Toene, aus denen eine Kontakt-Kategorie waehlen darf.
 *
 * EINE ALLOWLIST, KEIN FREIER FARBWAEHLER, und der Grund ist gemessen: die
 * Kategoriescheibe ist eine VOLLTON-Marke, ihre Tinte ist die feste
 * `--color-ink-on-vivid` (Vollton-Regel, DESIGN.md). Das haelt nur ueber
 * kuratierten Toenen - eine frei gewaehlte Farbe hat unbestimmte Helligkeit und
 * muesste als Kante statt als Flaeche erscheinen, also als zweites Gesicht
 * derselben Marke. Sieben Toene sind fuer ein Kategorie-Vokabular reichlich,
 * und es sind exakt die sieben, die vorher in contacts.css standen: bestehende
 * Haushalte sehen nach der Migration genau dasselbe wie davor.
 *
 * Der leere Wert gehoert dazu und heisst NEUTRAL - siehe Migration 152. Die
 * Seite liest die Liste ueber GET /api/v1/contacts/meta (`categoryColors`).
 */
export const CONTACT_CATEGORY_COLORS = Object.freeze([
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-accent)',
  'var(--module-budget)',
  'var(--module-meals)',
  'var(--color-danger)',
  'var(--color-text-secondary)',
]);
