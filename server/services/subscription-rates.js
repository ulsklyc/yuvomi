import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('SubscriptionRates');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FIXER_ENDPOINT = 'https://data.fixer.io/api/latest';

function cachedRates(baseCurrency, currencies) {
  const rows = db.get().prepare(`
    SELECT quote_currency, rate, fetched_at
    FROM subscription_exchange_rates
    WHERE base_currency = ?
  `).all(baseCurrency);
  const rates = Object.fromEntries(rows.map((row) => [row.quote_currency, row.rate]));
  rates[baseCurrency] = 1;
  const oldest = rows.reduce((value, row) => Math.min(value, Date.parse(row.fetched_at)), Infinity);
  const complete = currencies.every((currency) => rates[currency]);
  return {
    rates,
    fresh: complete && Number.isFinite(oldest) && Date.now() - oldest < CACHE_TTL_MS,
    fetchedAt: rows[0]?.fetched_at || null,
  };
}

async function fetchFixerRates(baseCurrency, currencies) {
  const accessKey = process.env.FIXER_API_KEY?.trim();
  if (!accessKey) return null;
  const symbols = [...new Set([baseCurrency, ...currencies])].join(',');
  const url = new URL(FIXER_ENDPOINT);
  url.searchParams.set('access_key', accessKey);
  url.searchParams.set('symbols', symbols);

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Fixer returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload?.success || !payload?.rates || !payload?.base) {
    throw new Error(payload?.error?.info || 'Fixer returned an invalid response.');
  }

  const sourceBase = payload.base;
  const sourceToTarget = Number(payload.rates[baseCurrency] ?? (sourceBase === baseCurrency ? 1 : 0));
  if (!sourceToTarget) throw new Error(`Fixer did not return the ${baseCurrency} rate.`);

  const converted = { [baseCurrency]: 1 };
  for (const currency of currencies) {
    const sourceToCurrency = Number(payload.rates[currency] ?? (sourceBase === currency ? 1 : 0));
    if (sourceToCurrency > 0) converted[currency] = sourceToTarget / sourceToCurrency;
  }

  const fetchedAt = new Date().toISOString();
  const write = db.get().prepare(`
    INSERT INTO subscription_exchange_rates (base_currency, quote_currency, rate, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(base_currency, quote_currency)
    DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at
  `);
  const save = db.get().transaction(() => {
    for (const [currency, rate] of Object.entries(converted)) {
      write.run(baseCurrency, currency, rate, fetchedAt);
    }
  });
  save();
  return { rates: converted, fetchedAt, source: 'fixer' };
}

async function getRates(baseCurrency, currencies, { refresh = false } = {}) {
  const unique = [...new Set(currencies.filter((currency) => currency !== baseCurrency))];
  const cached = cachedRates(baseCurrency, unique);
  if (!refresh && cached.fresh) return { ...cached, source: 'cache' };

  try {
    const fetched = await fetchFixerRates(baseCurrency, unique);
    if (fetched) return fetched;
  } catch (err) {
    log.warn(`Fixer refresh failed: ${err.message}`);
  }
  return { ...cached, source: cached.fetchedAt ? 'stale-cache' : 'unavailable' };
}

export { getRates };
