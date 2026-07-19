import {
  addSubscriptionForwardTarget,
  addSubscription,
  copySubscriptions,
  getSubscriptionRouting,
  initializeSubscriptionRouting,
  listSubscriptions,
  removeSubscriptionForwardTarget,
  removeSubscriptions,
  resetSubscriptionRouting,
  setSubscriptionIncludeSource
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
const UI_SESSION_PREFIX = 'ui_session:';
const UI_ACTIVE_PREFIX = 'ui_active:';
const UI_INPUT_PREFIX = 'ui_input:';
const UI_SESSION_TTL_SECONDS = 3600;
const UI_INPUT_TTL_SECONDS = 10 * 60;
const UI_PAGE_SIZE = 8;
const MAX_FORWARD_TARGETS = 10;
const FORWARD_COPY_PAGE_SIZE = 8;

const DEFAULT_SERVICES = Object.freeze({
  addSubscriptionForwardTarget,
  addSubscription,
  answerCallbackQuery,
  buildTelegramFailureLogDetails,
  buildRssHubUrl,
  canManageChat,
  canManageTargetChat,
  canUseForwardSession,
  copySubscriptions,
  getSubscriptionRouting,
  getChatMember,
  inferTypeFromRssUrl,
  initializeSubscriptionRouting,
  isManagementCommand,
  listSubscriptions,
  logTelegramError,
  parseCommand,
  removeSubscriptionForwardTarget,
  removeSubscriptions,
  resetSubscriptionRouting,
  sendTelegramMessage,
  setSubscriptionIncludeSource,
  validateFeedUrl
});

export async function handleMessage(message, env, config, overrides = {}) {
  const services = { ...DEFAULT_SERVICES, ...overrides };
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!text || message?.chat?.id === null || message?.chat?.id === undefined) {
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

  const command = services.parseCommand(text, config?.botUsername);
  if (!command) {
    await handleUiTextInput(context, text);
    return okResponse();
  }

  if (command.name === 'cancel') {
    await handleCancel(context);
    return okResponse();
  }

  await clearUiInput(context);

  if (services.isManagementCommand(command.name)) {
    const allowed = await canManageContext(context);
    if (!allowed) {
      await send(context, '⛔ You do not have permission to manage this chat.');
      return okResponse();
    }
  }

  switch (command.name) {
    case 'start':
    case 'menu':
      await handleMenu(context);
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
  if (data.startsWith('ui:')) {
    return handleUiCallback(callbackQuery, env, config, services, token);
  }

  if (!data.startsWith('fwd:')) {
    return okResponse();
  }

  const match = /^fwd:([A-Za-z0-9_-]{1,64}):(ALL|P\d{1,6}|\d+)$/.exec(data);
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
  if (/^P\d{1,6}$/.test(action)) {
    if (available.length === 0) {
      await answer(services, token, callbackQuery, '⚠️ No channel selected.');
      return okResponse();
    }
    const copyContext = {
      env,
      config: config ?? {},
      services,
      message: {
        ...(callbackQuery?.message ?? {}),
        from: callbackQuery?.from
      },
      chatId: String(callbackQuery?.message?.chat?.id ?? ''),
      threadId: optionalId(session.sourceThreadId),
      token
    };
    await answer(services, token, callbackQuery, '✅ 已翻页');
    await sendForwardCopyPage(
      copyContext, sessionId, session, parsePage(action.slice(1))
    );
    return okResponse();
  }

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

async function handleMenu(context) {
  const activeKey = uiActiveKey(context);
  const previousSessionId = await context.env.DB.get(activeKey);
  if (previousSessionId) {
    await context.env.DB.delete(UI_SESSION_PREFIX + String(previousSessionId));
  }

  const sessionId = createUiSessionId(context.services);
  const now = Math.floor(Date.now() / 1000);
  const session = {
    v: 1,
    sourceChatId: context.chatId,
    sourceThreadId: context.threadId,
    initiatorUserId: String(context.message.from.id),
    createdAt: now,
    expiresAt: now + UI_SESSION_TTL_SECONDS
  };
  await context.env.DB.put(
    UI_SESSION_PREFIX + sessionId,
    JSON.stringify(session),
    { expirationTtl: UI_SESSION_TTL_SECONDS }
  );
  await context.env.DB.put(
    activeKey,
    sessionId,
    { expirationTtl: UI_SESSION_TTL_SECONDS }
  );
  await sendUiHome(context, sessionId);
}

async function handleUiCallback(
  callbackQuery,
  env,
  config,
  services,
  token
) {
  const data = String(callbackQuery?.data ?? '');
  const byteLength = new TextEncoder().encode(data).length;
  const match = /^ui:([A-Za-z0-9_-]{1,24}):([A-Za-z0-9:]+)$/.exec(data);
  if (!match || byteLength > 64) {
    await answer(services, token, callbackQuery, '❌ 无效操作。');
    return okResponse();
  }

  const sessionId = match[1];
  const action = match[2];
  if (!isRecognizedUiAction(action)) {
    await answer(services, token, callbackQuery, '❌ 无效操作。');
    return okResponse();
  }

  const sessionKey = UI_SESSION_PREFIX + sessionId;
  const session = parseStoredObject(await env.DB.get(sessionKey));
  if (!isValidUiSession(session)) {
    await env.DB.delete(sessionKey);
    await answer(services, token, callbackQuery, '⌛ 菜单已过期，请发送 /menu。');
    return okResponse();
  }

  const message = {
    ...(callbackQuery?.message ?? {}),
    from: callbackQuery?.from
  };
  const context = {
    env,
    config: config ?? {},
    services,
    message,
    chatId: String(callbackQuery?.message?.chat?.id ?? ''),
    threadId: optionalId(callbackQuery?.message?.message_thread_id),
    token
  };
  const activeSessionId = await env.DB.get(uiActiveKey(context));
  if (
    String(activeSessionId ?? '') !== sessionId ||
    !uiSessionMatches(session, context)
  ) {
    await answer(services, token, callbackQuery, '⌛ 菜单已过期，请发送 /menu。');
    return okResponse();
  }

  if (!await canManageContext(context)) {
    await expireUiSession(context, sessionId);
    await answer(services, token, callbackQuery, '⛔ 管理权限已失效。');
    return okResponse();
  }

  await answer(services, token, callbackQuery, '✅ 已打开');
  await dispatchUiAction(context, sessionId, action);
  return okResponse();
}

async function dispatchUiAction(context, sessionId, action) {
  if (action === 'h') {
    await sendUiHome(context, sessionId);
    return;
  }
  if (action === 'a') {
    await sendUiAddMenu(context, sessionId);
    return;
  }
  if (action === 'id') {
    await handleId(context);
    return;
  }
  if (action === 'help') {
    await send(
      context,
      HELP_MESSAGE,
      { inline_keyboard: [[uiButton('🏠 主菜单', sessionId, 'h')]] }
    );
    return;
  }
  if (action === 'cp') {
    await beginUiInput(
      context,
      sessionId,
      { action: 'copy_subscriptions_target' },
      '📋 <b>复制订阅</b>\n\n请回复目标 <code>Chat ID</code>，' +
        '可选追加 <code>Topic ID</code>。\n' +
        '例如：<code>-100123456789 42</code>\n\n发送 /cancel 取消。'
    );
    return;
  }
  if (action === 'ic') {
    await clearUiInput(context);
    await sendUiHome(context, sessionId);
    return;
  }

  let match = /^at:([rxy])$/.exec(action);
  if (match) {
    const type = match[1] === 'r'
      ? 'rss'
      : (match[1] === 'x' ? 'x' : 'youtube');
    const label = type === 'rss'
      ? '完整 RSS/Atom URL'
      : (type === 'x' ? 'X 用户名（不需要 @）' : 'YouTube 频道名称');
    await beginUiInput(
      context,
      sessionId,
      { action: 'add_subscription', subscriptionType: type },
      '➕ <b>添加 ' + safe(type.toUpperCase()) + ' 订阅</b>\n\n' +
        '请回复' + label + '。\n\n发送 /cancel 取消。'
    );
    return;
  }

  match = /^l:(\d+)$/.exec(action);
  if (match) {
    await sendUiSubscriptionList(
      context,
      sessionId,
      parsePage(match[1]),
      false
    );
    return;
  }
  match = /^fl:(\d+)$/.exec(action);
  if (match) {
    await sendUiSubscriptionList(
      context,
      sessionId,
      parsePage(match[1]),
      true
    );
    return;
  }
  match = /^s:([1-9]\d{0,15}):(\d{1,6})$/.exec(action);
  if (match) {
    await sendUiSubscriptionDetail(
      context,
      sessionId,
      parseSafeId(match[1]),
      parsePage(match[2])
    );
    return;
  }
  match = /^f:([1-9]\d{0,15}):(\d{1,6})$/.exec(action);
  if (match) {
    await sendUiRoutingDetail(
      context,
      sessionId,
      parseSafeId(match[1]),
      parsePage(match[2])
    );
    return;
  }
  match = /^dc:([1-9]\d{0,15}):(\d{1,6})$/.exec(action);
  if (match) {
    await sendUiDeleteConfirmation(
      context,
      sessionId,
      parseSafeId(match[1]),
      parsePage(match[2])
    );
    return;
  }
  match = /^dx:([1-9]\d{0,15}):(\d{1,6})$/.exec(action);
  if (match) {
    await confirmUiSubscriptionDelete(
      context,
      sessionId,
      parseSafeId(match[1]),
      parsePage(match[2])
    );
    return;
  }
  match = /^fa:([1-9]\d{0,15})$/.exec(action);
  if (match) {
    await beginUiInput(
      context,
      sessionId,
      {
        action: 'add_forward_target',
        subscriptionId: parseSafeId(match[1])
      },
      '📨 <b>添加独立转发目标</b>\n\n请回复目标 ' +
        '<code>Chat ID</code>，可选追加 <code>Topic ID</code>。\n' +
        '例如：<code>-100123456789 42</code>\n\n发送 /cancel 取消。'
    );
    return;
  }
  match = /^fi:([1-9]\d{0,15}):([01])$/.exec(action);
  if (match) {
    await updateUiIncludeSource(
      context,
      sessionId,
      parseSafeId(match[1]),
      match[2] === '1'
    );
    return;
  }
  match = /^fs:([1-9]\d{0,15})$/.exec(action);
  if (match) {
    await setUiSourceOnly(
      context,
      sessionId,
      parseSafeId(match[1])
    );
    return;
  }
  match = /^fd:([1-9]\d{0,15}):([1-9]\d{0,15})$/.exec(action);
  if (match) {
    await removeUiForwardTarget(
      context,
      sessionId,
      parseSafeId(match[1]),
      parseSafeId(match[2])
    );
    return;
  }
  match = /^rc:([1-9]\d{0,15})$/.exec(action);
  if (match) {
    await sendUiResetRoutingConfirmation(
      context,
      sessionId,
      parseSafeId(match[1])
    );
    return;
  }
  match = /^rx:([1-9]\d{0,15})$/.exec(action);
  if (match) {
    await confirmUiResetRouting(
      context,
      sessionId,
      parseSafeId(match[1])
    );
  }
}

function isRecognizedUiAction(action) {
  return /^(?:h|a|id|help|cp|ic)$/.test(action) ||
    /^at:[rxy]$/.test(action) ||
    /^(?:l|fl):\d{1,6}$/.test(action) ||
    /^(?:s|f|dc|dx):[1-9]\d{0,15}:\d{1,6}$/.test(action) ||
    /^(?:fa|fs|rc|rx):[1-9]\d{0,15}$/.test(action) ||
    /^fi:[1-9]\d{0,15}:[01]$/.test(action) ||
    /^fd:[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(action);
}

function isValidUiSession(session) {
  return Boolean(
    session &&
    session.v === 1 &&
    session.sourceChatId !== undefined &&
    session.initiatorUserId !== undefined &&
    Number(session.expiresAt) > Math.floor(Date.now() / 1000)
  );
}

function uiSessionMatches(session, context) {
  return (
    String(session.sourceChatId) === context.chatId &&
    String(session.sourceThreadId ?? '') === String(context.threadId ?? '') &&
    String(session.initiatorUserId) === String(context.message?.from?.id ?? '')
  );
}

async function expireUiSession(context, sessionId) {
  await context.env.DB.delete(UI_SESSION_PREFIX + sessionId);
  const activeKey = uiActiveKey(context);
  const active = await context.env.DB.get(activeKey);
  if (String(active ?? '') === sessionId) {
    await context.env.DB.delete(activeKey);
  }
  await clearUiInput(context);
}

function createUiSessionId(services) {
  return createSessionId(services).slice(0, 24);
}

function uiCallback(sessionId, action) {
  const data = 'ui:' + sessionId + ':' + action;
  if (new TextEncoder().encode(data).length > 64) {
    throw new TypeError('UI callback data exceeds Telegram limit');
  }
  return data;
}

function uiButton(text, sessionId, action) {
  return {
    text: truncatePlain(text, 64),
    callback_data: uiCallback(sessionId, action)
  };
}

function parsePage(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseSafeId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('Invalid safe identifier');
  }
  return parsed;
}

async function sendUiHome(context, sessionId) {
  const subscriptions = await scopedSubscriptions(context);
  const scope = context.threadId === null
    ? '当前聊天'
    : 'Topic #' + safe(context.threadId);
  const text = '📰 <b>RSS 订阅管理</b>\n\n' +
    '<b>当前范围：</b>' + scope + '\n' +
    '<b>订阅数量：</b>' + subscriptions.length + '\n\n' +
    '“消息转发”控制新文章发送到哪里；\n' +
    '“复制订阅”会把订阅配置复制到其他聊天。';
  const keyboard = {
    inline_keyboard: [
      [
        uiButton('➕ 添加订阅', sessionId, 'a'),
        uiButton('📚 管理订阅', sessionId, 'l:0')
      ],
      [
        uiButton('📨 消息转发', sessionId, 'fl:0'),
        uiButton('📋 复制订阅', sessionId, 'cp')
      ],
      [
        uiButton('🆔 当前 ID', sessionId, 'id'),
        uiButton('❓ 帮助', sessionId, 'help')
      ]
    ]
  };
  await send(context, text, keyboard);
}

async function sendUiAddMenu(context, sessionId) {
  await send(
    context,
    '➕ <b>添加订阅</b>\n\n请选择订阅类型：',
    {
      inline_keyboard: [
        [uiButton('🌐 RSS / Atom', sessionId, 'at:r')],
        [
          uiButton('𝕏 X', sessionId, 'at:x'),
          uiButton('▶️ YouTube', sessionId, 'at:y')
        ],
        [uiButton('🏠 主菜单', sessionId, 'h')]
      ]
    }
  );
}

async function sendUiSubscriptionList(
  context,
  sessionId,
  requestedPage,
  forwarding
) {
  const subscriptions = await scopedSubscriptions(context);
  const totalPages = Math.max(1, Math.ceil(subscriptions.length / UI_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  const visible = subscriptions.slice(
    page * UI_PAGE_SIZE,
    (page + 1) * UI_PAGE_SIZE
  );
  const title = forwarding
    ? '📨 <b>分别管理消息转发</b>'
    : '📚 <b>管理订阅</b>';
  let text = title + '\n\n';
  if (subscriptions.length === 0) {
    text += '当前范围还没有订阅。';
  } else {
    text += '共 ' + subscriptions.length + ' 条 · 第 ' +
      (page + 1) + '/' + totalPages + ' 页\n';
    text += forwarding
      ? '请选择一条订阅设置独立转发目标。'
      : '请选择一条订阅查看详情。';
  }

  const rows = visible.map((subscription) => [
    uiButton(
      subscriptionButtonLabel(subscription, context.services),
      sessionId,
      (forwarding ? 'f:' : 's:') + subscriptionId(subscription) + ':' + page
    )
  ]);
  const navigation = [];
  if (page > 0) {
    navigation.push(
      uiButton(
        '⬅ 上一页',
        sessionId,
        (forwarding ? 'fl:' : 'l:') + (page - 1)
      )
    );
  }
  if (page + 1 < totalPages) {
    navigation.push(
      uiButton(
        '下一页 ➡',
        sessionId,
        (forwarding ? 'fl:' : 'l:') + (page + 1)
      )
    );
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }
  rows.push([
    uiButton('➕ 添加订阅', sessionId, 'a'),
    uiButton('🏠 主菜单', sessionId, 'h')
  ]);
  await send(context, text, { inline_keyboard: rows });
}

async function sendUiSubscriptionDetail(
  context,
  sessionId,
  id,
  page
) {
  const subscription = await findScopedSubscription(context, id);
  if (!subscription) {
    await send(
      context,
      '⚠️ 订阅 #' + id + ' 已不存在。',
      { inline_keyboard: [[uiButton('⬅ 返回列表', sessionId, 'l:' + page)]] }
    );
    return;
  }
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    routingScope(context, id)
  );
  const text = '📰 <b>' +
    safe('[' + subscriptionType(subscription, context.services).toUpperCase() + '] ') +
    safe(subscriptionDisplayName(subscription, context.services), 200) +
    '</b>\n\n' +
    '<b>订阅 ID：</b><code>#' + id + '</code>\n' +
    '<b>投递模式：</b>' +
    (routing?.independent ? '独立规则' : '继承聊天/Topic 规则') + '\n\n' +
    'Feed 地址的 path 与 query 会继续隐藏。';
  await send(context, text, {
    inline_keyboard: [
      [uiButton('📨 管理此订阅的转发', sessionId, 'f:' + id + ':' + page)],
      [uiButton('🗑 删除订阅', sessionId, 'dc:' + id + ':' + page)],
      [
        uiButton('⬅ 返回列表', sessionId, 'l:' + page),
        uiButton('🏠 主菜单', sessionId, 'h')
      ]
    ]
  });
}

async function sendUiDeleteConfirmation(
  context,
  sessionId,
  id,
  page
) {
  const subscription = await findScopedSubscription(context, id);
  if (!subscription) {
    await send(context, '⚠️ 订阅 #' + id + ' 已不存在。');
    return;
  }
  await send(
    context,
    '⚠️ <b>确认删除订阅？</b>\n\n' +
      subscriptionListLine(subscription, context.services) + '\n\n' +
      '删除会停止未来抓取和入队；已经进入 Outbox 的消息不会被撤回。',
    {
      inline_keyboard: [[
        uiButton('🗑 确认删除', sessionId, 'dx:' + id + ':' + page),
        uiButton('取消', sessionId, 's:' + id + ':' + page)
      ]]
    }
  );
}

async function confirmUiSubscriptionDelete(
  context,
  sessionId,
  id,
  page
) {
  const removed = await context.services.removeSubscriptions(
    context.env,
    {
      id,
      chatId: context.chatId,
      threadId: context.threadId
    }
  );
  await send(
    context,
    removed > 0
      ? '🗑️ 已删除订阅 #' + id + '。'
      : '⚠️ 订阅 #' + id + ' 已不存在。'
  );
  await sendUiSubscriptionList(context, sessionId, page, false);
}

async function sendUiRoutingDetail(
  context,
  sessionId,
  id,
  page
) {
  const subscription = await findScopedSubscription(context, id);
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    routingScope(context, id)
  );
  if (!subscription || !routing) {
    await send(context, '⚠️ 订阅 #' + id + ' 已不存在。');
    return;
  }

  const effective = routing.independent
    ? {
        includeSource: routing.includeSource,
        targets: routing.targets
      }
    : await inheritedRoutingSnapshot(context);
  let text = '📨 <b>消息转发规则</b>\n\n' +
    '<b>订阅：</b>' + subscriptionListLine(subscription, context.services) + '\n' +
    '<b>模式：</b>' +
    (routing.independent ? '独立规则' : '继承聊天/Topic 规则') + '\n' +
    '<b>源会话：</b>' +
    (effective.includeSource ? '保留投递' : '不投递') + '\n';
  if (effective.targets.length === 0) {
    text += '<b>独立目标：</b>无\n';
  } else {
    text += '<b>目标：</b>\n' + effective.targets.map((target, index) =>
      '• ' + (index + 1) + '. ' + formatTarget(target)
    ).join('\n') + '\n';
  }
  if (!routing.independent) {
    text += effective.targets.length > 0
      ? '\n普通修改会以当前规则为起点；“仅源会话”会停止继承默认目标。'
      : '\n首次修改会以当前有效投递效果为起点，然后切换为独立规则。';
  }
  text += '\n\n修改只影响未来入队的文章。';

  const rows = [[uiButton('➕ 添加目标', sessionId, 'fa:' + id)]];
  rows.push([
    uiButton(
      effective.includeSource ? '🚫 不再投递到源会话' : '✅ 恢复源会话投递',
      sessionId,
      'fi:' + id + ':' + (effective.includeSource ? '0' : '1')
    )
  ]);
  if (!routing.independent && effective.targets.length > 0) {
    rows.push([
      uiButton('🛑 仅源会话（停止继承）', sessionId, 'fs:' + id)
    ]);
  }
  if (routing.independent) {
    for (const target of routing.targets) {
      rows.push([
        uiButton(
          '🗑 ' + formatTargetPlain(target),
          sessionId,
          'fd:' + id + ':' + target.id
        )
      ]);
    }
    rows.push([
      uiButton('↩️ 恢复继承聊天规则', sessionId, 'rc:' + id)
    ]);
  }
  rows.push([
    uiButton('⬅ 订阅详情', sessionId, 's:' + id + ':' + page),
    uiButton('🏠 主菜单', sessionId, 'h')
  ]);
  await send(context, text, { inline_keyboard: rows });
}

async function updateUiIncludeSource(
  context,
  sessionId,
  id,
  includeSource
) {
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    routingScope(context, id)
  );
  if (!routing) {
    await send(context, '⚠️ 订阅 #' + id + ' 已不存在。');
    return;
  }
  if (
    routing.independent &&
    routing.includeSource === includeSource
  ) {
    await send(
      context,
      includeSource
        ? 'ℹ️ 源会话投递已经开启。'
        : 'ℹ️ 源会话投递已经关闭。'
    );
    await sendUiRoutingDetail(context, sessionId, id, 0);
    return;
  }


  let changed;
  if (routing.independent) {
    changed = await context.services.setSubscriptionIncludeSource(
      context.env,
      routingScope(context, id),
      includeSource
    );
  } else {
    const snapshot = await inheritedRoutingSnapshot(context);
    snapshot.includeSource = includeSource;
    if (!includeSource && snapshot.targets.length === 0) {
      await send(context, '⚠️ 请先添加至少一个转发目标，再关闭源会话投递。');
      await sendUiRoutingDetail(context, sessionId, id, 0);
      return;
    }
    const result = await context.services.initializeSubscriptionRouting(
      context.env,
      routingScope(context, id),
      snapshot
    );
    changed = result.created || result.targetsAdded > 0;
  }

  if (!changed && !includeSource) {
    await send(context, '⚠️ 请先添加至少一个转发目标，再关闭源会话投递。');
  } else {
    await send(
      context,
      includeSource
        ? '✅ 已恢复源会话投递。'
        : '✅ 之后的新文章将不再投递到源会话。'
    );
  }
  await sendUiRoutingDetail(context, sessionId, id, 0);
}
async function setUiSourceOnly(context, sessionId, id) {
  const scope = routingScope(context, id);
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    scope
  );
  if (!routing) {
    await send(context, '⚠️ 订阅 #' + id + ' 已不存在。');
    return;
  }
  if (routing.independent) {
    await send(
      context,
      routing.includeSource && routing.targets.length === 0
        ? 'ℹ️ 该订阅已经仅投递到源会话。'
        : 'ℹ️ 该订阅已经使用独立规则，请直接管理它的目标。'
    );
    await sendUiRoutingDetail(context, sessionId, id, 0);
    return;
  }

  const result = await context.services.initializeSubscriptionRouting(
    context.env,
    scope,
    { includeSource: true, targets: [] }
  );
  await send(
    context,
    result.created
      ? '✅ 已停止继承默认转发；之后仅投递到源会话。'
      : 'ℹ️ 转发规则刚刚发生变化，请按下面的最新状态继续管理。'
  );
  await sendUiRoutingDetail(context, sessionId, id, 0);
}


async function removeUiForwardTarget(
  context,
  sessionId,
  subscriptionIdValue,
  targetId
) {
  const removed = await context.services.removeSubscriptionForwardTarget(
    context.env,
    {
      ...routingScope(context, subscriptionIdValue),
      targetId
    }
  );
  await send(
    context,
    removed
      ? '🗑️ 已删除该转发目标。'
      : '⚠️ 无法删除：目标已不存在，或它是关闭源投递后的最后一个目标。'
  );
  await sendUiRoutingDetail(context, sessionId, subscriptionIdValue, 0);
}

async function sendUiResetRoutingConfirmation(
  context,
  sessionId,
  id
) {
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    routingScope(context, id)
  );
  if (!routing?.independent) {
    await send(context, 'ℹ️ 该订阅已经在继承聊天/Topic 规则。');
    return;
  }
  await send(
    context,
    '⚠️ <b>恢复继承聊天规则？</b>\n\n' +
      '这会删除此订阅的全部独立目标和源投递设置。\n' +
      '之后它会重新跟随 /set_forward 的当前规则。',
    {
      inline_keyboard: [[
        uiButton('↩️ 确认恢复继承', sessionId, 'rx:' + id),
        uiButton('取消', sessionId, 'f:' + id + ':0')
      ]]
    }
  );
}

