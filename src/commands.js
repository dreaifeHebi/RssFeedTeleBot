import {
  addSubscription,
  copySubscriptions,
  listSubscriptions,
  removeSubscriptions
} from './storage.js';
import {
  buildRssHubUrl,
  inferTypeFromRssUrl,
  validateFeedUrl
} from './feeds.js';
import {
  answerCallbackQuery,
  buildTelegramFailureLogDetails,
  escapeHtml,
  getChatMember,
  sendTelegramMessage
} from './telegram.js';
import {
  canManageChat,
  canManageTargetChat,
  canUseForwardSession,
  isManagementCommand,
  parseCommand
} from './security.js';

const TYPES = new Set(['rss', 'x', 'youtube']);
const SESSION_PREFIX = 'fwd_session:';
const SESSION_TTL_SECONDS = 3600;
const MAX_LIST_MESSAGE_LENGTH = 3900;

const DEFAULT_SERVICES = Object.freeze({
  addSubscription,
  answerCallbackQuery,
  buildTelegramFailureLogDetails,
  buildRssHubUrl,
  canManageChat,
  canManageTargetChat,
  canUseForwardSession,
  copySubscriptions,
  getChatMember,
  inferTypeFromRssUrl,
  isManagementCommand,
  listSubscriptions,
  logTelegramError,
  parseCommand,
  removeSubscriptions,
  sendTelegramMessage,
  validateFeedUrl
});

export async function handleMessage(message, env, config, overrides = {}) {
  const services = { ...DEFAULT_SERVICES, ...overrides };
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!text || message?.chat?.id === null || message?.chat?.id === undefined) {
    return okResponse();
  }

  const command = services.parseCommand(text, config?.botUsername);
  if (!command) {
    return okResponse();
  }

  const context = {
    env,
    config: config ?? {},
    services,
    message,
    chatId: String(message.chat.id),
    threadId: optionalId(message.message_thread_id),
    token: String(config?.telegramBotToken ?? env?.TELEGRAM_BOT_TOKEN ?? '')
  };

  if (services.isManagementCommand(command.name)) {
    const allowed = await services.canManageChat({
      message,
      config: context.config,
      getChatMemberFn: (chatId, userId) => lookupChatMember(context, chatId, userId)
    });
    if (!allowed) {
      await send(context, '⛔ You do not have permission to manage this chat.');
      return okResponse();
    }
  }

  switch (command.name) {
    case 'start':
      await send(context, START_MESSAGE);
      break;
    case 'help':
      await send(context, HELP_MESSAGE);
      break;
    case 'id':
      await handleId(context);
      break;
    case 'add':
      await handleAdd(context, command.args);
      break;
    case 'set_forward':
      await handleSetForward(context, command.args);
      break;
    case 'del_forward':
      await handleDeleteForward(context, command.args);
      break;
    case 'del':
    case 'remove':
      await handleRemove(context, command.args);
      break;
    case 'list':
      await handleList(context);
      break;
    case 'forward_to':
      await handleForwardTo(context, command.args);
      break;
    default:
      break;
  }

  return okResponse();
}

