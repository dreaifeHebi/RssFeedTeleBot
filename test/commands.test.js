import test from 'node:test';
import assert from 'node:assert/strict';

import { handleCallback, handleMessage } from '../src/commands.js';

function makeConfig(overrides = {}) {
  return {
    telegramBotToken: 'test-token',
    botUsername: 'mybot',
    rssBaseUrl: '',
    adminUserIds: new Set(['7']),
    allowedFeedHosts: new Set(),
    ...overrides
  };
}

function makeMessage(text, overrides = {}) {
  return {
    text,
    from: { id: '7' },
    chat: { id: '7', type: 'private' },
    ...overrides
  };
}

function makeKv() {
  const values = new Map();
  const puts = [];
  const deletes = [];
  return {
    values,
    puts,
    deletes,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value, options) {
      values.set(key, value);
      puts.push({ key, value, options });
    },
    async delete(key) {
      values.delete(key);
      deletes.push(key);
    }
  };
}

function makeHarness(overrides = {}) {
  const messages = [];
  const sends = [];
  const edits = [];
  const messageDeletes = [];
  const answers = [];
  const services = {
    async sendTelegramMessage(token, chatId, threadId, text, replyMarkup, options) {
      const message = {
        operation: 'send',
        token,
        chatId,
        threadId,
        text,
        replyMarkup,
        options
      };
      sends.push(message);
      messages.push(message);
      return { ok: true, result: { message_id: sends.length } };
    },
    async editTelegramMessage(
      token,
      chatId,
      messageId,
      text,
      replyMarkup,
      options
    ) {
      const message = {
        operation: 'edit',
        token,
        chatId,
        messageId: String(messageId),
        text,
        replyMarkup,
        options
      };
      edits.push(message);
      messages.push(message);
      return { ok: true, result: { message_id: Number(messageId) } };
    },
    async deleteTelegramMessage(token, chatId, messageId, options) {
      messageDeletes.push({
        token,
        chatId,
        messageId: String(messageId),
        options
      });
      return { ok: true, result: true };
    },
    async acquireOperationalLease() {
      return true;
    },
    async renewOperationalLease() {
      return true;
    },
    async releaseOperationalLease() {
      return true;
    },
    async readOperationalState(env, name) {
      return env.DB.get(name);
    },
    async applyOperationalStateChanges(env, changes) {
      let changed = 0;
      for (const change of changes) {
        const current = await env.DB.get(change.name);
        if (change.delete === true) {
          if (
            change.expectedValue !== null &&
            change.expectedValue !== undefined &&
            String(current ?? '') !== String(change.expectedValue)
          ) {
            continue;
          }
          if (current !== null && current !== undefined) {
            await env.DB.delete(change.name);
            changed += 1;
          }
          continue;
        }
        if (
          change.expectedValue !== null &&
          change.expectedValue !== undefined &&
          String(current ?? '') !== String(change.expectedValue)
        ) {
          continue;
        }
        await env.DB.put(
          change.name,
          String(change.value),
          { expirationTtl: change.expirationTtl }
        );
        changed += 1;
      }
      return changed;
    },
    async answerCallbackQuery(token, callbackQueryId, text, options) {
      answers.push({ token, callbackQueryId, text, options });
      return { ok: true };
    },
    async addSubscription() {
      return true;
    },
    async listSubscriptions() {
      return [];
    },
    async removeSubscriptions() {
      return 0;
    },
    async copySubscriptions() {
      return 0;
    },
    ...overrides
  };
  return { services, messages, sends, edits, messageDeletes, answers };
}