async function confirmUiResetRouting(context, sessionId, id) {
  const removed = await context.services.resetSubscriptionRouting(
    context.env,
    routingScope(context, id)
  );
  await send(
    context,
    removed > 0
      ? '✅ 已恢复继承聊天/Topic 转发规则。'
      : 'ℹ️ 该订阅已在继承规则，或已经不存在。'
  );
  await sendUiRoutingDetail(context, sessionId, id, 0);
}

async function scopedSubscriptions(context) {
  return context.services.listSubscriptions(context.env, {
    chatId: context.chatId,
    threadId: context.threadId
  });
}

async function findScopedSubscription(context, id) {
  const subscriptions = await scopedSubscriptions(context);
  return subscriptions.find((subscription) => subscriptionId(subscription) === id) ?? null;
}

function routingScope(context, id) {
  return {
    subscriptionId: id,
    chatId: context.chatId,
    threadId: context.threadId
  };
}

function subscriptionButtonLabel(subscription, services) {
  return truncatePlain(
    '[' + subscriptionType(subscription, services).toUpperCase() + '] ' +
      subscriptionDisplayName(subscription, services),
    60
  );
}

function formatTarget(target) {
  let text = '<code>' + safe(target.chatId) + '</code>';
  if (target.threadId !== null && target.threadId !== undefined) {
    text += ' · Topic <code>' + safe(target.threadId) + '</code>';
  }
  return text;
}

