import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildItemFingerprint,
  buildRssHubUrl,
  fetchFeed,
  inferTypeFromRssUrl,
  normalizeRssBaseUrl,
  normalizeUrlForDedup,
  parseFeed,
  simpleHash,
  validateFeedUrl
} from '../src/feeds.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example &amp; News</title>
    <item>
      <title>First &lt;story&gt;</title>
      <link>https://example.com/posts/1?utm_source=test&amp;b=2</link>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Fri, 17 Jul 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/posts/2</link>
      <guid>post-2</guid>
    </item>
  </channel>
</rss>`;

test('validateFeedUrl accepts public HTTP(S) URLs and normalizes them', () => {
  assert.equal(
    validateFeedUrl(' https://EXAMPLE.com/feed '),
    'https://example.com/feed'
  );
  assert.equal(validateFeedUrl('http://8.8.8.8/rss'), 'http://8.8.8.8/rss');
});

test('validateFeedUrl rejects unsafe schemes, credentials, localhost and private literals', () => {
  const invalidUrls = [
    'file:///etc/passwd',
    'https://user:password@example.com/feed',
    'http://localhost/feed',
    'http://api.localhost/feed',
    'http://127.0.0.1/feed',
    'http://10.20.30.40/feed',
    'http://172.16.0.1/feed',
    'http://192.168.1.1/feed',
    'http://169.254.169.254/latest',
    'http://[::1]/feed',
    'http://[fc00::1]/feed',
    'http://[::ffff:192.168.1.1]/feed'
  ];

  for (const url of invalidUrls) {
    assert.throws(() => validateFeedUrl(url), /Feed URL/);
  }
});

test('validateFeedUrl supports exact and wildcard host allowlists', () => {
  assert.equal(
    validateFeedUrl('https://feeds.example.com/a', {
      allowedHosts: new Set(['feeds.example.com'])
    }),
    'https://feeds.example.com/a'
  );
  assert.equal(
    validateFeedUrl('https://news.example.com/a', {
      allowedHosts: ['*.example.com']
    }),
    'https://news.example.com/a'
  );
  assert.throws(
    () => validateFeedUrl('https://evil.example.net/a', { allowedHosts: ['example.com'] }),
    /not allowed/
  );
});

test('RSSHub URL helpers retain custom base paths and remove legacy route suffixes', () => {
  assert.equal(normalizeRssBaseUrl(''), 'https://rsshub.app');
  assert.equal(normalizeRssBaseUrl('rss.example.com/root/'), 'https://rss.example.com/root');
  assert.equal(
    normalizeRssBaseUrl('https://rss.example.com/root/youtube/user'),
    'https://rss.example.com/root'
  );
  assert.equal(
    buildRssHubUrl({ RSS_BASE_URL: 'https://rss.example.com/root/' }, '/twitter/user/alice'),
    'https://rss.example.com/root/twitter/user/alice'
  );
  assert.equal(
    buildRssHubUrl('https://rss.example.com', 'youtube/user/bob'),
    'https://rss.example.com/youtube/user/bob'
  );
});

test('parseFeed normalizes RSS and enforces maxItems', () => {
  const feed = parseFeed(RSS, { maxItems: 1 });
  assert.equal(feed.title, 'Example & News');
  assert.deepEqual(feed.items, [{
    title: 'First <story>',
    link: 'https://example.com/posts/1?utm_source=test&b=2',
    guid: 'post-1',
    id: 'post-1',
    pubDate: 'Fri, 17 Jul 2026 00:00:00 GMT'
  }]);
});

test('parseFeed selects an Atom alternate link and ID', () => {
  const atom = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Feed</title>
      <entry>
        <title>Atom Item</title>
        <id>tag:example.com,2026:item</id>
        <updated>2026-07-17T00:00:00Z</updated>
        <link rel="self" href="https://example.com/api/item" />
        <link rel="alternate" href="https://example.com/item" />
      </entry>
    </feed>`;

  assert.deepEqual(parseFeed(atom), {
    title: 'Atom Feed',
    items: [{
      title: 'Atom Item',
      link: 'https://example.com/item',
      guid: 'tag:example.com,2026:item',
      id: 'tag:example.com,2026:item',
      pubDate: '2026-07-17T00:00:00Z'
    }]
  });
});

test('parseFeed rejects malformed XML', () => {
  assert.throws(() => parseFeed('<rss><channel></rss>'), /Invalid feed XML/);
});

test('fetchFeed checks HTTP status and returns parsed bounded data', async () => {
  let requestedUrl;
  const feed = await fetchFeed('https://example.com/feed', {
    fetchFn: async (url, init) => {
      requestedUrl = url;
      assert.equal(init.signal.aborted, false);
      return new Response(RSS, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' }
      });
    },
    maxItems: 1
  });

  assert.equal(requestedUrl, 'https://example.com/feed');
  assert.equal(feed.items.length, 1);
  await assert.rejects(
    fetchFeed('https://example.com/feed', {
      fetchFn: async () => new Response('unavailable', { status: 503 })
    }),
    /HTTP 503/
  );
});

