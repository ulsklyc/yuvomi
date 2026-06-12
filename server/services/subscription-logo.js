import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 500 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Yuvomi/1.0; +https://github.com/ulsklyc/yuvomi)',
  Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
};

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

async function fetchPublic(url, options = {}, redirectCount = 0) {
  const parsed = await assertPublicHttps(url);
  const response = await fetch(parsed, {
    ...options,
    headers: { ...REQUEST_HEADERS, ...options.headers },
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_REDIRECTS) throw new Error('Logo search followed too many redirects.');
    const location = response.headers.get('location');
    if (!location) throw new Error('Website returned a redirect without a location.');
    return fetchPublic(new URL(location, parsed).href, options, redirectCount + 1);
  }
  return { response, finalUrl: parsed };
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
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(rel)) continue;
    const href = link.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) return new URL(href, pageUrl).href;
  }
  return new URL('/favicon.ico', pageUrl).href;
}

async function findLogo(websiteUrl) {
  const normalized = /^https:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;
  const pageResult = await fetchPublic(normalized, {
    signal: AbortSignal.timeout(8000),
  });
  const pageResponse = pageResult.response;
  if (!pageResponse.ok) throw new Error(`Website returned HTTP ${pageResponse.status}.`);
  const html = (await readLimited(pageResponse, MAX_HTML_BYTES)).toString('utf8');
  const candidate = iconUrl(html, pageResult.finalUrl);
  const imageResult = await fetchPublic(candidate, {
    signal: AbortSignal.timeout(8000),
  });
  const imageResponse = imageResult.response;
  if (!imageResponse.ok) throw new Error(`Logo returned HTTP ${imageResponse.status}.`);
  let contentType = (imageResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/octet-stream' && /\.ico(?:$|\?)/i.test(imageResult.finalUrl.pathname)) {
    contentType = 'image/x-icon';
  }
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error('Website icon is not a supported image type.');
  const image = await readLimited(imageResponse, MAX_IMAGE_BYTES);
  return `data:${contentType};base64,${image.toString('base64')}`;
}

export { findLogo, privateAddress };