function formatTargetPlain(target) {
  let text = String(target.chatId);
  if (target.threadId !== null && target.threadId !== undefined) {
    text += ' · Topic ' + String(target.threadId);
  }
  return truncatePlain(text, 55);
}

async function beginUiInput(
  context,
  sessionId,
  fields,
  prompt
) {
  await context.env.DB.delete(uiInputKey(context));

  const result = await send(
    context,
    prompt,
    {
      force_reply: true,
      input_field_placeholder: '回复此消息，或发送 /cancel'
    }
  );
  if (result?.ok !== true) {
    return;
  }

  const promptMessageId = optionalId(result?.result?.message_id);
  if (
    context.message?.chat?.type !== 'private' &&
    promptMessageId === null
  ) {
    await send(
      context,
      '⚠️ 无法建立安全的群聊输入会话，请重新打开 /menu 后再试。'
    );
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const input = {
    v: 1,
    ...fields,
    menuSessionId: sessionId,
    sourceChatId: context.chatId,
    sourceThreadId: context.threadId,
    initiatorUserId: String(context.message.from.id),
    promptMessageId,
    createdAt: now,
    expiresAt: now + UI_INPUT_TTL_SECONDS
  };
  await context.env.DB.put(
    uiInputKey(context),
    JSON.stringify(input),
    { expirationTtl: UI_INPUT_TTL_SECONDS }
  );
}

async function handleUiTextInput(context, text) {
  const key = uiInputKey(context);
  const input = parseStoredObject(await context.env.DB.get(key));
  if (!isValidUiInput(input) || !uiInputMatches(input, context)) {
    if (input) {
      await context.env.DB.delete(key);
    }
    return false;
  }

  const menuSession = parseStoredObject(
    await context.env.DB.get(UI_SESSION_PREFIX + input.menuSessionId)
  );
  const activeSession = await context.env.DB.get(uiActiveKey(context));
  if (
    !isValidUiSession(menuSession) ||
    !uiSessionMatches(menuSession, context) ||
    String(activeSession ?? '') !== String(input.menuSessionId)
  ) {
    await context.env.DB.delete(key);
    return false;
  }

  const isPrivate = context.message?.chat?.type === 'private';
  const replyMessageId = optionalId(
    context.message?.reply_to_message?.message_id
  );
  if (
    !isPrivate &&
    input.promptMessageId === null
  ) {
    await context.env.DB.delete(key);
    await send(
      context,
      '⚠️ 群聊输入会话无法验证回复来源，已取消；请重新打开 /menu。'
    );
    return true;
  }

  if (
    !isPrivate &&
    input.promptMessageId !== null &&
    replyMessageId !== input.promptMessageId
  ) {
    return false;
  }

  if (!await canManageContext(context)) {
    await context.env.DB.delete(key);
    await expireUiSession(context, input.menuSessionId);
    await send(context, '⛔ 管理权限已失效，输入会话已取消。');
    return true;
  }

  if (input.action === 'add_subscription') {
    const result = await handleAdd(
      context,
      [input.subscriptionType, text]
    );
    if (result === 'invalid') {
      return true;
    }
    await context.env.DB.delete(key);
    await send(context, '下一步：', {
      inline_keyboard: [
        [
          uiButton('📚 查看订阅', input.menuSessionId, 'l:0'),
          uiButton('➕ 继续添加', input.menuSessionId, 'a')
        ],
        [uiButton('🏠 主菜单', input.menuSessionId, 'h')]
      ]
    });
    return true;
  }

  if (input.action === 'add_forward_target') {
    const complete = await handleUiForwardTargetInput(
      context,
      input.menuSessionId,
      input.subscriptionId,
      text
    );
    if (complete) {
      await context.env.DB.delete(key);
    }
    return true;
  }

  if (input.action === 'copy_subscriptions_target') {
    const target = parseTargetInput(text);
    if (!target) {
      await send(
        context,
        '⚠️ 格式无效。请回复：<code>&lt;Chat ID&gt; [Topic ID]</code>'
      );
      return true;
    }
    if (!await authorizeTargetChat(context, target.chatId)) {
      await send(context, '⛔ 你没有目标聊天的管理权限，请重新输入。');
      return true;
    }
    await context.env.DB.delete(key);
    await startForwardCopySession(
      context,
      target.chatId,
      target.threadId
    );
    return true;
  }

  await context.env.DB.delete(key);
  return false;
}

async function handleUiForwardTargetInput(
  context,
  sessionId,
  subscriptionIdValue,
  text
) {
  const target = parseTargetInput(text);
  if (!target) {
    await send(
      context,
      '⚠️ 格式无效。请回复：<code>&lt;Chat ID&gt; [Topic ID]</code>'
    );
    return false;
  }
  if (
    target.chatId === context.chatId &&
    String(target.threadId ?? '') === String(context.threadId ?? '')
  ) {
    await send(
      context,
      '⚠️ 目标与源会话相同。请使用“源会话投递”开关管理它。'
    );
    return false;
  }
  if (!await authorizeTargetChat(context, target.chatId)) {
    await send(context, '⛔ 你没有目标聊天的管理权限，请重新输入。');
    return false;
  }

  const scope = routingScope(context, subscriptionIdValue);
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    scope
  );
  if (!routing) {
    await send(context, '⚠️ 订阅 #' + subscriptionIdValue + ' 已不存在。');
    return true;
  }
  if (
    routing.independent &&
    routing.targets.some((existing) => sameTarget(existing, target))
  ) {
    await send(context, 'ℹ️ 该目标已经存在。');
    await sendUiRoutingDetail(
      context,
      sessionId,
      subscriptionIdValue,
      0
    );
    return true;
  }

  if (
    routing.independent &&
    routing.targets.length >= MAX_FORWARD_TARGETS
  ) {
    await send(
      context,
      '⚠️ 每条订阅最多 ' + MAX_FORWARD_TARGETS + ' 个独立目标。'
    );
    return true;
  }

  let added = false;
  if (routing.independent) {
    added = await context.services.addSubscriptionForwardTarget(
      context.env,
      scope,
      target
    );
  } else {
    const snapshot = await inheritedRoutingSnapshot(context);
    const alreadyPresent = snapshot.targets.some((existing) =>
      sameTarget(existing, target)
    );
    if (alreadyPresent) {
      await send(
        context,
        'ℹ️ 该目标已由默认规则提供，订阅仍保持继承。'
      );
      await sendUiRoutingDetail(
        context,
        sessionId,
        subscriptionIdValue,
        0
      );
      return true;
    }
    snapshot.targets.push(target);
    const result = await context.services.initializeSubscriptionRouting(
      context.env,
      scope,
      snapshot
    );
    added = result.targetsAdded > 0;
  }

  await send(
    context,
    added
      ? '✅ 已添加独立转发目标：' + formatTarget(target)
      : 'ℹ️ 该目标已经存在，或目标数量已达到上限。'
  );
  await sendUiRoutingDetail(
    context,
    sessionId,
    subscriptionIdValue,
    0
  );
  return true;
}

