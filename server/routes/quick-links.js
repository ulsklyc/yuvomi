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

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, color, collectErrors, MAX_SHORT } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { normalizeQuickLinkUrl } from '../../public/utils/quick-link-url.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';

const log = createLogger('QuickLinks');

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
 * @param {unknown} value
 * @returns {{ value: string|null, error: string|null }}
 */
function iconData(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  if (typeof value !== 'string') return { value: null, error: 'Icon must be a data URL string.' };
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
 * @param {unknown} value
 * @returns {{ value: string|null, error: string|null }}
 */
function iconName(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  if (typeof value !== 'string') return { value: null, error: 'Icon name must be a string.' };
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: null };
  if (trimmed.length > MAX_ICON_NAME_LENGTH) return { value: null, error: 'Icon name is too long.' };
  if (!ICON_NAME_RE.test(trimmed)) {
    return { value: null, error: 'Icon name must contain only lowercase letters, digits, and hyphens.' };
  }
  return { value: trimmed, error: null };
}

/**
 * WHERE-Fragment: was diese Person sehen darf.
 * Geteilte Kacheln sehen alle; private nur ihre Urheberin - auch Admins nicht,
 * wie überall sonst in dieser App (vgl. services/visibility.js).
 */
const VISIBLE_WHERE = "(q.visibility = 'all' OR q.created_by = @me)";

const SELECT_COLUMNS = `
  q.id, q.name, q.url, q.icon_data, q.icon_name, q.color, q.visibility,
  q.created_by, q.position, q.created_at, q.updated_at`;

/**
 * Darf diese Person die Kachel ändern oder löschen?
 *
 * ANLEGEN DARF JEDER, ÄNDERN NICHT JEDER. Eine geteilte Kachel steht auf der
 * Startseite des ganzen Haushalts; sie gehört der Person, die sie gesetzt hat,
 * und dem Admin. Eine private gehört nur ihrer Urheberin - ein Admin, der sie
 * bearbeiten dürfte, könnte sie über den Umweg "auf geteilt stellen" auch lesen.
 *
 * @param {{created_by: number|null, visibility: string}} row
 * @param {number|null} userId
 * @param {boolean} isAdmin
 */
function mayEdit(row, userId, isAdmin) {
  if (row.created_by === userId) return true;
  return row.visibility === 'all' && isAdmin === true;
}

/**
 * Die sichtbaren Schnellzugriffe einer Person, in ihrer Reihenfolge.
 * Steht hier und nicht in einem Service, weil sie genau zwei Aufrufer hat -
 * diese Datei und die Übersichts-Route.
 *
 * `can_edit` KOMMT MIT UND WIRD NICHT IM BROWSER HERGELEITET. Die Regel dafür
 * ist `mayEdit`, und die ist ohnehin die Grenze - der Client würde sie sonst
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
  `).all({ me: userId }).map((row) => ({ ...row, can_edit: mayEdit(row, userId, isAdmin) }));
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

/**
 * GET /api/v1/quick-links
 * Die für die anfragende Person sichtbaren Schnellzugriffe.
 * Response: { data: QuickLink[] }
 */
