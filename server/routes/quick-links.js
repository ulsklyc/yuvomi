/**
 * Modul: Schnellzugriffe (#469)
 * Zweck: REST-API für die Kachelreihe auf der Übersicht - Name, Adresse, Bild,
 *        und wer sie sieht.
 * Abhängigkeiten: express, server/db.js, public/utils/quick-link-url.js
 *
 * KEIN MODUL, TROTZDEM EINE EIGENE ROUTE. Die Kacheln kommen mit der
 * Übersichts-Antwort mit (ein Request weniger beim Seitenaufbau), aber
 * Anlegen, Ändern und Sortieren gehören nicht in einen Aggregat-Endpunkt.
 * Unter /api/v1/quick-links liegen sie an der Stelle, an der ein Drittmodul sie
 * auch erwartet - der Scope dafür ist `dashboard` (siehe scopes.js), weil sie
 * kein eigenes Berechtigungs-Modul sind.
 *
 * DIE ADRESSE WIRD HIER GEPRÜFT UND NICHT NUR IM FORMULAR. Was in dieser
 * Tabelle steht, landet als `href` einer Kachel - eine Client-Prüfung ist
 * Bequemlichkeit, keine Grenze. Beide Seiten rufen dieselbe Funktion auf
 * (public/utils/quick-link-url.js); die Begründung dafür steht dort.
 */

import express from 'express';
import * as db from '../db.js';
import { validateRequest } from '../api/validate-request.ts';
import { str, collectErrors, MAX_SHORT } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { normalizeQuickLinkUrl } from '../../public/utils/quick-link-url.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';
import { canEditQuickLink, rowVisible, visibleWhere } from '../authorize/index.ts';

const router = express.Router();

/**
 * all  - alle im Haushalt sehen die Kachel
 * private - nur die Person, die sie angelegt hat
 *
 * Die "assignees"-Stufe der Aufgaben und Termine fehlt: einem Link wird
 * niemand zugewiesen (siehe Migration v160).
 */
const VISIBILITY_VALUES = ['all', 'private'];

/**
 * So groß darf ein Kachelbild werden.
 *
 * 128 KB, und die Zahl kommt aus einer Messung statt aus Vorsicht: der
 * Zuschnitt (utils/avatar-crop.js) liefert 256x256 als JPEG bei Qualität 0.88,
 * also 20 bis 40 KB als Data-URL. Hier stand zuerst der Wert des
 * Mitglieder-Fotos - 512 KB, das Fünfzehnfache dessen, was je ankommt.
 *
 * DER UNTERSCHIED ZAEHLT, WEIL DIESE BILDER ANDERS REISEN ALS EIN AVATAR. Sie
 * liegen als Data-URL in der Zeile und gehen bei JEDEM Aufbau der Übersicht
 * mit, alle auf einmal. Ein grosszügiger Deckel mal einer unbegrenzten Anzahl
 * ergibt eine Startseite, die Megabyte laedt, bevor sie etwas zeigt.
 */
const MAX_ICON_DATA_LENGTH = 128 * 1024;

/**
 * So viele Schnellzugriffe darf ein Haushalt anlegen.
 *
 * EINE REIHE IST KEINE ABLAGE. Zwei Dutzend ist weit mehr, als eine Kachelreihe
 * je sinnvoll zeigt (auf breitem Desktop stehen etwa zwölf nebeneinander) - der
 * Deckel ist deshalb keine Einschränkung des Gebrauchs, sondern die Antwort auf
 * die Frage, wie gross die Übersichts-Antwort im schlimmsten Fall wird. Ohne
 * ihn wächst sie mit jeder Kachel, und niemand merkt es, bis die Startseite
 * langsam ist.
 *
 * Wer wirklich eine Bibliothek braucht, meint #759 - und die ist bewusst nicht
 * das hier (siehe Migration v160).
 */
const MAX_QUICK_LINKS = 24;

const ICON_DATA_RE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;

