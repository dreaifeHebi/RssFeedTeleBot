import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canManageChat,
  canManageTargetChat,
  canUseForwardSession,
  isManagementCommand,
  parseCommand,
  verifyWebhookRequest
} from '../src/security.js';

test('verifyWebhookRequest rejects missing or incorrect secrets', () => {
  const good = new Request('https://worker.test', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' }
  });
  const bad = new Request('https://worker.test', {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }
  });

  assert.equal(verifyWebhookRequest(good, 'secret'), true);
  assert.equal(verifyWebhookRequest(bad, 'secret'), false);
  assert.equal(verifyWebhookRequest(new Request('https://worker.test'), 'secret'), false);
});

test('parseCommand matches exact command tokens and bot mentions', () => {
  assert.deepEqual(parseCommand('/add rss https://example.test', 'mybot'), {
    name: 'add',
    args: ['rss', 'https://example.test'],
    mentionedBot: null
  });
  assert.equal(parseCommand('/add@otherbot rss x', 'mybot'), null);
  assert.equal(parseCommand('/add@mybot rss x', ''), null);
  assert.equal(parseCommand('/add@mybot rss x', 'mybot')?.name, 'add');
  assert.equal(parseCommand('/add-extra rss x', 'mybot'), null);
  assert.equal(parseCommand('hello'), null);
  assert.equal(isManagementCommand('set_forward'), true);
  assert.equal(isManagementCommand('list'), false);
});

test('canManageChat uses an explicit allowlist when configured', async () => {
  const message = { from: { id: 10 }, chat: { id: -100, type: 'supergroup' } };
  assert.equal(await canManageChat({
    message,
    config: { adminUserIds: new Set(['10']) },
    getChatMemberFn: async () => ({ status: 'member' })
  }), true);
  assert.equal(await canManageChat({
    message,
    config: { adminUserIds: new Set(['11']) },
    getChatMemberFn: async () => ({ status: 'administrator' })
  }), false);
});

test('canManageChat allows private chats and Telegram administrators', async () => {
  assert.equal(await canManageChat({
    message: { from: { id: 10 }, chat: { id: 10, type: 'private' } },
    config: { adminUserIds: new Set() }
  }), true);
  assert.equal(await canManageChat({
    message: { from: { id: 10 }, chat: { id: -100, type: 'supergroup' } },
    config: { adminUserIds: new Set() },
    getChatMemberFn: async () => ({ status: 'administrator' })
  }), true);
});

test('canManageTargetChat requires target ownership without a global allowlist', async () => {
  const message = {
    from: { id: 10 },
    chat: { id: -100, type: 'supergroup' }
  };
  let lookups = 0;
  const administratorLookup = async (chatId, userId) => {
    lookups += 1;
    assert.equal(String(chatId), '-200');
    assert.equal(String(userId), '10');
    return { status: 'administrator' };
  };

  assert.equal(await canManageTargetChat({
    message,
    targetChatId: -100,
    config: { adminUserIds: new Set() },
    getChatMemberFn: administratorLookup
  }), true);
  assert.equal(await canManageTargetChat({
    message,
    targetChatId: 10,
    config: { adminUserIds: new Set() },
    getChatMemberFn: administratorLookup
  }), true);
  assert.equal(lookups, 0);

  assert.equal(await canManageTargetChat({
    message,
    targetChatId: -200,
    config: { adminUserIds: new Set() },
    getChatMemberFn: administratorLookup
  }), true);
  assert.equal(lookups, 1);
  assert.equal(await canManageTargetChat({
    message,
    targetChatId: -200,
    config: { adminUserIds: new Set() },
    getChatMemberFn: async () => ({ status: 'member' })
  }), false);
  assert.equal(await canManageTargetChat({
    message,
    targetChatId: -200,
    config: { adminUserIds: new Set() }
  }), false);

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(await canManageTargetChat({
      message,
      targetChatId: -200,
      config: { adminUserIds: new Set() },
      getChatMemberFn: async () => {
        throw new Error('sensitive request detail');
      }
    }), false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(await canManageTargetChat({
    message,
    targetChatId: -200,
    config: { adminUserIds: new Set(['10']) },
    getChatMemberFn: async () => {
      throw new Error('must not query Telegram');
    }
  }), true);
  assert.equal(await canManageTargetChat({
    message,
    targetChatId: -200,
    config: { adminUserIds: new Set(['11']) },
    getChatMemberFn: async () => ({ status: 'administrator' })
  }), false);
});

test('forward sessions are bound to chat, thread and initiating user', () => {
  const callback = {
    from: { id: 7 },
    message: { chat: { id: -100 }, message_thread_id: 9 }
  };
  const session = { sourceChatId: -100, sourceThreadId: 9, initiatorUserId: 7 };
  assert.equal(canUseForwardSession(callback, session), true);
  assert.equal(canUseForwardSession({ ...callback, from: { id: 8 } }, session), false);
});
