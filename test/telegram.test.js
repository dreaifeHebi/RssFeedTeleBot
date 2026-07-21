import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerCallbackQuery,
  buildTelegramFailureLogDetails,
  deleteTelegramMessage,
  editTelegramMessage,
  escapeHtml,
  getChatMember,
  isChatAdministrator,
  renderFeedMessage,
  sanitizeTelegramLogValue,
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
  assert.equal(request.init.redirect, 'manual');
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
  assert.deepEqual(
    {
      ok: result.ok,
      status: result.status,
      retryable: result.retryable,
      permanent: result.permanent,
      retryAfterSeconds: result.retryAfterSeconds,
      error: result.error,
      result: result.result
    },
    {
      ok: false,
      status: 429,
      retryable: true,
      permanent: false,
      retryAfterSeconds: 12,
      error: 'Telegram HTTP 429',
      result: null
    }
  );
  assert.equal(result.diagnostic.failureKind, 'http_error');
  assert.equal(result.diagnostic.failurePhase, 'response_validate');
  assert.equal(result.diagnostic.upstreamStatus, 429);
  assert.ok(result.diagnostic.durationMs >= 0);
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
      const cause = new Error('connection reset');
      cause.code = 'ECONNRESET';
      throw new TypeError('socket closed', { cause });
    }
  });
  assert.equal(network.ok, false);
  assert.equal(network.status, 0);
  assert.equal(network.retryable, true);
  assert.equal(network.permanent, false);
  assert.equal(network.retryAfterSeconds, 0);
  assert.equal(network.error, 'Telegram network request failed');
  assert.equal(network.result, null);
  assert.equal(network.diagnostic.failureKind, 'network_exception');
  assert.equal(network.diagnostic.failurePhase, 'fetch');
  assert.equal(network.diagnostic.exceptionName, 'TypeError');
  assert.equal(network.diagnostic.exceptionMessage, 'socket closed');
  assert.equal(network.diagnostic.causeName, 'Error');
  assert.equal(network.diagnostic.causeCode, 'ECONNRESET');
  assert.equal(network.diagnostic.causeMessage, 'connection reset');
  assert.equal(network.diagnostic.timedOut, false);
  assert.ok(network.diagnostic.durationMs >= 0);
});