/**
 * Prüft ein Kachelbild.
 * @param {string|null|undefined} value
 * @returns {{ value: string|null, error: string|null }}
 */
function iconData(value) {
  // Ein Nicht-String weist schon das Schema ab (icon_data: string | null, #2810).
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  if (value.length > MAX_ICON_DATA_LENGTH) return { value: null, error: 'Icon image is too large.' };
  if (!ICON_DATA_RE.test(value)) return { value: null, error: 'Icon must be PNG, JPEG, or WebP.' };
  // Der Regex prueft die Deklaration, diese Zeile den Inhalt (#937).
  if (!dataUrlContentMatches(value)) return { value: null, error: 'Icon content does not match its image type.' };
  return { value, error: null };
}

/**
 * Der Name eines eingebauten Symbols (#873).
 *
 * DIE FORM IST DIE GRENZE, NICHT EINE NAMENSLISTE. Was hier durchkommt, landet
 * als `data-lucide` an einem Element; kennt Lucide den Namen nicht, bleibt das
 * Element leer und die Kachel zeigt ihren Buchstaben. Ein Tippfehler ist damit
 * folgenlos, und der Server muss den Vorrat nicht kennen - er kennt nur die
 * Zeichen, aus denen ein Lucide-Name bestehen darf.
 *
 * DAS IST TROTZDEM EINE SICHERHEITSPRUEFUNG und nicht nur Ordnung: Kleinbuchstaben,
 * Ziffern und Bindestriche schliessen alles aus, was aus einem Attributwert
 * ausbrechen koennte. Die Ausgabe entkommt zusaetzlich mit esc() - beides,
 * weil diese Zeichenkette in genau der Art von Kontext landet, in dem eine
 * einzelne Schutzschicht historisch reisst.
 */
const ICON_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lucides laengster Name liegt bei 34 Zeichen; 48 laesst Luft nach oben. */
const MAX_ICON_NAME_LENGTH = 48;

/**
 * Prüft den Namen eines eingebauten Symbols.
 * @param {string|null|undefined} value
 * @returns {{ value: string|null, error: string|null }}
 */
function iconName(value) {
  // Ein Nicht-String weist schon das Schema ab (icon_name: string | null, #2810).
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: null };
  if (trimmed.length > MAX_ICON_NAME_LENGTH) return { value: null, error: 'Icon name is too long.' };
  if (!ICON_NAME_RE.test(trimmed)) {
    return { value: null, error: 'Icon name must contain only lowercase letters, digits, and hyphens.' };
  }
  return { value: trimmed, error: null };
}

// What this person may see: the rule lives in authorize/rows/quick-links.ts.
const VISIBLE_WHERE = visibleWhere('quick_links', 'q', '@me');

const SELECT_COLUMNS = `
  q.id, q.name, q.url, q.icon_data, q.icon_name, q.color, q.visibility,
  q.created_by, q.position, q.created_at, q.updated_at`;

/**
 * Die sichtbaren Schnellzugriffe einer Person, in ihrer Reihenfolge.
 * Steht hier und nicht in einem Service, weil sie genau zwei Aufrufer hat -
 * diese Datei und die Übersichts-Route.
 *
 * `can_edit` KOMMT MIT UND WIRD NICHT IM BROWSER HERGELEITET. Die Regel dafür
 * ist `canEditQuickLink` (authorize/rows/quick-links.ts), und die ist ohnehin die Grenze - der Client würde sie sonst
 * ein zweites Mal formulieren, aus Angaben, die er nur mittelbar hat (wer bin
 * ich, bin ich Admin). Zwei Formulierungen derselben Regel laufen genau dann
 * auseinander, wenn eine von beiden sich ändert; hier gibt es nur eine, und
 * der Knopf im Dialog folgt ihr.
 *
 * @param {number|null} userId
 * @param {boolean} [isAdmin=false]
 * @returns {object[]}
 */