async function clickPrivateUi(kv, harness, sessionId, action, id = action) {
  return handleCallback(
    {
      id,
      data: 'ui:' + sessionId + ':' + action,
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
}
function seedPrivateUiSession(kv, sessionId, actions, overrides = {}) {
  const actionList = Array.isArray(actions) ? actions : [actions];
  const callbackAllowlist = actionList.map(
    (action) => 'ui:' + sessionId + ':' + action
  );
  kv.values.set('ui_active:7:_:7', sessionId);
  kv.values.set('ui_session:' + sessionId, JSON.stringify({
    v: 1,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    panelMessageId: '1',
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    callbackAllowlist,
    ...overrides
  }));
  return callbackAllowlist;
}

test('management commands deny a group member and allow an administrator', async () => {
  let addCalls = 0;
  const denied = makeHarness({
    async getChatMember() {
      return { status: 'member' };
    },
    async addSubscription() {
      addCalls += 1;
      return true;
    }
  });
  const message = makeMessage(
    '/add rss https://feeds.example/feeds/secret-token/rss?format=xml',
    {
      chat: { id: '-100', type: 'supergroup' }
    }
  );
  const config = makeConfig({
    adminUserIds: new Set(),
    allowedFeedHosts: new Set(['feeds.example'])
  });

  await handleMessage(message, { DB: makeKv() }, config, denied.services);
  assert.equal(addCalls, 0);
  assert.match(denied.messages[0].text, /do not have permission/);

  let added;
  const allowed = makeHarness({
    async getChatMember() {
      return { ok: true, member: { status: 'administrator' } };
    },
    async addSubscription(env, subscription) {
      added = subscription;
      return true;
    }
  });
  await handleMessage(message, { DB: makeKv() }, config, allowed.services);

  assert.deepEqual(added, {
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/feeds/secret-token/rss?format=xml',
    chatId: '-100',
    threadId: null
  });
  assert.doesNotMatch(added.channelName, /secret-token/);
  assert.match(allowed.messages.at(-1).text, /Added rss subscription/);
  assert.doesNotMatch(allowed.messages.at(-1).text, /secret-token/);
});

test('command reply failures emit structured logs without exposing the bot token', async () => {
  const logs = [];
  const token = 'test-token-must-not-leak';
  const harness = makeHarness({
    async sendTelegramMessage() {
      return {
        ok: false,
        status: 401,
        retryable: false,
        permanent: true,
        retryAfterSeconds: 0,
        error: 'Unauthorized for ' + token,
        url: 'https://api.telegram.org/bot' + token + '/sendMessage',
        payload: 'sensitive-payload',
        stack: 'sensitive stack ' + token,
        diagnostic: {
          failureKind: 'network_exception',
          failurePhase: 'fetch',
          durationMs: 7,
          timeoutMs: 10_000,
          upstreamHost: 'untrusted.example',
          upstreamStatus: 0,
          responseContentType: null,
          responseBodyLength: 0,
          timedOut: false,
          exceptionName: 'TypeError',
          exceptionMessage: 'failed for ' + token,
          causeName: 'Error',
          causeCode: 'ECONNRESET',
          causeMessage:
            'https://api.telegram.org/bot' + token + '/sendMessage',
          stack: 'must never be logged'
        }
      };
    },
    logTelegramError(details) {
      logs.push(details);
    }
  });

  await handleMessage(
    makeMessage('/start'),
    { DB: makeKv() },
    makeConfig({ telegramBotToken: token }),
    harness.services
  );

  assert.deepEqual(logs, [{
    message: 'Telegram API request failed.',
    operation: 'sendMessage',
    status: 401,
    retryable: false,
    permanent: true,
    retryAfterSeconds: 0,
    error: 'Unauthorized for [REDACTED]',
    source: 'webhook',
    failureKind: 'network_exception',
    failurePhase: 'fetch',
    durationMs: 7,
    timeoutMs: 10_000,
    upstreamHost: 'api.telegram.org',
    upstreamStatus: 0,
    responseContentType: null,
    responseBodyLength: 0,
    timedOut: false,
    exceptionName: 'TypeError',
    exceptionMessage: 'failed for [REDACTED]',
    causeName: 'Error',
    causeCode: 'ECONNRESET',
    causeMessage: '[REDACTED_TELEGRAM_URL]'
  }]);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.doesNotMatch(serialized, /sensitive-payload|sensitive stack|untrusted/);
  assert.doesNotMatch(serialized, /api\.telegram\.org\/bot/);
});

test('getChatMember failures are logged before permission checks fail closed', async () => {
  const token = 'member-check-token-must-not-leak';
  const logs = [];
  const harness = makeHarness({
    async getChatMember() {
      return {
        ok: false,
        status: 0,
        retryable: true,
        permanent: false,
        retryAfterSeconds: 0,
        error:
          'fetch failed https://api.telegram.org/bot' +
          token +
          '/getChatMember',
        diagnostic: {
          failureKind: 'network_exception',
          failurePhase: 'fetch',
          durationMs: 11,
          timeoutMs: 10_000,
          upstreamStatus: 0,
          responseContentType: null,
          responseBodyLength: 0,
          timedOut: false,
          exceptionName: 'TypeError',
          exceptionMessage: 'fetch failed for ' + token,
          causeName: null,
          causeCode: null,
          causeMessage: null
        }
      };
    },
    logTelegramError(details) {
      logs.push(details);
    }
  });

  await handleMessage(
    makeMessage('/add rss https://feeds.example/rss', {
      chat: { id: '-100123456789', type: 'supergroup' }
    }),
    { DB: makeKv() },
    makeConfig({
      telegramBotToken: token,
      adminUserIds: new Set(),
      allowedFeedHosts: new Set(['feeds.example'])
    }),
    harness.services
  );

  assert.equal(logs.length, 1);
  assert.deepEqual(
    {
      source: logs[0].source,
      operation: logs[0].operation,
      failureKind: logs[0].failureKind,
      failurePhase: logs[0].failurePhase,
      exceptionName: logs[0].exceptionName
    },
    {
      source: 'webhook',
      operation: 'getChatMember',
      failureKind: 'network_exception',
      failurePhase: 'fetch',
      exceptionName: 'TypeError'
    }
  );
  assert.match(harness.messages.at(-1).text, /do not have permission/);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(logs), /api\.telegram\.org\/bot/);
});

test('add applies the feed host allowlist and escapes dynamic HTML', async () => {
  let added;
  const harness = makeHarness({
    async addSubscription(env, subscription) {
      added = subscription;
      return true;
    }
  });
  const config = makeConfig({
    rssBaseUrl: 'https://rsshub.example',
    allowedFeedHosts: new Set(['rsshub.example'])
  });

  await handleMessage(
    makeMessage('/add x <b>evil</b>'),
    { DB: makeKv() },
    config,
    harness.services
  );

  assert.equal(added.channelName, '<b>evil</b>');
  assert.equal(
    added.rssUrl,
    'https://rsshub.example/twitter/user/%3Cb%3Eevil%3C%2Fb%3E'
  );
  assert.match(harness.messages.at(-1).text, /&lt;b&gt;evil&lt;\/b&gt;/);
  assert.doesNotMatch(harness.messages.at(-1).text, /subscription: <b>evil<\/b>/);

  added = undefined;
  await handleMessage(
    makeMessage('/add rss https://blocked.example/feed.xml'),
    { DB: makeKv() },
    config,
    harness.services
  );
  assert.equal(added, undefined);
  assert.match(harness.messages.at(-1).text, /host is not allowed/);
});

test('set_forward preserves large chat IDs and safe thread IDs as strings', async () => {
  const kv = makeKv();
  const sourceChatId = '-1009007199254740993000';
  const sourceThreadId = '123456789';
  const targetChatId = '-1009007199254740993999';
  const targetThreadId = '9007199254740991';
  const harness = makeHarness();

  await handleMessage(
    makeMessage(
      '/set_forward ' + targetChatId + ' ' + targetThreadId + ' true topic',
      {
        chat: { id: sourceChatId, type: 'supergroup' },
        message_thread_id: sourceThreadId
      }
    ),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(
    kv.puts[0].key,
    'forward_config:' + sourceChatId + ':' + sourceThreadId
  );
  assert.deepEqual(JSON.parse(kv.puts[0].value), {
    targetChatId,
    targetThreadId,
    onlyForward: true,
    isGlobal: false
  });
  assert.match(harness.messages[0].text, new RegExp(targetChatId));
});

test('forward commands reject thread IDs above Number.MAX_SAFE_INTEGER', async () => {
  const kv = makeKv();
  let listCalls = 0;
  const harness = makeHarness({
    async listSubscriptions() {
      listCalls += 1;
      return [];
    }
  });
  const oversizedThreadId = '9007199254740992';

  await handleMessage(
    makeMessage('/set_forward -200 ' + oversizedThreadId),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.puts.length, 0);
  assert.match(harness.messages.at(-1).text, /Invalid Target Thread ID/);

  await handleMessage(
    makeMessage('/forward_to -200 ' + oversizedThreadId),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(listCalls, 0);
  assert.match(harness.messages.at(-1).text, /Invalid Target Thread ID/);
});

test('list and remove use scoped string chat/thread IDs and escape names', async () => {
  const listFilters = [];
  const removedFilters = [];
  const harness = makeHarness({
    async listSubscriptions(env, filter) {
      listFilters.push(filter);
      return [
        {
          id: 101,
          type: 'x',
          channelName: '<b>unsafe</b>',
          rssUrl: 'https://rsshub.example/twitter/user/unsafe',
          chatId: '-100',
          threadId: '9'
        },
        {
          id: 102,
          type: 'rss',
          channelName: 'legacy/feeds/secret-token/rss',
          rssUrl: 'https://safe-feed.example/feeds/secret-token/rss',
          chatId: '-100',
          threadId: '9'
        },
        {
          id: 103,
          type: 'rss',
          channelName: 'legacy/other-secret/rss',
          rssUrl: 'https://safe-feed.example/other-secret/rss',
          chatId: '-100',
          threadId: '9'
        }
      ];
    },
    async removeSubscriptions(env, filter) {
      removedFilters.push(filter);
      return 1;
    }
  });
  const base = {
    chat: { id: '-100', type: 'supergroup' },
    from: { id: '7' },
    message_thread_id: '9'
  };

  await handleMessage(
    makeMessage('/list', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(listFilters[0], { chatId: '-100', threadId: '9' });
  assert.match(harness.messages.at(-1).text, /#101 \[x\]/);
  assert.match(harness.messages.at(-1).text, /#102 \[rss\]/);
  assert.match(harness.messages.at(-1).text, /#103 \[rss\]/);
  assert.match(harness.messages.at(-1).text, /&lt;b&gt;unsafe&lt;\/b&gt;/);
  assert.doesNotMatch(harness.messages.at(-1).text, /- \[x\] <b>unsafe<\/b>/);
  assert.match(harness.messages.at(-1).text, /safe-feed\.example/);
  assert.doesNotMatch(harness.messages.at(-1).text, /secret-token/);

  await handleMessage(
    makeMessage('/remove x <b>unsafe</b>', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(removedFilters[0], {
    id: 101,
    chatId: '-100',
    threadId: '9'
  });
  assert.match(harness.messages.at(-1).text, /#101 \[x\]/);
  assert.match(harness.messages.at(-1).text, /&lt;b&gt;unsafe&lt;\/b&gt;/);

  await handleMessage(
    makeMessage('/remove rss safe-feed.example', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.equal(removedFilters.length, 1);
  assert.match(harness.messages.at(-1).text, /Multiple subscriptions match/);
  assert.match(harness.messages.at(-1).text, /#102 \[rss\] safe-feed\.example/);
  assert.match(harness.messages.at(-1).text, /#103 \[rss\] safe-feed\.example/);
  assert.doesNotMatch(harness.messages.at(-1).text, /secret-token|other-secret/);

  await handleMessage(
    makeMessage('/del #102', base),
    { DB: makeKv() },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(removedFilters[1], {
    id: 102,
    chatId: '-100',
    threadId: '9'
  });
  assert.match(harness.messages.at(-1).text, /Removed subscription #102/);
});

test('del_forward removes the topic-specific KV key', async () => {
  const kv = makeKv();
  const harness = makeHarness();

  await handleMessage(
    makeMessage('/del_forward', {
      chat: { id: '-100', type: 'supergroup' },
      message_thread_id: '12'
    }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.deepEqual(kv.deletes, ['forward_config:-100:12']);
  assert.match(harness.messages[0].text, /This Topic/);
});

test('forward sessions bind chat, thread, and initiating user and copy once', async () => {
  const kv = makeKv();
  const copies = [];
  let forwardListFilter;
  const subscriptions = [{
    id: 201,
    type: 'rss',
    channelName: 'legacy/feeds/secret-token/rss',
    rssUrl: 'https://feeds.example/feeds/secret-token/rss',
    chatId: '-100',
    threadId: '9'
  }];
  const harness = makeHarness({
    randomUUID() {
      return 'session_1';
    },
    async listSubscriptions(env, filter) {
      forwardListFilter = filter;
      return subscriptions;
    },
    async copySubscriptions(env, selected, chatId, threadId) {
      copies.push({ selected, chatId, threadId });
      return 1;
    }
  });
  const targetChatId = '-1009007199254740993999';
  const targetThreadId = '9007199254740991';

  await handleMessage(
    makeMessage('/forward_to ' + targetChatId + ' ' + targetThreadId, {
      chat: { id: '-100', type: 'supergroup' },
      message_thread_id: '9'
    }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.deepEqual(forwardListFilter, { chatId: '-100', threadId: '9' });
  const stored = JSON.parse(kv.values.get('fwd_session:session_1'));
  assert.equal(stored.targetChatId, targetChatId);
  assert.equal(stored.targetThreadId, targetThreadId);
  assert.equal(stored.sourceChatId, '-100');
  assert.equal(stored.sourceThreadId, '9');
  assert.equal(stored.initiatorUserId, '7');
  assert.deepEqual(kv.puts[0].options, { expirationTtl: 3600 });
  assert.equal(stored.subMap[0].channelName, 'feeds.example');
  assert.doesNotMatch(JSON.stringify(stored.subMap[0]), /legacy\/feeds/);
  assert.equal(harness.messages[0].replyMarkup.inline_keyboard[1][0].text,
    '📋 [rss] feeds.example');
  assert.doesNotMatch(
    harness.messages[0].replyMarkup.inline_keyboard[1][0].text,
    /secret-token/
  );

  const callbackBase = {
    id: 'callback-1',
    data: 'fwd:session_1:ALL',
    message: { chat: { id: '-100' }, message_thread_id: '9' }
  };
  await handleCallback(
    { ...callbackBase, from: { id: '8' } },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copies.length, 0);
  assert.equal(kv.values.has('fwd_session:session_1'), true);
  assert.match(harness.answers.at(-1).text, /not available/);

  await handleCallback(
    { ...callbackBase, from: { id: '7' } },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(copies[0], {
    selected: [{
      type: 'rss',
      channelName: 'feeds.example',
      rssUrl: 'https://feeds.example/feeds/secret-token/rss'
    }],
    chatId: targetChatId,
    threadId: targetThreadId
  });
  assert.equal(kv.values.has('fwd_session:session_1'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:session_1')).phase, 'complete');
  assert.match(harness.answers.at(-1).text, /Forwarded 1/);

  await handleCallback(
    {
      ...callbackBase,
      id: 'callback-after-complete',
      from: { id: '7' }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copies.length, 1);
  assert.match(harness.answers.at(-1).text, /Forwarded 1/);
});

test('callback consumes the session when allowlist permission was revoked', async () => {
  const kv = makeKv();
  let copyCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'revoked_session';
    },
    async listSubscriptions() {
      return [{
        id: 301,
        type: 'rss',
        channelName: 'feed',
        rssUrl: 'https://feeds.example/feed.xml',
        chatId: '-100',
        threadId: null
      }];
    },
    async copySubscriptions() {
      copyCalls += 1;
      return 1;
    }
  });
  const message = makeMessage('/forward_to -200', {
    chat: { id: '-100', type: 'supergroup' }
  });

  await handleMessage(
    message,
    { DB: kv },
    makeConfig({ adminUserIds: new Set(['7']) }),
    harness.services
  );
  assert.equal(kv.values.has('fwd_session:revoked_session'), true);

  await handleCallback(
    {
      id: 'revoked-callback',
      data: 'fwd:revoked_session:ALL',
      from: { id: '7' },
      message: { chat: { id: '-100', type: 'supergroup' } }
    },
    { DB: kv },
    makeConfig({ adminUserIds: new Set(['99']) }),
    harness.services
  );

  assert.equal(copyCalls, 0);
  assert.equal(kv.values.has('fwd_session:revoked_session'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:revoked_session')).phase, 'revoked');
  assert.match(harness.answers.at(-1).text, /Permission expired/);
});

test('a valid forwarding callback is consumed when rows already exist', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  kv.values.set('fwd_session:existing', JSON.stringify({
    v: 2,
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '-100',
    sourceThreadId: null,
    initiatorUserId: '7',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: now + 3600
  }));
  const harness = makeHarness({
    async copySubscriptions() {
      return 0;
    }
  });

  await handleCallback(
    {
      id: 'callback-2',
      data: 'fwd:existing:ALL',
      from: { id: '7' },
      message: { chat: { id: '-100' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(kv.values.has('fwd_session:existing'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:existing')).phase, 'complete');
  assert.match(harness.answers[0].text, /already exist/);
});

test('menu session is scoped, active, and renders bounded navigation callbacks', async () => {
  const kv = makeKv();
  const subscriptions = [{
    id: 1,
    type: 'rss',
    channelName: 'hidden/path',
    rssUrl: 'https://feeds.example/hidden/path?token=secret',
    chatId: '7',
    threadId: null
  }];
  const harness = makeHarness({
    randomUUID() {
      return 'menu_1';
    },
    async listSubscriptions() {
      return subscriptions;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const session = JSON.parse(kv.values.get('ui_session:menu_1'));
  assert.equal(session.sourceChatId, '7');
  assert.equal(session.sourceThreadId, null);
  assert.equal(session.initiatorUserId, '7');
  assert.equal(kv.values.get('ui_active:7:_:7'), 'menu_1');
  assert.match(harness.messages[0].text, /RSS 订阅管理/);
  const callbacks = harness.messages[0].replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(callbacks.includes('ui:menu_1:l:0'), true);
  for (const callback of callbacks) {
    assert.ok(new TextEncoder().encode(callback).length <= 64);
  }

  await handleCallback(
    {
      id: 'wrong-user',
      data: 'ui:menu_1:l:0',
      from: { id: '8' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.match(harness.answers.at(-1).text, /菜单已过期/);

  await handleCallback(
    {
      id: 'right-user',
      data: 'ui:menu_1:l:0',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.match(harness.messages.at(-1).text, /管理订阅/);
  assert.match(
    harness.messages.at(-1).replyMarkup.inline_keyboard[0][0].text,
    /\[RSS\] feeds\.example/
  );
  assert.doesNotMatch(harness.messages.at(-1).text, /hidden|secret/);
});

test('menu RSS input keeps invalid sessions and consumes successful additions', async () => {
  const kv = makeKv();
  const added = [];
  const harness = makeHarness({
    randomUUID() {
      return 'menu_add';
    },
    async addSubscription(env, subscription) {
      added.push(subscription);
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(
    kv,
    harness,
    'menu_add',
    'a',
    'open-add-menu'
  );
  await handleCallback(
    {
      id: 'add-rss',
      data: 'ui:menu_add:at:r',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const inputKey = 'ui_input:7:_:7';
  assert.equal(JSON.parse(kv.values.get(inputKey)).subscriptionType, 'rss');

  await handleMessage(
    makeMessage('not-a-feed-url'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.has(inputKey), true);
  assert.equal(added.length, 0);

  await handleMessage(
    makeMessage('https://feeds.example/private/feed.xml?token=secret'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.has(inputKey), false);
  assert.equal(added.length, 1);
  assert.equal(added[0].channelName, 'feeds.example');
  assert.equal(added[0].chatId, '7');
  assert.doesNotMatch(harness.messages.at(-1).text, /token=secret/);
});

test('menu subscription deletion requires confirmation and stays source scoped', async () => {
  const kv = makeKv();
  const removed = [];
  const subscription = {
    id: 42,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '-100',
    threadId: '9'
  };
  const harness = makeHarness({
    randomUUID() {
      return 'menu_delete';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async removeSubscriptions(env, filter) {
      removed.push(filter);
      return 1;
    },
    async getSubscriptionRouting() {
      return {
        subscriptionId: 42,
        independent: false,
        includeSource: true,
        targets: []
      };
    }
  });
  const messageOverrides = {
    chat: { id: '-100', type: 'supergroup' },
    from: { id: '7' },
    message_thread_id: '9'
  };

  await handleMessage(
    makeMessage('/menu', messageOverrides),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const callbackBase = {
    from: { id: '7' },
    message: {
      chat: { id: '-100', type: 'supergroup' },
      message_thread_id: '9'
    }
  };
  const click = (id, action) => handleCallback(
    {
      ...callbackBase,
      id,
      data: 'ui:menu_delete:' + action
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await click('open-list', 'l:0');
  await click('open-detail', 's:42:0');
  await click('delete-confirm', 'dc:42:0');
  assert.equal(removed.length, 0);
  assert.match(harness.messages.at(-1).text, /确认删除订阅/);
  const firstDeleteCallback = harness.messages.at(-1).replyMarkup
    .inline_keyboard.flat()
    .map((button) => button.callback_data)
    .find((data) => data.startsWith('ui:menu_delete:dx:'));
  const firstDeleteAction = firstDeleteCallback
    .slice('ui:menu_delete:'.length);

  await click('cancel-delete', 's:42:0');
  const editsAfterCancel = harness.edits.length;
  await click('delayed-delete-execute', firstDeleteAction);
  assert.equal(removed.length, 0);
  assert.equal(harness.edits.length, editsAfterCancel);
  assert.match(
    harness.answers.at(-1).text,
    /按钮已不属于当前页面/
  );
  const activeSession = JSON.parse(
    kv.values.get('ui_session:menu_delete')
  );
  assert.equal(
    activeSession.callbackAllowlist.includes(firstDeleteCallback),
    false
  );

  await click('delete-confirm-again', 'dc:42:0');
  const secondDeleteCallback = harness.messages.at(-1).replyMarkup
    .inline_keyboard.flat()
    .map((button) => button.callback_data)
    .find((data) => data.startsWith('ui:menu_delete:dx:'));
  const secondDeleteAction = secondDeleteCallback
    .slice('ui:menu_delete:'.length);
  assert.notEqual(secondDeleteCallback, firstDeleteCallback);
  const editsAfterReopen = harness.edits.length;
  await click('replayed-first-confirmation', firstDeleteAction);
  assert.equal(removed.length, 0);
  assert.equal(harness.edits.length, editsAfterReopen);
  await click('delete-execute', secondDeleteAction);
  assert.deepEqual(removed, [{
    id: 42,
    chatId: '-100',
    threadId: '9'
  }]);
});

test('first independent target snapshots inherited only-forward behavior', async () => {
  const kv = makeKv();
  kv.values.set('forward_config:7', JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    onlyForward: true,
    isGlobal: true
  }));
  let independent = false;
  let storedSnapshot;
  const subscription = {
    id: 9,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '7',
    threadId: null
  };
  const harness = makeHarness({
    randomUUID() {
      return 'menu_route';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async getSubscriptionRouting() {
      return independent
        ? {
            subscriptionId: 9,
            independent: true,
            includeSource: storedSnapshot.includeSource,
            targets: storedSnapshot.targets.map((target, index) => ({
              id: index + 1,
              ...target
            }))
          }
        : {
            subscriptionId: 9,
            independent: false,
            includeSource: true,
            targets: []
          };
    },
    async initializeSubscriptionRouting(env, scope, snapshot) {
      assert.deepEqual(scope, {
        subscriptionId: 9,
        chatId: '7',
        threadId: null
      });
      storedSnapshot = structuredClone(snapshot);
      independent = true;
      return { created: true, targetsAdded: snapshot.targets.length };
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'menu_route', 'fw');
  await clickPrivateUi(kv, harness, 'menu_route', 'fl:0');
  await clickPrivateUi(kv, harness, 'menu_route', 'f:9:0');
  await handleCallback(
    {
      id: 'route-add',
      data: 'ui:menu_route:fa:9',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('-300 8'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.deepEqual(storedSnapshot, {
    includeSource: false,
    targets: [
      { chatId: '-200', threadId: null },
      { chatId: '-300', threadId: '8' }
    ]
  });
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.match(harness.messages.at(-1).text, /已添加独立转发目标/);
});


test('cross-chat commands fail closed unless the initiator manages the target', async () => {
  const kv = makeKv();
  const lookups = [];
  let listCalls = 0;
  const harness = makeHarness({
    async getChatMember(token, chatId, userId) {
      lookups.push(String(chatId));
      return {
        ok: true,
        member: {
          status: String(chatId) === '-100' ? 'administrator' : 'member'
        }
      };
    },
    async listSubscriptions() {
      listCalls += 1;
      return [];
    }
  });
  const messageOverrides = {
    from: { id: '7' },
    chat: { id: '-100', type: 'supergroup' }
  };
  const config = makeConfig({ adminUserIds: new Set() });

  await handleMessage(
    makeMessage('/set_forward -200', messageOverrides),
    { DB: kv },
    config,
    harness.services
  );
  assert.deepEqual(lookups, ['-100', '-200']);
  assert.equal(kv.puts.length, 0);
  assert.match(harness.messages.at(-1).text, /target chat/);

  lookups.length = 0;
  await handleMessage(
    makeMessage('/forward_to -200', messageOverrides),
    { DB: kv },
    config,
    harness.services
  );
  assert.deepEqual(lookups, ['-100', '-200']);
  assert.equal(listCalls, 0);
  assert.match(harness.messages.at(-1).text, /target chat/);
});

test('social names allow common handle characters and reject unsafe shapes', async () => {
  const added = [];
  const harness = makeHarness({
    async addSubscription(env, subscription) {
      added.push(subscription);
      return true;
    }
  });
  const config = makeConfig({
    rssBaseUrl: 'https://rsshub.example',
    allowedFeedHosts: new Set(['rsshub.example'])
  });

  await handleMessage(
    makeMessage('/add x @user.name_test-1'),
    { DB: makeKv() },
    config,
    harness.services
  );
  assert.equal(added[0].channelName, 'user.name_test-1');

  await handleMessage(
    makeMessage('/add x two values'),
    { DB: makeKv() },
    config,
    harness.services
  );
  await handleMessage(
    makeMessage('/add youtube bad\u0001name'),
    { DB: makeKv() },
    config,
    harness.services
  );
  await handleMessage(
    makeMessage('/add x ' + 'a'.repeat(101)),
    { DB: makeKv() },
    config,
    harness.services
  );
  assert.equal(added.length, 1);
  assert.match(harness.messages.at(-3).text, /one value without whitespace/);
  assert.match(harness.messages.at(-2).text, /invalid characters/);
  assert.match(harness.messages.at(-1).text, /too long/);
});

test('forward copy selector paginates without consuming the session', async () => {
  const kv = makeKv();
  const copies = [];
  const subscriptions = Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    type: 'x',
    channelName: 'feed-' + (index + 1),
    rssUrl: 'https://rsshub.example/twitter/user/feed-' + (index + 1),
    chatId: '7',
    threadId: null
  }));
  const harness = makeHarness({
    randomUUID() {
      return 'copy_pages';
    },
    async listSubscriptions() {
      return subscriptions;
    },
    async copySubscriptions(env, selected, chatId, threadId) {
      copies.push({ selected, chatId, threadId });
      return selected.length;
    }
  });

  await handleMessage(
    makeMessage('/forward_to -200'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const firstCallbacks = harness.messages.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.deepEqual(
    firstCallbacks.filter((value) => /^fwd:copy_pages:\d+$/.test(value)),
    Array.from({ length: 8 }, (_, index) => 'fwd:copy_pages:' + index)
  );
  assert.equal(firstCallbacks.includes('fwd:copy_pages:P1'), true);

  const callbackBase = {
    from: { id: '7' },
    message: { chat: { id: '7', type: 'private' } }
  };
  await handleCallback(
    {
      ...callbackBase,
      id: 'copy-page-2',
      data: 'fwd:copy_pages:P1'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(kv.values.has('fwd_session:copy_pages'), true);
  assert.match(harness.answers.at(-1).text, /已翻页/);
  assert.match(harness.messages.at(-1).text, /第 2\/3 页/);
  const secondCallbacks = harness.messages.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.deepEqual(
    secondCallbacks.filter((value) => /^fwd:copy_pages:\d+$/.test(value)),
    Array.from({ length: 8 }, (_, index) => 'fwd:copy_pages:' + (index + 8))
  );

  const editsOnSecondPage = harness.edits.length;
  await handleCallback(
    {
      ...callbackBase,
      id: 'delayed-copy-from-page-1',
      data: 'fwd:copy_pages:0'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copies.length, 0);
  assert.equal(harness.edits.length, editsOnSecondPage);
  assert.match(
    harness.answers.at(-1).text,
    /按钮已不属于当前选择器页面/
  );

  await handleCallback(
    {
      ...callbackBase,
      id: 'copy-one',
      data: 'fwd:copy_pages:9'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(kv.values.has('fwd_session:copy_pages'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:copy_pages')).phase, 'complete');
  assert.deepEqual(copies, [{
    selected: [{
      type: 'x',
      channelName: 'feed-10',
      rssUrl: 'https://rsshub.example/twitter/user/feed-10'
    }],
    chatId: '-200',
    threadId: null
  }]);
});

test('group menu input binds ForceReply to its prompt message', async () => {
  const kv = makeKv();
  const added = [];
  const harness = makeHarness({
    randomUUID() {
      return 'group_input';
    },
    async addSubscription(env, subscription) {
      added.push(subscription);
      return true;
    }
  });
  const group = {
    chat: { id: '-100', type: 'supergroup' },
    from: { id: '7' }
  };

  await handleMessage(
    makeMessage('/menu', group),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'group-open-add',
      data: 'ui:group_input:a',
      from: { id: '7' },
      message: { chat: { id: '-100', type: 'supergroup' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'group-add-rss',
      data: 'ui:group_input:at:r',
      from: { id: '7' },
      message: { chat: { id: '-100', type: 'supergroup' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const prompt = harness.messages.at(-1);
  assert.equal(prompt.replyMarkup.force_reply, true);
  assert.equal(Object.hasOwn(prompt.replyMarkup, 'selective'), false);
  const inputKey = 'ui_input:-100:_:7';
  const input = JSON.parse(kv.values.get(inputKey));
  assert.equal(input.promptMessageId, '2');

  await handleMessage(
    makeMessage('https://feeds.example/no-reply.xml', group),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(added.length, 0);
  assert.equal(kv.values.has(inputKey), true);

  await handleMessage(
    makeMessage('https://feeds.example/replied.xml', {
      ...group,
      reply_to_message: { message_id: 2 }
    }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(added.length, 1);
  assert.equal(kv.values.has(inputKey), false);
});

test('adding an inherited target keeps the subscription inherited', async () => {
  const kv = makeKv();
  kv.values.set('forward_config:7', JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    onlyForward: false,
    isGlobal: true
  }));
  let initializeCalls = 0;
  const subscription = {
    id: 9,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '7',
    threadId: null
  };
  const harness = makeHarness({
    randomUUID() {
      return 'inherit_duplicate';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async getSubscriptionRouting() {
      return {
        subscriptionId: 9,
        independent: false,
        includeSource: true,
        targets: []
      };
    },
    async initializeSubscriptionRouting() {
      initializeCalls += 1;
      return { created: true, targetsAdded: 1 };
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'inherit_duplicate', 'fw');
  await clickPrivateUi(kv, harness, 'inherit_duplicate', 'fl:0');
  await clickPrivateUi(kv, harness, 'inherit_duplicate', 'f:9:0');
  await handleCallback(
    {
      id: 'inherit-add',
      data: 'ui:inherit_duplicate:fa:9',
      from: { id: '7' },
      message: { chat: { id: '7', type: 'private' } }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('-200'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(initializeCalls, 0);
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.equal(
    harness.messages.some((message) => /仍保持继承/.test(message.text)),
    true
  );
});

test('an inherited subscription can opt into source-only routing', async () => {
  const kv = makeKv();
  kv.values.set('forward_config:7', JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    onlyForward: true,
    isGlobal: true
  }));
  let independent = false;
  let storedSnapshot = null;
  let setIncludeSourceCalls = 0;
  const subscription = {
    id: 9,
    type: 'rss',
    channelName: 'feeds.example',
    rssUrl: 'https://feeds.example/rss',
    chatId: '7',
    threadId: null
  };
  const harness = makeHarness({
    randomUUID() {
      return 'source_only';
    },
    async listSubscriptions() {
      return [subscription];
    },
    async getSubscriptionRouting() {
      return {
        subscriptionId: 9,
        independent,
        includeSource: true,
        targets: []
      };
    },
    async initializeSubscriptionRouting(env, scope, snapshot) {
      independent = true;
      storedSnapshot = structuredClone(snapshot);
      return { created: true, targetsAdded: 0 };
    },
    async setSubscriptionIncludeSource() {
      setIncludeSourceCalls += 1;
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'source_only', 'fw');
  await clickPrivateUi(kv, harness, 'source_only', 'fl:0');
  const callbackBase = {
    from: { id: '7' },
    message: { chat: { id: '7', type: 'private' } }
  };
  await handleCallback(
    {
      ...callbackBase,
      id: 'show-routing',
      data: 'ui:source_only:f:9:0'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const routingCallbacks = harness.messages.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(routingCallbacks.includes('ui:source_only:fs:9'), true);

  await handleCallback(
    {
      ...callbackBase,
      id: 'source-only',
      data: 'ui:source_only:fs:9'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(storedSnapshot, { includeSource: true, targets: [] });
  assert.equal(
    harness.messages.some((message) => /仅投递到源会话/.test(message.text)),
    true
  );

  const editsAfterSourceOnly = harness.edits.length;
  await handleCallback(
    {
      ...callbackBase,
      id: 'delayed-enable-source',
      data: 'ui:source_only:fi:9:1'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(setIncludeSourceCalls, 0);
  assert.equal(harness.edits.length, editsAfterSourceOnly);
  assert.match(
    harness.answers.at(-1).text,
    /按钮已不属于当前页面/
  );
});

test('menu navigation and repeated /menu reuse one canonical bot message', async () => {
  const kv = makeKv();
  let sequence = 0;
  const harness = makeHarness({
    randomUUID() {
      sequence += 1;
      return 'single_panel_' + sequence;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 0);
  assert.equal(
    JSON.parse(kv.values.get('ui_session:single_panel_1')).panelMessageId,
    '1'
  );

  const callbackMessage = {
    message_id: 1,
    chat: { id: '7', type: 'private' }
  };
  await handleCallback(
    {
      id: 'open-add',
      data: 'ui:single_panel_1:a',
      from: { id: '7' },
      message: callbackMessage
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'back-home',
      data: 'ui:single_panel_1:h',
      from: { id: '7' },
      message: callbackMessage
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 2);
  assert.deepEqual(
    harness.edits.map((entry) => entry.messageId),
    ['1', '1']
  );

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 3);
  assert.equal(
    JSON.parse(kv.values.get('ui_session:single_panel_2')).panelMessageId,
    '1'
  );

  await handleCallback(
    {
      id: 'stale-panel',
      data: 'ui:single_panel_2:a',
      from: { id: '7' },
      message: {
        message_id: 99,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(harness.edits.length, 3);
  assert.match(harness.answers.at(-1).text, /菜单已失效/);
});

test('a retryable repeated /menu edit restores the prior live session', async () => {
  const kv = makeKv();
  const sessionIds = ['menu_before_failure', 'menu_failed_render'];
  let editCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return sessionIds.shift();
    },
    async editTelegramMessage() {
      editCalls += 1;
      if (editCalls === 1) {
        return {
          ok: false,
          status: 503,
          retryable: true,
          permanent: false,
          error: 'Telegram HTTP 503'
        };
      }
      return { ok: true, result: { message_id: 1 } };
    },
    logTelegramError() {}
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(harness.sends.length, 1);
  assert.equal(editCalls, 1);
  assert.equal(
    kv.values.get('ui_active:7:_:7'),
    'menu_before_failure'
  );
  assert.equal(kv.values.has('ui_session:menu_before_failure'), true);
  assert.equal(kv.values.has('ui_session:menu_failed_render'), false);

  await handleCallback(
    {
      id: 'prior-menu-still-live',
      data: 'ui:menu_before_failure:a',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(editCalls, 2);
  assert.match(harness.answers.at(-1).text, /已打开/);
});

test('a repeated /menu list failure leaves the prior live session untouched', async () => {
  const kv = makeKv();
  const sessionIds = ['menu_before_list_failure', 'unused_session'];
  let listCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return sessionIds.shift();
    },
    async listSubscriptions() {
      listCalls += 1;
      if (listCalls === 2) {
        throw new Error('D1 list failed');
      }
      return [];
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await assert.rejects(
    handleMessage(
      makeMessage('/menu'),
      { DB: kv },
      makeConfig(),
      harness.services
    ),
    /D1 list failed/
  );

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 0);
  assert.equal(
    kv.values.get('ui_active:7:_:7'),
    'menu_before_list_failure'
  );
  assert.equal(
    kv.values.has('ui_session:menu_before_list_failure'),
    true
  );
  assert.equal(kv.values.has('ui_session:unused_session'), false);
});

test('menu input uses one temporary prompt and cleans it after success', async () => {
  const kv = makeKv();
  const added = [];
  const harness = makeHarness({
    randomUUID() {
      return 'single_input';
    },
    async addSubscription(env, subscription) {
      added.push(subscription);
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'single_input', 'a');
  await handleCallback(
    {
      id: 'start-input',
      data: 'ui:single_input:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(harness.sends.length, 2);
  assert.equal(harness.edits.length, 2);
  assert.equal(harness.sends[1].replyMarkup.force_reply, true);

  await handleMessage(
    makeMessage('not-a-url', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.edits.length, 3);
  assert.match(harness.edits.at(-1).text, /Invalid feed/);
  assert.equal(harness.messageDeletes.length, 0);

  await handleMessage(
    makeMessage('https://feeds.example/feed.xml', { message_id: 4 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(added.length, 1);
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.edits.length, 4);
  assert.match(harness.edits.at(-1).text, /Added rss subscription/);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['2', '4']
  );
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
});

test('ForceReply API failure restores the panel without another prompt', async () => {
  const kv = makeKv();
  let sendCalls = 0;
  const logs = [];
  const harness = makeHarness({
    randomUUID() {
      return 'prompt_api_failure';
    },
    async sendTelegramMessage() {
      sendCalls += 1;
      if (sendCalls === 2) {
        return {
          ok: false,
          status: 503,
          retryable: true,
          permanent: false,
          retryAfterSeconds: 0,
          error: 'Telegram HTTP 503'
        };
      }
      return { ok: true, result: { message_id: 1 } };
    },
    logTelegramError(details) {
      logs.push(details);
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'prompt_api_failure', 'a');
  await handleCallback(
    {
      id: 'prompt-api-failure',
      data: 'ui:prompt_api_failure:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(sendCalls, 2);
  assert.equal(harness.edits.length, 3);
  assert.match(harness.edits.at(-1).text, /无法启动输入/);
  assert.match(harness.edits.at(-1).text, /RSS 订阅管理/);
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].operation, 'sendMessage');
});

test('thrown ForceReply failure is rethrown after restoring the panel', async () => {
  const kv = makeKv();
  const sendError = new Error('prompt send failed');
  let sendCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'prompt_throw';
    },
    async sendTelegramMessage() {
      sendCalls += 1;
      if (sendCalls === 2) {
        throw sendError;
      }
      return { ok: true, result: { message_id: 1 } };
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'prompt_throw', 'a');
  let caught;
  try {
    await handleCallback(
      {
        id: 'prompt-throw',
        data: 'ui:prompt_throw:at:r',
        from: { id: '7' },
        message: {
          message_id: 1,
          chat: { id: '7', type: 'private' }
        }
      },
      { DB: kv },
      makeConfig(),
      harness.services
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, sendError);
  assert.equal(sendCalls, 2);
  assert.equal(harness.edits.length, 3);
  assert.match(harness.edits.at(-1).text, /无法启动输入/);
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
});

test('input-state persistence failure deletes the prompt and preserves the error', async () => {
  const kv = makeKv();
  const persistenceError = new Error('input state put failed');
  const put = kv.put.bind(kv);
  kv.put = async (key, value, options) => {
    if (key === 'ui_input:7:_:7') {
      throw persistenceError;
    }
    return put(key, value, options);
  };
  const harness = makeHarness({
    randomUUID() {
      return 'input_put_failure';
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'input_put_failure', 'a');
  let caught;
  try {
    await handleCallback(
      {
        id: 'input-put-failure',
        data: 'ui:input_put_failure:at:r',
        from: { id: '7' },
        message: {
          message_id: 1,
          chat: { id: '7', type: 'private' }
        }
      },
      { DB: kv },
      makeConfig(),
      harness.services
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, persistenceError);
  assert.equal(harness.sends.length, 2);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['2']
  );
  assert.equal(harness.edits.length, 2);
  assert.match(harness.edits.at(-1).text, /添加 RSS 订阅/);
  assert.doesNotMatch(harness.edits.at(-1).text, /无法启动输入/);
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
});

test('missing panels are recreated once while retryable edit failures do not duplicate', async () => {
  const missingKv = makeKv();
  let missingEdits = 0;
  const missingHarness = makeHarness({
    randomUUID() {
      return 'missing_panel';
    },
    async editTelegramMessage() {
      missingEdits += 1;
      return {
        ok: false,
        status: 400,
        retryable: false,
        permanent: true,
        apiDescription: 'Bad Request: message to edit not found',
        error: 'Telegram HTTP 400'
      };
    },
    logTelegramError() {}
  });
  await handleMessage(
    makeMessage('/menu'),
    { DB: missingKv },
    makeConfig(),
    missingHarness.services
  );
  await handleCallback(
    {
      id: 'missing-edit',
      data: 'ui:missing_panel:a',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: missingKv },
    makeConfig(),
    missingHarness.services
  );
  assert.equal(missingEdits, 1);
  assert.equal(missingHarness.sends.length, 2);
  assert.equal(
    JSON.parse(missingKv.values.get('ui_session:missing_panel')).panelMessageId,
    '2'
  );

  const retryKv = makeKv();
  let retryEdits = 0;
  const retryHarness = makeHarness({
    randomUUID() {
      return 'retry_panel';
    },
    async editTelegramMessage() {
      retryEdits += 1;
      return {
        ok: false,
        status: 503,
        retryable: true,
        permanent: false,
        error: 'Telegram HTTP 503'
      };
    },
    logTelegramError() {}
  });
  await handleMessage(
    makeMessage('/menu'),
    { DB: retryKv },
    makeConfig(),
    retryHarness.services
  );
  await handleCallback(
    {
      id: 'retry-edit',
      data: 'ui:retry_panel:a',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: retryKv },
    makeConfig(),
    retryHarness.services
  );
  assert.equal(retryEdits, 1);
  assert.equal(retryHarness.sends.length, 1);
});

test('forward selector pagination and completion edit the original message', async () => {
  const kv = makeKv();
  const subscriptions = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    type: 'rss',
    channelName: 'feed-' + (index + 1),
    rssUrl: 'https://feeds.example/' + (index + 1),
    chatId: '7',
    threadId: null
  }));
  const harness = makeHarness({
    randomUUID() {
      return 'single_copy';
    },
    async listSubscriptions() {
      return subscriptions;
    },
    async copySubscriptions() {
      return 1;
    }
  });
  await handleMessage(
    makeMessage('/forward_to -200'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const callbackBase = {
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };
  await handleCallback(
    { ...callbackBase, id: 'copy-next', data: 'fwd:single_copy:P1' },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    { ...callbackBase, id: 'copy-finish', data: 'fwd:single_copy:8' },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 2);
  assert.deepEqual(
    harness.edits.map((entry) => entry.messageId),
    ['1', '1']
  );
  assert.deepEqual(harness.edits.at(-1).replyMarkup, { inline_keyboard: [] });
  assert.equal(kv.values.has('fwd_session:single_copy'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:single_copy')).phase, 'complete');
});

test('a fresh /menu reuses the panel after the prior UI session expires', async () => {
  const kv = makeKv();
  let sequence = 0;
  const harness = makeHarness({
    randomUUID() {
      sequence += 1;
      return 'remembered_panel_' + sequence;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.get('ui_panel:7:_:7'), '1');

  kv.values.delete('ui_session:remembered_panel_1');
  kv.values.delete('ui_active:7:_:7');
  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 1);
  assert.equal(harness.edits[0].messageId, '1');
  assert.equal(
    JSON.parse(kv.values.get('ui_session:remembered_panel_2')).panelMessageId,
    '1'
  );
});

test('invalid remembered panel IDs are overwritten without a second KV mutation', async () => {
  const kv = makeKv();
  kv.values.set('ui_panel:7:_:7', 'unsafe-message-id');
  const harness = makeHarness({
    randomUUID() {
      return 'replace_invalid_panel';
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 0);
  assert.equal(kv.values.get('ui_panel:7:_:7'), '1');
  assert.equal(kv.deletes.includes('ui_panel:7:_:7'), false);
});

test('expired input metadata remains available for prompt cleanup', async () => {
  const kv = makeKv();
  let added = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'cleanup_input';
    },
    async addSubscription() {
      added += 1;
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'cleanup_input', 'a');
  const callback = {
    id: 'begin-cleanup-input',
    data: 'ui:cleanup_input:at:r',
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };
  await handleCallback(
    callback,
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const inputKey = 'ui_input:7:_:7';
  const inputPut = kv.puts.find((entry) => entry.key === inputKey);
  const input = JSON.parse(kv.values.get(inputKey));
  assert.equal(input.expiresAt - input.createdAt, 10 * 60);
  assert.deepEqual(inputPut.options, { expirationTtl: 47 * 60 * 60 });

  kv.values.set(inputKey, JSON.stringify({ ...input, expiresAt: 1 }));
  await handleMessage(
    makeMessage('late unrelated text', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(added, 0);
  assert.equal(kv.values.has(inputKey), false);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['2']
  );

  await clickPrivateUi(
    kv,
    harness,
    'cleanup_input',
    'ic:' + input.cancelNonce
  );
  await clickPrivateUi(kv, harness, 'cleanup_input', 'a');
  await handleCallback(
    { ...callback, id: 'begin-cleanup-input-again' },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const secondInput = JSON.parse(kv.values.get(inputKey));
  assert.equal(secondInput.promptMessageId, '3');
  const secondCancelData =
    'ui:cleanup_input:ic:' + secondInput.cancelNonce;
  kv.values.delete('ui_session:cleanup_input');
  kv.values.delete('ui_active:7:_:7');
  await handleCallback(
    {
      id: 'cancel-expired-input',
      data: secondCancelData,
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['2', '3']
  );
  assert.equal(kv.values.has(inputKey), false);
});

test('a menu-owned selector cannot overwrite a newer /menu session', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  kv.values.set('ui_panel:7:_:7', '1');
  kv.values.set('ui_active:7:_:7', 'old_menu');
  kv.values.set('ui_session:old_menu', JSON.stringify({
    v: 1,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    panelMessageId: '1',
    createdAt: now,
    expiresAt: now + 3600
  }));
  kv.values.set('fwd_session:old_copy', JSON.stringify({
    v: 2,
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    menuSessionId: 'old_menu',
    selectorMessageId: '1',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: now + 3600
  }));
  let copyCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'new_menu';
    },
    async copySubscriptions() {
      copyCalls += 1;
      return 1;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.get('ui_active:7:_:7'), 'new_menu');
  assert.equal(harness.edits.length, 1);

  await handleCallback(
    {
      id: 'stale-copy',
      data: 'fwd:old_copy:ALL',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(copyCalls, 0);
  assert.equal(harness.edits.length, 1);
  assert.equal(kv.values.has('fwd_session:old_copy'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:old_copy')).phase, 'stale');
  assert.equal(kv.values.get('ui_active:7:_:7'), 'new_menu');
  assert.match(harness.answers.at(-1).text, /失效/);
});
test('an initializing copy selector cannot be claimed by an early callback', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  kv.values.set('fwd_session:initializing_copy', JSON.stringify({
    v: 2,
    sessionId: 'initializing_copy',
    phase: 'initializing',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    menuSessionId: null,
    selectorMessageId: '1',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: now + 3600
  }));
  let copyCalls = 0;
  const harness = makeHarness({
    async copySubscriptions() {
      copyCalls += 1;
      return 1;
    }
  });

  await handleCallback(
    {
      id: 'early-selector-click',
      data: 'fwd:initializing_copy:ALL',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(copyCalls, 0);
  assert.equal(harness.edits.length, 0);
  assert.equal(
    JSON.parse(kv.values.get('fwd_session:initializing_copy')).phase,
    'initializing'
  );
  assert.match(harness.answers.at(-1).text, /正在打开/);
});


test('a D1 CAS claim prevents page callbacks from racing selector completion', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  const subscriptions = Array.from({ length: 10 }, (_, index) => ({
    type: 'rss',
    channelName: 'feed-' + (index + 1),
    rssUrl: 'https://feeds.example/' + (index + 1)
  }));
  kv.values.set('fwd_session:leased_copy', JSON.stringify({
    v: 2,
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    menuSessionId: null,
    selectorMessageId: '1',
    subMap: subscriptions,
    expiresAt: now + 3600
  }));

  let leaseHeld = false;
  let copyCalls = 0;
  let signalCopyStarted;
  let releaseCopy;
  const copyStarted = new Promise((resolve) => {
    signalCopyStarted = resolve;
  });
  const copyGate = new Promise((resolve) => {
    releaseCopy = resolve;
  });
  const harness = makeHarness({
    async acquireOperationalLease() {
      if (leaseHeld) {
        return false;
      }
      leaseHeld = true;
      return true;
    },
    async releaseOperationalLease() {
      leaseHeld = false;
      return true;
    },
    async copySubscriptions() {
      copyCalls += 1;
      signalCopyStarted();
      await copyGate;
      return 1;
    }
  });
  const callbackBase = {
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };

  const completion = handleCallback(
    { ...callbackBase, id: 'leased-complete', data: 'fwd:leased_copy:ALL' },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await copyStarted;
  assert.equal(
    JSON.parse(kv.values.get('fwd_session:leased_copy')).phase,
    'processing'
  );

  await handleCallback(
    { ...callbackBase, id: 'leased-page', data: 'fwd:leased_copy:P1' },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(harness.edits.length, 0);
  assert.match(harness.answers.at(-1).text, /正在处理/);

  releaseCopy();
  await completion;
  assert.equal(copyCalls, 1);
  assert.equal(leaseHeld, false);
  assert.equal(kv.values.has('fwd_session:leased_copy'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:leased_copy')).phase, 'complete');
  assert.equal(harness.edits.length, 1);
  assert.match(harness.edits[0].text, /Successfully copied 1/);
  assert.deepEqual(harness.edits[0].replyMarkup, { inline_keyboard: [] });
});

test('an expired forward claim fences the older worker from editing', async () => {
  const kv = makeKv();
  kv.values.set('fwd_session:fenced_copy', JSON.stringify({
    v: 2,
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    menuSessionId: null,
    selectorMessageId: '1',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  }));

  let copyCalls = 0;
  let signalFirstCopy;
  let releaseFirstCopy;
  const firstCopyStarted = new Promise((resolve) => {
    signalFirstCopy = resolve;
  });
  const firstCopyGate = new Promise((resolve) => {
    releaseFirstCopy = resolve;
  });
  const harness = makeHarness({
    async copySubscriptions() {
      copyCalls += 1;
      if (copyCalls === 1) {
        signalFirstCopy();
        await firstCopyGate;
        return 1;
      }
      return 0;
    }
  });
  const callbackBase = {
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };

  const olderWorker = handleCallback(
    {
      ...callbackBase,
      id: 'older-worker',
      data: 'fwd:fenced_copy:ALL'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await firstCopyStarted;
  const expiredClaim = JSON.parse(kv.values.get('fwd_session:fenced_copy'));
  kv.values.set('fwd_session:fenced_copy', JSON.stringify({
    ...expiredClaim,
    claimExpiresAt: 0
  }));

  await handleCallback(
    {
      ...callbackBase,
      id: 'newer-worker',
      data: 'fwd:fenced_copy:ALL'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  releaseFirstCopy();
  await olderWorker;

  assert.equal(copyCalls, 2);
  assert.equal(
    JSON.parse(kv.values.get('fwd_session:fenced_copy')).phase,
    'complete'
  );
  assert.equal(harness.edits.length, 1);
  assert.match(harness.edits[0].text, /already exist/);
  assert.match(harness.answers.at(-1).text, /另一个请求/);
});

test('an expired cancel button cannot remove a newer input session', async () => {
  const kv = makeKv();
  let sequence = 0;
  const harness = makeHarness({
    randomUUID() {
      sequence += 1;
      return 'cancel_scope_' + sequence;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'cancel_scope_2', 'a');
  await handleCallback(
    {
      id: 'new-input',
      data: 'ui:cancel_scope_2:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const inputKey = 'ui_input:7:_:7';
  assert.equal(
    JSON.parse(kv.values.get(inputKey)).menuSessionId,
    'cancel_scope_2'
  );

  await handleCallback(
    {
      id: 'old-cancel',
      data: 'ui:cancel_scope_1:ic:old_-abc',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(
    JSON.parse(kv.values.get(inputKey)).menuSessionId,
    'cancel_scope_2'
  );
  assert.equal(harness.messageDeletes.length, 0);
  assert.match(harness.answers.at(-1).text, /菜单已过期/);
});

test('retryable prompt deletion keeps cleanup metadata for the next interaction', async () => {
  const kv = makeKv();
  let sequence = 0;
  let retryDeletes = true;
  const deleteCalls = [];
  const harness = makeHarness({
    randomUUID() {
      sequence += 1;
      return 'retry_cleanup_' + sequence;
    },
    async addSubscription() {
      return true;
    },
    async deleteTelegramMessage(token, chatId, messageId) {
      deleteCalls.push(String(messageId));
      return retryDeletes
        ? {
            ok: false,
            status: 503,
            retryable: true,
            permanent: false,
            error: 'Telegram HTTP 503'
          }
        : { ok: true, result: true };
    },
    logTelegramError() {}
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'retry_cleanup_1', 'a');
  await handleCallback(
    {
      id: 'retry-cleanup-input',
      data: 'ui:retry_cleanup_1:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('https://feeds.example/retry.xml', { message_id: 4 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const cleanupKey = 'ui_input_cleanup:7:_:7';
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.deepEqual(deleteCalls, ['2', '4']);
  assert.deepEqual(
    JSON.parse(kv.values.get(cleanupKey)).entries.map((entry) => entry.messageId),
    ['2', '4']
  );
  const cleanupPut = kv.puts.find((entry) => entry.key === cleanupKey);
  assert.deepEqual(cleanupPut.options, { expirationTtl: 47 * 60 * 60 });

  const pendingCleanup = JSON.parse(kv.values.get(cleanupKey));
  kv.values.set(cleanupKey, JSON.stringify({
    ...pendingCleanup,
    updatedAt: 1
  }));
  retryDeletes = false;
  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(deleteCalls, ['2', '4', '2', '4']);
  assert.equal(kv.values.has(cleanupKey), false);
});

test('a delayed menu copy result cannot overwrite a newly opened menu', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  kv.values.set('ui_panel:7:_:7', '1');
  kv.values.set('ui_active:7:_:7', 'copy_old_menu');
  kv.values.set('ui_session:copy_old_menu', JSON.stringify({
    v: 1,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    panelMessageId: '1',
    renderFingerprint: 'copy_in_flight_view',
    forwardSessionId: 'copy_in_flight',
    createdAt: now,
    expiresAt: now + 3600
  }));
  kv.values.set('fwd_session:copy_in_flight', JSON.stringify({
    v: 2,
    sessionId: 'copy_in_flight',
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    menuSessionId: 'copy_old_menu',
    selectorMessageId: '1',
    selectorFingerprint: 'copy_in_flight_view',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: now + 3600
  }));

  let signalCopyStarted;
  let releaseCopy;
  const copyStarted = new Promise((resolve) => {
    signalCopyStarted = resolve;
  });
  const copyGate = new Promise((resolve) => {
    releaseCopy = resolve;
  });
  const generatedIds = ['copy_new_menu'];
  const harness = makeHarness({
    randomUUID() {
      return generatedIds.shift();
    },
    async copySubscriptions() {
      signalCopyStarted();
      await copyGate;
      return 1;
    }
  });
  const callback = {
    id: 'copy-before-menu',
    data: 'fwd:copy_in_flight:ALL',
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };

  const completion = handleCallback(
    callback,
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await copyStarted;

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.get('ui_active:7:_:7'), 'copy_new_menu');
  assert.equal(harness.edits.length, 1);
  assert.match(harness.edits[0].text, /RSS 订阅管理/);

  releaseCopy();
  await completion;
  assert.equal(harness.edits.length, 1);
  assert.match(harness.edits.at(-1).text, /RSS 订阅管理/);
  assert.equal(kv.values.has('fwd_session:copy_in_flight'), true);
  assert.equal(JSON.parse(kv.values.get('fwd_session:copy_in_flight')).phase, 'complete');
  assert.match(harness.answers.at(-1).text, /最新菜单保持不变/);
});

test('expired forward sessions are deleted instead of being revived', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  kv.values.set('fwd_session:expired_copy', JSON.stringify({
    v: 2,
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    selectorMessageId: '1',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: now - 1
  }));
  let copyCalls = 0;
  const harness = makeHarness({
    async copySubscriptions() {
      copyCalls += 1;
      return 1;
    }
  });

  await handleCallback(
    {
      id: 'expired-copy',
      data: 'fwd:expired_copy:ALL',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(copyCalls, 0);
  assert.equal(kv.values.has('fwd_session:expired_copy'), false);
  assert.match(harness.answers.at(-1).text, /expired|invalid/);
});

test('a thrown forward copy releases its claim for a safe retry', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  kv.values.set('fwd_session:retry_copy', JSON.stringify({
    v: 2,
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    selectorMessageId: '1',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: now + 3600
  }));
  let copyCalls = 0;
  let failCopy = true;
  const harness = makeHarness({
    async copySubscriptions() {
      copyCalls += 1;
      if (failCopy) {
        throw new Error('copy failed');
      }
      return 1;
    }
  });
  const callback = {
    data: 'fwd:retry_copy:ALL',
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };

  await assert.rejects(
    handleCallback(
      { ...callback, id: 'failed-copy' },
      { DB: kv },
      makeConfig(),
      harness.services
    ),
    /copy failed/
  );
  const reopened = JSON.parse(kv.values.get('fwd_session:retry_copy'));
  assert.equal(reopened.phase, 'open');
  assert.equal(reopened.claimToken, null);

  failCopy = false;
  await handleCallback(
    { ...callback, id: 'retried-copy' },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copyCalls, 2);
  assert.equal(
    JSON.parse(kv.values.get('fwd_session:retry_copy')).phase,
    'complete'
  );
});

test('a completed forward copy can refresh after a retryable edit failure', async () => {
  const kv = makeKv();
  const now = Math.floor(Date.now() / 1000);
  kv.values.set('fwd_session:refresh_complete', JSON.stringify({
    v: 2,
    phase: 'open',
    targetChatId: '-200',
    targetThreadId: null,
    sourceChatId: '7',
    sourceThreadId: null,
    initiatorUserId: '7',
    selectorMessageId: '1',
    subMap: [{
      type: 'rss',
      channelName: 'feed',
      rssUrl: 'https://feeds.example/feed.xml'
    }],
    expiresAt: now + 3600
  }));
  let copyCalls = 0;
  let editCalls = 0;
  const harness = makeHarness({
    async copySubscriptions() {
      copyCalls += 1;
      return 1;
    },
    async editTelegramMessage() {
      editCalls += 1;
      if (editCalls === 1) {
        return {
          ok: false,
          status: 503,
          retryable: true,
          permanent: false,
          error: 'Telegram HTTP 503'
        };
      }
      return { ok: true, result: { message_id: 1 } };
    },
    logTelegramError() {}
  });
  const callback = {
    data: 'fwd:refresh_complete:ALL',
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };

  await handleCallback(
    { ...callback, id: 'complete-edit-failed' },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copyCalls, 1);
  assert.equal(
    JSON.parse(kv.values.get('fwd_session:refresh_complete')).phase,
    'complete'
  );
  assert.match(harness.answers.at(-1).text, /面板更新失败/);

  await handleCallback(
    { ...callback, id: 'complete-edit-retry' },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copyCalls, 1);
  assert.equal(editCalls, 2);
  assert.match(harness.answers.at(-1).text, /Forwarded 1/);
});

test('a first panel whose D1 binding fails is deleted before retry', async () => {
  const kv = makeKv();
  const sessionIds = ['binding_failure_1', 'binding_failure_2'];
  const harness = makeHarness({
    randomUUID() {
      return sessionIds.shift();
    }
  });
  const baseApply = harness.services.applyOperationalStateChanges.bind(
    harness.services
  );
  let failPanelBinding = true;
  harness.services.applyOperationalStateChanges = async (env, changes) => {
    const persistsNewPanel = changes.some((change) =>
      change.name.startsWith('ui_session:') &&
      change.expectedValue !== undefined &&
      /panelMessageId/.test(String(change.value ?? ''))
    );
    if (failPanelBinding && persistsNewPanel) {
      failPanelBinding = false;
      throw new Error('D1 panel binding failed');
    }
    return baseApply(env, changes);
  };

  await assert.rejects(
    handleMessage(
      makeMessage('/menu'),
      { DB: kv },
      makeConfig(),
      harness.services
    ),
    /D1 panel binding failed/
  );
  assert.equal(harness.sends.length, 1);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['1']
  );
  assert.equal(kv.values.has('ui_panel:7:_:7'), false);

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(harness.sends.length, 2);
  assert.equal(kv.values.get('ui_panel:7:_:7'), '2');
  assert.equal(kv.values.get('ui_active:7:_:7'), 'binding_failure_2');
});

test('an active D1 panel wins over a stale KV pointer', async () => {
  const kv = makeKv();
  const originalPut = kv.put.bind(kv);
  let failPanelPointerWrite = false;
  kv.put = async (key, value, options) => {
    if (failPanelPointerWrite && key === 'ui_panel:7:_:7') {
      throw new Error('KV pointer write failed');
    }
    return originalPut(key, value, options);
  };
  const editMessageIds = [];
  const sessionIds = ['pointer_session_1', 'pointer_session_2'];
  let editCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return sessionIds.shift();
    },
    async editTelegramMessage(token, chatId, messageId) {
      editCalls += 1;
      editMessageIds.push(String(messageId));
      if (editCalls === 1) {
        return {
          ok: false,
          status: 400,
          retryable: false,
          permanent: true,
          apiDescription: 'Bad Request: message to edit not found',
          error: 'Telegram HTTP 400'
        };
      }
      return { ok: true, result: { message_id: Number(messageId) } };
    },
    logTelegramError() {}
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.get('ui_panel:7:_:7'), '1');

  failPanelPointerWrite = true;
  await handleCallback(
    {
      id: 'recreate-panel',
      data: 'ui:pointer_session_1:a',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(harness.sends.length, 2);
  assert.equal(kv.values.get('ui_panel:7:_:7'), '1');
  assert.equal(
    JSON.parse(kv.values.get('ui_session:pointer_session_1')).panelMessageId,
    '2'
  );

  failPanelPointerWrite = false;
  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.deepEqual(editMessageIds, ['1', '2']);
  assert.equal(harness.sends.length, 2);
  assert.equal(kv.values.get('ui_panel:7:_:7'), '2');
});

test('D1 input CAS lets only one concurrent text update mutate state', async () => {
  const kv = makeKv();
  let addCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'input_cas';
    },
    async addSubscription() {
      addCalls += 1;
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'input_cas', 'a');
  await handleCallback(
    {
      id: 'open-input-cas',
      data: 'ui:input_cas:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const inputKey = 'ui_input:7:_:7';
  let inputReads = 0;
  let releaseInputReads;
  const bothInputReads = new Promise((resolve) => {
    releaseInputReads = resolve;
  });
  harness.services.readOperationalState = async (env, name) => {
    const value = kv.values.has(name) ? kv.values.get(name) : null;
    if (name === inputKey && inputReads < 2) {
      inputReads += 1;
      if (inputReads === 2) {
        releaseInputReads();
      }
      await bothInputReads;
    }
    return value;
  };
  harness.services.applyOperationalStateChanges = async (env, changes) => {
    let changed = 0;
    for (const change of changes) {
      const current = kv.values.has(change.name)
        ? kv.values.get(change.name)
        : null;
      if (
        change.expectedValue !== null &&
        change.expectedValue !== undefined &&
        String(current ?? '') !== String(change.expectedValue)
      ) {
        continue;
      }
      if (change.delete === true) {
        if (current !== null) {
          kv.values.delete(change.name);
          changed += 1;
        }
      } else {
        kv.values.set(change.name, String(change.value));
        changed += 1;
      }
    }
    return changed;
  };

  await Promise.all([
    handleMessage(
      makeMessage('https://feeds.example/one.xml', { message_id: 3 }),
      { DB: kv },
      makeConfig(),
      harness.services
    ),
    handleMessage(
      makeMessage('https://feeds.example/two.xml', { message_id: 4 }),
      { DB: kv },
      makeConfig(),
      harness.services
    )
  ]);

  assert.equal(addCalls, 1);
  assert.equal(kv.values.has(inputKey), false);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId).sort(),
    ['2', '3', '4']
  );
});

test('an expired UI input claim is taken over instead of swallowing the reply', async () => {
  const kv = makeKv();
  let addCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'input_takeover';
    },
    async addSubscription() {
      addCalls += 1;
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'input_takeover', 'a');
  await handleCallback(
    {
      id: 'open-input-takeover',
      data: 'ui:input_takeover:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const inputKey = 'ui_input:7:_:7';
  const abandoned = JSON.parse(kv.values.get(inputKey));
  kv.values.set(inputKey, JSON.stringify({
    ...abandoned,
    phase: 'processing',
    revision: 'abandoned_revision',
    claimToken: 'abandoned_claim',
    claimExpiresAt: Math.floor(Date.now() / 1000) - 1
  }));

  await handleMessage(
    makeMessage('https://feeds.example/recovered.xml', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(addCalls, 1);
  assert.equal(kv.values.has(inputKey), false);
  assert.match(harness.edits.at(-1).text, /Added rss subscription/);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId).sort(),
    ['2', '3']
  );
});
test('a late UI reply extends its lifetime across claim recovery', async () => {
  const kv = makeKv();
  const inputKey = 'ui_input:7:_:7';
  const now = Math.floor(Date.now() / 1000);
  let addCalls = 0;
  let firstClaimExpiresAt = 0;
  let failFirstAttempt = true;
  const harness = makeHarness({
    randomUUID() {
      return 'late_input_takeover';
    },
    async addSubscription() {
      addCalls += 1;
      firstClaimExpiresAt ||= Number(
        JSON.parse(kv.values.get(inputKey)).expiresAt
      );
      if (failFirstAttempt) {
        throw new Error('simulated worker interruption');
      }
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'late_input_takeover', 'a');
  const menuSessionKey = 'ui_session:late_input_takeover';
  const nearExpiryMenu = JSON.parse(kv.values.get(menuSessionKey));
  kv.values.set(menuSessionKey, JSON.stringify({
    ...nearExpiryMenu,
    expiresAt: now + 30
  }));
  await handleCallback(
    {
      id: 'open-late-input',
      data: 'ui:late_input_takeover:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const extendedMenu = JSON.parse(kv.values.get(menuSessionKey));
  assert.ok(extendedMenu.expiresAt >= now + 9 * 60);
  const extendedActivePut = kv.puts
    .filter((entry) => entry.key === 'ui_active:7:_:7')
    .at(-1);
  assert.ok(
    extendedActivePut.options.expirationTtl >= 9 * 60
  );

  const lateInput = JSON.parse(kv.values.get(inputKey));
  kv.values.set(inputKey, JSON.stringify({
    ...lateInput,
    expiresAt: now + 1
  }));
  await assert.rejects(
    handleMessage(
      makeMessage('https://feeds.example/late.xml', { message_id: 3 }),
      { DB: kv },
      makeConfig(),
      harness.services
    ),
    /simulated worker interruption/
  );

  const recovered = JSON.parse(kv.values.get(inputKey));
  assert.equal(recovered.phase, 'open');
  assert.ok(firstClaimExpiresAt >= now + 9 * 60);
  assert.equal(recovered.expiresAt, firstClaimExpiresAt);

  kv.values.set(inputKey, JSON.stringify({
    ...recovered,
    phase: 'processing',
    revision: 'interrupted_revision',
    claimToken: 'interrupted_claim',
    claimExpiresAt: now - 1
  }));
  failFirstAttempt = false;
  await handleMessage(
    makeMessage('https://feeds.example/late.xml', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(addCalls, 2);
  assert.equal(kv.values.has(inputKey), false);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId).sort(),
    ['2', '3']
  );
});


test('/cancel cannot report success while an input mutation holds the panel lock', async () => {
  const kv = makeKv();
  let panelLeaseHeld = false;
  let addCalls = 0;
  let signalAddStarted;
  let releaseAdd;
  const addStarted = new Promise((resolve) => {
    signalAddStarted = resolve;
  });
  const addGate = new Promise((resolve) => {
    releaseAdd = resolve;
  });
  const harness = makeHarness({
    randomUUID() {
      return 'cancel_locked_input';
    },
    async acquireOperationalLease() {
      if (panelLeaseHeld) {
        return false;
      }
      panelLeaseHeld = true;
      return true;
    },
    async releaseOperationalLease() {
      panelLeaseHeld = false;
      return true;
    },
    async addSubscription() {
      addCalls += 1;
      signalAddStarted();
      await addGate;
      return true;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'cancel_locked_input', 'a');
  await handleCallback(
    {
      id: 'open-cancel-lock-input',
      data: 'ui:cancel_locked_input:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const inputUpdate = handleMessage(
    makeMessage('https://feeds.example/locked.xml', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await addStarted;
  await assert.rejects(
    handleMessage(
      makeMessage('/cancel', { message_id: 4 }),
      { DB: kv },
      makeConfig(),
      harness.services
    ),
    /UI panel is busy/
  );
  assert.equal(addCalls, 1);

  releaseAdd();
  await inputUpdate;
  await handleMessage(
    makeMessage('/cancel', { message_id: 4 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.equal(
    harness.messageDeletes.some((entry) => entry.messageId === '4'),
    true
  );
});

test('menu copy input, pagination, and completion stay on one panel', async () => {
  const kv = makeKv();
  const subscriptions = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    type: 'rss',
    channelName: 'feed-' + (index + 1),
    rssUrl: 'https://feeds.example/' + (index + 1),
    chatId: '7',
    threadId: null
  }));
  const sessionIds = ['copy_flow_menu', 'copy_flow_selector'];
  let copyCalls = 0;
  const harness = makeHarness({
    randomUUID() {
      return sessionIds.shift();
    },
    async listSubscriptions() {
      return subscriptions;
    },
    async copySubscriptions() {
      copyCalls += 1;
      return subscriptions.length;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'open-copy-input',
      data: 'ui:copy_flow_menu:cp',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('-200', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  const selectorCallback = {
    from: { id: '7' },
    message: {
      message_id: 1,
      chat: { id: '7', type: 'private' }
    }
  };
  await handleCallback(
    {
      ...selectorCallback,
      id: 'copy-flow-next',
      data: 'fwd:copy_flow_selector:P1'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      ...selectorCallback,
      id: 'copy-flow-complete',
      data: 'fwd:copy_flow_selector:ALL'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(copyCalls, 1);
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.edits.length, 4);
  assert.deepEqual(
    harness.edits.map((entry) => entry.messageId),
    ['1', '1', '1', '1']
  );
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId).sort(),
    ['2', '3']
  );
  assert.equal(
    kv.puts.filter((entry) => entry.key === 'ui_panel:7:_:7').length,
    1
  );
  assert.equal(
    JSON.parse(kv.values.get('fwd_session:copy_flow_selector')).phase,
    'complete'
  );
  await handleCallback(
    {
      ...selectorCallback,
      id: 'copy-flow-home',
      data: 'ui:copy_flow_menu:h'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const editsAfterHome = harness.edits.length;
  assert.equal(editsAfterHome, 5);
  assert.match(harness.edits.at(-1).text, /RSS 订阅管理/);
  assert.equal(
    Object.hasOwn(
      JSON.parse(kv.values.get('ui_session:copy_flow_menu')),
      'forwardSessionId'
    ),
    false
  );

  await handleCallback(
    {
      ...selectorCallback,
      id: 'copy-flow-delayed-completion',
      data: 'fwd:copy_flow_selector:ALL'
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  assert.equal(copyCalls, 1);
  assert.equal(harness.edits.length, editsAfterHome);
  assert.match(harness.answers.at(-1).text, /最新菜单保持不变/);
});

test('an expired copy initializer cannot overwrite a newer selector', async () => {
  const kv = makeKv();
  const subscriptions = [{
    id: 1,
    type: 'rss',
    channelName: 'feed',
    rssUrl: 'https://feeds.example/feed.xml',
    chatId: '7',
    threadId: null
  }];
  const sessionIds = [
    'selector_race_menu',
    'selector_new',
    'selector_old'
  ];
  let leaseOwner = null;
  let expireCurrentLease = false;
  let blockNextList = false;
  let signalOldListStarted;
  let releaseOldList;
  const oldListStarted = new Promise((resolve) => {
    signalOldListStarted = resolve;
  });
  const oldListGate = new Promise((resolve) => {
    releaseOldList = resolve;
  });
  const rejectedRenewals = [];
  const harness = makeHarness({
    randomUUID() {
      return sessionIds.shift();
    },
    async acquireOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === null || expireCurrentLease) {
        leaseOwner = leaseToken;
        expireCurrentLease = false;
        return true;
      }
      return false;
    },
    async renewOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === leaseToken) {
        return true;
      }
      rejectedRenewals.push(leaseToken);
      return false;
    },
    async releaseOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner !== leaseToken) {
        return false;
      }
      leaseOwner = null;
      return true;
    },
    async listSubscriptions() {
      if (blockNextList) {
        blockNextList = false;
        signalOldListStarted();
        await oldListGate;
      }
      return subscriptions;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(
    kv,
    harness,
    'selector_race_menu',
    'cp'
  );

  blockNextList = true;
  const oldWorker = handleMessage(
    makeMessage('-200', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await oldListStarted;
  const oldLeaseToken = leaseOwner;
  const inputKey = 'ui_input:7:_:7';
  const abandonedClaim = JSON.parse(kv.values.get(inputKey));
  kv.values.set(inputKey, JSON.stringify({
    ...abandonedClaim,
    revision: 'superseded-revision',
    claimExpiresAt: Math.floor(Date.now() / 1000) - 1
  }));
  expireCurrentLease = true;
  const editsBeforeTakeover = harness.edits.length;

  await handleMessage(
    makeMessage('-300', { message_id: 4 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const editsAfterTakeover = harness.edits.length;
  assert.equal(editsAfterTakeover, editsBeforeTakeover + 1);
  assert.equal(kv.values.has(inputKey), false);

  releaseOldList();
  await oldWorker;

  assert.equal(harness.edits.length, editsAfterTakeover);
  assert.equal(rejectedRenewals.includes(oldLeaseToken), true);
  const forwardEntries = [...kv.values.entries()]
    .filter(([key]) => key.startsWith('fwd_session:'));
  assert.equal(forwardEntries.length, 1);
  assert.equal(forwardEntries[0][0], 'fwd_session:selector_new');
  assert.equal(JSON.parse(forwardEntries[0][1]).phase, 'open');
  assert.equal(
    JSON.parse(
      kv.values.get('ui_session:selector_race_menu')
    ).forwardSessionId,
    'selector_new'
  );
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId).sort(),
    ['2', '3', '4']
  );
});

test('a partial selector binding is rolled back before its fallback is deleted', async () => {
  const kv = makeKv();
  const subscriptions = [{
    id: 1,
    type: 'rss',
    channelName: 'feed',
    rssUrl: 'https://feeds.example/feed.xml',
    chatId: '7',
    threadId: null
  }];
  const sessionIds = ['partial_menu', 'partial_selector'];
  const harness = makeHarness({
    randomUUID() {
      return sessionIds.shift();
    },
    async listSubscriptions() {
      return subscriptions;
    },
    async editTelegramMessage(token, chatId, messageId, text) {
      if (/请选择要复制到目标会话/.test(text)) {
        return {
          ok: false,
          status: 400,
          retryable: false,
          permanent: true,
          apiDescription: 'Bad Request: message to edit not found',
          error: 'Telegram HTTP 400'
        };
      }
      return { ok: true, result: { message_id: Number(messageId) } };
    },
    logTelegramError() {}
  });
  const baseApply = harness.services.applyOperationalStateChanges.bind(
    harness.services
  );
  let returnPartialBinding = true;
  harness.services.applyOperationalStateChanges = async (env, changes) => {
    if (
      returnPartialBinding &&
      changes.length === 3 &&
      changes[0].name === 'fwd_session:partial_selector'
    ) {
      returnPartialBinding = false;
      return baseApply(env, [changes[0]]);
    }
    return baseApply(env, changes);
  };

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleCallback(
    {
      id: 'open-partial-copy-input',
      data: 'ui:partial_menu:cp',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  await assert.rejects(
    handleMessage(
      makeMessage('-200', { message_id: 3 }),
      { DB: kv },
      makeConfig(),
      harness.services
    ),
    /Forward panel view changed before persistence/
  );

  const uiSession = JSON.parse(kv.values.get('ui_session:partial_menu'));
  const forwardSession = JSON.parse(
    kv.values.get('fwd_session:partial_selector')
  );
  assert.equal(uiSession.panelMessageId, '1');
  assert.equal(Object.hasOwn(uiSession, 'forwardSessionId'), false);
  assert.equal(forwardSession.phase, 'initializing');
  assert.equal(forwardSession.selectorMessageId, '1');
  assert.equal(kv.values.get('ui_panel:7:_:7'), '1');
  assert.equal(
    JSON.parse(kv.values.get('ui_input:7:_:7')).phase,
    'open'
  );
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['3']
  );
});


test('/cancel removes its ForceReply prompt and the cancel command message', async () => {
  const kv = makeKv();
  const harness = makeHarness({
    randomUUID() {
      return 'cancel_cleanup';
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'cancel_cleanup', 'a');
  await handleCallback(
    {
      id: 'start-cancel-cleanup',
      data: 'ui:cancel_cleanup:at:r',
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await handleMessage(
    makeMessage('/cancel', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.equal(harness.sends.length, 2);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId).sort(),
    ['2', '3']
  );
  assert.match(harness.edits.at(-1).text, /已取消当前输入/);
});

test('input prompt latency extends its parent menu to the final input expiry', async () => {
  const originalDateNow = Date.now;
  let nowMs = 2_000_000_000_000;
  let sentMessageId = 0;
  Date.now = () => nowMs;
  try {
    const kv = makeKv();
    const harness = makeHarness({
      randomUUID() {
        return 'input_ttl_sync';
      },
      async sendTelegramMessage() {
        nowMs += 10_000;
        sentMessageId += 1;
        return {
          ok: true,
          result: { message_id: sentMessageId }
        };
      },
      async editTelegramMessage(token, chatId, messageId) {
        nowMs += 10_000;
        return {
          ok: true,
          result: { message_id: Number(messageId) }
        };
      }
    });

    await handleMessage(
      makeMessage('/menu'),
      { DB: kv },
      makeConfig(),
      harness.services
    );
    await clickPrivateUi(kv, harness, 'input_ttl_sync', 'a');
    await clickPrivateUi(kv, harness, 'input_ttl_sync', 'at:r');

    const input = JSON.parse(kv.values.get('ui_input:7:_:7'));
    const parent = JSON.parse(
      kv.values.get('ui_session:input_ttl_sync')
    );
    assert.equal(parent.expiresAt >= input.expiresAt, true);
    const activePut = kv.puts
      .filter((entry) => entry.key === 'ui_active:7:_:7')
      .at(-1);
    assert.equal(
      activePut.options.expirationTtl >=
        input.expiresAt - Math.floor(nowMs / 1000),
      true
    );
  } finally {
    Date.now = originalDateNow;
  }
});

test('a destructive callback cannot mutate after losing its panel lease', async () => {
  const kv = makeKv();
  const subscription = {
    id: 42,
    type: 'rss',
    channelName: 'feed',
    rssUrl: 'https://feeds.example/feed.xml',
    chatId: '7',
    threadId: null
  };
  let leaseOwner = null;
  let expireCurrentLease = false;
  let removed = 0;
  let signalOldAnswer;
  let releaseOldAnswer;
  const oldAnswerStarted = new Promise((resolve) => {
    signalOldAnswer = resolve;
  });
  const oldAnswerGate = new Promise((resolve) => {
    releaseOldAnswer = resolve;
  });
  const rejectedRenewals = [];
  const harness = makeHarness({
    randomUUID() {
      return 'delete_lease_race';
    },
    async acquireOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === null || expireCurrentLease) {
        leaseOwner = leaseToken;
        expireCurrentLease = false;
        return true;
      }
      return false;
    },
    async renewOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === leaseToken) {
        return true;
      }
      rejectedRenewals.push(leaseToken);
      return false;
    },
    async releaseOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner !== leaseToken) {
        return false;
      }
      leaseOwner = null;
      return true;
    },
    async answerCallbackQuery(token, id) {
      if (id === 'old-delete') {
        signalOldAnswer();
        await oldAnswerGate;
      }
      return { ok: true };
    },
    async listSubscriptions() {
      return [subscription];
    },
    async getSubscriptionRouting() {
      return {
        subscriptionId: 42,
        independent: false,
        includeSource: true,
        targets: []
      };
    },
    async removeSubscriptions() {
      removed += 1;
      return 1;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'delete_lease_race', 'l:0');
  await clickPrivateUi(kv, harness, 'delete_lease_race', 's:42:0');
  await clickPrivateUi(kv, harness, 'delete_lease_race', 'dc:42:0');
  const deleteCallback = harness.messages.at(-1).replyMarkup
    .inline_keyboard.flat()
    .map((button) => button.callback_data)
    .find((data) => data.startsWith('ui:delete_lease_race:dx:'));
  const deleteAction = deleteCallback
    .slice('ui:delete_lease_race:'.length);

  const oldWorker = clickPrivateUi(
    kv,
    harness,
    'delete_lease_race',
    deleteAction,
    'old-delete'
  );
  await oldAnswerStarted;
  const oldLeaseToken = leaseOwner;
  expireCurrentLease = true;
  await clickPrivateUi(
    kv,
    harness,
    'delete_lease_race',
    's:42:0',
    'cancel-after-expiry'
  );
  const editsAfterCancel = harness.edits.length;

  releaseOldAnswer();
  await oldWorker;

  assert.equal(removed, 0);
  assert.equal(harness.edits.length, editsAfterCancel);
  assert.equal(rejectedRenewals.includes(oldLeaseToken), true);
});

test('a stale input callback cannot replace a newer input after losing its lease', async () => {
  const kv = makeKv();
  let leaseOwner = null;
  let expireCurrentLease = false;
  let signalOldAnswer;
  let releaseOldAnswer;
  const oldAnswerStarted = new Promise((resolve) => {
    signalOldAnswer = resolve;
  });
  const oldAnswerGate = new Promise((resolve) => {
    releaseOldAnswer = resolve;
  });
  const rejectedRenewals = [];
  const harness = makeHarness({
    randomUUID() {
      return 'input_lease_race';
    },
    async acquireOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === null || expireCurrentLease) {
        leaseOwner = leaseToken;
        expireCurrentLease = false;
        return true;
      }
      return false;
    },
    async renewOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === leaseToken) {
        return true;
      }
      rejectedRenewals.push(leaseToken);
      return false;
    },
    async releaseOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner !== leaseToken) {
        return false;
      }
      leaseOwner = null;
      return true;
    },
    async answerCallbackQuery(token, id) {
      if (id === 'old-rss-input') {
        signalOldAnswer();
        await oldAnswerGate;
      }
      return { ok: true };
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'input_lease_race', 'a');

  const oldWorker = clickPrivateUi(
    kv,
    harness,
    'input_lease_race',
    'at:r',
    'old-rss-input'
  );
  await oldAnswerStarted;
  const oldLeaseToken = leaseOwner;
  expireCurrentLease = true;

  await clickPrivateUi(
    kv,
    harness,
    'input_lease_race',
    'at:x',
    'new-x-input'
  );
  const inputKey = 'ui_input:7:_:7';
  const newerInputRaw = kv.values.get(inputKey);
  const sendsAfterNewInput = harness.sends.length;
  const editsAfterNewInput = harness.edits.length;
  const deletesAfterNewInput = harness.messageDeletes.length;
  assert.equal(JSON.parse(newerInputRaw).subscriptionType, 'x');

  releaseOldAnswer();
  await oldWorker;

  assert.equal(kv.values.get(inputKey), newerInputRaw);
  assert.equal(harness.sends.length, sendsAfterNewInput);
  assert.equal(harness.edits.length, editsAfterNewInput);
  assert.equal(harness.messageDeletes.length, deletesAfterNewInput);
  assert.equal(rejectedRenewals.includes(oldLeaseToken), true);
});

test('a stale input cancel cannot clear a newer input in the same menu', async () => {
  const kv = makeKv();
  let leaseOwner = null;
  let expireCurrentLease = false;
  let signalOldAnswer;
  let releaseOldAnswer;
  const oldAnswerStarted = new Promise((resolve) => {
    signalOldAnswer = resolve;
  });
  const oldAnswerGate = new Promise((resolve) => {
    releaseOldAnswer = resolve;
  });
  const rejectedRenewals = [];
  const harness = makeHarness({
    randomUUID() {
      return 'cancel_lease_race';
    },
    async acquireOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === null || expireCurrentLease) {
        leaseOwner = leaseToken;
        expireCurrentLease = false;
        return true;
      }
      return false;
    },
    async renewOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === leaseToken) {
        return true;
      }
      rejectedRenewals.push(leaseToken);
      return false;
    },
    async releaseOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner !== leaseToken) {
        return false;
      }
      leaseOwner = null;
      return true;
    },
    async answerCallbackQuery(token, id) {
      if (id === 'old-input-cancel') {
        signalOldAnswer();
        await oldAnswerGate;
      }
      return { ok: true };
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'cancel_lease_race', 'a');
  await clickPrivateUi(kv, harness, 'cancel_lease_race', 'at:r');
  const firstInput = JSON.parse(kv.values.get('ui_input:7:_:7'));
  const firstCancelAction = 'ic:' + firstInput.cancelNonce;

  const oldWorker = clickPrivateUi(
    kv,
    harness,
    'cancel_lease_race',
    firstCancelAction,
    'old-input-cancel'
  );
  await oldAnswerStarted;
  const oldLeaseToken = leaseOwner;
  expireCurrentLease = true;

  await clickPrivateUi(
    kv,
    harness,
    'cancel_lease_race',
    firstCancelAction,
    'new-input-cancel'
  );
  await clickPrivateUi(kv, harness, 'cancel_lease_race', 'a');
  await clickPrivateUi(
    kv,
    harness,
    'cancel_lease_race',
    'at:x',
    'new-x-after-cancel'
  );

  const inputKey = 'ui_input:7:_:7';
  const newerInputRaw = kv.values.get(inputKey);
  const sendsAfterNewInput = harness.sends.length;
  const editsAfterNewInput = harness.edits.length;
  const deletesAfterNewInput = harness.messageDeletes.length;
  assert.equal(JSON.parse(newerInputRaw).subscriptionType, 'x');

  releaseOldAnswer();
  await oldWorker;

  assert.equal(kv.values.get(inputKey), newerInputRaw);
  assert.equal(harness.sends.length, sendsAfterNewInput);
  assert.equal(harness.edits.length, editsAfterNewInput);
  assert.equal(harness.messageDeletes.length, deletesAfterNewInput);
  assert.equal(
    harness.messageDeletes.some((entry) => entry.messageId === '3'),
    false
  );
  assert.equal(rejectedRenewals.includes(oldLeaseToken), true);
});

test('input start stops before ForceReply when panel rendering loses its lease', async () => {
  const kv = makeKv();
  let fenceInputStart = false;
  let fencedRenewals = 0;
  const harness = makeHarness({
    randomUUID() {
      return 'input_render_fence';
    },
    async renewOperationalLease() {
      if (!fenceInputStart) {
        return true;
      }
      fencedRenewals += 1;
      return fencedRenewals === 1;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'input_render_fence', 'a');
  fenceInputStart = true;

  await clickPrivateUi(
    kv,
    harness,
    'input_render_fence',
    'at:r',
    'input-render-lost-lease'
  );

  assert.equal(fencedRenewals, 2);
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
  assert.equal(
    harness.sends.filter((message) => message.replyMarkup?.force_reply).length,
    0
  );
});

test('input start requires a successful panel render before ForceReply', async () => {
  for (const status of [429, 503]) {
    const kv = makeKv();
    const sessionId = 'render_status_' + status;
    seedPrivateUiSession(kv, sessionId, 'at:r');
    let editCalls = 0;
    const harness = makeHarness({
      async editTelegramMessage() {
        editCalls += 1;
        return {
          ok: false,
          status,
          retryable: true,
          permanent: false,
          retryAfterSeconds: status === 429 ? 1 : 0,
          error: 'Telegram HTTP ' + status
        };
      },
      logTelegramError() {}
    });

    await clickPrivateUi(
      kv,
      harness,
      sessionId,
      'at:r',
      'render-status-' + status
    );

    assert.equal(editCalls, 1);
    assert.equal(harness.sends.length, 0);
    assert.equal(kv.values.has('ui_input:7:_:7'), false);
    assert.deepEqual(
      JSON.parse(kv.values.get('ui_session:' + sessionId)).callbackAllowlist,
      ['ui:' + sessionId + ':at:r']
    );
  }
});

test('input start stops when its panel view becomes stale before rendering', async () => {
  const kv = makeKv();
  const sessionId = 'render_stale';
  seedPrivateUiSession(kv, sessionId, 'at:r');
  let renewals = 0;
  const harness = makeHarness({
    async renewOperationalLease() {
      renewals += 1;
      if (renewals === 2) {
        kv.values.set('ui_active:7:_:7', 'newer_session');
      }
      return true;
    }
  });

  await clickPrivateUi(
    kv,
    harness,
    sessionId,
    'at:r',
    'render-became-stale'
  );

  assert.equal(renewals, 2);
  assert.equal(harness.edits.length, 0);
  assert.equal(harness.sends.length, 0);
  assert.equal(kv.values.has('ui_input:7:_:7'), false);
});

test('all input-entry callbacks require renewed ownership before starting', async () => {
  const scenarios = [
    { action: 'at:r', sessionId: 'entry_guard_at' },
    { action: 'cp', sessionId: 'entry_guard_cp' },
    { action: 'fa:42', sessionId: 'entry_guard_fa' },
    { action: 'ds:g:0', sessionId: 'entry_guard_df' }
  ];
  for (const scenario of scenarios) {
    const kv = makeKv();
    seedPrivateUiSession(kv, scenario.sessionId, scenario.action);
    let renewalCalls = 0;
    const harness = makeHarness({
      async renewOperationalLease() {
        renewalCalls += 1;
        return false;
      }
    });

    await clickPrivateUi(
      kv,
      harness,
      scenario.sessionId,
      scenario.action,
      'lost-owner-' + scenario.action
    );

    assert.equal(renewalCalls, 1, scenario.action);
    assert.equal(harness.edits.length, 0);
    assert.equal(harness.sends.length, 0);
    assert.equal(kv.values.has('ui_input:7:_:7'), false);
  }
});

test('post-ForceReply takeover only deletes the superseded worker prompt', async () => {
  const kv = makeKv();
  const sessionId = 'post_prompt_takeover';
  let leaseOwner = null;
  let expireCurrentLease = false;
  const rejectedRenewals = [];
  const harness = makeHarness({
    randomUUID() {
      return sessionId;
    },
    async acquireOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === null || expireCurrentLease) {
        leaseOwner = leaseToken;
        expireCurrentLease = false;
        return true;
      }
      return false;
    },
    async renewOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner === leaseToken) {
        return true;
      }
      rejectedRenewals.push(leaseToken);
      return false;
    },
    async releaseOperationalLease(env, name, { leaseToken }) {
      if (leaseOwner !== leaseToken) {
        return false;
      }
      leaseOwner = null;
      return true;
    }
  });
  let signalOldPrompt;
  let releaseOldPrompt;
  const oldPromptSent = new Promise((resolve) => {
    signalOldPrompt = resolve;
  });
  const oldPromptGate = new Promise((resolve) => {
    releaseOldPrompt = resolve;
  });
  let blockFirstPrompt = true;
  const baseSend = harness.services.sendTelegramMessage.bind(harness.services);
  harness.services.sendTelegramMessage = async (...args) => {
    const result = await baseSend(...args);
    if (args[4]?.force_reply === true && blockFirstPrompt) {
      blockFirstPrompt = false;
      signalOldPrompt();
      await oldPromptGate;
    }
    return result;
  };

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, sessionId, 'a');

  const oldWorker = clickPrivateUi(
    kv,
    harness,
    sessionId,
    'at:r',
    'old-post-prompt'
  );
  await oldPromptSent;
  const oldLeaseToken = leaseOwner;
  const inputView = JSON.parse(kv.values.get('ui_session:' + sessionId));
  const oldCancelData = inputView.callbackAllowlist.find(
    (data) => data.startsWith('ui:' + sessionId + ':ic:')
  );
  const oldCancelAction = oldCancelData.slice(
    ('ui:' + sessionId + ':').length
  );

  expireCurrentLease = true;
  await clickPrivateUi(
    kv,
    harness,
    sessionId,
    oldCancelAction,
    'cancel-promptless-input'
  );
  await clickPrivateUi(kv, harness, sessionId, 'a');
  await clickPrivateUi(
    kv,
    harness,
    sessionId,
    'at:x',
    'new-input-after-prompt'
  );

  const inputKey = 'ui_input:7:_:7';
  const successorRaw = kv.values.get(inputKey);
  const successor = JSON.parse(successorRaw);
  const editsAfterSuccessor = harness.edits.length;
  assert.equal(successor.subscriptionType, 'x');
  assert.equal(successor.promptMessageId, '3');

  releaseOldPrompt();
  await oldWorker;

  assert.equal(kv.values.get(inputKey), successorRaw);
  assert.equal(harness.edits.length, editsAfterSuccessor);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['2']
  );
  assert.equal(rejectedRenewals.includes(oldLeaseToken), true);
});

test('an old cancel nonce cannot cancel a newer input in the same menu', async () => {
  const kv = makeKv();
  const sessionId = 'nonce_replay';
  const harness = makeHarness({
    randomUUID() {
      return sessionId;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, sessionId, 'a');
  await clickPrivateUi(kv, harness, sessionId, 'at:r');
  const firstInput = JSON.parse(kv.values.get('ui_input:7:_:7'));
  const firstCancelAction = 'ic:' + firstInput.cancelNonce;

  await clickPrivateUi(
    kv,
    harness,
    sessionId,
    firstCancelAction,
    'cancel-first-input'
  );
  await clickPrivateUi(kv, harness, sessionId, 'a');
  await clickPrivateUi(kv, harness, sessionId, 'at:x');

  const inputKey = 'ui_input:7:_:7';
  const successorRaw = kv.values.get(inputKey);
  const successor = JSON.parse(successorRaw);
  const editsAfterSuccessor = harness.edits.length;
  const deletesAfterSuccessor = harness.messageDeletes.length;
  assert.equal(successor.subscriptionType, 'x');
  assert.notEqual(successor.cancelNonce, firstInput.cancelNonce);

  await clickPrivateUi(
    kv,
    harness,
    sessionId,
    firstCancelAction,
    'replay-first-cancel'
  );

  assert.equal(kv.values.get(inputKey), successorRaw);
  assert.equal(harness.edits.length, editsAfterSuccessor);
  assert.equal(harness.messageDeletes.length, deletesAfterSuccessor);
  assert.match(harness.answers.at(-1).text, /按钮已不属于当前页面/);
});

test('cancel CAS loss neither renders Home nor deletes the successor', async () => {
  const kv = makeKv();
  const sessionId = 'cancel_cas_zero';
  const harness = makeHarness({
    randomUUID() {
      return sessionId;
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, sessionId, 'a');
  await clickPrivateUi(kv, harness, sessionId, 'at:r');

  const inputKey = 'ui_input:7:_:7';
  const current = JSON.parse(kv.values.get(inputKey));
  const cancelAction = 'ic:' + current.cancelNonce;
  const successor = {
    ...current,
    subscriptionType: 'x',
    cancelNonce: 'next_ab-',
    revision: 'successor_revision',
    promptMessageId: '99'
  };
  const successorRaw = JSON.stringify(successor);
  const baseApply = harness.services.applyOperationalStateChanges.bind(
    harness.services
  );
  let replaceBeforeCancelCas = true;
  harness.services.applyOperationalStateChanges = async (env, changes) => {
    if (
      replaceBeforeCancelCas &&
      changes.length === 1 &&
      changes[0].name === inputKey &&
      changes[0].delete === true
    ) {
      replaceBeforeCancelCas = false;
      kv.values.set(inputKey, successorRaw);
      return 0;
    }
    return baseApply(env, changes);
  };
  const editsBeforeCancel = harness.edits.length;
  const deletesBeforeCancel = harness.messageDeletes.length;

  await clickPrivateUi(
    kv,
    harness,
    sessionId,
    cancelAction,
    'cancel-cas-zero'
  );

  assert.equal(replaceBeforeCancelCas, false);
  assert.equal(kv.values.get(inputKey), successorRaw);
  assert.equal(harness.edits.length, editsBeforeCancel);
  assert.equal(harness.messageDeletes.length, deletesBeforeCancel);
});

test('forwarding menu exposes default and per-subscription paths on one panel', async () => {
  const kv = makeKv();
  const harness = makeHarness({
    randomUUID() {
      return 'default_menu';
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  const homeCallbacks = harness.sends[0].replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(homeCallbacks.includes('ui:default_menu:fw'), true);
  assert.equal(homeCallbacks.includes('ui:default_menu:fl:0'), false);

  await clickPrivateUi(kv, harness, 'default_menu', 'fw');
  assert.match(harness.edits.at(-1).text, /默认转发.*分别管理/s);
  let callbacks = harness.edits.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(callbacks.includes('ui:default_menu:df'), true);
  assert.equal(callbacks.includes('ui:default_menu:fl:0'), true);

  await clickPrivateUi(kv, harness, 'default_menu', 'df');
  assert.match(harness.edits.at(-1).text, /默认消息转发/);
  callbacks = harness.edits.at(-1).replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(callbacks.includes('ui:default_menu:ds:g:0'), true);
  assert.equal(callbacks.includes('ui:default_menu:ds:g:1'), true);
  assert.equal(
    callbacks.some((callback) => callback.includes(':ds:t:')),
    false
  );
  for (const callback of callbacks) {
    assert.ok(new TextEncoder().encode(callback).length <= 64);
  }
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 2);
});

test('default forwarding input validates then stores a global only-target rule', async () => {
  const kv = makeKv();
  const harness = makeHarness({
    randomUUID() {
      return 'default_set';
    }
  });

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'default_set', 'fw');
  await clickPrivateUi(kv, harness, 'default_set', 'df');
  await clickPrivateUi(kv, harness, 'default_set', 'ds:g:1');

  const inputKey = 'ui_input:7:_:7';
  let input = JSON.parse(kv.values.get(inputKey));
  assert.equal(input.action, 'set_default_forward');
  assert.equal(input.forwardScope, 'global');
  assert.equal(input.onlyForward, true);
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends[1].replyMarkup.force_reply, true);

  await handleMessage(
    makeMessage('invalid target shape value', { message_id: 3 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  input = JSON.parse(kv.values.get(inputKey));
  assert.equal(input.phase, 'open');
  assert.equal(kv.values.has('forward_config:7'), false);
  assert.match(harness.edits.at(-1).text, /格式无效/);

  await handleMessage(
    makeMessage('-100200300 42', { message_id: 4 }),
    { DB: kv },
    makeConfig(),
    harness.services
  );

  assert.deepEqual(
    JSON.parse(kv.values.get('forward_config:7')),
    {
      targetChatId: '-100200300',
      targetThreadId: '42',
      onlyForward: true,
      isGlobal: true
    }
  );
  assert.equal(kv.values.has(inputKey), false);
  assert.equal(harness.sends.length, 2);
  assert.match(harness.edits.at(-1).text, /已设置Global.*仅目标/s);
  assert.deepEqual(
    harness.messageDeletes.map((entry) => entry.messageId),
    ['2', '4']
  );
});

test('default forwarding input rejects an unmanaged target and stays open', async () => {
  const kv = makeKv();
  const config = makeConfig({ adminUserIds: new Set() });
  const targetLookups = [];
  const harness = makeHarness({
    randomUUID() {
      return 'default_denied';
    },
    async getChatMember(token, chatId) {
      targetLookups.push(String(chatId));
      return { ok: true, member: { status: 'member' } };
    }
  });
  const click = (action) => handleCallback(
    {
      id: 'denied-' + action,
      data: 'ui:default_denied:' + action,
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '7', type: 'private' }
      }
    },
    { DB: kv },
    config,
    harness.services
  );

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    config,
    harness.services
  );
  await click('fw');
  await click('df');
  await click('ds:g:0');
  await handleMessage(
    makeMessage('-100200300', { message_id: 3 }),
    { DB: kv },
    config,
    harness.services
  );

  const input = JSON.parse(kv.values.get('ui_input:7:_:7'));
  assert.equal(input.action, 'set_default_forward');
  assert.equal(input.phase, 'open');
  assert.deepEqual(targetLookups, ['-100200300']);
  assert.equal(kv.values.has('forward_config:7'), false);
  assert.match(
    harness.edits.at(-1).text,
    /没有目标聊天的管理权限/
  );
  assert.equal(harness.sends.length, 2);
});

test('topic default page shows topic override and global fallback separately', async () => {
  const kv = makeKv();
  kv.values.set('forward_config:-100:9', JSON.stringify({
    targetChatId: '-201',
    targetThreadId: '11',
    onlyForward: false,
    isGlobal: false
  }));
  kv.values.set('forward_config:-100', JSON.stringify({
    targetChatId: '-202',
    targetThreadId: '12',
    onlyForward: true,
    isGlobal: true
  }));
  const harness = makeHarness({
    randomUUID() {
      return 'topic_defaults';
    }
  });
  const messageOverrides = {
    chat: { id: '-100', type: 'supergroup' },
    from: { id: '7' },
    message_thread_id: '9'
  };
  const click = (action) => handleCallback(
    {
      id: 'topic-' + action,
      data: 'ui:topic_defaults:' + action,
      from: { id: '7' },
      message: {
        message_id: 1,
        chat: { id: '-100', type: 'supergroup' },
        message_thread_id: '9'
      }
    },
    { DB: kv },
    makeConfig(),
    harness.services
  );

  await handleMessage(
    makeMessage('/menu', messageOverrides),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await click('fw');
  await click('df');

  const page = harness.edits.at(-1);
  assert.match(page.text, /当前有效规则：<\/b>当前 Topic/);
  assert.match(page.text, /-201.*Topic <code>11/s);
  assert.match(page.text, /-202.*Topic <code>12/s);
  const callbacks = page.replyMarkup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.equal(callbacks.includes('ui:topic_defaults:ds:t:0'), true);
  assert.equal(callbacks.includes('ui:topic_defaults:ds:t:1'), true);
  assert.equal(callbacks.includes('ui:topic_defaults:ds:g:0'), true);
  assert.equal(callbacks.includes('ui:topic_defaults:ddc:t'), true);
  assert.equal(callbacks.includes('ui:topic_defaults:ddc:g'), true);
  assert.equal(harness.sends.length, 1);
});

test('default forward deletion detects changes, deletes once, and fences replay', async () => {
  const kv = makeKv();
  const key = 'forward_config:7';
  kv.values.set(key, JSON.stringify({
    targetChatId: '-200',
    targetThreadId: null,
    onlyForward: false,
    isGlobal: true
  }));
  const harness = makeHarness({
    randomUUID() {
      return 'default_delete';
    }
  });
  const confirmationAction = () => {
    const callback = harness.edits.at(-1).replyMarkup.inline_keyboard
      .flat()
      .map((button) => button.callback_data)
      .find((data) => data.startsWith('ui:default_delete:ddx:g:'));
    return callback.slice('ui:default_delete:'.length);
  };

  await handleMessage(
    makeMessage('/menu'),
    { DB: kv },
    makeConfig(),
    harness.services
  );
  await clickPrivateUi(kv, harness, 'default_delete', 'fw');
  await clickPrivateUi(kv, harness, 'default_delete', 'df');
  await clickPrivateUi(kv, harness, 'default_delete', 'ddc:g');
  const staleAction = confirmationAction();

  kv.values.set(key, JSON.stringify({
    targetChatId: '-300',
    targetThreadId: '8',
    onlyForward: true,
    isGlobal: true
  }));
  await clickPrivateUi(
    kv,
    harness,
    'default_delete',
    staleAction,
    'stale-default-delete'
  );
  assert.equal(JSON.parse(kv.values.get(key)).targetChatId, '-300');
  assert.match(harness.edits.at(-1).text, /规则已发生变化/);
  assert.equal(kv.deletes.filter((entry) => entry === key).length, 0);

  await clickPrivateUi(kv, harness, 'default_delete', 'ddc:g');
  const currentAction = confirmationAction();
  await clickPrivateUi(
    kv,
    harness,
    'default_delete',
    currentAction,
    'current-default-delete'
  );
  assert.equal(kv.values.has(key), false);
  assert.equal(kv.deletes.filter((entry) => entry === key).length, 1);
  assert.match(harness.edits.at(-1).text, /已删除Global/);

  const editsAfterDelete = harness.edits.length;
  await clickPrivateUi(
    kv,
    harness,
    'default_delete',
    currentAction,
    'replay-default-delete'
  );
  assert.equal(kv.deletes.filter((entry) => entry === key).length, 1);
  assert.equal(harness.edits.length, editsAfterDelete);
  assert.match(harness.answers.at(-1).text, /按钮已不属于当前页面/);
  assert.equal(harness.sends.length, 1);
});
