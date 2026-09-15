/**
 * Test: Schnellzugriffe (#469)
 * Zweck: Die vier Zusicherungen, an denen dieses Feature hängt:
 *        1. eine Adresse wird normalisiert ODER abgelehnt, und `javascript:`
 *           gehört zur zweiten Gruppe (public/utils/quick-link-url.js),
 *        2. eine private Kachel ist für niemanden sonst da - auch nicht für
 *           einen Admin, und auch nicht auf der Leitung,
 *        3. ändern darf sie, wem sie gehört; eine geteilte zusätzlich der Admin,
 *        4. `can_edit` kommt vom Server und deckt sich mit dem, was er erlaubt.
 * Ausführen: npm run test:quick-links
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: quickLinksRouter, listQuickLinksFor } = await import('../server/routes/quick-links.js');
const { normalizeQuickLinkUrl, quickLinkHost, MAX_QUICK_LINK_URL_LENGTH } =
  await import('../public/utils/quick-link-url.js');
const { MAX_ICON_DATA_LENGTH, MAX_QUICK_LINKS } = await import('../server/routes/quick-links.js');
const db = dbmod.get();

const ALICE = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('alice','Alice','x','member')").run().lastInsertRowid;
const BOB   = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('bob','Bob','x','member')").run().lastInsertRowid;
const ADMIN = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('root','Root','x','admin')").run().lastInsertRowid;

let actor = { id: ALICE, role: 'member' };
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', quickLinksRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

const as = (id, role = 'member') => { actor = { id, role }; };

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

function reset() {
  db.prepare('DELETE FROM quick_links').run();
}

// --------------------------------------------------------
// 1. Adressen
// --------------------------------------------------------

test('ein fehlendes Schema wird ergänzt - der Normalfall beim Heimserver', () => {
  // "192.168.1.5:8096" ist das, was jemand tippt, der Jellyfin verlinkt. Ein
  // Formular, das darauf "ungültige Adresse" sagt, ist schlicht falsch.
  assert.deepEqual(normalizeQuickLinkUrl('192.168.1.5:8096'), { ok: true, url: 'https://192.168.1.5:8096/' });
  assert.deepEqual(normalizeQuickLinkUrl('jellyfin.local'), { ok: true, url: 'https://jellyfin.local/' });
  assert.deepEqual(normalizeQuickLinkUrl('  example.com/pfad  '), { ok: true, url: 'https://example.com/pfad' });
});

test('ein vorhandenes Schema bleibt stehen', () => {
  assert.deepEqual(normalizeQuickLinkUrl('http://nas:8080/web/'), { ok: true, url: 'http://nas:8080/web/' });
  assert.deepEqual(normalizeQuickLinkUrl('https://a.example/x'), { ok: true, url: 'https://a.example/x' });
});

test('nur http und https kommen durch - alles andere fällt an der Erlaubnisliste', () => {
  // DIE ZUSICHERUNG, AN DER DAS GANZE FEATURE HÄNGT. Was hier gespeichert wird,
  // landet als href einer Kachel.
  //
  // GEPRUEFT WIRD DER GRUND UND NICHT NUR DAS NEIN, und das ist der Unterschied
  // zwischen diesem Test und dem, der hier zuerst stand: der prüfte `ok ===
  // false` und blieb deshalb grün, als die Schema-Erkennung versuchsweise durch
  // ein naives `includes('://')` ersetzt wurde - `https://javascript:alert(1)`
  // scheitert nämlich schon am Parser und ergibt ebenfalls ein Nein, nur mit
  // der falschen Begründung. Ein Guard, der eine kaputte Fassung nicht rot
  // macht, sichert nichts zu.
  for (const evil of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'jAvAsCrIpT:alert(document.cookie)',
    'javascript://%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'ftp://example.com',
  ]) {
    assert.deepEqual(normalizeQuickLinkUrl(evil), { ok: false, reason: 'protocol' }, evil);
  }
});

test('eine schemalose Adresse mit Doppelpunkt wird nicht still zu einem Host', () => {
  // `vbscript:1` ergäbe naiv ein gültiges `https://vbscript:1/` - eine Adresse,
  // die niemand gemeint hat, gespeichert ohne ein Wort. Erkannt als Schema,
  // fällt sie an der Erlaubnisliste, und der Nutzer erfährt warum.
  assert.deepEqual(normalizeQuickLinkUrl('vbscript:1'), { ok: false, reason: 'protocol' });

  // Die schemarelative Form ist dagegen harmlos und gemeint: sie wird https.
  assert.deepEqual(normalizeQuickLinkUrl('//nas.local'), { ok: true, url: 'https://nas.local/' });
});

test('leer, zu lang und unparsebar bekommen je einen eigenen Grund', () => {
  assert.deepEqual(normalizeQuickLinkUrl('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(normalizeQuickLinkUrl(null), { ok: false, reason: 'empty' });
  assert.equal(normalizeQuickLinkUrl(`https://a.example/${'x'.repeat(MAX_QUICK_LINK_URL_LENGTH)}`).reason, 'too-long');
  assert.equal(normalizeQuickLinkUrl('https://').reason, 'malformed');
});

test('quickLinkHost liest den Host und stolpert nicht über Müll', () => {
  assert.equal(quickLinkHost('https://nas.local:8096/web/'), 'nas.local:8096');
  assert.equal(quickLinkHost('kein-url'), '');
});

// --------------------------------------------------------
// 2. Anlegen und Validierung
// --------------------------------------------------------

test('POST normalisiert die Adresse und hängt hinten an', async () => {
  reset();
  as(ALICE);
  const first = await call('POST', '/', { name: 'Jellyfin', url: 'jellyfin.local' });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.url, 'https://jellyfin.local/');
  assert.equal(first.body.data.position, 0);

  const second = await call('POST', '/', { name: 'Immich', url: 'https://immich.local' });
  assert.equal(second.body.data.position, 1);
});

test('POST weist eine javascript:-Adresse ab, auch wenn der Browser sie durchliess', async () => {
  reset();
  as(ALICE);
  // Die Client-Prüfung ist Bequemlichkeit; hier steht die Grenze.
  const res = await call('POST', '/', { name: 'Böse', url: 'javascript:alert(1)' });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quick_links').get().n, 0);
});

test('POST weist einen fehlenden Namen und eine kaputte Farbe ab', async () => {
  reset();
  as(ALICE);
  assert.equal((await call('POST', '/', { name: '', url: 'a.example' })).status, 400);
  assert.equal((await call('POST', '/', { name: 'X', url: 'a.example', color: 'rot' })).status, 400);
});

test('ein Bild muss eine Bild-Data-URL sein', async () => {
  reset();
  as(ALICE);
  // Ein `data:text/html`-Wert in dieser Spalte landete als `<img src>` - was
  // dort nichts rendert, aber nichts in dieser Spalte zu suchen hat.
  const bad = await call('POST', '/', { name: 'X', url: 'a.example', icon_data: 'data:text/html,<script>' });
  assert.equal(bad.status, 400);

  const good = await call('POST', '/', {
    name: 'X', url: 'a.example',
    icon_data: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(good.status, 201);
});

test('das Kachelbild ist gedeckelt - die Reihe ist keine Ablage', async () => {
  reset();
  as(ALICE);
  // DER WERT STEHT HIER FEST UND WIRD VON HAND NACHGEZOGEN. Ohne diese Zeile
  // prueft der Test nur relativ zur Konstante und bliebe gruen, wenn jemand sie
  // auf 50 MB setzt - gemessen, als der Deckel probeweise auf die alten 512 KB
  // zurueckging. Die 128 KB sind an dem bemessen, was utils/avatar-crop.js
  // liefert (256x256 JPEG q=0.88, also 20-40 KB als Data-URL); wer sie anhebt,
  // vergroessert jede Uebersichts-Antwort und soll das hier begruenden.
  assert.equal(MAX_ICON_DATA_LENGTH, 128 * 1024, 'Deckel geaendert - Begruendung pruefen');
  // DIESE BILDER REISEN ANDERS ALS EIN AVATAR: sie liegen als Data-URL in der
  // Zeile und gehen bei JEDEM Aufbau der Uebersicht mit, alle auf einmal. Der
  // Deckel ist deshalb an dem bemessen, was der Zuschnitt liefert (20-40 KB),
  // und nicht am Grosszuegigen.
  const zuGross = 'data:image/png;base64,' + 'A'.repeat(MAX_ICON_DATA_LENGTH);
  assert.equal((await call('POST', '/', { name: 'X', url: 'a.example', icon_data: zuGross })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quick_links').get().n, 0);
});

test('die Anzahl ist gedeckelt, damit die Uebersichts-Antwort es bleibt', async () => {
  reset();
  as(ALICE);
  for (let i = 0; i < MAX_QUICK_LINKS; i++) {
    const res = await call('POST', '/', { name: `L${i}`, url: `host${i}.example` });
    assert.equal(res.status, 201, `Kachel ${i} sollte noch durchgehen`);
  }
  const zuViel = await call('POST', '/', { name: 'einer zu viel', url: 'x.example' });
  assert.equal(zuViel.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quick_links').get().n, MAX_QUICK_LINKS);

  // Der Deckel zaehlt den HAUSHALT, nicht die eigenen Kacheln: was die Antwort
  // gross macht, sind alle zusammen.
  as(BOB);
  assert.equal((await call('POST', '/', { name: 'Bobs', url: 'b.example' })).status, 400);
});

// --------------------------------------------------------
// 3. Sichtbarkeit
// --------------------------------------------------------

test('eine private Kachel sieht nur ihre Urheberin - auch der Admin nicht', async () => {
  reset();
  as(ALICE);
  await call('POST', '/', { name: 'Mein Kram', url: 'privat.example', visibility: 'private' });
  await call('POST', '/', { name: 'Für alle', url: 'geteilt.example', visibility: 'all' });

  as(ALICE);
  assert.equal((await call('GET', '/')).body.data.length, 2);

  as(BOB);
  const bobSees = (await call('GET', '/')).body.data;
  assert.deepEqual(bobSees.map((q) => q.name), ['Für alle']);

  // DER ADMIN IST HIER KEINE AUSNAHME, und das ist Absicht: privat heisst
  // privat, wie überall sonst in dieser App (services/visibility.js).
  as(ADMIN, 'admin');
  assert.deepEqual((await call('GET', '/')).body.data.map((q) => q.name), ['Für alle']);
});

test('listQuickLinksFor ist die Quelle, aus der auch die Übersicht schöpft', () => {
  reset();
  const mine = db.prepare("INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('P','https://p/','private',?,0)").run(ALICE);
  db.prepare("INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('S','https://s/','all',?,1)").run(BOB);

  assert.deepEqual(listQuickLinksFor(ALICE).map((q) => q.name), ['P', 'S']);
  assert.deepEqual(listQuickLinksFor(BOB).map((q) => q.name), ['S']);
  assert.equal(mine.changes, 1);
});

// --------------------------------------------------------
// 4. Wer ändern darf - und was can_edit dazu sagt
// --------------------------------------------------------

test('can_edit deckt sich mit dem, was der Server danach erlaubt', async () => {
  reset();
  as(BOB);
  const shared = (await call('POST', '/', { name: 'Bobs geteilte', url: 'b.example' })).body.data;

  // Alice sieht sie, darf sie aber nicht anfassen - und die Antwort sagt das.
  as(ALICE);
  const seen = (await call('GET', '/')).body.data.find((q) => q.id === shared.id);
  assert.equal(seen.can_edit, false);
  assert.equal((await call('PUT', `/${shared.id}`, { name: 'geklaut' })).status, 403);
  assert.equal((await call('DELETE', `/${shared.id}`)).status, 403);

  // Der Admin darf eine GETEILTE Kachel aufräumen - sie steht auf der
  // Startseite des Haushalts, nicht auf seiner.
  as(ADMIN, 'admin');
  const asAdmin = (await call('GET', '/')).body.data.find((q) => q.id === shared.id);
  assert.equal(asAdmin.can_edit, true);
  assert.equal((await call('PUT', `/${shared.id}`, { name: 'aufgeraeumt' })).status, 200);

  // Bob selbst natürlich auch.
  as(BOB);
  assert.equal((await call('GET', '/')).body.data[0].can_edit, true);
});

test('eine fremde private Kachel antwortet mit 404 und nicht mit 403', async () => {
  reset();
  as(ALICE);
  const priv = (await call('POST', '/', { name: 'Geheim', url: 'g.example', visibility: 'private' })).body.data;

  // 403 würde ihre Existenz bestätigen. Für Bob gibt es sie nicht.
  as(BOB);
  assert.equal((await call('PUT', `/${priv.id}`, { name: 'x' })).status, 404);
  assert.equal((await call('DELETE', `/${priv.id}`)).status, 404);

  // Auch für den Admin nicht - sonst wäre "auf geteilt stellen" ein Leseweg.
  as(ADMIN, 'admin');
  assert.equal((await call('PUT', `/${priv.id}`, { visibility: 'all' })).status, 404);
});

test('PUT ändert nur, was mitgeschickt wurde', async () => {
  reset();
  as(ALICE);
  const created = (await call('POST', '/', {
    name: 'Alt', url: 'alt.example', color: '#007AFF', visibility: 'all',
  })).body.data;

  const updated = (await call('PUT', `/${created.id}`, { name: 'Neu' })).body.data;
  assert.equal(updated.name, 'Neu');
  assert.equal(updated.url, 'https://alt.example/');
  assert.equal(updated.color, '#007AFF');
  assert.equal(updated.visibility, 'all');
});

test('PUT weist eine kaputte Adresse ab und lässt die alte stehen', async () => {
  reset();
  as(ALICE);
  const created = (await call('POST', '/', { name: 'X', url: 'gut.example' })).body.data;
  assert.equal((await call('PUT', `/${created.id}`, { url: 'javascript:alert(1)' })).status, 400);
  assert.equal(db.prepare('SELECT url FROM quick_links WHERE id = ?').get(created.id).url, 'https://gut.example/');
});

// --------------------------------------------------------
// 5. Reihenfolge
// --------------------------------------------------------

test('die Reihenfolge folgt der gesendeten Liste', async () => {
  reset();
  as(ALICE);
  const a = (await call('POST', '/', { name: 'A', url: 'a.example' })).body.data;
  const b = (await call('POST', '/', { name: 'B', url: 'b.example' })).body.data;
  const c = (await call('POST', '/', { name: 'C', url: 'c.example' })).body.data;

  const res = await call('PUT', '/order', { ids: [c.id, a.id, b.id] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((q) => q.name), ['C', 'A', 'B']);
});

test('eine fremde private Kachel lässt sich nicht per Reihenfolge verschieben', async () => {
  reset();
  as(ALICE);
  const priv = (await call('POST', '/', { name: 'Geheim', url: 'g.example', visibility: 'private' })).body.data;
  const before = db.prepare('SELECT position FROM quick_links WHERE id = ?').get(priv.id).position;

  as(BOB);
  const own = (await call('POST', '/', { name: 'Bobs', url: 'b.example' })).body.data;
  // Bob schickt eine Id mit, die er nicht sehen kann. Sie wird ignoriert,
  // nicht verschoben - eine Reihenfolge ist kein Weg an der Sichtbarkeit vorbei.
  await call('PUT', '/order', { ids: [priv.id, own.id] });
  assert.equal(db.prepare('SELECT position FROM quick_links WHERE id = ?').get(priv.id).position, before);
});

test('/order fängt eine kaputte Anfrage ab, statt die Reihenfolge zu leeren', async () => {
  reset();
  as(ALICE);
  await call('POST', '/', { name: 'A', url: 'a.example' });
  assert.equal((await call('PUT', '/order', { ids: 'keine-liste' })).status, 400);
  assert.equal((await call('PUT', '/order', {})).status, 400);
});

// --------------------------------------------------------
// Das eingebaute Symbol als drittes Gesicht (#873)
// --------------------------------------------------------

test('ein Symbolname wird gespeichert und kommt zurück', async () => {
  reset();
  as(ALICE);
  const res = await call('POST', '/', { name: 'Jellyfin', url: 'j.example', icon_name: 'clapperboard' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.icon_name, 'clapperboard');
  assert.equal(res.body.data.icon_data, null);
});

test('der Server prüft die FORM des Namens, nicht seine Existenz', async () => {
  reset();
  as(ALICE);
  // Ein Name, den dieser Lucide-Stand nicht kennt, ist KEIN Fehler: das Bundle
  // benennt zwischen Versionen um, und der Server kennt den Vorrat nicht. Die
  // Kachel fällt in der Anzeige auf ihren Buchstaben zurück.
  const ok = await call('POST', '/', { name: 'X', url: 'x.example', icon_name: 'gibt-es-nicht-mehr' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.icon_name, 'gibt-es-nicht-mehr');
});

test('ein Symbolname, der aus dem Attribut ausbrechen könnte, wird abgewiesen', async () => {
  reset();
  as(ALICE);
  // Der Name landet als `data-lucide="..."` im Markup. Grossbuchstaben,
  // Anfuehrungszeichen, spitze Klammern und Leerzeichen haben dort nichts zu
  // suchen - und die Absage kommt vom Server, nicht erst vom esc() dahinter.
  for (const bad of ['film" onload="x', '<script>', 'Film', 'film icon', 'film/../x', 'ünicode']) {
    const res = await call('POST', '/', { name: 'X', url: 'x.example', icon_name: bad });
    assert.equal(res.status, 400, `"${bad}" hätte abgewiesen werden müssen`);
  }
});

test('ein zu langer Symbolname wird abgewiesen', async () => {
  reset();
  as(ALICE);
  const res = await call('POST', '/', { name: 'X', url: 'x.example', icon_name: 'a'.repeat(49) });
  assert.equal(res.status, 400);
});

test('leer und null heissen beide „kein Symbol"', async () => {
  reset();
  as(ALICE);
  for (const value of ['', null, '   ']) {
    const res = await call('POST', '/', { name: 'X', url: 'x.example', icon_name: value });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.icon_name, null, `${JSON.stringify(value)} sollte null ergeben`);
  }
});

test('PUT ohne icon_name lässt das vorhandene Symbol stehen', async () => {
  reset();
  as(ALICE);
  const row = (await call('POST', '/', { name: 'X', url: 'x.example', icon_name: 'server' })).body.data;

  // Ein Feld, das nicht mitgeschickt wird, ist keine Ansage - sonst löschte
  // jede Teiländerung das Symbol mit.
  const res = await call('PUT', `/${row.id}`, { name: 'Y' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.icon_name, 'server');
});

test('PUT mit null nimmt das Symbol weg', async () => {
  reset();
  as(ALICE);
  const row = (await call('POST', '/', { name: 'X', url: 'x.example', icon_name: 'server' })).body.data;
  const res = await call('PUT', `/${row.id}`, { icon_name: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.icon_name, null);
});

test('Symbol und Bild dürfen nebeneinander stehen - die Anzeige entscheidet', async () => {
  reset();
  as(ALICE);
  // Das Schema verbietet es bewusst nicht (Migration v163): ein CHECK machte
  // aus jedem Wechsel zwischen den Gesichtern zwei Schreibvorgänge.
  // Ein echter PNG-Kopf statt Fuellzeichen: seit #937 prueft der Upload den
  // Inhalt, und 40 mal 'A' war nie ein Bild.
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const res = await call('POST', '/', { name: 'X', url: 'x.example', icon_name: 'server', icon_data: png });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.icon_name, 'server');
  assert.equal(res.body.data.icon_data, png);
});

test('listQuickLinksFor liefert icon_name mit - die Übersicht liest über diesen Weg', async () => {
  reset();
  as(ALICE);
  await call('POST', '/', { name: 'X', url: 'x.example', icon_name: 'house' });
  // Die Kacheln kommen mit der Übersichts-Antwort, nicht über GET /quick-links
  // (server/routes/dashboard.js). Fehlte die Spalte dort, wäre das Symbol im
  // Verwaltungsdialog zu sehen und auf der Startseite nicht.
  const rows = listQuickLinksFor(ALICE, false);
  assert.equal(rows[0].icon_name, 'house');
});