export function listQuickLinksFor(userId, isAdmin = false) {
  return db.get().prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM quick_links q
    WHERE ${VISIBLE_WHERE}
    ORDER BY q.position, q.id
  `).all({ me: userId }).map((row) => ({ ...row, can_edit: canEditQuickLink(row, userId, isAdmin) }));
}

/** Die handelnde Person - dieselbe Auflösung wie in den übrigen Routen. */
function actingUser(req) {
  return req.authUserId || req.session?.userId || null;
}

/**
 * Übersetzt die Absage der Adressprüfung in eine Fehlermeldung.
 * @param {'empty'|'too-long'|'malformed'|'protocol'} reason
 */
function urlErrorMessage(reason) {
  switch (reason) {
    case 'empty':    return 'Address is required.';
    case 'too-long': return 'Address is too long.';
    case 'protocol': return 'Address must start with http:// or https://.';
    default:         return 'Address must be a valid URL.';
  }
}

// Ein unerwarteter Fehler geht an den zentralen Fehlerhandler (#2810): 500 mit
// festem Satz. Ein `catch` steht nur, wo ein erwarteter Fehler seine eigene
// Antwort hat.
/**
 * GET /api/v1/quick-links
 * Die für die anfragende Person sichtbaren Schnellzugriffe.
 * Response: { data: QuickLink[] }
 */
router.get('/', validateRequest(), (req, res) => {
  res.json({ data: listQuickLinksFor(actingUser(req), isAdminRequest(req)) });
});

/**
 * POST /api/v1/quick-links
 * Body: { name, url, icon_data?, icon_name?, color?, visibility? }
 * Response: { data: QuickLink }
 */
router.post('/', validateRequest(), (req, res) => {
  const me = actingUser(req);
  const vName  = str(req.body.name, 'Name', { max: MAX_SHORT });
  // Die Farbe ist laut Schema `#RRGGBB`, null oder "" (leer heisst keine).
  const tileColor = req.body.color || null;
  const vIcon  = iconData(req.body.icon_data);
  const vGlyph = iconName(req.body.icon_name);
  const errors = collectErrors([vName, vIcon, vGlyph]);

  const parsedUrl = normalizeQuickLinkUrl(req.body.url);
  if (!parsedUrl.ok) errors.push(urlErrorMessage(parsedUrl.reason));

  const visibility = VISIBILITY_VALUES.includes(req.body.visibility) ? req.body.visibility : 'all';
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

  // Der Deckel zaehlt den ganzen Haushalt und nicht die eigenen Kacheln: was
  // die Übersichts-Antwort gross macht, sind alle zusammen.
  const { total } = db.get().prepare('SELECT COUNT(*) AS total FROM quick_links').get();
  if (total >= MAX_QUICK_LINKS) {
    return res.status(400).json({
      error: `At most ${MAX_QUICK_LINKS} quick links can be created.`,
      code: 400,
      // #1909: der Fall hat einen Namen, die Zahl steht strukturiert daneben -
      // den Satz dazu sagt die App in der Sprache der Oberflaeche.
      reason: 'quick_links_limit_reached',
      params: { limit: MAX_QUICK_LINKS },
    });
  }

  // Neue Kacheln hängen sich hinten an - eine neue Kachel soll die gewohnte
  // Reihenfolge nicht verschieben.
  const next = db.get().prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM quick_links').get().pos;

  const result = db.get().prepare(`
    INSERT INTO quick_links (name, url, icon_data, icon_name, color, visibility, created_by, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(vName.value, parsedUrl.url, vIcon.value, vGlyph.value, tileColor, visibility, me, next);

  const row = db.get().prepare(`SELECT ${SELECT_COLUMNS} FROM quick_links q WHERE q.id = ?`)
    .get(result.lastInsertRowid);
  res.status(201).json({ data: row });
});

/**
 * PUT /api/v1/quick-links/order
 * Body: { ids: number[] }  - die neue Reihenfolge, vollständig.
 * Response: { data: QuickLink[] }
 *
 * STEHT VOR /:id, sonst fängt der Parameter-Pfad "order" ab.
 *
 * NUR SICHTBARE IDS ZÄHLEN. Wer eine fremde private Kachel in die Liste
 * schmuggelt, verschiebt sie nicht - sie ist für ihn nicht da, und eine
 * Reihenfolge ist kein Weg, das zu ändern.
 */
router.put('/order', validateRequest(), (req, res) => {
  const me = actingUser(req);
  // Eine Liste ganzer Zahlen: das Schema (QuickLinkOrderInput) prueft sie.
  const ids = /** @type {number[]} */ (req.body.ids);

  const visible = new Set(listQuickLinksFor(me).map((s) => s.id));
  const ordered = ids.filter((id) => visible.has(id));

  db.transaction(() => {
    const stmt = db.get().prepare('UPDATE quick_links SET position = ? WHERE id = ?');
    ordered.forEach((id, index) => stmt.run(index, id));
  });

  res.json({ data: listQuickLinksFor(me, isAdminRequest(req)) });
});

/**
 * PUT /api/v1/quick-links/:id
 * Body: { name?, url?, icon_data?, icon_name?, color?, visibility? }
 * Response: { data: QuickLink }
 */
router.put('/:id', validateRequest(), (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = db.get().prepare('SELECT * FROM quick_links WHERE id = ?').get(id);
  // A tile this person's list does not show does not exist for them - 404 and
  // not 403, or the answer gives its existence away. The same rule as the list
  // (rowVisible), also for a value outside all|private, which only a restore
  // can write (no CHECK on quick_links.visibility).
  if (!rowVisible(db.get(), 'quick_links', row, actingUser(req))) {
    return res.status(404).json({ error: 'Quick link not found.', code: 404, reason: 'quick_links_link_not_found' });
  }
  if (!canEditQuickLink(row, actingUser(req), isAdminRequest(req))) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

  const vName  = req.body.name !== undefined ? str(req.body.name, 'Name', { max: MAX_SHORT }) : { value: row.name, error: null };
  const tileColor = req.body.color !== undefined ? (req.body.color || null) : row.color;
  const vIcon  = req.body.icon_data !== undefined ? iconData(req.body.icon_data) : { value: row.icon_data, error: null };
  const vGlyph = req.body.icon_name !== undefined ? iconName(req.body.icon_name) : { value: row.icon_name, error: null };
  const errors = collectErrors([vName, vIcon, vGlyph]);

  let url = row.url;
  if (req.body.url !== undefined) {
    const parsed = normalizeQuickLinkUrl(req.body.url);
    if (!parsed.ok) errors.push(urlErrorMessage(parsed.reason));
    else url = parsed.url;
  }
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

  const visibility = req.body.visibility !== undefined && VISIBILITY_VALUES.includes(req.body.visibility)
    ? req.body.visibility
    : row.visibility;

  db.get().prepare(`
    UPDATE quick_links
    SET name = ?, url = ?, icon_data = ?, icon_name = ?, color = ?, visibility = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ?
  `).run(vName.value, url, vIcon.value, vGlyph.value, tileColor, visibility, id);

  res.json({ data: db.get().prepare(`SELECT ${SELECT_COLUMNS} FROM quick_links q WHERE q.id = ?`).get(id) });
});

/**
 * DELETE /api/v1/quick-links/:id
 * Response: 204
 */
router.delete('/:id', validateRequest(), (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const row = db.get().prepare('SELECT * FROM quick_links WHERE id = ?').get(id);
  // As in PUT: not visible means 404, never 403.
  if (!rowVisible(db.get(), 'quick_links', row, actingUser(req))) {
    return res.status(404).json({ error: 'Quick link not found.', code: 404, reason: 'quick_links_link_not_found' });
  }
  if (!canEditQuickLink(row, actingUser(req), isAdminRequest(req))) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

  db.get().prepare('DELETE FROM quick_links WHERE id = ?').run(id);
  res.status(204).end();
});

export default router;
export { VISIBILITY_VALUES, MAX_ICON_DATA_LENGTH, MAX_QUICK_LINKS };