export async function handleCallback(callbackQuery, env, config, overrides = {}) {
  const services = { ...DEFAULT_SERVICES, ...overrides };
  const token = String(config?.telegramBotToken ?? env?.TELEGRAM_BOT_TOKEN ?? '');
  const data = String(callbackQuery?.data ?? '');
  if (!data.startsWith('fwd:')) {
    return okResponse();
  }

  const match = /^fwd:([A-Za-z0-9_-]{1,64}):(ALL|\d+)$/.exec(data);
  if (!match) {
    await answer(services, token, callbackQuery, '❌ Invalid callback data.');
    return okResponse();
  }

  const sessionId = match[1];
  const action = match[2];
  const sessionKey = SESSION_PREFIX + sessionId;
  const raw = await env.DB.get(sessionKey);
  if (!raw) {
    await answer(services, token, callbackQuery, '❌ Session expired or invalid.');
    return okResponse();
  }

  let session;
  try {
    session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    await env.DB.delete(sessionKey);
    await answer(services, token, callbackQuery, '❌ Session expired or invalid.');
    return okResponse();
  }

  if (!services.canUseForwardSession(callbackQuery, session)) {
    await answer(services, token, callbackQuery, '❌ This button is not available to you.');
    return okResponse();
  }

  const permissionMessage = {
    from: callbackQuery.from,
    chat: callbackQuery.message.chat
  };
  const permissionContext = {
    services,
    token,
    config: config ?? {},
    message: permissionMessage
  };
  const getChatMemberFn = (chatId, userId) =>
    lookupChatMember(permissionContext, chatId, userId);
  const canStillManageSource = await services.canManageChat({
    message: permissionMessage,
    config: permissionContext.config,
    getChatMemberFn
  });
  const canStillManageTarget = await services.canManageTargetChat({
    message: permissionMessage,
    targetChatId: session.targetChatId,
    config: permissionContext.config,
    getChatMemberFn
  });
  if (!canStillManageSource || !canStillManageTarget) {
    await env.DB.delete(sessionKey);
    await answer(
      services,
      token,
      callbackQuery,
      '❌ Permission expired. Start a new forwarding session.'
    );
    return okResponse();
  }

  const available = Array.isArray(session.subMap) ? session.subMap : [];
  let selected = [];
  if (action === 'ALL') {
    selected = available;
  } else {
    const index = Number(action);
    if (Number.isSafeInteger(index) && index >= 0 && available[index]) {
      selected = [available[index]];
    }
  }

  if (selected.length === 0) {
    await answer(services, token, callbackQuery, '⚠️ No channel selected.');
    return okResponse();
  }

  const added = await services.copySubscriptions(
    env,
    selected,
    session.targetChatId,
    session.targetThreadId ?? null
  );
  await env.DB.delete(sessionKey);

  if (added > 0) {
    await answer(services, token, callbackQuery, '✅ Forwarded ' + added + ' subscriptions!');
    const result = await services.sendTelegramMessage(
      token,
      String(callbackQuery.message.chat.id),
      optionalId(session.sourceThreadId),
      '✅ Successfully forwarded ' + added + ' subscriptions to target.',
      null,
      telegramOptions(services)
    );
    reportTelegramFailure(services, token, 'sendMessage', result);
  } else {
    await answer(services, token, callbackQuery, '⚠️ Channels already exist in target.');
  }

  return okResponse();
}

async function handleId(context) {
  let text = '🆔 <b>Chat Info</b>\n\n<b>Chat ID:</b> <code>' +
    safe(context.chatId) + '</code>';
  if (context.threadId !== null) {
    text += '\n<b>Thread ID:</b> <code>' + safe(context.threadId) + '</code>';
  }
  await send(context, text);
}

async function handleAdd(context, args) {
  if (args.length < 2) {
    await send(
      context,
      'Usage:\n/add rss &lt;url&gt;\n/add x &lt;username&gt;\n' +
        '/add youtube &lt;channel_name&gt;'
    );
    return;
  }

  const type = String(args[0]).toLowerCase();
  const argument = String(args[1]);
  if (!TYPES.has(type)) {
    await send(context, 'Unknown type. Use rss, x, or youtube.');
    return;
  }
  if (type !== 'rss' && args.length !== 2) {
    await send(
      context,
      '⚠️ Username or channel name must be one value without whitespace.'
    );
    return;
  }

  let channelName;
  let rssUrl;
  try {
    if (type === 'rss') {
      if (argument.length > 4096) {
        throw new TypeError('Feed URL is too long');
      }
      rssUrl = validateConfiguredUrl(context, argument);
      const parsed = new URL(rssUrl);
      channelName = parsed.hostname;
    } else {
      channelName = normalizeSocialName(argument);
      const route = type === 'x'
        ? '/twitter/user/' + encodeURIComponent(channelName)
        : '/youtube/user/' + encodeURIComponent(channelName);
      rssUrl = validateConfiguredUrl(
        context,
        context.services.buildRssHubUrl(context.config.rssBaseUrl, route)
      );
    }
  } catch (error) {
    await send(context, '⚠️ Invalid feed: ' + safe(errorMessage(error), 500));
    return;
  }

  const added = await context.services.addSubscription(context.env, {
    type,
    channelName,
    rssUrl,
    chatId: context.chatId,
    threadId: context.threadId
  });
  if (added) {
    await send(
      context,
      '✅ Added ' + safe(type) + ' subscription: ' + safe(channelName, 700)
    );
  } else {
    await send(context, '⚠️ Subscription already exists.');
  }
}