async function inheritedRoutingSnapshot(context) {
  const config = await readEffectiveLegacyForwardConfig(context);
  if (!config) {
    return { includeSource: true, targets: [] };
  }
  const target = {
    chatId: config.targetChatId,
    threadId: config.targetThreadId
  };
  if (sameTarget(target, {
    chatId: context.chatId,
    threadId: context.threadId
  })) {
    return { includeSource: true, targets: [] };
  }
  return {
    includeSource: !config.onlyForward,
    targets: [target]
  };
}

async function readEffectiveLegacyForwardConfig(context) {
  const hasThread = context.threadId !== null;
  if (hasThread) {
    const topic = normalizeLegacyForwardConfig(
      parseStoredObject(
        await context.env.DB.get(
          'forward_config:' + context.chatId + ':' + context.threadId
        )
      )
    );
    if (topic) {
      return topic;
    }
  }

  const global = normalizeLegacyForwardConfig(
    parseStoredObject(
      await context.env.DB.get('forward_config:' + context.chatId)
    )
  );
  if (global && (!hasThread || global.isGlobal)) {
    return global;
  }
  return null;
}

function normalizeLegacyForwardConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const targetChatId = parseChatId(
    value.targetChatId ?? value.target_chat_id
  );
  const rawThreadId = value.targetThreadId ?? value.target_thread_id;
  const targetThreadId =
    rawThreadId === null || rawThreadId === undefined || rawThreadId === ''
      ? null
      : parseThreadId(rawThreadId);
  if (!targetChatId || (rawThreadId != null && rawThreadId !== '' && !targetThreadId)) {
    return null;
  }
  return {
    targetChatId,
    targetThreadId,
    onlyForward: value.onlyForward === true,
    isGlobal: value.isGlobal === true
  };
}

