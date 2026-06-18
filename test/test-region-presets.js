import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CUSTOM_REGION,
  REGION_CODES,
  REGION_PRESETS,
  detectRegion,
} from '../public/settings/region-presets.js';

async function backendList(name) {
  const src = await readFile(
    new URL('../server/routes/preferences.js', import.meta.url),
    'utf8',
  );
  const match = src.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  assert.ok(match, `${name} must be declared in preferences route`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every region preset maps to backend-valid currency, date and time values', async () => {
  const currencies = await backendList('VALID_CURRENCIES');
  const dateFormats = await backendList('VALID_DATE_FORMATS');
  const timeFormats = await backendList('VALID_TIME_FORMATS');

  for (const [code, preset] of Object.entries(REGION_PRESETS)) {
    assert.ok(currencies.includes(preset.currency), `${code}: invalid currency ${preset.currency}`);
    assert.ok(dateFormats.includes(preset.date_format), `${code}: invalid date_format ${preset.date_format}`);
    assert.ok(timeFormats.includes(preset.time_format), `${code}: invalid time_format ${preset.time_format}`);
  }
});

test('every preset date_format is selectable in the appearance UI', async () => {
  const src = await readFile(
    new URL('../public/settings/pages/personal-appearance.js', import.meta.url),
    'utf8',
  );
  const block = src.match(/const DATE_FORMATS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'personal-appearance must declare DATE_FORMATS');
  const uiFormats = [...block[1].matchAll(/\['([^']+)'/g)].map((m) => m[1]);

  for (const [code, preset] of Object.entries(REGION_PRESETS)) {
    assert.ok(uiFormats.includes(preset.date_format), `${code}: ${preset.date_format} missing from UI DATE_FORMATS`);
  }
});

test('detectRegion resolves every preset to a code with identical format values', () => {
  // Several regions intentionally share the same currency/date/time triple
  // (e.g. de-DE and de-AT). Since no `region` is persisted, detectRegion only
  // guarantees a representative code whose preset equals the input values.
  for (const code of REGION_CODES) {
    const resolved = detectRegion(REGION_PRESETS[code]);
    assert.ok(REGION_PRESETS[resolved], `${code}: resolved to unknown code ${resolved}`);
    assert.deepEqual(REGION_PRESETS[resolved], REGION_PRESETS[code], `${code}: resolved preset differs`);
  }
});

test('detectRegion falls back to custom for unknown or partial combinations', () => {
  assert.equal(detectRegion({ currency: 'EUR', date_format: 'mdy', time_format: '12h' }), CUSTOM_REGION);
  assert.equal(detectRegion({ currency: 'EUR', date_format: 'dmy' }), CUSTOM_REGION);
  assert.equal(detectRegion({}), CUSTOM_REGION);
  assert.equal(detectRegion(), CUSTOM_REGION);
});