async function handleSetForward(context, args) {
  if (args.length < 1) {
    await send(
      context,
      'Usage: /set_forward &lt;target_chat_id&gt; [target_thread_id] ' +
        '[only_forward] [scope]\nScope: "topic" (default) or "global"\n' +
        'Example: /set_forward -100123456789 123 true global'
    );
    return;
  }

  const targetChatId = parseChatId(args[0]);
  if (targetChatId === null) {
    await send(context, '⚠️ Invalid Target Chat ID.');
    return;
  }
  let targetThreadId = null;
  let onlyForward = false;
  let isGlobal = false;
  for (const raw of args.slice(1)) {
    const value = String(raw).toLowerCase();
    if (value === 'true' || value === 'false') {
      onlyForward = value === 'true';
    } else if (value === 'global' || value === 'all') {
      isGlobal = true;
    } else if (value === 'topic') {
      isGlobal = false;
    } else {
      const parsed = parseThreadId(value);
      if (parsed === null) {
        await send(context, '⚠️ Invalid Target Thread ID.');
        return;
      }
      targetThreadId = parsed;
    }
  }

  if (!await authorizeTargetChat(context, targetChatId)) {
    await send(context, '⛔ You do not have permission to manage the target chat.');
    return;
  }

  const topicScope = !isGlobal && context.threadId !== null;
  const key = topicScope
    ? 'forward_config:' + context.chatId + ':' + context.threadId
    : 'forward_config:' + context.chatId;
  const scope = topicScope
    ? 'This Topic (' + safe(context.threadId) + ')'
    : (isGlobal ? 'Global (All Topics)' : 'Global (Default)');

  await context.env.DB.put(key, JSON.stringify({
    targetChatId,
    targetThreadId,
    onlyForward,
    isGlobal
  }));

  let text = '✅ Forwarding configured.\nTarget: ' + safe(targetChatId);
  if (targetThreadId !== null) {
    text += '\nThread ID: ' + safe(targetThreadId);
  }
  text += '\nOnly Forward: ' + onlyForward + '\nScope: ' + scope;
  await send(context, text);
}

async function handleDeleteForward(context, args) {
  const globalScope = args.some((raw) => {
    const value = String(raw).toLowerCase();
    return value === 'global' || value === 'all';
  });
  const topicScope = !globalScope && context.threadId !== null;
  const key = topicScope
    ? 'forward_config:' + context.chatId + ':' + context.threadId
    : 'forward_config:' + context.chatId;
  const scope = topicScope
    ? 'This Topic (' + safe(context.threadId) + ')'
    : 'Global';

  await context.env.DB.delete(key);
  await send(context, '✅ Forwarding configuration removed for scope: ' + scope + '.');
}