function sameTarget(left, right) {
  return String(left?.chatId ?? '') === String(right?.chatId ?? '') &&
    String(left?.threadId ?? '') === String(right?.threadId ?? '');
}

function parseTargetInput(text) {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) {
    return null;
  }
  const chatId = parseChatId(parts[0]);
  const threadId = parts.length === 2 ? parseThreadId(parts[1]) : null;
  if (!chatId || (parts.length === 2 && !threadId)) {
    return null;
  }
  return { chatId, threadId };
}

function isValidUiInput(input) {
  return Boolean(
    input &&
    input.v === 1 &&
    typeof input.action === 'string' &&
    typeof input.menuSessionId === 'string' &&
    Number(input.expiresAt) > Math.floor(Date.now() / 1000)
  );
}

function uiInputMatches(input, context) {
  return (
    String(input.sourceChatId) === context.chatId &&
    String(input.sourceThreadId ?? '') === String(context.threadId ?? '') &&
    String(input.initiatorUserId) === String(context.message?.from?.id ?? '')
  );
}

function parseStoredObject(raw) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function uiScopeKey(context) {
  return context.chatId + ':' +
    (context.threadId === null ? '_' : context.threadId) + ':' +
    String(context.message?.from?.id ?? '');
}

function uiActiveKey(context) {
  return UI_ACTIVE_PREFIX + uiScopeKey(context);
}

