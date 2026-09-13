/**
 * Modul: Anzeigezone (#829 Teil 3)
 * Zweck: Die Anzeige folgt der Haushaltszone statt der des Browsers - und die
 *        Regel, die entscheidet, WAS umgerechnet wird.
 *
 *        Teil 1+2 (v2.34.0) haben die fuenf serverseitigen Uhren auf
 *        `householdTimeZone(database)` zusammengefuehrt. Die sechste war die
 *        Anzeige: der Browser rechnet einen extern synchronisierten Termin
 *        (Instant, `…Z`) in SEINE Zone um, waehrend ein von Hand angelegter
 *        (zonenlose Wanduhrzeit) stehenbleibt. Zwei Termine derselben Uhrzeit
 *        landeten so auf zwei verschiedenen Zeiten - aber nur auf einem Geraet,
 *        das nicht in der Zone des Haushalts steht.
 *
 *        Deckt ab:
 *          - die Regel: umgerechnet wird nur, was seine Zone SELBST traegt
 *            (Gegenprobe: eine Wanduhrzeit, die faelschlich umgerechnet wuerde,
 *            zeigte eine andere Zahl als die eingetippte)
 *          - ohne Einstellung aendert sich nichts - Bestandshaushalte behalten
 *            exakt das Browser-Verhalten
 *          - `todayKey()` ist der Tag der Haushaltszone, nicht der des Browsers
 *          - `toLocalDateKey`/`parseLocalDateKey` bleiben ein Paar: der
 *            Round-Trip darf die Zone NICHT sehen, sonst kippt jeder Datums-Key
 *          - der Guard: kein Frontend-Modul leitet einen Kalendertag oder eine
 *            Uhrzeit noch aus den Browser-Gettern eines Instants ab
 *
 *        Die Browser-Zone wird explizit gesetzt. In der UTC-CI faellt kein
 *        Kalendertag um, ein Test ohne Vorgabe waere gruen und blind - dieselbe
 *        Falle wie bei test-household-timezone.js und
 *        test-calendar-timezone-window.js (#824).
 * Ausfuehren: node --test test/test-display-timezone.js
 */
process.env.TZ = 'America/Toronto';   // UTC-5/-4: ein Abend-Instant faellt hier auf den Vortag

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tz = await import('../public/utils/timezone.js');
test('recorded wall time preserves astronomical year zero and BCE identity', () => {
  for (const year of ['0000', '-000001', '-200000']) {
    const original = `${year}-06-01T12:00:00.123Z`;
    assert.equal(tz.wallTimeValue(original, 'UTC'), `${year}-06-01T12:00:00`);
    assert.equal(tz.wallTimeInstant(`${year}-06-01T12:00:00`, 'UTC', original), original);
    assert.equal(tz.wallTimeInstant(`${year}-06-01T12:05:00`, 'UTC', original), `${year}-06-01T12:05:00.000Z`);
  }
});
test('explicit recorded zone retains fold offset and rejects a missing local hour', () => {
  assert.equal(typeof tz.wallTimeInstant, 'function');
  assert.equal(tz.wallTimeInstant('2025-10-26T02:35:00', 'Europe/Prague', '2025-10-26T01:30:00Z'), '2025-10-26T01:35:00.000Z');
  assert.equal(tz.wallTimeInstant('2025-10-26T02:35:00', 'Europe/Prague', '2025-10-26T00:30:00Z'), '2025-10-26T00:35:00.000Z');
  assert.throws(() => tz.wallTimeInstant('2025-03-30T02:30:00', 'Europe/Prague'), /wall time/);
  assert.equal(tz.wallTimeValue('2025-10-26T01:30:00.123Z', 'Europe/Prague'), '2025-10-26T02:30:00');
  assert.equal(tz.wallTimeInstant('2025-10-26T02:30:00', 'Europe/Prague', '2025-10-26T01:30:00.123Z'), '2025-10-26T01:30:00.123Z');
});
const dateUtils = await import('../public/utils/date.js');

