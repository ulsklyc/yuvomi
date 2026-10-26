// DIE NACHTSTUNDEN DIESES GERAETS - EINE FUNKTION FUER ZWEI LESER (#1901, #2234).
//
// Wand-Modus und Bildschirmschoner dunkeln in denselben Stunden ab. Gefragt
// wird an zwei Stellen, die nicht dieselbe Sprache sprechen:
//   - theme-init.js, ein klassisches <script> im <head>, vor jedem Modul: es
//     setzt `data-wall-night` fuer das erste Bild und kann nichts importieren;
//   - utils/night-hours.js, das Modul, das Wand (utils/wall-mode.js,
//     isWallNight) und Bildschirmschoner (components/photo-screensaver.js)
//     fragen.
// Bis #2234 standen die Stunden deshalb zweimal da, als Konstanten im Modul
// und als Literale hier im Kopf, und die beiden lasen verschiedene Uhren: der
// Kopf die des Geraets, das Modul die des Haushalts. Auf einem Tablet, dessen
// Browser in einer anderen Zone steht, malte ein Reload in den Stunden
// dazwischen erst den falschen Zustand und kippte dann.
//
// Jetzt steht die Rechnung EINMAL hier. Diese Datei ist beides: index.html und
// offline.html laden sie als klassisches Skript VOR theme-init.js, und
// utils/night-hours.js importiert sie als Modul (ein Modul ohne `export`
// laeuft einfach durch). Beide Wege legen dasselbe Objekt auf
// `globalThis.yuvomiNightHours`; deshalb steht hier kein `import`/`export`
// und nichts, was ein klassisches Skript nicht kann.
//
// GERAETELOKAL wie Wand-Modus und Schoner-Wartezeit (`localStorage`): eine Wand
// laeuft meist auf einem geteilten Konto, eine Haushaltseinstellung schaltete
// allen das Handy um. Die STUNDEN sind aber Haushaltszeit: gelesen wird die
// gespiegelte Haushaltszone (`yuvomi-timezone`, utils/timezone.js), ohne sie
// die des Geraets - dieselbe Rueckfallregel wie `displayTimeZone()`.
(function (root) {
  'use strict';

  var KEY = 'yuvomi-night-hours';
  // Gleicher Schluessel wie STORAGE_KEY in utils/timezone.js; der Guard in
  // test-frontend-audit.js haelt die beiden zusammen.
  var ZONE_KEY = 'yuvomi-timezone';
  // Unveraendert seit dem ersten Wand-Modus: 22:00 bis 06:00.
  var DEFAULT_FROM = 22;
  var DEFAULT_TO = 6;

  function isHour(n) {
    return typeof n === 'number' && n % 1 === 0 && n >= 0 && n <= 23;
  }

  /**
   * Gespeicherter oder gewaehlter Wert -> { from, to } in ganzen Stunden.
   * Alles andere (kein Schluessel, Handarbeit, gleiche Grenzen) faellt auf die
   * Vorgabe zurueck, nicht auf ein Fenster, das niemand gewaehlt hat. Gleiche
   * Grenzen waeren ein leeres Fenster - ein "Aus", das die Einstellung nicht
   * anbietet (die Auswahl sperrt die Stunde der anderen Grenze).
   */
  function parse(value) {
    var m = /^(\d{1,2})-(\d{1,2})$/.exec(String(value == null ? '' : value));
    if (m) {
      var from = Number(m[1]);
      var to = Number(m[2]);
      if (isHour(from) && isHour(to) && from !== to) return { from: from, to: to };
    }
    return { from: DEFAULT_FROM, to: DEFAULT_TO };
  }

  /** Die Schreibweise im Speicher: "22-6". */
  function serialize(hours) {
    return hours.from + '-' + hours.to;
  }

  /** Die Stunden dieses Geraets aus einem Storage (blockiert -> Vorgabe). */
  function read(storage) {
    try {
      return parse(storage.getItem(KEY));
    } catch (e) {
      return parse(null);
    }
  }

  /** Die Haushaltszone aus einem Storage, oder null. */
  function readZone(storage) {
    try {
      return storage.getItem(ZONE_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Die Stunde von `now` auf der Uhr von `zone`; ohne oder mit unbekannter
   * Zone die des Geraets (wie `displayTimeZone()` eine ungueltige Zone
   * verwirft).
   */
  function hourIn(now, zone) {
    if (zone) {
      try {
        var parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hour12: false })
          .formatToParts(now);
        for (var i = 0; i < parts.length; i++) {
          // Manche Engines schreiben Mitternacht als "24".
          if (parts[i].type === 'hour') return Number(parts[i].value) % 24;
        }
      } catch (e) { /* unbekannte Zone: Geraeteuhr */ }
    }
    return now.getHours();
  }

  /**
   * Liegt `now` in den Nachtstunden? Ueber Mitternacht hinweg (22-6) ist es
   * ein ODER, am selben Tag (1-5) ein UND - dieselbe Falle, die das
   * Tagesprogramm beim Mitternachts-Ausblick schon einmal hatte.
   */
  function isNight(now, zone, hours) {
    var h = hourIn(now, zone);
    var w = hours || parse(null);
    return w.from > w.to ? (h >= w.from || h < w.to) : (h >= w.from && h < w.to);
  }

  root.yuvomiNightHours = Object.freeze({
    KEY: KEY,
    ZONE_KEY: ZONE_KEY,
    DEFAULT_FROM: DEFAULT_FROM,
    DEFAULT_TO: DEFAULT_TO,
    parse: parse,
    serialize: serialize,
    read: read,
    readZone: readZone,
    hourIn: hourIn,
    isNight: isNight,
  });
})(globalThis);
