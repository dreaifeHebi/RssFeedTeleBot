import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerCallbackQuery,
  escapeHtml,
  getChatMember,
  isChatAdministrator,
  renderFeedMessage,
  sendTelegramMessage
} from '../src/telegram.js';

test('escapeHtml escapes every Telegram HTML metacharacter', () => {
  assert.equal(
    escapeHtml(`<tag a="x">Tom & Jerry's</tag>`),
    '&lt;tag a=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/tag&gt;'
  );
});

test('renderFeedMessage escapes dynamic fields and stays within Telegram limits', () => {
  const message = renderFeedMessage({
    title: '<b>injected</b> & '.repeat(1_000),
    link: 'https://example.com/?a=1&b=<bad>',
    pubDate: '<script>alert(1)</script>'
  }, 'A & B');

  assert.match(message, /&lt;b&gt;injected&lt;\/b&gt;/);
  assert.match(message, /A &amp; B/);
  assert.match(message, /&lt;bad&gt;/);
  assert.doesNotMatch(message, /<script>|<bad>|<b>injected<\/b>/);
  assert.ok(message.length <= 4096);
});

test('sendTelegramMessage preserves thread/reply markup and returns success metadata', async () => {
  let calls = 0;
  let request;
  const result = await sendTelegramMessage(
    'token',
    -100,
    '42',
    '<b>Hello</b>',
    { inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] },
    {
      fetchFn: async (url, init) => {
        calls += 1;
        request = { url, init };
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(request.url, 'https://api.telegram.org/bottoken/sendMessage');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.deepEqual(JSON.parse(request.init.body), {
    chat_id: -100,
    text: '<b>Hello</b>',
    parse_mode: 'HTML',
    message_thread_id: 42,
    reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] }
  });
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    retryable: false,
    permanent: false,
    retryAfterSeconds: 0,
    error: null,
    result: { message_id: 7 }
  });
});

test('sendTelegramMessage reports 429 without sleeping or retrying', async () => {
  let calls = 0;
  const result = await sendTelegramMessage('token', 1, null, 'hello', null, {
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        ok: false,
        description: 'Too Many Requests',
        parameters: { retry_after: 12 }
      }), { status: 429 });
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: false,
    status: 429,
    retryable: true,
    permanent: false,
    retryAfterSeconds: 12,
    error: 'Too Many Requests',
    result: null
  });
});

test('sendTelegramMessage distinguishes permanent, retryable and network failures', async () => {
  const badRequest = await sendTelegramMessage('token', 1, null, 'hello', null, {
    fetchFn: async () => new Response(
      JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }),
      { status: 400 }
    )
  });
  assert.equal(badRequest.retryable, false);
  assert.equal(badRequest.permanent, true);

  const unavailable = await sendTelegramMessage('token', 1, null, 'hello', null, {
    fetchFn: async () => new Response('upstream unavailable', { status: 503 })
  });
  assert.equal(unavailable.retryable, true);
  assert.equal(unavailable.permanent, false);

  const network = await sendTelegramMessage('token', 1, null, 'hello', null, {
    fetchFn: async () => {
      throw new Error('socket closed');
    }
  });
  assert.deepEqual(network, {
    ok: false,
    status: 0,
    retryable: true,
    permanent: false,
    retryAfterSeconds: 0,
    error: 'Telegram network request failed',
    result: null
  });
});

test('sendTelegramMessage rejects oversized text before fetching', async () => {
  let called = false;
  const result = await sendTelegramMessage('token', 1, null, 'x'.repeat(4097), null, {
    fetchFn: async () => {
      called = true;
      return new Response('{}');
    }
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.permanent, true);
  assert.match(result.error, /exceeds 4096/);
});

test('answerCallbackQuery truncates text to Telegram limits', async () => {
  let payload;
  const result = await answerCallbackQuery('token', 'callback-id', '界'.repeat(250), {
    fetchFn: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(payload.callback_query_id, 'callback-id');
  assert.equal([...payload.text].length, 200);
  assert.match(payload.text, /…$/);
});

test('getChatMember returns member data and administrator checks support both shapes', async () => {
  const response = await getChatMember('token', -100, '123', {
    fetchFn: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { chat_id: -100, user_id: 123 });
      return new Response(JSON.stringify({
        ok: true,
        result: { status: 'administrator', user: { id: 123 } }
      }), { status: 200 });
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.member.status, 'administrator');
  assert.equal(isChatAdministrator(response), true);
  assert.equal(isChatAdministrator({ status: 'creator' }), true);
  assert.equal(isChatAdministrator({ status: 'member' }), false);
  assert.equal(isChatAdministrator(null), false);
});

test('Telegram API calls time out as retryable failures and validate timeoutMs', async () => {
  let observedSignal;
  const result = await sendTelegramMessage('token', 1, null, 'hello', null, {
    timeoutMs: 5,
    fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => {
      observedSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });

  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    retryable: true,
    permanent: false,
    retryAfterSeconds: 0,
    error: 'Telegram request timed out after 5ms',
    result: null
  });

  let called = false;
  const invalid = await sendTelegramMessage('token', 1, null, 'hello', null, {
    timeoutMs: 0,
    fetchFn: async () => {
      called = true;
      return new Response('{}');
    }
  });
  assert.equal(called, false);
  assert.equal(invalid.permanent, true);
  assert.match(invalid.error, /timeoutMs must be a positive integer/);
});

test('Telegram HTTP 200 requires valid JSON and body-read failures are retryable', async () => {
  const invalidJson = await sendTelegramMessage('token', 1, null, 'hello', null, {
    fetchFn: async () => new Response('not-json', { status: 200 })
  });
  assert.deepEqual(invalidJson, {
    ok: false,
    status: 200,
    retryable: true,
    permanent: false,
    retryAfterSeconds: 0,
    error: 'Telegram returned an invalid response',
    result: null
  });

  const readFailure = await sendTelegramMessage('token', 1, null, 'hello', null, {
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new DOMException('aborted bot-token-url', 'AbortError');
      }
    })
  });
  assert.deepEqual(readFailure, {
    ok: false,
    status: 0,
    retryable: true,
    permanent: false,
    retryAfterSeconds: 0,
    error: 'Telegram network request failed',
    result: null
  });
});

test('invalid Telegram thread and user IDs fail locally without fetching', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const invalidThread = await sendTelegramMessage(
    'token', 1, '1.5', 'hello', null, { fetchFn }
  );
  const invalidUser = await getChatMember('token', 1, '9007199254740992', { fetchFn });

  assert.equal(calls, 0);
  assert.equal(invalidThread.ok, false);
  assert.equal(invalidThread.permanent, true);
  assert.match(invalidThread.error, /message_thread_id must be a positive safe integer/);
  assert.equal(invalidUser.ok, false);
  assert.equal(invalidUser.permanent, true);
  assert.match(invalidUser.error, /user_id must be a positive safe integer/);
  assert.equal(invalidUser.member, null);
});