async function handleRemove(context, args) {
  if (args.length < 1) {
    await send(
      context,
      'Usage: /del #&lt;subscription_id&gt;\n' +
        'Legacy: /del [&lt;type&gt;] &lt;name&gt; (only when unique)'
    );
    return;
  }

  const scope = {
    chatId: context.chatId,
    threadId: context.threadId
  };
  const id = parseSubscriptionIdToken(args[0]);
  if (id !== null) {
    if (args.length !== 1) {
      await send(context, 'Usage: /del #&lt;subscription_id&gt;');
      return;
    }

    const removed = await context.services.removeSubscriptions(context.env, {
      id,
      ...scope
    });
    if (removed > 0) {
      await send(context, '🗑️ Removed subscription #' + id + '.');
    } else {
      await send(
        context,
        '⚠️ Subscription #' + id + ' was not found in this chat/topic.'
      );
    }
    return;
  }
  if (String(args[0]).startsWith('#')) {
    await send(context, '⚠️ Invalid subscription ID. Use a value such as #123.');
    return;
  }

  let type = null;
  let channelName = String(args[0]);
  const possibleType = String(args[0]).toLowerCase();
  if (args.length >= 2 && TYPES.has(possibleType)) {
    type = possibleType;
    channelName = String(args[1]);
  }

  const current = await context.services.listSubscriptions(context.env, scope);
  const matches = current.filter((subscription) => {
    const effectiveType = subscriptionType(subscription, context.services);
    const displayName = subscriptionDisplayName(subscription, context.services);
    const storedName = String(subscription?.channelName ?? '');
    return (!type || effectiveType === type) &&
      (displayName === channelName || storedName === channelName);
  });

  if (matches.length === 0) {
    await send(context, '⚠️ No matching subscription was found.');
    return;
  }
  if (matches.length > 1) {
    const lines = matches.map((subscription) =>
      subscriptionListLine(subscription, context.services)
    );
    await sendList(
      context,
      lines,
      '⚠️ <b>Multiple subscriptions match.</b>\n' +
        'Nothing was removed. Choose one with <code>/del #ID</code>:',
      '⚠️ <b>Matching subscriptions (continued):</b>'
    );
    return;
  }

  const matched = matches[0];
  const matchedId = subscriptionId(matched);
  const removed = await context.services.removeSubscriptions(context.env, {
    id: matchedId,
    ...scope
  });
  if (removed > 0) {
    await send(
      context,
      '🗑️ Removed ' + subscriptionListLine(matched, context.services) +
        ' from watchlist.'
    );
  } else {
    await send(context, '⚠️ The subscription was no longer present.');
  }
}

async function handleList(context) {
  const current = await context.services.listSubscriptions(context.env, {
    chatId: context.chatId,
    threadId: context.threadId
  });
  if (current.length === 0) {
    await send(context, '📭 No active subscriptions.');
    return;
  }

  const lines = current.map((subscription) =>
    subscriptionListLine(subscription, context.services)
  );
  await sendList(context, lines);
}

async function handleForwardTo(context, args) {
  if (args.length < 1) {
    await send(context, 'Usage: /forward_to &lt;target_chat_id&gt; [target_thread_id]');
    return;
  }

  const targetChatId = parseChatId(args[0]);
  if (targetChatId === null) {
    await send(context, '⚠️ Invalid Target Chat ID.');
    return;
  }

  let targetThreadId = null;
  if (args.length > 1) {
    targetThreadId = parseThreadId(args[1]);
    if (targetThreadId === null) {
      await send(context, '⚠️ Invalid Target Thread ID.');
      return;
    }
  }

  if (!await authorizeTargetChat(context, targetChatId)) {
    await send(context, '⛔ You do not have permission to manage the target chat.');
    return;
  }

  const current = await context.services.listSubscriptions(context.env, {
    chatId: context.chatId,
    threadId: context.threadId
  });
  if (current.length === 0) {
    await send(context, '⚠️ No subscriptions found in this chat to forward.');
    return;
  }

  const sessionId = createSessionId(context.services);
  const session = {
    targetChatId,
    targetThreadId,
    sourceChatId: context.chatId,
    sourceThreadId: context.threadId,
    initiatorUserId: String(context.message.from.id),
    subMap: current.map((subscription) => ({
      type: subscriptionType(subscription, context.services),
      channelName: subscriptionDisplayName(subscription, context.services),
      rssUrl: subscription.rssUrl
    }))
  };
  await context.env.DB.put(
    SESSION_PREFIX + sessionId,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL_SECONDS }
  );

  const keyboard = {
    inline_keyboard: [
      [{ text: '🚀 Forward All', callback_data: 'fwd:' + sessionId + ':ALL' }],
      ...current.map((subscription, index) => [{
        text: truncatePlain(
          '📺 [' + subscriptionType(subscription, context.services) +
            '] ' + subscriptionDisplayName(subscription, context.services),
          120
        ),
        callback_data: 'fwd:' + sessionId + ':' + index
      }])
    ]
  };
  const text = '📤 <b>Forward Subscriptions</b>\n\n' +
    '<b>Target Chat ID:</b> <code>' + safe(targetChatId) + '</code>\n' +
    (targetThreadId !== null
      ? '<b>Target Thread ID:</b> <code>' + safe(targetThreadId) + '</code>\n'
      : '') +
    '\nSelect the subscriptions you want to copy to the target chat:';
  await send(context, text, keyboard);
}