const {
  displayTimeZone, hasExplicitZone, isInstant, isValidTimeZone,
  setDisplayTimeZone, todayKey, zonedDateKey, zonedFields, zonedTimeKey, zonedWeekday,
} = tz;

// localStorage gibt es in Node nicht; setDisplayTimeZone haelt den Wert deshalb
// zusaetzlich im Prozess-Cache. Genau dieser Rueckfall wird hier benutzt.
const withZone = (zone, fn) => {
  setDisplayTimeZone(zone);
  try { return fn(); } finally { setDisplayTimeZone(null); }
};

// --------------------------------------------------------
// Die Regel: umgerechnet wird nur, was seine Zone selbst traegt
// --------------------------------------------------------

test('hasExplicitZone trennt die zwei Speicherformen in start_datetime', () => {
  assert.equal(hasExplicitZone('2026-08-21T19:00:00Z'), true);
  assert.equal(hasExplicitZone('2026-08-21T19:00:00+02:00'), true);
  assert.equal(hasExplicitZone('2026-08-21T19:00:00+0200'), true);
  // Die andere Form: zonenlose Wanduhrzeit, wie der Termin-Dialog sie schreibt.
  assert.equal(hasExplicitZone('2026-08-21T19:00'), false);
  assert.equal(hasExplicitZone('2026-08-21'), false);
});

test('isInstant: nur Date, Zahl und zonenbehafteter String sind Zeitpunkte', () => {
  assert.equal(isInstant(new Date()), true);
  assert.equal(isInstant(1_755_800_000_000), true);
  assert.equal(isInstant('2026-08-21T19:00:00Z'), true);
  assert.equal(isInstant('2026-08-21T19:00'), false);
  assert.equal(isInstant('2026-08-21'), false);
});

test('eine zonenlose Wanduhrzeit wird GELESEN, nicht gerechnet', () => {
  // Der Kern der Regel. Wer "19:00" eingetippt hat, meinte 19:00 - in jeder
  // Zone. Eine Umrechnung machte daraus eine andere Zahl.
  withZone('Asia/Tokyo', () => {
    assert.equal(zonedTimeKey('2026-08-21T19:00'), '19:00');
    assert.equal(zonedDateKey('2026-08-21T19:00'), '2026-08-21');
  });
  // Gegenprobe mit einer Zone auf der anderen Seite von UTC: dieselbe Antwort.
  // Ohne diese Haelfte koennte der Test auch gruen sein, wenn Tokio zufaellig
  // die Zone waere, in der die Rechnung aufgeht.
  withZone('America/Los_Angeles', () => {
    assert.equal(zonedTimeKey('2026-08-21T19:00'), '19:00');
    assert.equal(zonedDateKey('2026-08-21T19:00'), '2026-08-21');
  });
});

test('ein reines Datum hat keine Uhrzeit und bleibt in jeder Zone derselbe Tag', () => {
  for (const zone of ['Asia/Tokyo', 'America/Los_Angeles', 'UTC', 'Pacific/Kiritimati']) {
    withZone(zone, () => {
      assert.equal(zonedDateKey('2026-08-21'), '2026-08-21', `Zone ${zone}`);
    });
  }
});

test('ein Instant wird in die Anzeigezone umgerechnet', () => {
  // 2026-08-21T23:30Z ist in Tokio bereits der 22. um 08:30.
  withZone('Asia/Tokyo', () => {
    assert.equal(zonedDateKey('2026-08-21T23:30:00Z'), '2026-08-22');
    assert.equal(zonedTimeKey('2026-08-21T23:30:00Z'), '08:30');
  });
  // ...und in Los Angeles noch der 21. um 16:30.
  withZone('America/Los_Angeles', () => {
    assert.equal(zonedDateKey('2026-08-21T23:30:00Z'), '2026-08-21');
    assert.equal(zonedTimeKey('2026-08-21T23:30:00Z'), '16:30');
  });
});

