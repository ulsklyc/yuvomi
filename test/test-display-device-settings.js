import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_DEVICE_DEFAULTS, DISPLAY_IDLE_STEPS, normalizeDisplayDeviceSettings, applyDisplayDeviceSettings, getDisplayDeviceSettings } from '../public/utils/display-device-settings.js';
import { getNightHours } from '../public/utils/night-hours.js';
import { getScreensaverIdleSeconds, isScreensaverClockOn, isScreensaverCoverOn, SCREENSAVER_IDLE_STEPS } from '../public/utils/screensaver-idle.js';
import { createDisplaySettingsSync } from '../public/utils/display-settings-sync.js';

const chosen = {night_from:21, night_until:7, idle_seconds:60, show_clock:false, cover_photo:true};

test('display values use the existing idle steps and reject malformed or partial configurations', () => {
  assert.deepEqual(SCREENSAVER_IDLE_STEPS, DISPLAY_IDLE_STEPS);
  assert.deepEqual(normalizeDisplayDeviceSettings(DISPLAY_DEVICE_DEFAULTS), DISPLAY_DEVICE_DEFAULTS);
  for (const value of [null, [], {}, {...chosen, night_from:7}, {...chosen, night_from:-1}, {...chosen, night_until:1.5}, {...chosen, idle_seconds:'60'}, {...chosen, show_clock:'false'}, {...chosen, cover_photo:1}, {...chosen, extra:true}]) {
    assert.equal(normalizeDisplayDeviceSettings(value), null, JSON.stringify(value));
  }
});

test('a display override drives both night and screensaver readers without overwriting personal storage', () => {
  const values = new Map([['yuvomi-night-hours','1-5'], ['yuvomi-screensaver-idle','600'], ['yuvomi-screensaver-clock','1']]);
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem:key => values.get(key) ?? null, setItem() { throw new Error('must not write'); } };
  try {
    assert.deepEqual(getNightHours(), {from:1,to:5}); assert.equal(getScreensaverIdleSeconds(), 600);
    assert.equal(applyDisplayDeviceSettings(chosen), true);
    assert.deepEqual(getNightHours(), {from:21,to:7}); assert.equal(getScreensaverIdleSeconds(), 60);
    assert.equal(isScreensaverClockOn(), false); assert.equal(isScreensaverCoverOn(), true);
    assert.equal(applyDisplayDeviceSettings({...chosen}), false, 'identical polling data is a no-op');
    applyDisplayDeviceSettings(null);
    assert.deepEqual(getNightHours(), {from:1,to:5}); assert.equal(getScreensaverIdleSeconds(), 600);
    assert.equal(isScreensaverClockOn(), true); assert.equal(isScreensaverCoverOn(), false);
    assert.equal(values.get('yuvomi-night-hours'), '1-5');
  } finally { applyDisplayDeviceSettings(null); globalThis.localStorage = original; }
});

function harness(fetchPreferences) {
  const applied = []; const listeners = new Map(); const intervals = new Map();
  const doc = { hidden:false, addEventListener:(name, fn)=>listeners.set(name,fn), removeEventListener:name=>listeners.delete(name) };
  const win = { setInterval:(fn,ms)=>{assert.equal(ms,30_000); intervals.set(1,fn); return 1;}, clearInterval:id=>intervals.delete(id),
    addEventListener:(name,fn)=>listeners.set(name,fn), removeEventListener:name=>listeners.delete(name) };
  const sync = createDisplaySettingsSync({fetchPreferences, apply:value=>applied.push(value), document:doc, window:win});
  return {sync, applied, listeners, intervals, doc};
}

test('a paired display refreshes every 30 seconds and on resume, with no duplicate or hidden requests', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return {data:{display_device_settings:chosen}}; });
  h.sync.start(); h.sync.start(); assert.equal(h.intervals.size, 1);
  await h.intervals.get(1)(); assert.deepEqual(h.applied, [chosen]);
  h.doc.hidden = true; await h.intervals.get(1)(); assert.equal(calls, 1);
  h.doc.hidden = false; await h.listeners.get('visibilitychange')(); await h.listeners.get('online')(); assert.equal(calls, 3);
  h.sync.stop(); assert.equal(h.intervals.size, 0); assert.equal(h.listeners.size, 0); assert.equal(h.applied.at(-1), null);
});

test('late answers cannot restore a departed display session and concurrent refreshes stay single-flight', async () => {
  let finish; let calls = 0;
  const h = harness(() => {calls++; return new Promise(resolve=>{finish=resolve;});});
  h.sync.start(); const pending = h.sync.refresh(); await h.sync.refresh(); assert.equal(calls, 1);
  h.sync.stop(); finish({data:{display_device_settings:chosen}}); await pending;
  assert.deepEqual(h.applied, [null]);
  h.sync.start(); const fresh = h.sync.refresh(); finish({data:{display_device_settings:chosen}}); await fresh;
  assert.deepEqual(h.applied, [null,chosen]); h.sync.stop();
});

test('offline refresh keeps the last configuration and retries on the next tick', async () => {
  let offline = true;
  const h = harness(async () => {if (offline) throw new Error('offline'); return {data:{display_device_settings:chosen}};});
  h.sync.start(); await h.sync.refresh(); assert.deepEqual(h.applied, []);
  offline = false; await h.sync.refresh(); assert.deepEqual(h.applied, [chosen]); h.sync.stop();
});

test('an unchanged display poll does not postpone the screensaver idle timer', () => {
  const original = {document:globalThis.document, window:globalThis.window, location:globalThis.location, localStorage:globalThis.localStorage};
  const attrs = new Map([['data-screensaver-idle','300']]); let writes = 0;
  const root = { getAttribute:name=>attrs.get(name), hasAttribute:name=>attrs.has(name),
    setAttribute(name,value) {attrs.set(name,value); if (name === 'data-screensaver-idle') writes++;},
    toggleAttribute(name,on) {if(on) attrs.set(name,''); else attrs.delete(name);} };
  globalThis.document = {documentElement:root}; globalThis.window = {}; globalThis.location = {pathname:'/'};
  globalThis.localStorage = {getItem:()=>null};
  try {
    const sync = createDisplaySettingsSync(); sync.apply(chosen); sync.apply({...chosen});
    assert.equal(writes, 1); assert.equal(attrs.get('data-screensaver-idle'), '60');
    sync.apply(null); assert.equal(attrs.get('data-screensaver-idle'), '300'); assert.equal(getDisplayDeviceSettings(), null);
  } finally {Object.assign(globalThis, original); applyDisplayDeviceSettings(null);}
});
