import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 500 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']);

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized);
}

async function assertPublicHttps(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Logo search only supports HTTPS websites.');
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error('Logo search cannot access private or local network addresses.');
  }
  return parsed;
}

async function readLimited(response, limit) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > limit) throw new Error('Remote response is too large.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) throw new Error('Remote response is too large.');
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function iconUrl(html, pageUrl) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  for (const link of links) {
    const rel = link.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!/\b(icon|apple-touch-icon)\b/i.test(rel)) continue;
    const href = link.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) return new URL(href, pageUrl).href;
  }
  return new URL('/favicon.ico', pageUrl).href;
}

async function findLogo(websiteUrl) {
  const page = await assertPublicHttps(websiteUrl);
  const pageResponse = await fetch(page, {
    headers: { 'User-Agent': 'Yuvomi subscription logo finder' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!pageResponse.ok) throw new Error(`Website returned HTTP ${pageResponse.status}.`);
  const html = (await readLimited(pageResponse, MAX_HTML_BYTES)).toString('utf8');
  const candidate = iconUrl(html, page);
  await assertPublicHttps(candidate);
  const imageResponse = await fetch(candidate, {
    headers: { 'User-Agent': 'Yuvomi subscription logo finder' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!imageResponse.ok) throw new Error(`Logo returned HTTP ${imageResponse.status}.`);
  const contentType = (imageResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error('Website icon is not a supported image type.');
  const image = await readLimited(imageResponse, MAX_IMAGE_BYTES);
  return `data:${contentType};base64,${image.toString('base64')}`;
}

export { findLogo, privateAddress };