test('derselbe Zeitpunkt aus beiden Speicherformen zeigt dieselbe Uhrzeit', () => {
  // Das ist die Zusicherung, um die es #829 geht. Ein Termin um 19:00 Berliner
  // Zeit, einmal lokal angelegt (Wanduhr) und einmal ueber Google
  // hereinsynchronisiert (Instant), muss auf demselben Schirm dieselbe Uhrzeit
  // zeigen - auch wenn der Browser in Toronto steht.
  withZone('Europe/Berlin', () => {
    assert.equal(zonedTimeKey('2026-08-21T19:00'), '19:00');
    assert.equal(zonedTimeKey('2026-08-21T17:00:00Z'), '19:00');   // Sommerzeit: UTC+2
  });
});

test('ueber die DST-Grenze folgt der Offset der Zone, nicht einem Fixwert', () => {
  withZone('Europe/Berlin', () => {
    assert.equal(zonedTimeKey('2026-01-15T17:00:00Z'), '18:00');   // Winter: UTC+1
    assert.equal(zonedTimeKey('2026-07-15T17:00:00Z'), '19:00');   // Sommer: UTC+2
  });
});

// --------------------------------------------------------
// Ohne Einstellung aendert sich nichts
// --------------------------------------------------------

test('ohne Einstellung ist die Anzeigezone null - also die des Browsers', () => {
  setDisplayTimeZone(null);
  assert.equal(displayTimeZone(), null);
  // process.env.TZ ist America/Toronto: 23:30Z ist dort der 21. um 19:30.
  assert.equal(zonedDateKey('2026-08-21T23:30:00Z'), '2026-08-21');
  assert.equal(zonedTimeKey('2026-08-21T23:30:00Z'), '19:30');
});

test('ohne Einstellung liefert zonedFields exakt die Browser-Getter', () => {
  setDisplayTimeZone(null);
  const d = new Date('2026-08-21T23:30:45Z');
  assert.deepEqual(zonedFields(d), {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
  });
});

test('eine unbekannte oder unsinnige Zone faellt zurueck statt zu werfen', () => {
  setDisplayTimeZone('Mars/Olympus_Mons');
  assert.equal(displayTimeZone(), null);
  setDisplayTimeZone('');
  assert.equal(displayTimeZone(), null);
  setDisplayTimeZone(undefined);
  assert.equal(displayTimeZone(), null);
  assert.equal(isValidTimeZone('Europe/Berlin'), true);
  assert.equal(isValidTimeZone('nonsense'), false);
});

// --------------------------------------------------------
// todayKey - die Frage an die Uhr
// --------------------------------------------------------

test('todayKey liefert den Tag der Haushaltszone, nicht den des Browsers', () => {
  // 2026-08-22T02:30Z: in Toronto (Browser) noch der 21. um 22:30, in Berlin
  // schon der 22. um 04:30.
  const now = new Date('2026-08-22T02:30:00Z');
  withZone('Europe/Berlin', () => {
    assert.equal(todayKey(now), '2026-08-22');
  });
  // Gegenprobe: ohne Einstellung waere die Zusicherung falsch - genau das ist
  // der Fehler, den Teil 3 behebt.
  setDisplayTimeZone(null);
  assert.equal(todayKey(now), '2026-08-21');
});

test('date.js exportiert todayKey und reicht die Anzeigezone durch', () => {
  withZone('Asia/Tokyo', () => {
    const viaDateUtils = dateUtils.todayKey();
    assert.equal(viaDateUtils, todayKey());
    assert.match(viaDateUtils, /^\d{4}-\d{2}-\d{2}$/);
  });
});

// --------------------------------------------------------
// Das Paar toLocalDateKey/parseLocalDateKey darf die Zone NICHT sehen
// --------------------------------------------------------