async function lookupChatMember(context, chatId, userId) {
  const result = await context.services.getChatMember(
    context.token,
    String(chatId),
    String(userId),
    telegramOptions(context.services)
  );
  if (result?.ok === false) {
    reportTelegramFailure(
      context.services,
      context.token,
      'getChatMember',
      result
    );
    throw new Error(result.error || 'Telegram getChatMember failed');
  }
  return result?.member ?? result?.result ?? result;
}

function validateConfiguredUrl(context, rawUrl) {
  const allowedHosts = context.config.allowedFeedHosts?.size > 0
    ? context.config.allowedFeedHosts
    : undefined;
  return context.services.validateFeedUrl(rawUrl, { allowedHosts });
}
async function authorizeTargetChat(context, targetChatId) {
  return context.services.canManageTargetChat({
    message: context.message,
    targetChatId,
    config: context.config,
    getChatMemberFn: (chatId, userId) =>
      lookupChatMember(context, chatId, userId)
  });
}

async function send(context, text, replyMarkup = null) {
  const result = await context.services.sendTelegramMessage(
    context.token,
    context.chatId,
    context.threadId,
    text,
    replyMarkup,
    telegramOptions(context.services)
  );
  reportTelegramFailure(
    context.services,
    context.token,
    'sendMessage',
    result
  );
  return result;
}

async function sendList(
  context,
  lines,
  firstHeader = '📋 <b>Subscriptions:</b>',
  nextHeader = '📋 <b>Subscriptions (continued):</b>'
) {
  let header = firstHeader;
  let text = header;

  for (const line of lines) {
    if ((text + '\n' + line).length > MAX_LIST_MESSAGE_LENGTH && text !== header) {
      await send(context, text);
      header = nextHeader;
      text = header;
    }
    text += '\n' + line;
  }
  await send(context, text);
}

async function answer(services, token, callbackQuery, text) {
  if (callbackQuery?.id === null || callbackQuery?.id === undefined) {
    return null;
  }
  const result = await services.answerCallbackQuery(
    token,
    String(callbackQuery.id),
    text,
    telegramOptions(services)
  );
  reportTelegramFailure(services, token, 'answerCallbackQuery', result);
  return result;
}

function reportTelegramFailure(services, token, operation, result) {
  if (result?.ok === true) {
    return;
  }

  services.logTelegramError(
    services.buildTelegramFailureLogDetails(token, operation, result, {
      source: 'webhook'
    })
  );
}

function logTelegramError(details) {
  console.error(details);
}

function telegramOptions(services) {
  return services.fetchFn ? { fetchFn: services.fetchFn } : {};
}

function optionalId(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function subscriptionId(subscription) {
  const id = Number(subscription?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError('Subscription row is missing a safe D1 id');
  }
  return id;
}

function parseSubscriptionIdToken(value) {
  const match = /^#([1-9]\d*)$/.exec(String(value ?? ''));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function subscriptionType(subscription, services) {
  return String(
    subscription?.type || services.inferTypeFromRssUrl(subscription?.rssUrl)
  ).toLowerCase();
}

function subscriptionListLine(subscription, services) {
  const id = subscriptionId(subscription);
  const type = subscriptionType(subscription, services);
  const displayName = subscriptionDisplayName(subscription, services);
  return '#' + id + ' [' + safe(type, 50) + '] ' + safe(displayName, 700);
}

function subscriptionDisplayName(subscription, services) {
  if (subscriptionType(subscription, services) !== 'rss') {
    return String(subscription?.channelName ?? '');
  }

  try {
    return new URL(String(subscription?.rssUrl ?? '')).hostname || 'RSS feed';
  } catch {
    return 'RSS feed';
  }
}

function parseChatId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^-?\d+$/.test(normalized)) {
    return null;
  }
  try {
    const parsed = BigInt(normalized);
    return parsed === 0n ? null : parsed.toString();
  } catch {
    return null;
  }
}

