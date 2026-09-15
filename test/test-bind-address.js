/**
 * Test: BIND_ADDRESS - worauf der Server lauscht
 * Zweck: Die Auslegung (leer = alle Interfaces, Wildcards -> passender Loopback
 *        fuer den Selbstaufruf, IPv6 in Klammern, Zonen-ID abgelehnt) UND der
 *        echte Aufruf: server/index.js bindet ueber test/server-ready.js an
 *        127.0.0.1. Ein Unit-Test allein saehe nicht, ob index.js die Funktion
 *        ueberhaupt fragt.
 * Ausfuehren: node --experimental-sqlite --test test/test-bind-address.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readBindAddress, selfCallHost } from '../server/utils/bind-address.js';
import { startTestServer } from './server-ready.js';

test('leer, Leerraum oder nicht gesetzt heisst: alle Interfaces', () => {
  assert.equal(readBindAddress(undefined), undefined);
  assert.equal(readBindAddress(''), undefined);
  assert.equal(readBindAddress('   '), undefined);
  assert.equal(readBindAddress(' 127.0.0.1 '), '127.0.0.1');
});

test('eine IPv6-Adresse mit Zonen-ID wird beim Start abgelehnt, nicht erst beim MCP-Aufruf', () => {
  // Nodes URL-Parser verwirft beide Schreibweisen - das ist der Grund der Ablehnung.
  assert.throws(() => new URL('http://[fe80::1%eth0]:3000/'), { code: 'ERR_INVALID_URL' });
  assert.throws(() => new URL('http://[fe80::1%25eth0]:3000/'), { code: 'ERR_INVALID_URL' });
  assert.throws(() => readBindAddress('fe80::1%eth0'), /zone ID/);
});

test('der Selbstaufruf trifft die Adresse, auf der der Server wirklich lauscht', () => {
  assert.equal(selfCallHost(undefined), '127.0.0.1');
  assert.equal(selfCallHost('0.0.0.0'), '127.0.0.1');
  // `::` muss IPv4 nicht annehmen, ueber IPv6-Loopback ist er immer erreichbar.
  assert.equal(selfCallHost('::'), '[::1]');
  assert.equal(selfCallHost('127.0.0.1'), '127.0.0.1');
  assert.equal(selfCallHost('192.168.1.5'), '192.168.1.5');
  assert.equal(selfCallHost('fd00::5'), '[fd00::5]');
  for (const host of ['127.0.0.1', '[::1]', '192.168.1.5', '[fd00::5]']) {
    assert.doesNotThrow(() => new URL(`http://${host}:3000/`), host);
  }
});

test('server/index.js lauscht auf BIND_ADDRESS und nicht auf allen Interfaces', async () => {
  const { server } = await startTestServer({
    name: 'bind-address',
    env: { SESSION_SECRET: 'test-bind-address-secret-min-32-chars' },
  });
  assert.equal(server.address().address, '127.0.0.1');
});