test('der Round-Trip Key -> Date -> Key ueberlebt jede Anzeigezone', () => {
  // toLocalDateKey ist ein KONVERTER, kein Blick auf die Uhr: parseLocalDateKey
  // baut ein Date in der Browser-Zone, und nur wenn die Rueckrichtung dieselbe
  // Zone liest, kommt der Schluessel unveraendert zurueck. Haette man beide auf
  // die Haushaltszone umgestellt, kippte jedes Datum in der App um einen Tag.
  const keys = ['2026-01-01', '2026-08-21', '2026-12-31', '2026-03-29'];
  for (const zone of ['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', null]) {
    withZone(zone, () => {
      for (const key of keys) {
        assert.equal(
          dateUtils.toLocalDateKey(dateUtils.parseLocalDateKey(key)), key,
          `Zone ${zone}, Key ${key}`
        );
      }
    });
  }
});

test('addLocalDays und monthPeriodKeys bleiben zonenfest', () => {
  withZone('Pacific/Kiritimati', () => {
    assert.equal(dateUtils.addLocalDays('2026-08-31', 1), '2026-09-01');
    assert.deepEqual(dateUtils.monthPeriodKeys('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  });
});

// --------------------------------------------------------
// Kleinkram, der schon einmal falsch war
// --------------------------------------------------------

test('Mitternacht wird nicht als Stunde 24 durchgereicht', () => {
  // Manche ICU-Locales geben Mitternacht als '24'. Die Korrektur gilt NUR fuer
  // die Stunde - auf den Tag angewandt wuerde sie den 24. eines Monats auf 0
  // setzen (dieselbe Falle wie in server/utils/timezone.js).
  withZone('Europe/Berlin', () => {
    assert.equal(zonedTimeKey('2026-08-23T22:00:00Z'), '00:00');
    assert.equal(zonedDateKey('2026-08-23T22:00:00Z'), '2026-08-24');
    const f = zonedFields('2026-08-23T22:00:00Z');
    assert.equal(f.day, 24, 'der 24. darf nicht mit der Stunden-Korrektur kollidieren');
  });
});

test('zonedWeekday zaehlt wie getDay (0=Sonntag) und folgt der Zone', () => {
  withZone('Asia/Tokyo', () => {
    // 2026-08-21T23:30Z ist in Tokio Samstag, der 22.
    assert.equal(zonedWeekday('2026-08-21T23:30:00Z'), 6);
  });
  withZone('America/Los_Angeles', () => {
    // ...und dort noch Freitag, der 21.
    assert.equal(zonedWeekday('2026-08-21T23:30:00Z'), 5);
  });
});

test('unlesbare Werte geben leer zurueck statt zu werfen', () => {
  for (const bad of [null, undefined, '', 'kein datum', NaN, new Date('x')]) {
    assert.equal(zonedFields(bad), null, String(bad));
    assert.equal(zonedDateKey(bad), '');
    assert.equal(zonedTimeKey(bad), '');
  }
});

// --------------------------------------------------------
// Der Guard: keine zweite Uhr im Frontend
// --------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'vendor' || entry === 'locales') continue;
      jsFiles(full, out);
    } else if (entry.endsWith('.js') && !entry.endsWith('.min.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Kommentarzeilen raus, bevor ein Guard sucht.
 *
 * Ein Guard, der Prosa liest, meldet die Erklaerung, warum etwas erlaubt ist,
 * als Verstoss - genau das ist beim ersten Lauf passiert: der Satz „`timeZone:
 * 'UTC'`: so bleibt die Schreibweise erhalten" schlug an. Bewusst zeilenweise
 * und nicht mit einem Parser: ein Regex ueber `/* … *\/` und `//` muesste
 * Strings verschonen (`'https://…'`), und die Fehlerrichtung waere dann still
 * falsch statt laut.
 */
function withoutComments(text) {
  return text.split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

const SOURCES = jsFiles(PUBLIC).map((file) => {
  const text = readFileSync(file, 'utf8');
  return { file, rel: path.relative(PUBLIC, file), text, code: withoutComments(text) };
});

test('der Guard sieht ueberhaupt Dateien - sonst waere er gruen und blind', () => {
  assert.ok(SOURCES.length > 50, `nur ${SOURCES.length} Dateien gefunden`);
  assert.ok(SOURCES.some((s) => s.rel === 'i18n.js'));
  assert.ok(SOURCES.some((s) => s.rel === path.join('pages', 'calendar.js')));
});

test('formatDate/formatTime bekommen keinen Date-Umweg um einen Datums-Key', () => {
  // `formatDate(new Date(key + 'T00:00:00'))` ist Mitternacht der BROWSER-Zone.
  // In einer Haushaltszone westlich davon zeigt das den Vortag. Der Key gehoert
  // direkt hinein - formatDate() kennt die reine Datumsform.
  const pattern = /format(?:Date|DayMonth|Time)\(\s*new Date\(\s*`\$\{[^`]*\}T00:00:00`/;
  const offenders = SOURCES.filter((s) => pattern.test(s.code)).map((s) => s.rel);
  assert.deepEqual(offenders, [], 'Datums-Key direkt an formatDate() uebergeben');
});

test('ausser utils/timezone.js liest kein Modul eine Uhrzeit aus einem Instant', () => {
  // Die Formulierung `new Date(irgendwas).getHours()` (oder getDate/getFullYear)
  // ist die Browser-Uhr - genau die sechste Uhr, die Teil 3 abgeschafft hat.
  // Erlaubt bleibt sie auf einem Date, das aus lokalen Kalenderfeldern gebaut
  // wurde (`new Date(y, m, d)`), denn das IST Browser-Wanduhrzeit.
  const pattern = /new Date\(\s*(?:[A-Za-z_$][\w$.?[\]]*|`[^`]*`|'[^']*'|"[^"]*")\s*\)\s*\.\s*get(?:Hours|Minutes|Date|FullYear|Month|Day)\(/;
  const allowed = new Set([
    path.join('utils', 'timezone.js'),
    path.join('utils', 'date.js'),        // parseLocalDateKey: Browser-Wanduhr ist dort die Absicht
  ]);
  const offenders = SOURCES
    .filter((s) => !allowed.has(s.rel) && pattern.test(s.code))
    .map((s) => s.rel);
  assert.deepEqual(offenders, [], 'Uhrzeit/Tag aus der Browser-Zone eines Instants abgeleitet');
});

/* DIE UHR STEHT AUCH DANN DA, WENN SIE EINEN NAMEN HAT.
 *
 * Der Guard darueber trifft `new Date(x).getHours()` - die Getter direkt am
 * Ausdruck. Die haeufigere Schreibweise ist aber
 *
 *     const now = new Date();
 *     now.getFullYear()
 *
 * und die sah er nicht. Sieben Stellen standen so im Baum, darunter beide
 * Faelligkeits-Beschriftungen (#851): eine Aufgabe konnte im Aufgabenmodul unter
 * „Morgen" stehen und „Heute faellig" heissen, weil die Gruppierung daneben
 * laengst `todayKey()` fragte. Der Guard war gruen und blind.
 *
 * Gesucht wird deshalb der ARGUMENTLOSE `new Date()` - das ist "jetzt", also
 * eine Frage an die Uhr, und die hat genau eine Antwort: `nowFields()` bzw.
 * `todayKey()`. `new Date(wert)` bleibt unberuehrt; einen gespeicherten Wert zu
 * lesen ist etwas anderes als die Uhr zu fragen.
 *
 * `getSeconds`/`getMilliseconds` stehen NICHT im Muster: sie sind in jeder Zone
 * dieselben. Wer sie liest, misst eine Dauer und fragt keinen Kalender - der
 * Minutentakt der Uhr-Kachel etwa. `getMinutes` dagegen steht drin, denn es gibt
 * Zonen mit halben und viertel Stunden (Indien +05:30, Nepal +05:45).
 *
 * Ohne Ausnahmeliste, mit zwei Ausnahmen, die keine sind:
 *   - utils/timezone.js beantwortet die Frage, es darf sie stellen.
 *   - theme-init.js laeuft als erstes Skript im <head>, vor jedem Modul und vor
 *     der gespiegelten Zone. Es hat keine Anzeigezone, die es fragen koennte,
 *     und was es entscheidet (Nachtthema) haengt an dem Geraet, vor dem jemand
 *     sitzt - nicht am Haushalt.
 */
test('kein Frontend-Modul baut sich sein eigenes "jetzt" aus der Browser-Uhr', () => {
  const allowed = new Set([
    path.join('utils', 'timezone.js'),
    'theme-init.js',
  ]);

  const offenders = [];
  for (const s of SOURCES) {
    if (allowed.has(s.rel)) continue;
    const lines = s.code.split('\n');
    lines.forEach((line, i) => {
      // `new Date()` ohne Argument, einer Bindung zugewiesen oder direkt gelesen.
      const bound = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new Date\(\s*\)/.exec(line);
      if (bound) {
        const window = lines.slice(i, i + 12).join('\n');
        const getter = new RegExp(`\\b${bound[1]}\\.get(?:Hours|Minutes|Date|Day|FullYear|Month)\\(`);
        if (getter.test(window)) offenders.push(`${s.rel}:${i + 1} (${bound[1]})`);
        return;
      }
      if (/new Date\(\s*\)\s*\.\s*get(?:Hours|Minutes|Date|Day|FullYear|Month)\(/.test(line)) {
        offenders.push(`${s.rel}:${i + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    'ein "jetzt" aus der Browser-Uhr statt aus der Anzeigezone - `nowFields()` bzw. `todayKey()` fragen');
});

/* `toDateString()` ist dieselbe Uhr unter anderem Namen.
 *
 * Sie kam beim Aufraeumen der sieben Uhren mit heraus und stand nicht im Muster
 * darueber, weil sie keinen Getter benutzt:
 *
 *     const today = new Date().toDateString();
 *     if (d.toDateString() === today) ...
 *
 * Das ist ein Kalendertagsvergleich in der BROWSER-Zone, und er stand an drei
 * Stellen im Dashboard - einmal fuer „ist dieser Termin heute", einmal fuer die
 * Auswahl der heutigen Termine, einmal im Heute/Morgen-Label. Wer Kalendertage
 * vergleicht, vergleicht Keys: `zonedDateKey()` bzw. `todayKey()`.
 */
test('kein Frontend-Modul vergleicht Kalendertage ueber toDateString()', () => {
  const offenders = [];
  for (const s of SOURCES) {
    if (s.rel === path.join('utils', 'timezone.js')) continue;
    s.code.split('\n').forEach((line, i) => {
      if (/\.toDateString\(\s*\)/.test(line)) offenders.push(`${s.rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'Kalendertage ueber toDateString() verglichen - das ist die Browser-Zone, `zonedDateKey()`/`todayKey()` nehmen');
});

test('der Guard erkennt die Schreibweise, an der er vorbeigesehen hat', () => {
  // Die Gegenprobe zum Guard selbst: er ist auf eine BINDUNG gebaut, und genau
  // die hat ihm gefehlt. Ein Guard ohne diese Zeile behauptet nur, er koenne es.
  const bound = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new Date\(\s*\)/;
  assert.ok(bound.test('const now = new Date();'));
  assert.ok(bound.test('  let today = new Date()'));
  // Ein Wert im Konstruktor ist kein "jetzt".
  assert.equal(bound.test('const d = new Date(iso);'), false);
  assert.equal(bound.test('const d = new Date(y, m, 1);'), false);
});

test('utils/timezone.js ist die einzige Stelle mit einem zonenbehafteten Formatter', () => {
  // Ein zweiter `Intl.DateTimeFormat` mit eigenem `timeZone` waere eine zweite
  // Uhr. Erlaubt ist `timeZone: 'UTC'` - das ist keine Zone, sondern die
  // Zusicherung, NICHT umzurechnen (i18n.js formatiert damit die bereits in der
  // Anzeigezone berechneten Felder, datepicker.js ein reines Kalenderraster).
  const offenders = [];
  for (const s of SOURCES) {
    if (s.rel === path.join('utils', 'timezone.js')) continue;
    for (const m of s.code.matchAll(/timeZone:\s*([^,\n}]+)/g)) {
      const value = m[1].trim();
      if (value !== "'UTC'" && value !== '"UTC"') offenders.push(`${s.rel}: ${value}`);
    }
  }
  assert.deepEqual(offenders, [], 'zweiter zonenbehafteter Formatter neben utils/timezone.js');
});

test('i18n.js formatiert ueber zonedFields, nicht ueber die Browser-Getter', () => {
  const src = SOURCES.find((s) => s.rel === 'i18n.js').text;
  assert.match(src, /import \{[^}]*zonedFields[^}]*\} from '\.\/utils\/timezone\.js'/);
  // Die drei Formatierer, die vor Teil 3 auf getFullYear/getHours standen.
  for (const fn of ['formatDateParts', 'formatDayMonth', 'formatTime']) {
    const body = src.slice(src.indexOf(`function ${fn}(`));
    const end = body.indexOf('\n}\n');
    assert.match(body.slice(0, end), /zonedFields\(/, `${fn} geht nicht ueber zonedFields`);
  }
});

test('meals.js leitet den Wochentag ueber zonedWeekday ab', () => {
  const src = SOURCES.find((s) => s.rel === path.join('pages', 'meals.js')).code;
  assert.match(src, /zonedWeekday\(/);
});

test('der Kalender liest Tag und Uhrzeit eines Termins ueber die Anzeigezone', () => {
  const src = SOURCES.find((s) => s.rel === path.join('pages', 'calendar.js')).text;
  assert.match(src, /import \{[^}]*zonedDateKey[^}]*\} from '\/utils\/timezone\.js'/);
  for (const fn of ['localDate', 'localTime']) {
    const body = src.slice(src.indexOf(`function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\n}\n')), /zoned(?:Date|Time)Key\(/, `${fn}`);
  }
});

test('die Haushaltszone wird beim Laden und beim Umstellen gespiegelt', () => {
  const router = SOURCES.find((s) => s.rel === 'router.js').text;
  assert.match(router, /setDisplayTimeZone\(res\?\.data\?\.timezone/,
    'router.js spiegelt die Zone nicht aus /preferences');
  // Bewusst `timezone`, nicht `timezone_effective`: letzteres ist nie leer und
  // wuerde die Anzeige eines Bestandshaushalts still auf die Container-`TZ`
  // umstellen.
  assert.doesNotMatch(router, /setDisplayTimeZone\([^)]*timezone_effective/,
    'router.js spiegelt die Rueckfallkette statt der getroffenen Wahl');
  assert.match(router, /addEventListener\('timezone-changed'/,
    'router.js zeichnet nach einem Zonenwechsel nicht neu');

  const settings = SOURCES.find((s) => s.rel === path.join('settings', 'pages', 'personal-appearance.js')).text;
  assert.match(settings, /setDisplayTimeZone\(/, 'die Settings-Seite spiegelt die Zone nicht');
  assert.match(settings, /dispatchEvent\(new CustomEvent\('timezone-changed'/,
    'ein Zonenwechsel loest kein Neuzeichnen aus');
  // Der Bug aus v2.34.0: renderPage liest beide Felder, render() reichte keines
  // durch - das Auswahlfeld stand nach dem Speichern wieder auf "Automatisch".
  assert.match(settings, /timezone:\s*loaded\.timezone/,
    'render() reicht die gewaehlte Zone nicht an das Formular durch');
  assert.match(settings, /timezone_effective:\s*loaded\.timezone_effective/,
    'render() reicht die geltende Zone nicht an das Automatik-Label durch');
});
