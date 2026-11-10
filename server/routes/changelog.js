/**
 * Modul: Changelog
 * Zweck: Authentifizierter Proxy fuer GitHub-Releases, auf UI-relevante
 *        Versionshinweise reduziert. Faellt auf die mitgelieferte
 *        CHANGELOG.md zurueck, wenn GitHub nicht antwortet (#838).
 * Abhängigkeiten: express, node:fs, logger
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('Changelog');

const RELEASES_URL = 'https://api.github.com/repos/ulsklyc/yuvomi/releases?per_page=30';
const CHANGELOG_PATH = new URL('../../CHANGELOG.md', import.meta.url);
// Dieselbe Zahl wie `per_page` oben: online und offline soll die Liste gleich
// lang sein, damit der Rueckfall nicht als "kuerzer" auffaellt.
const LOCAL_RELEASE_LIMIT = 30;
const CACHE_TTL_MS = 30 * 60 * 1000;
// Nach einem Fehlschlag wird GitHub eine Weile nicht erneut gefragt. Ohne
// diese Sperre liefe JEDE Anfrage wieder hinaus, sobald ein Abruf scheitert -
// bei sechzig unauthentifizierten Anfragen je Stunde und IP faehrt sich ein
// Haushalt damit selbst ins Limit und haelt den Fehler aufrecht (#838).
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const REQUEST_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Yuvomi/1.0 (+https://github.com/ulsklyc/yuvomi)',
  'X-GitHub-Api-Version': '2022-11-28',
};

const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
);

function normalizeVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^release[-_\s]*/i, '')
    .replace(/^v/i, '')
    .toLowerCase();
}

function cleanMarkdownText(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoiseLine(value) {
  return /^(assets?|downloads?|source code|full changelog|compare|all reactions?)\b/i.test(value)
    || /^https:\/\/github\.com\/.+\/compare\//i.test(value);
}

function ensureSection(sections, title) {
  const requestedTitle = title || 'Changes';
  let current = sections[sections.length - 1];
  if (!title && current) return current;
  if (!current || current.title !== requestedTitle) {
    current = { title: requestedTitle, entries: [] };
    sections.push(current);
  }
  return current;
}

// Der fett gesetzte Vorspann am Anfang eines Eintrags. Seit v2.41.0 oeffnet
// JEDER Changelog-Eintrag so, und `test/test-changelog.js` setzt das durch
// (#850) - hier wird diese Kante wieder gelesen, statt sie einzuebnen.
const LEAD_PATTERN = /^\*\*(.+?)\*\*\s*/;

/**
 * Zerlegt eine Eintragszeile in Vorspann und Begruendung.
 *
 * OHNE Vorspann (alles vor v2.41.0) ist die ganze Zeile der Vorspann und die
 * Begruendung leer. Das ist die ehrliche Lesart: ein Eintrag ohne Kurzfassung
 * bekommt keine erfundene, und die Ansicht zeigt ihn dann eben ganz.
 */
function splitEntry(rawText) {
  const lead = rawText.match(LEAD_PATTERN);
  if (!lead) return { lead: cleanMarkdownText(rawText), detail: '' };
  return {
    lead: cleanMarkdownText(lead[1]),
    detail: cleanMarkdownText(rawText.slice(lead[0].length)),
  };
}

/**
 * Ein Vorspann, der geoeffnet, aber auf dieser Zeile nicht geschlossen ist.
 *
 * CHANGELOG.md bricht bei rund 100 Zeichen um, und ein laengerer Vorspann
 * schliesst sein `**` erst auf der zweiten Zeile (#2656). Solange das so ist,
 * gehoert die naechste Zeile noch zum Vorspann und nicht zur Begruendung.
 *
 * @param {string} rawText
 */
function hasOpenLead(rawText) {
  return rawText.startsWith('**') && !LEAD_PATTERN.test(rawText);
}

function parseReleaseBody(body) {
  const sections = [];
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const title = cleanMarkdownText(heading[1]);
      if (title && !isNoiseLine(title)) ensureSection(sections, title);
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    const raw = bullet ? bullet[1] : line;
    // Die Rauschpruefung laeuft auf dem GEREINIGTEN Text - sie kennt Woerter,
    // keine Auszeichnung.
    const cleaned = cleanMarkdownText(raw);
    if (!cleaned || isNoiseLine(cleaned)) continue;

    const current = ensureSection(sections);
    if (bullet || current.entries.length === 0) {
      // `openLead` ist ein Arbeitsfeld dieser Schleife: der Rohtext eines
      // Vorspanns, dessen `**` noch offen ist. Es verlaesst die Funktion nicht.
      current.entries.push({ ...splitEntry(raw), openLead: hasOpenLead(raw) ? raw : null });
    } else {
      const last = current.entries[current.entries.length - 1];
      if (last.openLead) {
        // Der Vorspann laeuft ueber den Umbruch (#2656): Rohtext zusammenfuegen
        // und neu teilen. Schliesst er nie, bleibt der ganze Eintrag Vorspann -
        // wie bei jedem Eintrag ohne Vorspann, erfunden wird keiner.
        const joined = `${last.openLead} ${raw}`;
        Object.assign(last, splitEntry(joined), { openLead: hasOpenLead(joined) ? joined : null });
      } else {
        // Fortsetzungszeile: sie gehoert zur BEGRUENDUNG, nie zum Vorspann - der
        // ist genau ein Satz, und ihn waehrend des Lesens wachsen zu lassen
        // wuerde die Kurzfassung wieder zur Textwand machen.
        last.detail = `${last.detail} ${cleaned}`.trim();
      }
    }
  }

  return sections
    .map((section) => {
      const entries = section.entries
        .filter((e) => e.lead || e.detail)
        .map((/** @type {{ lead: string, detail: string }} */ e) => ({ lead: e.lead, detail: e.detail }));
      return {
        title: section.title,
        entries,
        // `items` bleibt Wort fuer Wort, was es vorher war: ein Eintrag als
        // EIN String. /api/v1 ist eine zugesagte Oberflaeche, und `entries`
        // daneben zu legen kostet ein paar Bytes doppelt, aber niemandem
        // seinen Integrator. Beides stammt aus derselben Zerlegung - es sind
        // zwei Sichten auf einen Text, keine zwei Wahrheiten.
        items: entries.map((e) => `${e.lead} ${e.detail}`.trim()).filter(Boolean),
      };
    })
    .filter((section) => section.items.length);
}