function uiInputKey(context) {
  return UI_INPUT_PREFIX + uiScopeKey(context);
}

async function clearUiInput(context) {
  if (
    context?.message?.from?.id === null ||
    context?.message?.from?.id === undefined
  ) {
    return;
  }
  const key = uiInputKey(context);
  const existing = await context.env.DB.get(key);
  if (existing !== null && existing !== undefined) {
    await context.env.DB.delete(key);
  }
}

async function handleCancel(context) {
  await clearUiInput(context);
  await send(context, '✅ 已取消当前输入。发送 /menu 返回主菜单。');
}

async function canManageContext(context) {
  return context.services.canManageChat({
    message: context.message,
    config: context.config,
    getChatMemberFn: (chatId, userId) =>
      lookupChatMember(context, chatId, userId)
  });
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
    return 'invalid';
  }

  const type = String(args[0]).toLowerCase();
  const argument = String(args[1]);
  if (!TYPES.has(type)) {
    await send(context, 'Unknown type. Use rss, x, or youtube.');
    return 'invalid';
  }
  if (type !== 'rss' && args.length !== 2) {
    await send(
      context,
      '⚠️ Username or channel name must be one value without whitespace.'
    );
    return 'invalid';
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
    return 'invalid';
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
  return added ? 'added' : 'duplicate';
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
  text += '\nOnly Forward: ' + onlyForward + '\nScope: ' + scope +
    '\n\nℹ️ 已有独立规则的订阅不会受此默认规则影响；' +
    '可在 /menu 中恢复继承。';
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
  await send(
    context,
    '✅ Forwarding configuration removed for scope: ' + scope + '.\n' +
      'ℹ️ 已有独立规则的订阅保持不变。'
  );
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

  await startForwardCopySession(context, targetChatId, targetThreadId);
}