test('fetchFeed enforces declared and streamed response limits', async () => {
  await assert.rejects(
    fetchFeed('https://example.com/feed', {
      fetchFn: async () => new Response(RSS, {
        headers: { 'content-length': String(Buffer.byteLength(RSS)) }
      }),
      maxBytes: 10
    }),
    /exceeds 10 bytes/
  );

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('123456'));
      controller.enqueue(new TextEncoder().encode('789'));
      controller.close();
    }
  });
  await assert.rejects(
    fetchFeed('https://example.com/feed', {
      fetchFn: async () => new Response(stream),
      maxBytes: 8
    }),
    /exceeds 8 bytes/
  );
});

test('fetchFeed aborts requests after the configured timeout', async () => {
  await assert.rejects(
    fetchFeed('https://example.com/feed', {
      timeoutMs: 5,
      fetchFn: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    }),
    /timed out after 5ms/
  );
});

test('fingerprints prefer GUID, then canonical links, then title/date', () => {
  assert.equal(
    buildItemFingerprint({ guid: 'same', link: 'https://example.com/one' }),
    buildItemFingerprint({ guid: 'same', link: 'https://example.com/two' })
  );
  assert.notEqual(
    buildItemFingerprint({ guid: 'one', link: 'https://example.com/post' }),
    buildItemFingerprint({ guid: 'two', link: 'https://example.com/post' })
  );
  assert.equal(
    buildItemFingerprint({ link: 'https://EXAMPLE.com/post/?b=2&utm_source=x&a=1#top' }),
    buildItemFingerprint({ link: 'https://example.com/post?a=1&b=2' })
  );
  assert.equal(
    buildItemFingerprint({ title: ' Story ', pubDate: 'Today' }),
    buildItemFingerprint({ title: 'story', pubDate: 'today' })
  );
  assert.equal(buildItemFingerprint({}), '');
});

test('URL normalization, hashing and type inference are deterministic', () => {
  assert.equal(
    normalizeUrlForDedup('https://EXAMPLE.com/post/?z=2&utm_medium=x&a=1#fragment'),
    'https://example.com/post?a=1&z=2'
  );
  assert.equal(simpleHash('same input'), simpleHash('same input'));
  assert.notEqual(simpleHash('one'), simpleHash('two'));
  assert.equal(inferTypeFromRssUrl('https://rsshub.app/twitter/user/name'), 'x');
  assert.equal(inferTypeFromRssUrl('/youtube/user/name'), 'youtube');
  assert.equal(inferTypeFromRssUrl('https://example.com/feed.xml'), 'rss');
});

test('fetchFeed follows validated relative redirects with one timeout signal', async () => {
  const requests = [];
  let redirectResponse;
  const feed = await fetchFeed('https://example.com/start', {
    allowedHosts: new Set(['example.com']),
    fetchFn: async (url, options) => {
      requests.push([url, options]);
      if (requests.length === 1) {
        redirectResponse = new Response('redirecting', {
          status: 302,
          headers: { location: '/final' }
        });
        return redirectResponse;
      }
      return new Response(RSS);
    }
  });

  assert.equal(feed.title, 'Example & News');
  assert.deepEqual(requests.map(([url]) => url), [
    'https://example.com/start',
    'https://example.com/final'
  ]);
  assert.equal(requests.every(([, options]) => options.redirect === 'manual'), true);
  assert.equal(requests[0][1].signal, requests[1][1].signal);
  assert.equal(redirectResponse.bodyUsed, true);
});

test('fetchFeed rejects redirects to private and non-allowlisted hosts', async () => {
  const redirectingTo = (location) => async () => new Response(null, {
    status: 302,
    headers: { location }
  });

  await assert.rejects(
    fetchFeed('https://example.com/start', {
      fetchFn: redirectingTo('http://127.0.0.1/feed')
    }),
    /private or local IP address/
  );

  await assert.rejects(
    fetchFeed('https://example.com/start', {
      allowedHosts: new Set(['example.com']),
      fetchFn: redirectingTo('https://outside.example.net/feed')
    }),
    /host is not allowed/
  );
});

test('fetchFeed rejects missing redirect locations and redirect limit overflow', async () => {
  let requests = 0;
  await assert.rejects(
    fetchFeed('https://example.com/start', {
      maxRedirects: 1,
      fetchFn: async () => {
        requests += 1;
        return new Response(null, {
          status: 307,
          headers: { location: `/hop-${requests}` }
        });
      }
    }),
    /redirect limit exceeded \(1\)/
  );
  assert.equal(requests, 2);

  await assert.rejects(
    fetchFeed('https://example.com/start', {
      fetchFn: async () => new Response(null, { status: 301 })
    }),
    /missing a Location header/
  );
});

test('fetchFeed sanitizes non-timeout network errors', async () => {
  const secretUrl = 'https://example.com/feed?token=do-not-log';
  await assert.rejects(
    fetchFeed(secretUrl, {
      fetchFn: async () => {
        throw new Error(`request failed for ${secretUrl}`);
      }
    }),
    (error) => {
      assert.equal(error.message, 'Feed network request failed');
      assert.doesNotMatch(error.message, /do-not-log/);
      return true;
    }
  );
});