function parseThreadId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  try {
    const parsed = BigInt(normalized);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function normalizeSocialName(value) {
  const normalized = String(value ?? '').replace(/^@/, '');
  if (!normalized) {
    throw new TypeError('Username or channel name is required');
  }
  if ([...normalized].length > 100) {
    throw new TypeError('Username or channel name is too long');
  }
  if ([...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return character.trim() === '' ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159);
  })) {
    throw new TypeError('Username or channel name contains invalid characters');
  }
  return normalized;
}

function createSessionId(services) {
  if (typeof services.randomUUID === 'function') {
    return assertSessionId(services.randomUUID());
  }
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return assertSessionId(globalThis.crypto.randomUUID());
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('A cryptographically secure random generator is required');
}

function assertSessionId(value) {
  const sessionId = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    throw new TypeError('Generated forwarding session ID is invalid');
  }
  return sessionId;
}

function safe(value, maxCharacters = 300) {
  const characters = [...String(value ?? '')];
  const bounded = characters.length > maxCharacters
    ? characters.slice(0, Math.max(0, maxCharacters - 1)).join('') + '…'
    : characters.join('');
  return escapeHtml(bounded);
}

function truncatePlain(value, maxCharacters) {
  const characters = [...String(value ?? '')];
  return characters.length <= maxCharacters
    ? characters.join('')
    : characters.slice(0, Math.max(0, maxCharacters - 1)).join('') + '…';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'Invalid input');
}

function okResponse() {
  return new Response('OK', { status: 200 });
}

const START_MESSAGE = '👋 <b>RSS & Social Monitor Bot</b>\n\n' +
  'I can monitor RSS feeds, X (Twitter), and YouTube channels for you.\n\n' +
  '<b>Commands:</b>\n' +
  '/add rss &lt;url&gt; - Add RSS feed\n' +
  '/add x &lt;username&gt; - Add X user\n' +
  '/del #&lt;id&gt; - Remove subscription shown by /list\n' +
  '/list - List subscriptions\n' +
  '/set_forward - Configure forwarding (Scope: topic/global)\n' +
  '/help - Show help';

const HELP_MESSAGE = '📖 <b>Help Guide</b>\n\n' +
  '<b>1. Add Subscription</b>\n' +
  'Use <code>/add &lt;type&gt; &lt;arg&gt;</code>\n' +
  '- RSS: <code>/add rss https://example.com/feed.xml</code>\n' +
  '- X (Twitter): <code>/add x username</code>\n' +
  '- YouTube: <code>/add youtube username</code>\n\n' +
  '<b>2. Forwarding Settings</b>\n' +
  'Configure message forwarding to another channel/group/topic:\n' +
  '<code>/set_forward &lt;target_chat_id&gt; [target_thread_id] [only_forward] [scope]</code>\n' +
  'Scope: <code>topic</code> (default) or <code>global</code>\n' +
  'Example: <code>/set_forward -100 10 true global</code> (Sets global forward for this group)\n' +
  'To remove: <code>/del_forward [scope]</code> (default: topic)\n\n' +
  '<b>3. Manage Subscriptions</b>\n' +
  '- List: <code>/list</code>\n' +
  '- Remove: <code>/del #123</code> (preferred)\n' +
  '- Legacy unique name: <code>/del [type] &lt;name&gt;</code>\n' +
  '- ID Info: <code>/id</code>';