test('Telegram HTTP failures never expose upstream response bodies', async () => {
  const token = '123456:http-body-secret';
  const message = 'private\n"payload"';
  const responseBody = JSON.stringify({
    ok: false,
    description: `echo ${message} ${token}`,
    echo: message
  });
  const result = await sendTelegramMessage(token, 1, null, message, null, {
    fetchFn: async () => new Response(responseBody, { status: 502 })
  });

  assert.equal(result.error, 'Telegram HTTP 502');
  assert.equal(result.diagnostic.failureKind, 'http_error');
  assert.equal(result.diagnostic.responseBodyLength, responseBody.length);
  const serialized = JSON.stringify(result);
  for (const secret of [token, 'private', 'payload']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('network diagnostics redact JSON-encoded request payloads', async () => {
  const token = '123456:request-body-secret';
  const chatId = '-100777777777';
  const message = 'private\n"payload"';
  const result = await sendTelegramMessage(token, chatId, null, message, null, {
    fetchFn: async (_url, init) => {
      throw new Error(init.body);
    }
  });

  assert.equal(result.diagnostic.failureKind, 'network_exception');
  assert.match(result.diagnostic.exceptionMessage, /\[REDACTED\]/);
  const serialized = JSON.stringify(result);
  for (const secret of [token, chatId, 'private', 'payload']) {
    assert.equal(serialized.includes(secret), false);
  }
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
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.retryable, true);
  assert.equal(result.error, 'Telegram request timed out after 5ms');
  assert.equal(result.diagnostic.failureKind, 'timeout');
  assert.equal(result.diagnostic.failurePhase, 'fetch');
  assert.equal(result.diagnostic.timedOut, true);
  assert.equal(result.diagnostic.timeoutMs, 5);

  let bodySignal;
  const bodyTimeout = await sendTelegramMessage('token', 1, null, 'hello', null, {
    timeoutMs: 5,
    fetchFn: async (_url, init) => {
      bodySignal = init.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => new Promise((_resolve, reject) => {
          bodySignal.addEventListener(
            'abort',
            () => reject(bodySignal.reason),
            { once: true }
          );
        })
      };
    }
  });
  assert.equal(bodyTimeout.status, 200);
  assert.equal(bodyTimeout.diagnostic.failureKind, 'timeout');
  assert.equal(bodyTimeout.diagnostic.failurePhase, 'response_body');
  assert.equal(bodyTimeout.diagnostic.upstreamStatus, 200);
  assert.equal(bodyTimeout.diagnostic.timedOut, true);

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
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.status, 200);
  assert.equal(invalidJson.retryable, true);
  assert.equal(invalidJson.error, 'Telegram returned invalid JSON');
  assert.equal(invalidJson.diagnostic.failureKind, 'invalid_json');
  assert.equal(invalidJson.diagnostic.failurePhase, 'response_parse');
  assert.equal(invalidJson.diagnostic.upstreamStatus, 200);
  assert.equal(invalidJson.diagnostic.responseBodyLength, 8);

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
  assert.equal(readFailure.ok, false);
  assert.equal(readFailure.status, 200);
  assert.equal(readFailure.retryable, true);
  assert.equal(readFailure.error, 'Telegram network request failed');
  assert.equal(readFailure.diagnostic.failureKind, 'network_exception');
  assert.equal(readFailure.diagnostic.failurePhase, 'response_body');
  assert.equal(readFailure.diagnostic.upstreamStatus, 200);
  assert.equal(readFailure.diagnostic.exceptionName, 'AbortError');
  assert.doesNotMatch(JSON.stringify(readFailure), /bot-token-url|\/bottoken\//);
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

test('Telegram redirects are returned as explicit failures without exposing Location', async () => {
  const token = '123456:redirect-secret';
  const message = 'private-message-for-redirect';
  const callbackData = 'private-callback-data';
  let requestInit;
  const result = await sendTelegramMessage(
    token,
    '-100987654321',
    null,
    message,
    {
      inline_keyboard: [[{
        text: 'Private button',
        callback_data: callbackData
      }]]
    },
    {
      fetchFn: async (_url, init) => {
        requestInit = init;
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://evil.example/bot${token}/${message}`
          }
        });
      }
    }
  );

  assert.equal(requestInit.redirect, 'manual');
  assert.equal(result.ok, false);
  assert.equal(result.status, 302);
  assert.equal(result.error, 'Telegram returned an unexpected redirect');
  assert.equal(result.diagnostic.failureKind, 'unexpected_redirect');
  assert.equal(result.diagnostic.failurePhase, 'redirect');
  assert.equal(result.diagnostic.upstreamStatus, 302);
  assert.equal(result.diagnostic.redirectHost, 'evil.example');
  const details = buildTelegramFailureLogDetails(
    token,
    'sendMessage',
    result,
    { source: 'webhook', sensitiveValues: [message, callbackData] }
  );
  assert.equal(details.redirectHost, 'evil.example');
  const serialized = JSON.stringify({ result, details });
  assert.doesNotMatch(
    serialized,
    /redirect-secret|private-message|private-callback|\/bot|location/i
  );
});

