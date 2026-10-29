/**
 * Modul: Web-Installer - Heimnetz-Adresse im Einfach-Pfad
 * Zweck: Der Einfach-Pfad schrieb BASE_URL=http://localhost:3000. Einladungs-
 *        und Reset-Links zeigten damit auf das Gerät, auf dem man sie öffnet,
 *        und die Handys, auf denen die Fertig-Seite die App installieren lässt,
 *        erreichten nichts. pickLanAddress() wählt die private IPv4 des Hosts
 *        und meidet Container-Bridges und VPN-Tunnel, deren Adressen ebenfalls
 *        privat sind und sonst genauso gut aussähen.
 * Ausführen: node --test test/test-installer-lan.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { pickLanAddress, createInstallerServer } from '../tools/installer/install-server.js';

const html = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0' });
const v6 = address => ({ address, family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::' });
const LO = { lo: [v4('127.0.0.1', true), { ...v6('::1'), internal: true }] };

test('das WLAN gewinnt gegen Docker-Bridge, VPN-Tunnel und Loopback', () => {
  assert.equal(pickLanAddress({
    ...LO,
    docker0: [v4('172.17.0.1')],
    'br-3f2a1c': [v4('172.18.0.1')],
    veth12ab: [v4('169.254.10.2')],
    utun3: [v4('10.8.0.2')],
    wg0: [v4('10.66.0.1')],
    tailscale0: [v4('100.101.102.103')],
    en0: [v6('fe80::1'), v4('192.168.1.20')],
  }), '192.168.1.20');
});

test('ein 10er-Heimnetz ohne 192.168 wird gefunden', () => {
  assert.equal(pickLanAddress({ ...LO, docker0: [v4('172.17.0.1')], eth0: [v4('10.0.0.5')] }), '10.0.0.5');
});

test('192.168 hat Vorrang vor 10.x auf einer zweiten echten Schnittstelle', () => {
  assert.equal(pickLanAddress({ eth1: [v4('10.0.0.5')], eth0: [v4('192.168.178.30')] }), '192.168.178.30');
});

test('172.17 (Dockers Standard-Bridge) steht hinter jedem anderen privaten Netz', () => {
  assert.equal(pickLanAddress({ eth9: [v4('172.17.0.4')], eth0: [v4('172.20.1.7')] }), '172.20.1.7');
});

test('nur Loopback, Bridges und öffentliche Adressen: keine Heimnetz-Adresse', () => {
  assert.equal(pickLanAddress(LO), null);
  assert.equal(pickLanAddress({ ...LO, docker0: [v4('172.17.0.1')], utun0: [v4('10.8.0.2')] }), null);
  assert.equal(pickLanAddress({ eth0: [v4('203.0.113.9')], tailscale0: [v4('100.64.0.1')] }), null);
  assert.equal(pickLanAddress({}), null);
});

test('Node 18 meldet die Familie als Zahl', () => {
  assert.equal(pickLanAddress({ eth0: [{ address: '192.168.0.9', family: 4, internal: false }] }), '192.168.0.9');
});

test('GET /api/lan-address antwortet mit einer privaten Adresse oder null', async () => {
  const server = createInstallerServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}/api/lan-address`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok('address' in d);
    if (d.address !== null) assert.match(d.address, /^(10|172|192\.168)\./);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('der Einfach-Pfad nimmt die Heimnetz-Adresse statt localhost', () => {
  const at = html.indexOf('function applySimpleDefaults()');
  const body = html.slice(at, html.indexOf('\n}\n', at));
  assert.doesNotMatch(body, /S\.host = 'localhost';/, 'applySimpleDefaults setzt weiter fest localhost');
  assert.match(body, /lanAddress/, 'applySimpleDefaults kennt die Heimnetz-Adresse nicht');
  assert.match(html, /fetch\('\/api\/lan-address'\)/, 'install.html fragt die Heimnetz-Adresse nicht ab');
  // Die Adresse ist änderbar, und die Prüfung beim Start nimmt sie ernst.
  assert.match(html, /id="simple-host"/, 'es fehlt das Feld zum Ändern der Adresse');
  const start = html.slice(html.indexOf("$('simple-next').addEventListener"));
  assert.match(start.slice(0, 3000), /simple-host/, 'simple-next prüft die geänderte Adresse nicht');
});

test('Compose lauscht auf allen Schnittstellen, der Installer nur auf Loopback', () => {
  for (const f of ['docker-compose.yml', 'podman-compose.yml']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /"(0\.0\.0\.0|\$\{OIKOS_HTTP_BIND:-0\.0\.0\.0\}):\$\{OIKOS_HTTP_PORT:-3000\}:3000"/,
      `${f} bindet nicht standardmäßig auf 0.0.0.0 - die Heimnetz-Adresse wäre tot`);
  }
  const server = readFileSync(new URL('../tools/installer/install-server.js', import.meta.url), 'utf8');
  assert.match(server, /server\.listen\(PORT, '127\.0\.0\.1'/);
});

test('Enter im Adress-Editor schliesst nur den Editor und startet nicht das Setup', () => {
  // Review #2382: der Editor-Handler klickte "Fertig", das Ereignis lief weiter
  // zum dokumentweiten Enter-Handler, und der klickte simple-next - bei schon
  // bestätigtem Start speicherte das die .env und startete Yuvomi.
  const arrow = marker => {
    const at = html.indexOf(marker);
    assert.ok(at !== -1, `${marker} nicht gefunden`);
    const end = html.indexOf('\n});', at);
    return `${html.slice(html.indexOf('e => {', at), end)}\n}`;
  };
  const clicks = { done: 0, primary: 0 };
  const primary = { disabled: false, click: () => { clicks.primary++; } };
  const $ = id => (id === 'simple-access-edit' ? { click: () => { clicks.done++; } }
    : { querySelector: () => primary });
  const editor = new Function('$', `return (${arrow("$('simple-host').addEventListener('keydown'")});`)($);
  const onDocument = new Function('$', 'flow', 'currentStep',
    `return (${arrow("document.addEventListener('keydown'")});`)($, ['simple'], 0);

  // Ein Ereignis, das vom Feld zum Dokument aufsteigt wie im Browser.
  const input = { tagName: 'INPUT', type: 'text' };
  const enter = () => ({
    key: 'Enter', target: input, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
  });
  const e = enter();
  editor(e);
  if (!e.stopped) onDocument(e);
  assert.equal(clicks.done, 1, 'Enter schliesst den Editor nicht');
  assert.equal(clicks.primary, 0, 'Enter im Adress-Editor löst den Start aus');

  // Der dokumentweite Handler selbst respektiert ein schon behandeltes Enter ...
  const handled = enter();
  handled.preventDefault();
  onDocument(handled);
  assert.equal(clicks.primary, 0, 'der Dokument-Handler übergeht defaultPrevented');
  // ... und löst in einem gewöhnlichen Feld weiter die primäre Aktion aus.
  onDocument(enter());
  assert.equal(clicks.primary, 1, 'Enter in einem Feld löst die primäre Aktion nicht mehr aus');
});
