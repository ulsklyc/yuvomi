/**
 * Modul: SSRF-Schutz (Server-Side Request Forgery)
 * Zweck: Ein einziger, gehärteter Ort für die Klassifikation von Netzwerkzielen,
 *        die aus Nutzereingaben stammen (ICS-Abos, Abo-Logo-Suche, WebDAV-Dokument-
 *        speicher). Alle drei Subsysteme holen Daten von URLs, die ein Nutzer angibt,
 *        und müssen verhindern, dass diese auf interne/private Adressen zeigen
 *        (Cloud-Metadaten 169.254.169.254, RFC1918-LAN, Loopback, …).
 *
 *        Vor der Zentralisierung existierten drei unabhängige Klassifizierer mit
 *        unterschiedlicher Stärke — der schwächste erkannte IPv4-mapped-IPv6
 *        (`::ffff:192.168.0.1`) nicht. Genau diese Drift ist der Grund für dieses
 *        Modul: EINE Klassifikationslogik, EINE Testsuite (test/test-ssrf.js).
 *
 * Kanonischer Klassifizierer: node:net BlockList. Nativ, deckt zusätzlich zu
 * RFC1918 auch Carrier-Grade-NAT (100.64/10), TEST-NET, Benchmarking (198.18/15),
 * Multicast, reservierte Bereiche sowie IPv6-Sonderpräfixe (NAT64, Teredo, 6to4,
 * ULA, Link-Local) ab und behandelt IPv4-mapped-IPv6 in beiden Schreibweisen
 * (dotted und hex) automatisch als die eingebettete IPv4.
 *
 * Abhängigkeiten: node:net, node:dns (keine externen).
 */

import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';

/**
 * Nicht öffentlich routbare Netze. Ein Ziel, dessen IP hier hineinfällt, gilt als
 * blockiert (potenzielles SSRF). Die Liste umfasst bewusst mehr als die klassischen
 * privaten Bereiche, weil auch Loopback, Link-Local (Cloud-Metadaten!), CGN und
 * reservierte/Test-Netze keine legitimen Fetch-Ziele für Nutzer-URLs sind.
 */
const BLOCKED_SUBNETS = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['2001:2::', 48, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

const BLOCKED_NETWORKS = new BlockList();
for (const [address, prefix, type] of BLOCKED_SUBNETS) {
  BLOCKED_NETWORKS.addSubnet(address, prefix, type);
}

/**
 * Hostnamen, die niemals aufgelöst werden dürfen — unabhängig davon, worauf ein
 * bösartiger/kompromittierter DNS sie zeigen ließe. `.local`/`.internal`/`.home.arpa`
 * sind reservierte interne Suffixe; `localhost` ist der offensichtliche Loopback-Name.
 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * Normalisiert einen Hostnamen: kleinschreiben und die eckigen Klammern einer
 * IPv6-URL-Notation (`[::1]`) entfernen, damit isIP/BlockList die rohe Adresse sehen.
 */
export function normalizeHostname(hostname) {
  const value = String(hostname).toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/**
 * Ist die gegebene Adresse nicht-öffentlich (privat/reserviert/Loopback/…)?
 *
 * Fail-closed: Was keine gültige IP ist (isIP === 0), gilt als blockiert. Aufrufer
 * übergeben hier bereits DNS-aufgelöste Adressen; ein Nicht-IP-Wert deutet auf einen
 * Fehler hin und darf nicht versehentlich als „öffentlich" durchrutschen.
 *
 * IPv4-mapped-IPv6 (`::ffff:192.168.0.1` und die Hex-Form `::ffff:c0a8:0001`) wird
 * von BlockList automatisch gegen die IPv4-Regeln geprüft.
 */
export function isBlockedAddress(address) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (!family) return true;
  return BLOCKED_NETWORKS.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Ist der Hostname per se blockiert (localhost / reserviertes internes Suffix)?
 * Reine Namensprüfung vor der DNS-Auflösung; die IP-Prüfung erfolgt separat über
 * isBlockedAddress auf den aufgelösten Adressen.
 */
export function isBlockedHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === 'localhost'
    || BLOCKED_HOST_SUFFIXES.some(
      (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
    )
  );
}

/**
 * Liest ein Opt-in-Env-Flag, das den SSRF-Schutz eines Subsystems bewusst aufhebt
 * (z. B. ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK für einen Feed im selben LAN). Nur
 * exakt `true` oder `1` (nach trim) aktivieren; alles andere lässt den Schutz aktiv.
 * Wird zur Laufzeit gelesen, damit Tests process.env vor dem Aufruf setzen können.
 */
export function readPrivateNetworkOptIn(envName) {
  const raw = process.env[envName];
  return raw !== undefined && (raw.trim() === 'true' || raw.trim() === '1');
}

/**
 * Baut eine Node-style `lookup(hostname, options, callback)`-Funktion, die JEDE vom
 * DNS zurückgegebene Adresse zum Zeitpunkt des Verbindungsaufbaus gegen isBlockedAddress
 * prüft. Das schließt DNS-Rebinding aus: Ein Angreifer-DNS kann eine Vorab-Prüfung nicht
 * mit einer öffentlichen IP täuschen und beim eigentlichen Connect auf eine private IP
 * umschwenken, weil hier die Adresse validiert wird, mit der die Socket-Verbindung
 * tatsächlich aufgebaut wird.
 *
 * Übergib das Resultat an http(s).Agent({ lookup }) oder http(s).request({ lookup }).
 * Unterstützt beide Aufrufformen (`{ all: true }` → Adress-Array, sonst
 * Einzeladresse + Family) sowie die numerische Family-Kurzform von Node.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.allowPrivate=false] Opt-in: Validierung überspringen.
 * @param {Function} [opts.lookup=dnsLookup]   Für Tests injizierbarer DNS-Lookup.
 */
export function createGuardedLookup({ allowPrivate = false, lookup = dnsLookup } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate) {
        for (const entry of addresses) {
          if (isBlockedAddress(entry.address)) {
            return callback(new Error(`URL resolves to a private IP address: ${entry.address}`));
          }
        }
      }
      if (opts.all) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first.address, first.family);
    });
  };
}

export { BLOCKED_SUBNETS, BLOCKED_HOST_SUFFIXES };