function releaseVersion(release) {
  return String(release?.tag_name || release?.name || '').trim();
}

function normalizeRelease(release) {
  const version = releaseVersion(release);
  return {
    version,
    sections: parseReleaseBody(release?.body),
  };
}

/**
 * Schneidet die mitgelieferte CHANGELOG.md in Versionsbloecke.
 *
 * Der Rueckfall existiert, weil die Route sonst nichts anzuzeigen hat, sobald
 * api.github.com nicht erreichbar ist (#838): kein Netz nach draussen, ein
 * Timeout, oder das Limit von sechzig unauthentifizierten Anfragen je Stunde
 * und IP. Fuer eine selbstgehostete App ist "der eigene Verlauf braucht
 * fremdes Netz" die falsche Abhaengigkeit.
 *
 * Die Bloecke laufen durch dasselbe `parseReleaseBody` wie die Texte von
 * GitHub - beide sind Markdown mit `###`-Ueberschriften und Listen, und beide
 * sollen gleich aussehen. `[Unreleased]` faellt raus: der Abschnitt traegt
 * keine Version und beschreibt nichts, was der laufende Stand schon kann.
 */
function parseChangelogFile(text) {
  const releases = [];
  let current = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+\[([^\]]+)]/);
    if (heading) {
      const version = heading[1].trim();
      if (/^unreleased$/i.test(version)) {
        current = null;
        continue;
      }
      if (releases.length >= LOCAL_RELEASE_LIMIT) break;
      current = { version, lines: [] };
      releases.push(current);
      continue;
    }
    if (current) current.lines.push(rawLine);
  }

  return releases.map((release) => ({
    version: release.version,
    sections: parseReleaseBody(release.lines.join('\n')),
  })).filter((release) => release.sections.length);
}

