import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_HTML_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 500 * 1024;
const MAX_LOGO_OPTIONS = 16;
const MAX_REDIRECTS = 5;
const SERVICE_DOMAIN_FETCH_LIMIT = 8;
const DOMAIN_SUFFIXES = ['.com', '.io', '.app', '.tv', '.net', '.org'];
const TRAILING_SERVICE_WORDS = new Set([
  'app',
  'cloud',
  'drive',
  'go',
  'max',
  'music',
  'one',
  'plus',
  'premium',
  'prime',
  'pro',
  'tv',
  'video',
]);
const ALLOWED_IMAGE_TYPES = new Set([
  'image/avif',
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

async function readHtmlHead(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    const html = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    if (/<\/head\s*>/i.test(html)) {
      await reader.cancel();
      return html;
    }
  }
  await reader.cancel();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function readHtmlPreview(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_HTML_SCAN_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
  }
  await reader.cancel();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function attrValue(markup, name) {
  return decodeHtml(markup.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] || '');
}

function diagnosticError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
  };
}

function addDiagnostic(diagnostics, stage, detail = {}) {
  if (!diagnostics) return;
  diagnostics.push({ stage, ...detail });
}

function safeLogUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
  } catch {
    return String(value || '').slice(0, 300);
  }
}

function domainFromInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function domainLikeInput(value) {
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(String(value || '').trim());
}

function serviceTokens(value) {
  return String(value || '')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function serviceDomainCandidates(value) {
  if (/^https?:\/\//i.test(String(value || '').trim()) || domainLikeInput(value)) {
    const domain = domainFromInput(value);
    return domain ? [domain] : [];
  }

  const tokens = serviceTokens(value);
  if (!tokens.length) return [];

  const bases = [];
  const addBase = (base) => {
    const normalized = String(base || '').replace(/[^a-z0-9-]/g, '');
    if (normalized && !bases.includes(normalized)) bases.push(normalized);
  };

  addBase(tokens.join(''));
  if (tokens.length > 1) {
    addBase(tokens.join('-'));
    addBase(tokens[0]);
    if (TRAILING_SERVICE_WORDS.has(tokens[tokens.length - 1])) {
      addBase(tokens.slice(0, -1).join(''));
      addBase(tokens.slice(0, -1).join('-'));
    }
  }

  return [...new Set(bases.flatMap((base) => DOMAIN_SUFFIXES.map((suffix) => `${base}${suffix}`)))].slice(0, 24);
}

function iconUrls(html, pageUrl) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const candidates = [];
  for (const link of links) {
    const rel = attrValue(link, 'rel');
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(rel)) continue;
    const href = attrValue(link, 'href');
    if (!href || href.startsWith('data:')) continue;
    candidates.push({
      url: new URL(href, pageUrl).href,
      priority: /apple-touch-icon/i.test(rel) ? 1 : 0,
    });
  }
  candidates.push({ url: new URL('/favicon.ico', pageUrl).href, priority: 2 });
  return [...new Map(
    candidates
      .sort((a, b) => a.priority - b.priority)
      .map((candidate) => [candidate.url, candidate.url]),
  ).values()];
}

function normalizedWebsiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Website is required.');
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    parsed.protocol = 'https:';
    return parsed.href;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw)) return `https://${raw}`;
  throw new Error('Website must be a public domain or HTTPS URL.');
}

function websiteImageUrls(html, pageUrl) {
  const urls = iconUrls(html, pageUrl).map((url) => ({ url, priority: 0 }));

  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  for (const meta of metas) {
    const property = `${attrValue(meta, 'property')} ${attrValue(meta, 'name')}`;
    if (!/(^|\s)(og:image|twitter:image|msapplication-tileimage)(\s|$)/i.test(property)) continue;
    const content = attrValue(meta, 'content');
    if (content && !content.startsWith('data:')) urls.push({ url: new URL(content, pageUrl).href, priority: 1 });
  }

  const images = [...html.matchAll(/<(?:img|source)\b[^>]*>/gi)].map((match) => match[0]);
  for (const image of images) {
    const marker = `${attrValue(image, 'alt')} ${attrValue(image, 'class')} ${attrValue(image, 'id')} ${attrValue(image, 'title')}`;
    const src = attrValue(image, 'src') || attrValue(image, 'data-src') || attrValue(image, 'srcset').split(/\s+/)[0];
    if (!src || src.startsWith('data:') || !/(logo|brand|mark|icon)/i.test(`${marker} ${src}`)) continue;
    urls.push({ url: new URL(src, pageUrl).href, priority: 2 });
  }

  return [...new Map(
    urls
      .sort((a, b) => a.priority - b.priority)
      .map((candidate) => [candidate.url, candidate.url]),
  ).values()];
}

function imageType(response, finalUrl) {
  let contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const pathname = finalUrl.pathname.toLowerCase();
  if (contentType === 'application/octet-stream' || !contentType) {
    if (/\.ico(?:$|\?)/i.test(pathname)) contentType = 'image/x-icon';
    if (/\.svg(?:$|\?)/i.test(pathname)) contentType = 'image/svg+xml';
    if (/\.png(?:$|\?)/i.test(pathname)) contentType = 'image/png';
    if (/\.jpe?g(?:$|\?)/i.test(pathname)) contentType = 'image/jpeg';
    if (/\.webp(?:$|\?)/i.test(pathname)) contentType = 'image/webp';
  }
  return contentType;
}

