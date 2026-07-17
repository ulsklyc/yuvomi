/**
 * Testsuite: zentraler SSRF-Schutz (server/utils/ssrf.js)
 *
 * Nagelt die kanonische Klassifikationslogik fest, auf die sich ICS-Abos,
 * Abo-Logo-Suche und WebDAV-Dokumentspeicher stützen. Insbesondere die Fälle,
 * in denen die früheren drei Einzelimplementierungen auseinanderliefen
 * (IPv4-mapped-IPv6, CGN, Link-Local/Cloud-Metadaten), sind hier hart gepinnt —
 * dieser Test ist das Netz gegen erneute Drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBlockedAddress,
  isBlockedHostname,
  normalizeHostname,
  readPrivateNetworkOptIn,
  createGuardedLookup,
} from '../server/utils/ssrf.js';

test('isBlockedAddress: öffentliche IPs sind erlaubt', () => {
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('1.1.1.1'), false);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
});

test('isBlockedAddress: private/Loopback/Link-Local IPv4 sind blockiert', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.4', '169.254.169.254', '0.0.0.0',
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} muss blockiert sein`);
  }
});

test('isBlockedAddress: CGN/TEST-NET/Multicast/reserviert sind blockiert', () => {
  for (const ip of [
    '100.64.0.1',       // Carrier-Grade NAT
    '198.18.0.1',       // Benchmarking
    '192.0.2.5',        // TEST-NET-1
    '198.51.100.5',     // TEST-NET-2
    '203.0.113.5',      // TEST-NET-3
    '224.0.0.1',        // Multicast
    '240.0.0.1',        // reserviert
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} muss blockiert sein`);
  }
});

test('isBlockedAddress: private/Sonder-IPv6 sind blockiert', () => {
  for (const ip of ['::1', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} muss blockiert sein`);
  }
});

test('isBlockedAddress: IPv4-mapped-IPv6 wird gegen IPv4-Regeln geprüft (die alte Drift-Lücke)', () => {
  // dotted-Form
  assert.equal(isBlockedAddress('::ffff:192.168.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
  // hex-Form (so normalisieren URL/DNS gelegentlich)
  assert.equal(isBlockedAddress('::ffff:c0a8:0001'), true); // 192.168.0.1
  assert.equal(isBlockedAddress('::ffff:a9fe:a9fe'), true);  // 169.254.169.254
  // öffentliche mapped-Adresse bleibt erlaubt
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('isBlockedAddress: fail-closed bei Nicht-IP-Eingaben', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress(''), true);
  assert.equal(isBlockedAddress('example.com'), true);
});

test('isBlockedAddress: IPv6 in eckigen Klammern wird normalisiert', () => {
  assert.equal(isBlockedAddress('[::1]'), true);
  assert.equal(isBlockedAddress('[2606:4700:4700::1111]'), false);
});

test('isBlockedHostname: interne Namen sind blockiert', () => {
  for (const h of [
    'localhost', 'foo.localhost', 'nas.local', 'service.internal',
    'router.home.arpa', 'LOCALHOST',
  ]) {
    assert.equal(isBlockedHostname(h), true, `${h} muss blockiert sein`);
  }
});

test('isBlockedHostname: normale Hosts sind erlaubt', () => {
  for (const h of ['example.com', 'calendar.google.com', 'localhosting.example.com']) {
    assert.equal(isBlockedHostname(h), false, `${h} darf nicht blockiert sein`);
  }
});

test('normalizeHostname: lowercase + Klammer-Strip', () => {
  assert.equal(normalizeHostname('EXAMPLE.COM'), 'example.com');
  assert.equal(normalizeHostname('[::1]'), '::1');
  assert.equal(normalizeHostname('[2001:DB8::1]'), '2001:db8::1');
});

test('readPrivateNetworkOptIn: nur exakt true/1 aktiviert', () => {
  const KEY = 'TEST_SSRF_OPT_IN_FLAG';
  const prev = process.env[KEY];
  try {
    delete process.env[KEY];
    assert.equal(readPrivateNetworkOptIn(KEY), false);
    for (const v of ['true', ' true ', '1', ' 1 ']) {
      process.env[KEY] = v;
      assert.equal(readPrivateNetworkOptIn(KEY), true, `"${v}" muss aktivieren`);
    }
    for (const v of ['false', '0', 'yes', 'TRUE', '', 'on']) {
      process.env[KEY] = v;
      assert.equal(readPrivateNetworkOptIn(KEY), false, `"${v}" darf nicht aktivieren`);
    }
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});

// --- createGuardedLookup: Anti-Rebinding auf Verbindungsebene ---

function fakeLookup(map) {
  // map: hostname -> [{ address, family }]
  return (hostname, options, callback) => {
    const entries = map[hostname];
    if (!entries) return callback(new Error(`no fake DNS for ${hostname}`));
    if (options?.all) return callback(null, entries);
    const [first] = entries;
    return callback(null, first.address, first.family);
  };
}

test('createGuardedLookup: öffentliche Auflösung wird durchgereicht (all-Form)', (t, done) => {
  const lookup = createGuardedLookup({
    lookup: fakeLookup({ 'good.example': [{ address: '93.184.216.34', family: 4 }] }),
  });
  lookup('good.example', { all: true }, (err, addresses) => {
    assert.equal(err, null);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
    done();
  });
});

test('createGuardedLookup: private Auflösung wird geblockt', (t, done) => {
  const lookup = createGuardedLookup({
    lookup: fakeLookup({ 'evil.example': [{ address: '169.254.169.254', family: 4 }] }),
  });
  lookup('evil.example', { all: true }, (err) => {
    assert.ok(err, 'muss einen Fehler liefern');
    assert.match(err.message, /private IP/i);
    done();
  });
});

test('createGuardedLookup: Rebinding — eine private unter mehreren Adressen genügt zum Block', (t, done) => {
  const lookup = createGuardedLookup({
    lookup: fakeLookup({
      'rebind.example': [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
  });
  lookup('rebind.example', { all: true }, (err) => {
    assert.ok(err);
    assert.match(err.message, /127\.0\.0\.1/);
    done();
  });
});

test('createGuardedLookup: Einzeladress-Form (kein all) liefert address + family', (t, done) => {
  const lookup = createGuardedLookup({
    lookup: fakeLookup({ 'good.example': [{ address: '93.184.216.34', family: 4 }] }),
  });
  lookup('good.example', {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
    done();
  });
});

test('createGuardedLookup: numerische Family-Kurzform wird akzeptiert', (t, done) => {
  const lookup = createGuardedLookup({
    lookup: fakeLookup({ 'good.example': [{ address: '93.184.216.34', family: 4 }] }),
  });
  lookup('good.example', 4, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
    done();
  });
});

test('createGuardedLookup: allowPrivate überspringt die Validierung', (t, done) => {
  const lookup = createGuardedLookup({
    allowPrivate: true,
    lookup: fakeLookup({ 'lan.example': [{ address: '192.168.1.50', family: 4 }] }),
  });
  lookup('lan.example', { all: true }, (err, addresses) => {
    assert.equal(err, null);
    assert.deepEqual(addresses, [{ address: '192.168.1.50', family: 4 }]);
    done();
  });
});