test('invalid response objects are distinguishable from fetch exceptions', async () => {
  const result = await sendTelegramMessage('token', 1, null, 'hello', null, {
    fetchFn: async () => ({ ok: 'not-a-boolean' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.diagnostic.failureKind, 'invalid_response');
  assert.equal(result.diagnostic.failurePhase, 'response_validate');
  assert.equal(result.diagnostic.exceptionName, null);
});

test('Telegram log sanitization redacts before truncation and allowlists fields', () => {
  const token = '123456:boundary-secret';
  const encodedToken = encodeURIComponent(token);
  const payloadText = 'unique-private-payload';
  const raw = 'x'.repeat(490) + token +
    ` https://api.telegram.org/bot${encodedToken}/sendMessage\u0000`;
  const sanitized = sanitizeTelegramLogValue(raw, token, [payloadText]);

  assert.ok(sanitized.length <= 500);
  assert.doesNotMatch(sanitized, /boundary-secret|123456%3A|api\.telegram\.org/);
  assert.doesNotMatch(sanitized, /\u0000/);

  const details = buildTelegramFailureLogDetails(
    token,
    'sendMessage',
    {
      ok: false,
      status: 0,
      retryable: true,
      permanent: false,
      retryAfterSeconds: 0,
      error: `failed via https://api.telegram.org/bot${token}/sendMessage`,
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      payload: payloadText,
      stack: `stack with ${token}`,
      diagnostic: {
        failureKind: 'network_exception',
        failurePhase: 'fetch',
        durationMs: 4,
        timeoutMs: 10_000,
        upstreamStatus: 0,
        responseContentType: null,
        responseBodyLength: 0,
        timedOut: false,
        exceptionName: 'TypeError',
        exceptionMessage: `fetch failed for ${token}`,
        causeName: 'Error',
        causeCode: 'ECONNRESET',
        causeMessage: payloadText,
        stack: `must not appear ${token}`
      }
    },
    {
      source: 'scheduled',
      deliveryId: 42,
      attempt: 3,
      maxAttempts: 10,
      exhausted: false,
      sensitiveValues: [payloadText]
    }
  );

  assert.equal(details.failurePhase, 'fetch');
  assert.equal(details.causeCode, 'ECONNRESET');
  assert.equal(details.deliveryId, 42);
  assert.equal(details.attempt, 3);
  assert.equal(details.exhausted, false);
  assert.equal(Object.hasOwn(details, 'url'), false);
  assert.equal(Object.hasOwn(details, 'payload'), false);
  assert.equal(Object.hasOwn(details, 'stack'), false);
  assert.doesNotMatch(
    JSON.stringify(details),
    /boundary-secret|unique-private-payload|api\.telegram\.org\/bot/
  );
});

test('editTelegramMessage and deleteTelegramMessage use bounded message IDs', async () => {
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      ok: true,
      result: url.endsWith('/deleteMessage')
        ? true
        : { message_id: 77 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const edited = await editTelegramMessage(
    'token',
    '-100',
    '77',
    '<b>Updated</b>',
    { inline_keyboard: [[{ text: 'Back', callback_data: 'back' }]] },
    { fetchFn }
  );
  const deleted = await deleteTelegramMessage(
    'token',
    '-100',
    78,
    { fetchFn }
  );

  assert.equal(edited.ok, true);
  assert.equal(deleted.ok, true);
  assert.deepEqual(requests, [
    {
      url: 'https://api.telegram.org/bottoken/editMessageText',
      payload: {
        chat_id: '-100',
        message_id: 77,
        text: '<b>Updated</b>',
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Back', callback_data: 'back' }]]
        }
      }
    },
    {
      url: 'https://api.telegram.org/bottoken/deleteMessage',
      payload: {
        chat_id: '-100',
        message_id: 78
      }
    }
  ]);

  let called = false;
  const invalid = await editTelegramMessage(
    'token',
    '-100',
    '9007199254740992',
    'text',
    null,
    {
      fetchFn: async () => {
        called = true;
        return new Response('{}');
      }
    }
  );
  assert.equal(called, false);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /message_id/);
});

test('edit failures expose only a sanitized API description for control flow', async () => {
  const token = 'edit-token-secret';
  const text = 'private-edit-payload';
  const result = await editTelegramMessage(
    token,
    123,
    77,
    text,
    null,
    {
      fetchFn: async () => new Response(JSON.stringify({
        ok: false,
        description: 'Bad Request: message is not modified ' + text + ' ' + token
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Telegram HTTP 400');
  assert.match(result.apiDescription, /message is not modified/);
  assert.doesNotMatch(JSON.stringify(result), /private-edit-payload|edit-token-secret/);
});