router.get('/', (req, res) => {
  try {
    res.json({ data: listQuickLinksFor(actingUser(req), isAdminRequest(req)) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/quick-links
 * Body: { name, url, icon_data?, icon_name?, color?, visibility? }
 * Response: { data: QuickLink }
 */
router.post('/', (req, res) => {
  try {
    const me = actingUser(req);
    const vName  = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vColor = color(req.body.color || null, 'Color');
    const vIcon  = iconData(req.body.icon_data);
    const vGlyph = iconName(req.body.icon_name);
    const errors = collectErrors([vName, vColor, vIcon, vGlyph]);

    const parsedUrl = normalizeQuickLinkUrl(req.body.url);
    if (!parsedUrl.ok) errors.push(urlErrorMessage(parsedUrl.reason));

    const visibility = VISIBILITY_VALUES.includes(req.body.visibility) ? req.body.visibility : 'all';
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    // Der Deckel zaehlt den ganzen Haushalt und nicht die eigenen Kacheln: was
    // die Übersichts-Antwort gross macht, sind alle zusammen.
    const { total } = db.get().prepare('SELECT COUNT(*) AS total FROM quick_links').get();
    if (total >= MAX_QUICK_LINKS) {
      return res.status(400).json({ error: `At most ${MAX_QUICK_LINKS} quick links can be created.`, code: 400 });
    }

    // Neue Kacheln hängen sich hinten an - eine neue Kachel soll die gewohnte
    // Reihenfolge nicht verschieben.
    const next = db.get().prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM quick_links').get().pos;

    const result = db.get().prepare(`
      INSERT INTO quick_links (name, url, icon_data, icon_name, color, visibility, created_by, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(vName.value, parsedUrl.url, vIcon.value, vGlyph.value, vColor.value, visibility, me, next);

    const row = db.get().prepare(`SELECT ${SELECT_COLUMNS} FROM quick_links q WHERE q.id = ?`)
      .get(result.lastInsertRowid);
    res.status(201).json({ data: row });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
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
router.put('/order', (req, res) => {
  try {
    const me = actingUser(req);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    if (!ids) return res.status(400).json({ error: 'ids muss ein Array sein', code: 400 });

    const visible = new Set(listQuickLinksFor(me).map((s) => s.id));
    const ordered = ids.filter((id) => visible.has(id));

    db.transaction(() => {
      const stmt = db.get().prepare('UPDATE quick_links SET position = ? WHERE id = ?');
      ordered.forEach((id, index) => stmt.run(index, id));
    });

    res.json({ data: listQuickLinksFor(me, isAdminRequest(req)) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PUT /api/v1/quick-links/:id
 * Body: { name?, url?, icon_data?, icon_name?, color?, visibility? }
 * Response: { data: QuickLink }
 */
router.put('/:id', (req, res) => {
  try {
    const id  = parseInt(req.params.id, 10);
    const row = db.get().prepare('SELECT * FROM quick_links WHERE id = ?').get(id);
    // Eine fremde private Kachel gibt es für diese Person nicht - 404 und nicht
    // 403, sonst verrät die Antwort ihre Existenz.
    if (!row || (row.visibility === 'private' && row.created_by !== actingUser(req))) {
      return res.status(404).json({ error: 'Schnellzugriff nicht gefunden', code: 404 });
    }
    if (!mayEdit(row, actingUser(req), isAdminRequest(req))) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });

    const vName  = req.body.name !== undefined ? str(req.body.name, 'Name', { max: MAX_SHORT }) : { value: row.name, error: null };
    const vColor = req.body.color !== undefined ? color(req.body.color || null, 'Color') : { value: row.color, error: null };
    const vIcon  = req.body.icon_data !== undefined ? iconData(req.body.icon_data) : { value: row.icon_data, error: null };
    const vGlyph = req.body.icon_name !== undefined ? iconName(req.body.icon_name) : { value: row.icon_name, error: null };
    const errors = collectErrors([vName, vColor, vIcon, vGlyph]);

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
    `).run(vName.value, url, vIcon.value, vGlyph.value, vColor.value, visibility, id);

    res.json({ data: db.get().prepare(`SELECT ${SELECT_COLUMNS} FROM quick_links q WHERE q.id = ?`).get(id) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/quick-links/:id
 * Response: 204
 */
router.delete('/:id', (req, res) => {
  try {
    const id  = parseInt(req.params.id, 10);
    const row = db.get().prepare('SELECT * FROM quick_links WHERE id = ?').get(id);
    if (!row || (row.visibility === 'private' && row.created_by !== actingUser(req))) {
      return res.status(404).json({ error: 'Schnellzugriff nicht gefunden', code: 404 });
    }
    if (!mayEdit(row, actingUser(req), isAdminRequest(req))) return res.status(403).json({ error: 'Keine Berechtigung', code: 403 });

    db.get().prepare('DELETE FROM quick_links WHERE id = ?').run(id);
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
export { VISIBILITY_VALUES, MAX_ICON_DATA_LENGTH, MAX_QUICK_LINKS };
