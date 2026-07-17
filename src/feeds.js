import { XMLParser, XMLValidator } from 'fast-xml-parser';

const DEFAULT_RSS_BASE_URL = 'https://rsshub.app';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'spm',
  'from'
]);

/**
 * Validate a user-provided feed URL and return its normalized href.
 *
 * fetchFeed applies this validation to every redirect hop. This intentionally
 * rejects only local/private IP *literals*; DNS resolution must still be
 * constrained at the egress boundary because it can change over time.
 */
export function validateFeedUrl(rawUrl, { allowedHosts } = {}) {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    throw new TypeError('Feed URL is required');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Feed URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Feed URL must use http or https');
  }
  if (url.username || url.password) {
    throw new TypeError('Feed URL must not contain credentials');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new TypeError('Feed URL must contain a hostname');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new TypeError('Feed URL must not target localhost');
  }
  if (isNonPublicIpLiteral(hostname)) {
    throw new TypeError('Feed URL must not target a private or local IP address');
  }

  if (allowedHosts !== undefined && allowedHosts !== null) {
    const entries = normalizeAllowedHosts(allowedHosts);
    const isAllowed = entries.some((entry) => hostMatches(hostname, entry));
    if (!isAllowed) {
      throw new TypeError(`Feed URL host is not allowed: ${hostname}`);
    }
  }

  return url.href;
}

/**
 * Fetch and parse an RSS/Atom feed with bounded time, response size and items.
 */
export async function fetchFeed(
  rawUrl,
  {
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxItems = DEFAULT_MAX_ITEMS,
    allowedHosts,
    maxRedirects = DEFAULT_MAX_REDIRECTS
  } = {}
) {
  if (typeof fetchFn !== 'function') {
    throw new TypeError('fetchFn must be a function');
  }

  let currentUrl = validateFeedUrl(rawUrl, { allowedHosts });
  const safeMaxRedirects = nonNegativeInteger(maxRedirects, 'maxRedirects');
  const safeTimeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
  const safeMaxBytes = positiveInteger(maxBytes, 'maxBytes');
  const safeMaxItems = nonNegativeInteger(maxItems, 'maxItems');
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Feed request timed out after ${safeTimeoutMs}ms`));
  }, safeTimeoutMs);

  try {
    const response = await fetchWithValidatedRedirects(currentUrl, {
      fetchFn,
      signal: controller.signal,
      allowedHosts,
      maxRedirects: safeMaxRedirects,
      headers: {
        Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1'
      }
    });

    if (!response || typeof response.ok !== 'boolean') {
      throw new TypeError('Feed fetch returned an invalid response');
    }
    if (!response.ok) {
      const status = Number(response.status) || 0;
      const statusText = String(response.statusText || '').trim();
      throw new Error(`Feed request failed with HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    }

    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > safeMaxBytes) {
      throw new RangeError(`Feed response exceeds ${safeMaxBytes} bytes`);
    }

    const xml = await readResponseText(response, safeMaxBytes, controller.signal);
    return parseFeed(xml, { maxItems: safeMaxItems });
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      throw new Error(`Feed request timed out after ${safeTimeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Parse RSS 2.x or Atom XML into the small normalized shape used by polling. */
export function parseFeed(xml, { maxItems = DEFAULT_MAX_ITEMS } = {}) {
  const source = String(xml ?? '');
  const safeMaxItems = nonNegativeInteger(maxItems, 'maxItems');
  if (!source.trim()) {
    return { title: '', items: [] };
  }

  const validation = XMLValidator.validate(source);
  if (validation !== true) {
    const detail = validation?.err?.msg ? `: ${validation.err.msg}` : '';
    throw new Error(`Invalid feed XML${detail}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true
  });
  const document = parser.parse(source);

  if (document?.feed) {
    const feed = document.feed;
    const entries = toArray(feed.entry).slice(0, safeMaxItems);
    return {
      title: getXmlText(feed.title),
      items: entries.map((entry) => {
        const guid = getXmlText(entry?.id);
        return {
          title: getXmlText(entry?.title),
          link: extractFeedLink(entry?.link),
          guid,
          id: guid,
          pubDate: getXmlText(entry?.published ?? entry?.updated)
        };
      })
    };
  }

  if (document?.rss?.channel) {
    const channel = document.rss.channel;
    const entries = toArray(channel.item).slice(0, safeMaxItems);
    return {
      title: getXmlText(channel.title),
      items: entries.map((item) => {
        const guid = getXmlText(item?.guid);
        return {
          title: getXmlText(item?.title),
          link: extractFeedLink(item?.link),
          guid,
          id: guid,
          pubDate: getXmlText(item?.pubDate ?? item?.date ?? item?.['dc:date'])
        };
      })
    };
  }

  // RSS 1.0 / RDF is still encountered in older feeds.
  const rdf = document?.['rdf:RDF'] ?? document?.RDF;
  if (rdf) {
    const entries = toArray(rdf.item).slice(0, safeMaxItems);
    return {
      title: getXmlText(rdf.channel?.title),
      items: entries.map((item) => {
        const guid = getXmlText(item?.guid ?? item?.['dc:identifier'] ?? item?.['@_rdf:about']);
        return {
          title: getXmlText(item?.title),
          link: extractFeedLink(item?.link),
          guid,
          id: guid,
          pubDate: getXmlText(item?.pubDate ?? item?.date ?? item?.['dc:date'])
        };
      })
    };
  }

  return { title: '', items: [] };
}