/**
 * Baut die Antwort aus der mitgelieferten Datei.
 *
 * `latest_version` bleibt bewusst null: die Datei kann nur bis zur eigenen
 * Version reichen, "die neueste ist meine" waere also eine Zusicherung, die
 * hier niemand pruefen konnte. Der Client zeigt die Version dann als
 * unbekannt an, statt faelschlich Aktualitaet zu melden.
 */
function buildLocalPayload(readFile, currentVersion = APP_VERSION) {
  const releases = parseChangelogFile(readFile());
  const currentKey = normalizeVersion(currentVersion);
  return {
    current_version: currentVersion,
    latest_version: null,
    current_in_releases: Boolean(currentKey)
      && releases.some((release) => normalizeVersion(release.version) === currentKey),
    releases,
    source: 'local',
  };
}

function buildChangelogPayload(releases, currentVersion = APP_VERSION) {
  const normalized = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && release.draft !== true)
    .map(normalizeRelease)
    .filter((release) => release.version);

  const currentKey = normalizeVersion(currentVersion);
  const latestVersion = normalized[0]?.version || null;
  const currentInReleases = Boolean(currentKey)
    && normalized.some((release) => normalizeVersion(release.version) === currentKey);

  return {
    current_version: currentVersion,
    latest_version: latestVersion,
    current_in_releases: currentInReleases,
    releases: normalized,
    source: 'github',
  };
}

export function buildRouter({
  fetchFn = globalThis.fetch,
  appVersion = APP_VERSION,
  now = () => Date.now(),
  readChangelogFile = () => readFileSync(CHANGELOG_PATH, 'utf-8'),
} = {}) {
  const router = express.Router();
  let cachedPayload = null;
  let cachedAt = 0;
  let cachedLocal = null;
  let failedAt = 0;

  // Der lokale Stand aendert sich zur Laufzeit nie - die Datei liegt im Image.
  // Er wird deshalb einmal geparst und danach behalten, statt bei jedem
  // fehlgeschlagenen GitHub-Abruf erneut ueber siebentausend Zeilen zu laufen.
  function localPayload() {
    if (cachedLocal === null) {
      try {
        cachedLocal = buildLocalPayload(readChangelogFile, appVersion);
      } catch (err) {
        log.warn('Bundled CHANGELOG.md unavailable:', err.message);
        cachedLocal = false;
      }
    }
    return cachedLocal || null;
  }

  router.get('/', async (_req, res) => {
    const age = now() - cachedAt;
    if (cachedPayload && age >= 0 && age < CACHE_TTL_MS) {
      return res.json({ data: cachedPayload });
    }

    const sinceFailure = now() - failedAt;
    if (failedAt && sinceFailure >= 0 && sinceFailure < FAILURE_BACKOFF_MS) {
      const recent = cachedPayload ? { data: cachedPayload, stale: true } : { data: localPayload() };
      if (recent.data) return res.json(recent);
    }

    try {
      const response = await fetchFn(RELEASES_URL, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new Error(`GitHub releases returned ${response.status}`);
      }

      const releases = await response.json();
      cachedPayload = buildChangelogPayload(releases, appVersion);
      cachedAt = now();
      failedAt = 0;
      return res.json({ data: cachedPayload });
    } catch (err) {
      log.warn('Unable to load GitHub releases:', err.message);
      failedAt = now();
      if (cachedPayload) return res.json({ data: cachedPayload, stale: true });

      // Kein 502 mehr, solange die mitgelieferte Datei da ist: der Verlauf bis
      // zur laufenden Version ist im Image und braucht GitHub nicht (#838).
      const local = localPayload();
      if (local) return res.json({ data: local });

      return res.status(502).json({ error: 'Release notes could not be loaded.', code: 502 });
    }
  });

  return router;
}

const router = buildRouter();

export default router;
export const __test = {
  normalizeVersion,
  cleanMarkdownText,
  parseReleaseBody,
  buildChangelogPayload,
  parseChangelogFile,
  buildLocalPayload,
  CHANGELOG_PATH,
};