async function startForwardCopySession(
  context,
  targetChatId,
  targetThreadId
) {
  const current = await context.services.listSubscriptions(context.env, {
    chatId: context.chatId,
    threadId: context.threadId
  });
  if (current.length === 0) {
    await send(context, '⚠️ No subscriptions found in this chat to forward.');
    return;
  }

  const sessionId = createSessionId(context.services).slice(0, 48);
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
  await sendForwardCopyPage(context, sessionId, session, 0);
}

async function sendForwardCopyPage(
  context,
  sessionId,
  session,
  requestedPage
) {
  const available = Array.isArray(session.subMap) ? session.subMap : [];
  const pageCount = Math.max(
    1,
    Math.ceil(available.length / FORWARD_COPY_PAGE_SIZE)
  );
  const page = Math.min(parsePage(requestedPage), pageCount - 1);
  const start = page * FORWARD_COPY_PAGE_SIZE;
  const visible = available.slice(start, start + FORWARD_COPY_PAGE_SIZE);
  const rows = [
    [{ text: '🚀 复制全部', callback_data: 'fwd:' + sessionId + ':ALL' }],
    ...visible.map((subscription, offset) => [{
        text: truncatePlain(
          '📋 [' + String(subscription?.type ?? '').toLowerCase() +
            '] ' + String(subscription?.channelName ?? ''),
          64
        ),
        callback_data: 'fwd:' + sessionId + ':' + (start + offset)
      }])
  ];
  const navigation = [];
  if (page > 0) {
    navigation.push({
      text: '⬅ 上一页',
      callback_data: 'fwd:' + sessionId + ':P' + (page - 1)
    });
  }
  if (page + 1 < pageCount) {
    navigation.push({
      text: '下一页 ➡',
      callback_data: 'fwd:' + sessionId + ':P' + (page + 1)
    });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }

  const text = '📋 <b>复制订阅</b>\n\n' +
    '<b>目标 Chat ID：</b><code>' + safe(session.targetChatId) + '</code>\n' +
    (session.targetThreadId !== null
      ? '<b>目标 Topic ID：</b><code>' +
        safe(session.targetThreadId) + '</code>\n'
      : '') +
    '<b>列表：</b>第 ' + (page + 1) + '/' + pageCount +
      ' 页，共 ' + available.length + ' 条\n' +
    '\n请选择要复制到目标会话的订阅；复制后两边会独立管理：';
  await send(context, text, { inline_keyboard: rows });
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

const HELP_MESSAGE = '📖 <b>使用帮助</b>\n\n' +
  '发送 /menu 打开可视化管理菜单，无需记住下面的参数。\n\n' +
  '<b>1. 添加订阅</b>\n' +
  '菜单：点击“添加订阅”后直接回复 URL 或用户名。\n' +
  '快捷命令：<code>/add &lt;type&gt; &lt;arg&gt;</code>\n' +
  '- RSS: <code>/add rss https://example.com/feed.xml</code>\n' +
  '- X: <code>/add x username</code>\n' +
  '- YouTube: <code>/add youtube username</code>\n\n' +
  '<b>2. 消息转发规则</b>\n' +
  '菜单支持每条订阅分别设置最多 10 个目标、源会话投递、' +
  '停止继承并仅投递源会话，或恢复继承。\n' +
  '聊天/Topic 默认规则仍可使用：\n' +
  '<code>/set_forward &lt;target_chat_id&gt; [target_thread_id] [only_forward] [scope]</code>\n' +
  '删除默认规则：<code>/del_forward [scope]</code>。\n\n' +
  '<b>3. 复制订阅（不是消息转发）</b>\n' +
  '菜单会引导输入目标；快捷命令：\n' +
  '<code>/forward_to &lt;target_chat_id&gt; [target_thread_id]</code>\n\n' +
  '<b>4. 其他快捷命令</b>\n' +
  '- 列表：<code>/list</code>\n' +
  '- 删除：<code>/del #123</code>\n' +
  '- 当前 ID：<code>/id</code>\n' +
  '- 取消输入：<code>/cancel</code>';