/**
 * Build a stable item fingerprint: trusted GUID/Atom ID, canonical link, then
 * title plus publication date. The source discriminator avoids cross-kind
 * collisions where the literal values happen to match.
 */
export function buildItemFingerprint(item) {
  const guid = normalizeIdentity(item?.guid ?? item?.id);
  if (guid) {
    return simpleHash(`guid:${guid}`);
  }

  const link = normalizeUrlForDedup(item?.link);
  if (link) {
    return simpleHash(`link:${link}`);
  }

  const title = normalizeIdentity(item?.title).toLowerCase();
  const pubDate = normalizeIdentity(item?.pubDate).toLowerCase();
  if (!title && !pubDate) {
    return '';
  }
  return simpleHash(`fallback:${title}|${pubDate}`);
}

export function normalizeUrlForDedup(rawUrl = '') {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(lowerKey)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch {
    return value.toLowerCase();
  }
}

export function simpleHash(input = '') {
  const value = String(input ?? '');
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

export function inferTypeFromRssUrl(rssUrl = '') {
  const route = extractPathname(rssUrl);
  if (route.includes('/twitter/') || route.includes('/x/')) {
    return 'x';
  }
  if (route.includes('/youtube/')) {
    return 'youtube';
  }
  return 'rss';
}

export function normalizeRssBaseUrl(rawBaseUrl = '') {
  const trimmed = String(rawBaseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_RSS_BASE_URL;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return DEFAULT_RSS_BASE_URL;
    }

    let pathname = url.pathname.replace(/\/+$/, '');
    const legacySuffixes = [
      '/youtube/user',
      '/youtube/channel',
      '/youtube/live',
      '/twitter/user',
      '/x/user'
    ];
    for (const suffix of legacySuffixes) {
      if (pathname.toLowerCase().endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }

    return `${url.origin}${pathname && pathname !== '/' ? pathname : ''}`;
  } catch {
    return DEFAULT_RSS_BASE_URL;
  }
}

/** Accept either an env-like object or a raw base URL for easy migration. */
export function buildRssHubUrl(envOrBaseUrl, route) {
  const rawBaseUrl = envOrBaseUrl && typeof envOrBaseUrl === 'object'
    ? envOrBaseUrl.RSS_BASE_URL
    : envOrBaseUrl;
  const baseUrl = normalizeRssBaseUrl(rawBaseUrl);
  const normalizedRoute = String(route ?? '').startsWith('/') ? String(route) : `/${String(route ?? '')}`;
  return `${baseUrl}${normalizedRoute}`;
}

async function fetchWithValidatedRedirects(
  initialUrl,
  { fetchFn, signal, headers, allowedHosts, maxRedirects }
) {
  let currentUrl = initialUrl;
  let redirectsFollowed = 0;

  while (true) {
    let response;
    try {
      response = await fetchFn(currentUrl, {
        signal,
        headers,
        redirect: 'manual'
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new Error('Feed network request failed', { cause: error });
    }

    const status = Number(response?.status) || 0;
    if (!REDIRECT_STATUSES.has(status)) {
      return response;
    }

    await response.body?.cancel?.();

    if (redirectsFollowed >= maxRedirects) {
      throw new Error(`Feed redirect limit exceeded (${maxRedirects})`);
    }

    const location = String(response.headers?.get?.('location') ?? '').trim();
    if (!location) {
      throw new Error(`Feed redirect response HTTP ${status} is missing a Location header`);
    }

    let redirectUrl;
    try {
      redirectUrl = new URL(location, currentUrl).href;
    } catch {
      throw new Error(`Feed redirect response HTTP ${status} has an invalid Location header`);
    }

    currentUrl = validateFeedUrl(redirectUrl, { allowedHosts });
    redirectsFollowed += 1;
  }
}

async function readResponseText(response, maxBytes, signal) {
  if (!response.body) {
    return '';
  }

  if (typeof response.body.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new RangeError(`Feed response exceeds ${maxBytes} bytes`);
    }
    return new TextDecoder().decode(buffer);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new Error('Feed request aborted');
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Feed response too large');
        throw new RangeError(`Feed response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

function getXmlText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    if ('#text' in value) {
      return String(value['#text'] ?? '').trim();
    }
    return '';
  }
  return String(value).trim();
}

function extractFeedLink(linkNode) {
  if (linkNode === null || linkNode === undefined) {
    return '';
  }
  if (Array.isArray(linkNode)) {
    const alternate = linkNode.find((link) => {
      const rel = String(link?.['@_rel'] ?? link?.rel ?? '').toLowerCase();
      return rel === 'alternate';
    });
    return extractFeedLink(alternate ?? linkNode[0]);
  }
  if (typeof linkNode === 'string') {
    return linkNode.trim();
  }
  if (typeof linkNode === 'object') {
    return getXmlText(
      linkNode['@_href'] ?? linkNode.href ?? linkNode['#text'] ?? linkNode.url
    );
  }
  return getXmlText(linkNode);
}

function toArray(value) {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeIdentity(value) {
  return getXmlText(value).replace(/\s+/g, ' ').trim();
}

function extractPathname(urlOrPath) {
  const value = String(urlOrPath ?? '').trim().toLowerCase();
  if (!value) {
    return '';
  }
  try {
    return new URL(value).pathname.toLowerCase();
  } catch {
    return value;
  }
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return number;
}

function normalizeHostname(hostname) {
  return String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function normalizeAllowedHosts(allowedHosts) {
  const values = typeof allowedHosts === 'string'
    ? [allowedHosts]
    : [...allowedHosts];
  return values.map((entry) => {
    const value = String(entry ?? '').trim().toLowerCase();
    if (/^https?:\/\//.test(value)) {
      try {
        return normalizeHostname(new URL(value).hostname);
      } catch {
        return '';
      }
    }
    const wildcard = value.startsWith('*.');
    const hostname = normalizeHostname(wildcard ? value.slice(2) : value);
    return wildcard ? `*.${hostname}` : hostname;
  }).filter(Boolean);
}

function hostMatches(hostname, allowedEntry) {
  if (allowedEntry.startsWith('*.')) {
    const suffix = allowedEntry.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === allowedEntry;
}

function isNonPublicIpLiteral(hostname) {
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    return isNonPublicIpv4(ipv4);
  }
  const ipv6 = parseIpv6(hostname);
  if (ipv6 === null) {
    return false;
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96).
  if ((ipv6 >> 32n) === 0xffffn) {
    return isNonPublicIpv4([
      Number((ipv6 >> 24n) & 255n),
      Number((ipv6 >> 16n) & 255n),
      Number((ipv6 >> 8n) & 255n),
      Number(ipv6 & 255n)
    ]);
  }

  return inIpv6Range(ipv6, 0n, 128) || // unspecified
    inIpv6Range(ipv6, 1n, 128) || // loopback
    inIpv6Range(ipv6, 0xfc00n << 112n, 7) || // unique-local
    inIpv6Range(ipv6, 0xfe80n << 112n, 10) || // link-local
    inIpv6Range(ipv6, 0xfec0n << 112n, 10) || // deprecated site-local
    inIpv6Range(ipv6, 0xff00n << 112n, 8) || // multicast
    inIpv6Range(ipv6, 0x20010db8n << 96n, 32); // documentation
}

function parseIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isNonPublicIpv4([a, b, c]) {
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c <= 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function parseIpv6(hostname) {
  if (!hostname.includes(':')) {
    return null;
  }
  const halves = hostname.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value, base, prefixLength) {
  if (prefixLength === 0) {
    return true;
  }
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (base >> shift);
}