async function logoDataFromUrl(url) {
  const imageResult = await fetchPublic(url, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' },
  });
  const imageResponse = imageResult.response;
  if (!imageResponse.ok) throw new Error(`Logo returned HTTP ${imageResponse.status}.`);
  const contentType = imageType(imageResponse, imageResult.finalUrl);
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error('Website icon is not a supported image type.');
  const image = await readLimited(imageResponse, MAX_IMAGE_BYTES);
  return {
    content_type: contentType,
    logo_data: `data:${contentType};base64,${image.toString('base64')}`,
    url: imageResult.finalUrl.href,
  };
}

async function logoOptionsFromUrls(urls, source, seenUrls, seenData, limit = MAX_LOGO_OPTIONS, diagnostics = null) {
  const uniqueUrls = urls.filter((url) => {
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  }).slice(0, limit * 2);
  const settled = await Promise.allSettled(uniqueUrls.map((url) => logoDataFromUrl(url)));
  const options = [];
  const failures = [];
  for (const [index, result] of settled.entries()) {
    if (result.status !== 'fulfilled') {
      failures.push({ url: safeLogUrl(uniqueUrls[index]), error: diagnosticError(result.reason) });
      continue;
    }
    if (seenData.has(result.value.logo_data)) continue;
    seenData.add(result.value.logo_data);
    options.push({ ...result.value, source });
    if (options.length >= limit) break;
  }
  addDiagnostic(diagnostics, `${source}-fetch`, {
    candidate_count: urls.length,
    attempted_count: uniqueUrls.length,
    success_count: options.length,
    failure_count: failures.length,
    failures: failures.slice(0, 8),
  });
  return options;
}

async function candidateDomainLogoUrls(input, diagnostics = null) {
  const domains = serviceDomainCandidates(input).slice(0, SERVICE_DOMAIN_FETCH_LIMIT);
  if (!domains.length) return [];

  const settled = await Promise.allSettled(domains.map(async (domain) => {
    const homepage = `https://${domain}/`;
    const fallbackIcon = new URL('/favicon.ico', homepage).href;
    try {
      const pageResult = await fetchPublic(homepage, { signal: AbortSignal.timeout(6000) });
      addDiagnostic(diagnostics, 'domain-response', {
        domain,
        status: pageResult.response.status,
        final_url: safeLogUrl(pageResult.finalUrl.href),
      });
      if (!pageResult.response.ok) return [fallbackIcon];
      const html = await readHtmlPreview(pageResult.response);
      return [...new Set([...websiteImageUrls(html, pageResult.finalUrl), fallbackIcon])];
    } catch (err) {
      addDiagnostic(diagnostics, 'domain-error', { domain, error: diagnosticError(err) });
      return [fallbackIcon];
    }
  }));

  const urls = [];
  let successCount = 0;
  let failureCount = 0;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value.length) successCount += 1;
      urls.push(...result.value);
    } else {
      failureCount += 1;
      addDiagnostic(diagnostics, 'domain-error', { error: diagnosticError(result.reason) });
    }
  }
  addDiagnostic(diagnostics, 'domain-candidates', {
    domain_count: domains.length,
    url_count: urls.length,
    success_count: successCount,
    failure_count: failureCount,
  });
  return [...new Set(urls)];
}

async function findLogoOptions(input, { diagnostics = null } = {}) {
  const started = Date.now();
  const seenUrls = new Set();
  const seenData = new Set();
  const options = [];
  addDiagnostic(diagnostics, 'start', {
    input_type: /^https?:\/\//i.test(String(input || '').trim()) || domainLikeInput(input) ? 'website' : 'service_name',
    domain_candidates: serviceDomainCandidates(input),
  });

  try {
    const normalized = normalizedWebsiteUrl(input);
    addDiagnostic(diagnostics, 'website-request', { url: safeLogUrl(normalized) });
    const pageResult = await fetchPublic(normalized, { signal: AbortSignal.timeout(8000) });
    addDiagnostic(diagnostics, 'website-response', { status: pageResult.response.status, final_url: safeLogUrl(pageResult.finalUrl.href) });
    if (pageResult.response.ok) {
      const html = await readHtmlPreview(pageResult.response);
      const websiteUrls = websiteImageUrls(html, pageResult.finalUrl);
      addDiagnostic(diagnostics, 'website-candidates', { candidate_count: websiteUrls.length });
      options.push(...await logoOptionsFromUrls(
        websiteUrls,
        'website',
        seenUrls,
        seenData,
        Math.ceil(MAX_LOGO_OPTIONS / 2),
        diagnostics,
      ));
    }
  } catch (err) {
    addDiagnostic(diagnostics, 'website-error', { error: diagnosticError(err) });
  }

  if (options.length < MAX_LOGO_OPTIONS) {
    try {
      options.push(...await logoOptionsFromUrls(
        await candidateDomainLogoUrls(input, diagnostics),
        'website',
        seenUrls,
        seenData,
        MAX_LOGO_OPTIONS - options.length,
        diagnostics,
      ));
    } catch (err) {
      addDiagnostic(diagnostics, 'domain-candidates-error', { error: diagnosticError(err) });
    }
  }

  addDiagnostic(diagnostics, 'complete', { result_count: options.length, elapsed_ms: Date.now() - started });
  return options.slice(0, MAX_LOGO_OPTIONS);
}

async function findLogo(websiteUrl) {
  const normalized = normalizedWebsiteUrl(websiteUrl);
  const pageResult = await fetchPublic(normalized, {
    signal: AbortSignal.timeout(8000),
  });
  const pageResponse = pageResult.response;
  if (!pageResponse.ok) throw new Error(`Website returned HTTP ${pageResponse.status}.`);
  const html = await readHtmlHead(pageResponse);
  for (const candidate of iconUrls(html, pageResult.finalUrl)) {
    try {
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
    } catch {}
  }
  throw new Error('No supported logo could be found.');
}

export { findLogo, findLogoOptions, iconUrls, privateAddress, serviceDomainCandidates, websiteImageUrls };
