import {
  acquireOperationalLease,
  applyOperationalStateChanges,
  addSubscriptionForwardTarget,
  addSubscription,
  copySubscriptions,
  getSubscriptionRouting,
  initializeSubscriptionRouting,
  listSubscriptions,
  removeSubscriptionForwardTarget,
  removeSubscriptions,
  readOperationalState,
  renewOperationalLease,
  releaseOperationalLease,
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
  deleteTelegramMessage,
  editTelegramMessage,
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
const UI_INPUT_CLEANUP_PREFIX = 'ui_input_cleanup:';
const UI_PANEL_PREFIX = 'ui_panel:';
const UI_SESSION_TTL_SECONDS = 3600;
const UI_INPUT_TTL_SECONDS = 10 * 60;
const UI_INPUT_CLEANUP_TTL_SECONDS = 47 * 60 * 60;
const UI_INPUT_CLAIM_SECONDS = 60;
const UI_PAGE_SIZE = 8;
const MAX_FORWARD_TARGETS = 10;
const FORWARD_COPY_PAGE_SIZE = 8;
const FORWARD_CALLBACK_LEASE_SECONDS = 60;
const UI_PANEL_LEASE_PREFIX = 'ui-panel:';
const UI_PANEL_LEASE_SECONDS = 60;

const DEFAULT_SERVICES = Object.freeze({
  acquireOperationalLease,
  applyOperationalStateChanges,
  addSubscriptionForwardTarget,
  addSubscription,
  answerCallbackQuery,
  buildTelegramFailureLogDetails,
  buildRssHubUrl,
  canManageChat,
  canManageTargetChat,
  canUseForwardSession,
  copySubscriptions,
  deleteTelegramMessage,
  editTelegramMessage,
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
  readOperationalState,
  renewOperationalLease,
  releaseOperationalLease,
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

  const opensMenu = command.name === 'start' || command.name === 'menu';
  if (!opensMenu) {
    await runWithRequiredUiPanelLease(
      context, () => clearUiInput(context)
    );
  }

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
  const raw = await services.readOperationalState(env, sessionKey);
  if (!raw) {
    await answer(services, token, callbackQuery, '❌ Session expired or invalid.');
    return okResponse();
  }

  const session = parseStoredObject(raw);
  if (!session) {
    await replaceForwardSessionPhase(
      env,
      services,
      sessionKey,
      raw,
      { v: 2, expiresAt: forwardSessionExpiresAt(null) },
      'invalid'
    );
    await answer(services, token, callbackQuery, '❌ Session expired or invalid.');
    return okResponse();
  }
  if (isForwardSessionExpired(session)) {
    await services.applyOperationalStateChanges(env, [{
      name: sessionKey,
      delete: true,
      expectedValue: String(raw)
    }]);
    await answer(services, token, callbackQuery, '❌ Session expired or invalid.');
    return okResponse();
  }
  if (session.phase === 'initializing') {
    await answer(
      services,
      token,
      callbackQuery,
      '⏳ 复制选择器正在打开，请稍后重试。'
    );
    return okResponse();
  }
  if (session.phase === 'complete') {
    return renderCompletedForwardSession({
      callbackQuery,
      config,
      env,
      services,
      session,
      sessionKey,
      stateRaw: raw,
      token
    });
  }
  if (isForwardSessionTerminal(session)) {
    await answer(services, token, callbackQuery, '❌ Session expired or invalid.');
    return okResponse();
  }
  if (!services.canUseForwardSession(callbackQuery, session)) {
    await answer(services, token, callbackQuery, '❌ This button is not available to you.');
    return okResponse();
  }
  if (!forwardSelectorMessageMatches(callbackQuery, session)) {
    await answer(services, token, callbackQuery, '⌛ 这条选择器已失效。');
    return okResponse();
  }
  if (
    Array.isArray(session.selectorCallbackAllowlist) &&
    !session.selectorCallbackAllowlist.includes(data)
  ) {
    await answer(
      services,
      token,
      callbackQuery,
      '⌛ 这个按钮已不属于当前选择器页面。'
    );
    return okResponse();
  }
  const claim = await claimForwardSession(
    env,
    services,
    sessionKey,
    raw,
    session
  );
  if (!claim) {
    await answer(
      services,
      token,
      callbackQuery,
      '⏳ 该选择器正在处理，请稍后重试。'
    );
    return okResponse();
  }

  return withForwardClaimCompensation(
    env,
    services,
    sessionKey,
    claim.session,
    async () => {
  if (!await menuOwnedForwardSessionIsActive(
    env,
    services,
    callbackQuery,
    claim.session
  )) {
    await replaceForwardSessionPhase(
      env,
      services,
      sessionKey,
      claim.raw,
      claim.session,
      'stale'
    );
    await answer(
      services,
      token,
      callbackQuery,
      '⌛ 复制选择器已失效，请重新打开 /menu。'
    );
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
    targetChatId: claim.session.targetChatId,
    config: permissionContext.config,
    getChatMemberFn
  });
  if (!canStillManageSource || !canStillManageTarget) {
    await replaceForwardSessionPhase(
      env,
      services,
      sessionKey,
      claim.raw,
      claim.session,
      'revoked'
    );
    await answer(
      services,
      token,
      callbackQuery,
      '❌ Permission expired. Start a new forwarding session.'
    );
    return okResponse();
  }

  return executeForwardCallbackAction({
    action,
    callbackQuery,
    claimRaw: claim.raw,
    config,
    env,
    services,
    session: claim.session,
    sessionId,
    sessionKey,
    token
  });
    }
  );
}

function forwardSelectorMessageMatches(callbackQuery, session) {
  const callbackMessageId = telegramMessageId(
    callbackQuery?.message?.message_id
  );
  const selectorMessageId = telegramMessageId(session?.selectorMessageId);
  return callbackMessageId === null ||
    selectorMessageId === null ||
    callbackMessageId === selectorMessageId;
}

async function menuOwnedForwardSessionIsActive(
  env,
  services,
  callbackQuery,
  session,
  { allowUnboundView = false } = {}
) {
  if (!session?.menuSessionId) {
    return true;
  }
  const context = {
    chatId: String(callbackQuery?.message?.chat?.id ?? ''),
    threadId: optionalId(callbackQuery?.message?.message_thread_id),
    message: { from: callbackQuery?.from }
  };
  const menuSessionId = String(session.menuSessionId);
  const menuSession = parseStoredObject(
    await services.readOperationalState(env, UI_SESSION_PREFIX + menuSessionId)
  );
  const activeSessionId = await services.readOperationalState(
    env,
    uiActiveKey(context)
  );
  if (
    !isValidUiSession(menuSession) ||
    !uiSessionMatches(menuSession, context) ||
    String(activeSessionId ?? '') !== menuSessionId
  ) {
    return false;
  }

  const panelMessageId = telegramMessageId(menuSession.panelMessageId);
  const selectorMessageId = telegramMessageId(session.selectorMessageId);
  const callbackMessageId = telegramMessageId(
    callbackQuery?.message?.message_id
  );
  const activeMessageId = callbackMessageId ?? selectorMessageId;
  const messageMatches = panelMessageId !== null &&
    activeMessageId !== null &&
    panelMessageId === activeMessageId;
  if (!messageMatches) {
    return false;
  }

  const forwardSessionId = String(session.sessionId ?? '');
  const selectorFingerprint = String(session.selectorFingerprint ?? '');
  if (!forwardSessionId) {
    return false;
  }
  if (allowUnboundView) {
    const boundSessionId = String(menuSession.forwardSessionId ?? '');
    return !boundSessionId || boundSessionId === forwardSessionId;
  }
  if (!selectorFingerprint) {
    return false;
  }
  return String(menuSession.forwardSessionId ?? '') === forwardSessionId &&
    String(menuSession.renderFingerprint ?? '') === selectorFingerprint;
}

function forwardSessionExpiresAt(session) {
  if (!session) {
    return Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  }
  const stored = Number(session?.expiresAt);
  return Number.isSafeInteger(stored) ? stored : 0;
}

function isForwardSessionExpired(
  session,
  now = Math.floor(Date.now() / 1000)
) {
  const expiresAt = forwardSessionExpiresAt(session);
  return !Number.isSafeInteger(expiresAt) || expiresAt <= now;
}

function forwardStateTtl(session) {
  return Math.max(
    60,
    forwardSessionExpiresAt(session) - Math.floor(Date.now() / 1000)
  );
}

function isForwardSessionTerminal(session) {
  return ['complete', 'stale', 'revoked', 'invalid'].includes(session?.phase);
}

async function claimForwardSession(env, services, sessionKey, raw, session) {
  const now = Math.floor(Date.now() / 1000);
  if (
    isForwardSessionExpired(session, now) ||
    isForwardSessionTerminal(session) ||
    (session.phase === 'processing' && Number(session.claimExpiresAt) > now)
  ) {
    return null;
  }
  const claimed = {
    ...session,
    v: 2,
    phase: 'processing',
    revision: createOperationToken(),
    claimToken: createOperationToken(),
    claimExpiresAt: now + FORWARD_CALLBACK_LEASE_SECONDS,
    expiresAt: forwardSessionExpiresAt(session)
  };
  const claimedRaw = JSON.stringify(claimed);
  const changed = await services.applyOperationalStateChanges(env, [{
    name: sessionKey,
    value: claimedRaw,
    expectedValue: String(raw),
    expirationTtl: forwardStateTtl(claimed)
  }]);
  return changed > 0 ? { raw: claimedRaw, session: claimed } : null;
}

async function replaceForwardSessionPhase(
  env,
  services,
  sessionKey,
  expectedRaw,
  session,
  phase,
  fields = {}
) {
  const next = {
    ...session,
    ...fields,
    v: 2,
    phase,
    revision: createOperationToken(),
    claimToken: null,
    claimExpiresAt: 0,
    expiresAt: forwardSessionExpiresAt(session)
  };
  const raw = JSON.stringify(next);
  const changed = await services.applyOperationalStateChanges(env, [{
    name: sessionKey,
    value: raw,
    expectedValue: String(expectedRaw),
    expirationTtl: forwardStateTtl(next)
  }]);
  return changed > 0 ? { raw, session: next } : null;
}

async function releaseForwardSessionClaim(
  env,
  services,
  sessionKey,
  claimedSession
) {
  const currentRaw = await services.readOperationalState(env, sessionKey);
  const current = parseStoredObject(currentRaw);
  if (
    !current ||
    current.phase !== 'processing' ||
    String(current.claimToken ?? '') !== String(claimedSession.claimToken ?? '')
  ) {
    return null;
  }
  return replaceForwardSessionPhase(
    env, services, sessionKey, currentRaw, current, 'open'
  );
}

async function withForwardClaimCompensation(
  env,
  services,
  sessionKey,
  claimedSession,
  operation
) {
  try {
    return await operation();
  } catch (error) {
    try {
      await releaseForwardSessionClaim(
        env,
        services,
        sessionKey,
        claimedSession
      );
    } catch {
      console.error({
        source: 'webhook',
        operation: 'releaseForwardSessionClaim',
        message: 'Unable to release a failed forward callback claim.'
      });
    }
    throw error;
  }
}

async function executeForwardCallbackAction({
  action,
  callbackQuery,
  claimRaw,
  config,
  env,
  services,
  session,
  sessionId,
  sessionKey,
  token
}) {
  const callbackMessageId = telegramMessageId(
    callbackQuery?.message?.message_id
  );
  const selectorMessageId = telegramMessageId(session.selectorMessageId);
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
    panelMessageId: callbackMessageId ?? selectorMessageId,
    token
  };

  const available = Array.isArray(session.subMap) ? session.subMap : [];
  if (/^P\d{1,6}$/.test(action)) {
    if (available.length === 0) {
      await releaseForwardSessionClaim(
        env, services, sessionKey, session
      );
      await answer(services, token, callbackQuery, '⚠️ No channel selected.');
      return okResponse();
    }
    if (!await menuOwnedForwardSessionIsActive(
      env,
      services,
      callbackQuery,
      session
    )) {
      await replaceForwardSessionPhase(
        env, services, sessionKey, claimRaw, session, 'stale'
      );
      await answer(
        services,
        token,
        callbackQuery,
        '⌛ 复制选择器已失效，请使用最新菜单。'
      );
      return okResponse();
    }
    await answer(services, token, callbackQuery, '✅ 已翻页');
    try {
      await sendForwardCopyPage(
        copyContext,
        sessionId,
        session,
        parsePage(action.slice(1)),
        { stateRaw: claimRaw }
      );
    } finally {
      await releaseForwardSessionClaim(
        env, services, sessionKey, session
      );
    }
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
    await releaseForwardSessionClaim(
      env, services, sessionKey, session
    );
    await answer(services, token, callbackQuery, '⚠️ No channel selected.');
    return okResponse();
  }

  const added = await services.copySubscriptions(
    env,
    selected,
    session.targetChatId,
    session.targetThreadId ?? null
  );
  const completed = await replaceForwardSessionPhase(
    env,
    services,
    sessionKey,
    claimRaw,
    session,
    'complete',
    { copyAdded: added }
  );
  if (!completed) {
    await answer(
      services,
      token,
      callbackQuery,
      'ℹ️ 该复制操作已由另一个请求处理。'
    );
    return okResponse();
  }
  return renderCompletedForwardSession({
    callbackQuery,
    config,
    env,
    services,
    session: completed.session,
    sessionKey,
    stateRaw: completed.raw,
    token
  });
}

async function renderCompletedForwardSession({
  callbackQuery,
  config,
  env,
  services,
  session,
  sessionKey,
  stateRaw,
  token
}) {
  if (!services.canUseForwardSession(callbackQuery, session)) {
    await answer(
      services,
      token,
      callbackQuery,
      '❌ This button is not available to you.'
    );
    return okResponse();
  }
  if (!forwardSelectorMessageMatches(callbackQuery, session)) {
    await answer(services, token, callbackQuery, '⌛ 这条选择器已失效。');
    return okResponse();
  }

  const added = Number(session.copyAdded);
  const hasKnownResult = Number.isSafeInteger(added) && added >= 0;
  const completion = hasKnownResult
    ? (
        added > 0
          ? '✅ Successfully copied ' + added + ' subscriptions to the target.'
          : 'ℹ️ Selected subscriptions already exist in the target.'
      )
    : '✅ Subscription copy is complete.';
  const callbackAnswer = hasKnownResult
    ? (
        added > 0
          ? '✅ Forwarded ' + added + ' subscriptions!'
          : '⚠️ Channels already exist in target.'
      )
    : '✅ Subscription copy is complete.';
  if (!await menuOwnedForwardSessionIsActive(
    env,
    services,
    callbackQuery,
    session
  )) {
    await answer(
      services,
      token,
      callbackQuery,
      hasKnownResult && added === 0
        ? 'ℹ️ 订阅已存在；最新菜单保持不变。'
        : '✅ 已完成复制；最新菜单保持不变。'
    );
    return okResponse();
  }

  const callbackMessageId = telegramMessageId(
    callbackQuery?.message?.message_id
  );
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
    panelMessageId: callbackMessageId ?? telegramMessageId(
      session.selectorMessageId
    ),
    token
  };
  const replyMarkup = session.menuSessionId
    ? {
        inline_keyboard: [[
          uiButton('🏠 主菜单', session.menuSessionId, 'h')
        ]]
      }
    : { inline_keyboard: [] };
  const rendered = await renderForwardCopyPanel(
    copyContext,
    sessionKey,
    session,
    completion,
    replyMarkup,
    { stateRaw }
  );
  await answer(
    services,
    token,
    callbackQuery,
    rendered?.ok === true
      ? callbackAnswer
      : (rendered?.stale === true
          ? '✅ 已完成复制；最新菜单保持不变。'
          : '✅ 复制已完成；面板更新失败，请再点一次刷新。')
  );
  return okResponse();
}

async function handleMenu(context) {
  return runWithRequiredUiPanelLease(
    context, () => handleMenuWithPanelLease(context)
  );
}

async function handleMenuWithPanelLease(context) {
  await clearUiInput(context);
  const activeKey = uiActiveKey(context);
  const subscriptions = await scopedSubscriptions(context);
  const rememberedPanelMessageId = await loadUiPanelMessageId(context);
  context.rememberedPanelMessageId = rememberedPanelMessageId;
  context.panelMessageId = rememberedPanelMessageId;
  const previousSessionId = await context.services.readOperationalState(
    context.env,
    activeKey
  );
  let previousSession = null;
  if (previousSessionId) {
    previousSession = parseStoredObject(
      await context.services.readOperationalState(
        context.env,
        UI_SESSION_PREFIX + String(previousSessionId)
      )
    );
    if (
      isValidUiSession(previousSession) &&
      uiSessionMatches(previousSession, context)
    ) {
      const activePanelMessageId = telegramMessageId(
        previousSession.panelMessageId
      );
      if (activePanelMessageId !== null) {
        context.panelMessageId = activePanelMessageId;
      }
    }
  }

  const sessionId = createUiSessionId(context.services);
  const now = Math.floor(Date.now() / 1000);
  const session = {
    v: 1,
    sourceChatId: context.chatId,
    sourceThreadId: context.threadId,
    initiatorUserId: String(context.message.from.id),
    createdAt: now,
    ...(context.panelMessageId ? { panelMessageId: context.panelMessageId } : {}),
    expiresAt: now + UI_SESSION_TTL_SECONDS
  };
  const sessionKey = UI_SESSION_PREFIX + sessionId;
  const sessionRaw = JSON.stringify(session);
  await context.services.applyOperationalStateChanges(context.env, [
    {
      name: sessionKey,
      value: sessionRaw,
      expirationTtl: UI_SESSION_TTL_SECONDS
    },
    {
      name: activeKey,
      value: sessionId,
      expirationTtl: UI_SESSION_TTL_SECONDS
    }
  ]);

  const rendered = await sendUiHome(context, sessionId, '', subscriptions);
  if (rendered?.ok === true) {
    return rendered;
  }
  await rollbackMenuSession(
    context,
    activeKey,
    sessionId,
    sessionKey,
    sessionRaw,
    previousSessionId,
    previousSession
  );
  return rendered;
}

async function rollbackMenuSession(
  context,
  activeKey,
  sessionId,
  sessionKey,
  sessionRaw,
  previousSessionId,
  previousSession
) {
  const changes = [{
    name: sessionKey,
    delete: true,
    expectedValue: sessionRaw
  }];
  if (
    previousSessionId &&
    isValidUiSession(previousSession) &&
    uiSessionMatches(previousSession, context)
  ) {
    changes.push({
      name: activeKey,
      value: String(previousSessionId),
      expectedValue: sessionId,
      expirationTtl: Math.max(
        60,
        Number(previousSession.expiresAt) - Math.floor(Date.now() / 1000)
      )
    });
  } else {
    changes.push({
      name: activeKey,
      delete: true,
      expectedValue: sessionId
    });
  }
  await context.services.applyOperationalStateChanges(context.env, changes);
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
  const match = /^ui:([A-Za-z0-9_-]{1,24}):([A-Za-z0-9:_-]+)$/.exec(data);
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
  const inputCancelMatch = /^ic:([A-Za-z0-9_-]{8})$/.exec(action);

  const sessionKey = UI_SESSION_PREFIX + sessionId;
  const session = parseStoredObject(
    await services.readOperationalState(env, sessionKey)
  );
  if (!isValidUiSession(session)) {
    if (
      inputCancelMatch &&
      callbackQuery?.message?.chat?.id !== null &&
      callbackQuery?.message?.chat?.id !== undefined &&
      callbackQuery?.from?.id !== null &&
      callbackQuery?.from?.id !== undefined
    ) {
      const expiredContext = {
        env,
        services,
        message: { ...callbackQuery.message, from: callbackQuery.from },
        chatId: String(callbackQuery.message.chat.id),
        threadId: optionalId(callbackQuery.message.message_thread_id),
        token
      };
      await runWithUiPanelLease(
        expiredContext,
        () => clearUiInputForCallback(
          expiredContext,
          sessionId,
          inputCancelMatch[1]
        )
      );
    }
    await services.applyOperationalStateChanges(env, [{
      name: sessionKey,
      delete: true
    }]);
    await answer(services, token, callbackQuery, '⌛ 菜单已过期，请发送 /menu。');
    return okResponse();
  }

  const message = {
    ...(callbackQuery?.message ?? {}),
    from: callbackQuery?.from
  };
  const callbackMessageId = optionalId(callbackQuery?.message?.message_id);
  const sessionPanelMessageId = optionalId(session.panelMessageId);
  if (
    callbackMessageId !== null &&
    sessionPanelMessageId !== null &&
    callbackMessageId !== sessionPanelMessageId
  ) {
    await answer(services, token, callbackQuery, '⌛ 这条菜单已失效，请使用最新面板。');
    return okResponse();
  }
  const context = {
    env,
    config: config ?? {},
    services,
    message,
    chatId: String(callbackQuery?.message?.chat?.id ?? ''),
    threadId: optionalId(callbackQuery?.message?.message_thread_id),
    panelMessageId: callbackMessageId ?? sessionPanelMessageId,
    uiSessionId: sessionId,
    uiCallbackData: data,
    token
  };
  const activeSessionId = await services.readOperationalState(
    env,
    uiActiveKey(context)
  );
  if (
    String(activeSessionId ?? '') !== sessionId ||
    !uiSessionMatches(session, context)
  ) {
    await answer(services, token, callbackQuery, '⌛ 菜单已过期，请发送 /menu。');
    return okResponse();
  }

  const handled = await runWithUiPanelLease(context, async () => {
    const lockedSession = parseStoredObject(
      await services.readOperationalState(env, sessionKey)
    );
    const lockedActiveSessionId = await services.readOperationalState(
      env,
      uiActiveKey(context)
    );
    if (
      !isValidUiSession(lockedSession) ||
      !uiSessionMatches(lockedSession, context) ||
      String(lockedActiveSessionId ?? '') !== sessionId ||
      (
        callbackMessageId !== null &&
        telegramMessageId(lockedSession.panelMessageId) !== null &&
        callbackMessageId !== telegramMessageId(lockedSession.panelMessageId)
      )
    ) {
      await answer(
        services,
        token,
        callbackQuery,
        '⌛ 菜单已过期，请发送 /menu。'
      );
      return okResponse();
    }
    const allowedCallbacks = Array.isArray(lockedSession.callbackAllowlist)
      ? lockedSession.callbackAllowlist
      : [];
    if (!allowedCallbacks.includes(data)) {
      await answer(
        services,
        token,
        callbackQuery,
        '⌛ 这个按钮已不属于当前页面。'
      );
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
  });
  if (handled?.panelBusy === true) {
    await answer(
      services,
      token,
      callbackQuery,
      '⏳ 面板正在更新，请再点一次。'
    );
  }
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
    await renderUiPanel(
      context,
      sessionId,
      chatInfoText(context),
      { inline_keyboard: [[uiButton('🏠 主菜单', sessionId, 'h')]] }
    );
    return;
  }
  if (action === 'help') {
    await renderUiPanel(
      context,
      sessionId,
      HELP_MESSAGE,
      { inline_keyboard: [[uiButton('🏠 主菜单', sessionId, 'h')]] }
    );
    return;
  }
  if (action === 'fw') {
    await sendUiForwardingMenu(context, sessionId);
    return;
  }
  if (action === 'df') {
    await sendUiDefaultForwarding(context, sessionId);
    return;
  }
  let defaultMatch = /^ds:([tg]):([01])$/.exec(action);
  if (defaultMatch) {
    const scope = defaultMatch[1] === 't' ? 'topic' : 'global';
    if (!defaultForwardScopeAvailable(context, scope)) {
      await sendUiDefaultForwarding(
        context,
        sessionId,
        '⚠️ 当前会话不是 Topic，无法设置 Topic 默认规则。'
      );
      return;
    }
    const onlyForward = defaultMatch[2] === '1';
    const scopeLabel = scope === 'topic'
      ? '当前 Topic'
      : 'Global（所有 Topics）';
    await runCurrentUiCallbackMutation(
      context,
      sessionId,
      () => beginUiInput(
        context,
        sessionId,
        {
          action: 'set_default_forward',
          forwardScope: scope,
          onlyForward
        },
        '📨 <b>设置' + scopeLabel + '默认转发</b>\n\n' +
          '<b>投递模式：</b>' +
          (onlyForward ? '仅目标' : '源会话 + 目标') + '\n\n' +
          '请回复目标 <code>Chat ID</code>，可选追加 ' +
          '<code>Topic ID</code>。\n' +
          '例如：<code>-100123456789 42</code>\n\n发送 /cancel 取消。'
      )
    );
    return;
  }
  defaultMatch = /^ddc:([tg])$/.exec(action);
  if (defaultMatch) {
    await sendUiDefaultForwardDeleteConfirmation(
      context,
      sessionId,
      defaultMatch[1] === 't' ? 'topic' : 'global'
    );
    return;
  }
  defaultMatch = /^ddx:([tg]):([A-Za-z0-9_-]{8}):([a-z0-9]{1,8})$/.exec(
    action
  );
  if (defaultMatch) {
    await confirmUiDefaultForwardDelete(
      context,
      sessionId,
      defaultMatch[1] === 't' ? 'topic' : 'global',
      defaultMatch[3]
    );
    return;
  }
  if (action === 'cp') {
    await runCurrentUiCallbackMutation(
      context,
      sessionId,
      () => beginUiInput(
        context,
        sessionId,
        { action: 'copy_subscriptions_target' },
        '📋 <b>复制订阅</b>\n\n请回复目标 <code>Chat ID</code>，' +
          '可选追加 <code>Topic ID</code>。\n' +
          '例如：<code>-100123456789 42</code>\n\n发送 /cancel 取消。'
      )
    );
    return;
  }
  let match = /^ic:([A-Za-z0-9_-]{8})$/.exec(action);
  if (match) {
    const cancelNonce = match[1];
    await runCurrentUiCallbackMutation(
      context,
      sessionId,
      async () => {
        const cleared = await clearUiInputForCallback(
          context,
          sessionId,
          cancelNonce
        );
        if (!cleared) {
          return { ok: false, stale: true };
        }
        return sendUiHome(context, sessionId);
      }
    );
    return;
  }

  match = /^at:([rxy])$/.exec(action);
  if (match) {
    const type = match[1] === 'r'
      ? 'rss'
      : (match[1] === 'x' ? 'x' : 'youtube');
    const label = type === 'rss'
      ? '完整 RSS/Atom URL'
      : (type === 'x' ? 'X 用户名（不需要 @）' : 'YouTube 频道名称');
    await runCurrentUiCallbackMutation(
      context,
      sessionId,
      () => beginUiInput(
        context,
        sessionId,
        { action: 'add_subscription', subscriptionType: type },
        '➕ <b>添加 ' + safe(type.toUpperCase()) + ' 订阅</b>\n\n' +
          '请回复' + label + '。\n\n发送 /cancel 取消。'
      )
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
  match = /^dx:([1-9]\d{0,15}):(\d{1,6}):([A-Za-z0-9_-]{8})$/.exec(action);
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
    await runCurrentUiCallbackMutation(
      context,
      sessionId,
      () => beginUiInput(
        context,
        sessionId,
        {
          action: 'add_forward_target',
          subscriptionId: parseSafeId(match[1])
        },
        '📨 <b>添加独立转发目标</b>\n\n请回复目标 ' +
          '<code>Chat ID</code>，可选追加 <code>Topic ID</code>。\n' +
          '例如：<code>-100123456789 42</code>\n\n发送 /cancel 取消。'
      )
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
  match = /^rx:([1-9]\d{0,15}):([A-Za-z0-9_-]{8})$/.exec(action);
  if (match) {
    await confirmUiResetRouting(
      context,
      sessionId,
      parseSafeId(match[1])
    );
  }
}

function isRecognizedUiAction(action) {
  return /^(?:h|a|id|help|cp|fw|df)$/.test(action) ||
    /^ds:[tg]:[01]$/.test(action) ||
    /^ddc:[tg]$/.test(action) ||
    /^ddx:[tg]:[A-Za-z0-9_-]{8}:[a-z0-9]{1,8}$/.test(action) ||
    /^at:[rxy]$/.test(action) ||
    /^ic:[A-Za-z0-9_-]{8}$/.test(action) ||
    /^(?:l|fl):\d{1,6}$/.test(action) ||
    /^(?:s|f|dc):[1-9]\d{0,15}:\d{1,6}$/.test(action) ||
    /^dx:[1-9]\d{0,15}:\d{1,6}:[A-Za-z0-9_-]{8}$/.test(action) ||
    /^(?:fa|fs|rc):[1-9]\d{0,15}$/.test(action) ||
    /^rx:[1-9]\d{0,15}:[A-Za-z0-9_-]{8}$/.test(action) ||
    /^fi:[1-9]\d{0,15}:[01]$/.test(action) ||
    /^fd:[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(action);
}

function isUiSessionShape(session) {
  return Boolean(
    session &&
    session.v === 1 &&
    session.sourceChatId !== undefined &&
    session.initiatorUserId !== undefined &&
    Number.isFinite(Number(session.expiresAt))
  );
}

function isValidUiSession(session) {
  return isUiSessionShape(session) &&
    Number(session.expiresAt) > Math.floor(Date.now() / 1000);
}

function uiSessionMatches(session, context) {
  return (
    String(session.sourceChatId) === context.chatId &&
    String(session.sourceThreadId ?? '') === String(context.threadId ?? '') &&
    String(session.initiatorUserId) === String(context.message?.from?.id ?? '')
  );
}
async function extendUiSessionForInput(
  context,
  sessionId,
  minimumExpiresAt
) {
  const normalizedSessionId = String(sessionId ?? '');
  const targetExpiresAt = Math.floor(Number(minimumExpiresAt));
  if (
    !/^[A-Za-z0-9_-]{1,24}$/.test(normalizedSessionId) ||
    !Number.isSafeInteger(targetExpiresAt)
  ) {
    throw new TypeError('UI input session extension is invalid');
  }

  const sessionKey = UI_SESSION_PREFIX + normalizedSessionId;
  const activeKey = uiActiveKey(context);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let sessionRaw;
    let activeSessionId;
    try {
      [sessionRaw, activeSessionId] = await Promise.all([
        context.services.readOperationalState(context.env, sessionKey),
        context.services.readOperationalState(context.env, activeKey)
      ]);
    } catch (error) {
      lastError = error;
      continue;
    }
    const session = parseStoredObject(sessionRaw);
    if (
      !isUiSessionShape(session) ||
      !uiSessionMatches(session, context) ||
      String(activeSessionId ?? '') !== normalizedSessionId
    ) {
      throw new Error('UI input parent session is no longer active');
    }

    const expiresAt = Math.max(
      Math.floor(Number(session.expiresAt)),
      targetExpiresAt
    );
    const expirationTtl = Math.max(
      60,
      expiresAt - Math.floor(Date.now() / 1000)
    );
    const nextSession = { ...session, expiresAt };
    try {
      const changed = await context.services.applyOperationalStateChanges(
        context.env,
        [
          {
            name: sessionKey,
            value: JSON.stringify(nextSession),
            expectedValue: String(sessionRaw),
            expirationTtl
          },
          {
            name: activeKey,
            value: normalizedSessionId,
            expectedValue: normalizedSessionId,
            expirationTtl
          }
        ]
      );
      if (changed === 2) {
        return nextSession;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Unable to extend the UI input session');
}


async function expireUiSession(context, sessionId) {
  const activeKey = uiActiveKey(context);
  await context.services.applyOperationalStateChanges(context.env, [
    {
      name: UI_SESSION_PREFIX + sessionId,
      delete: true
    },
    {
      name: activeKey,
      delete: true,
      expectedValue: sessionId
    }
  ]);
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

function uiConfirmationNonce() {
  const nonce = createOperationToken().slice(0, 8);
  if (!/^[A-Za-z0-9_-]{8}$/.test(nonce)) {
    throw new Error('Unable to generate a confirmation nonce');
  }
  return nonce;
}


function normalizeUiInputCancelNonce(value) {
  const nonce = String(value ?? '');
  return /^[A-Za-z0-9_-]{8}$/.test(nonce) ? nonce : null;
}

function uiInputCancelAction(value) {
  const nonce = normalizeUiInputCancelNonce(value);
  if (nonce === null) {
    throw new TypeError('UI input cancel nonce is invalid');
  }
  return 'ic:' + nonce;
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

async function sendUiHome(
  context,
  sessionId,
  notice = '',
  loadedSubscriptions = null
) {
  const subscriptions = loadedSubscriptions ?? await scopedSubscriptions(context);
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
        uiButton('📨 消息转发', sessionId, 'fw'),
        uiButton('📋 复制订阅', sessionId, 'cp')
      ],
      [
        uiButton('🆔 当前 ID', sessionId, 'id'),
        uiButton('❓ 帮助', sessionId, 'help')
      ]
    ]
  };
  return renderUiPanel(
    context,
    sessionId,
    text,
    keyboard,
    notice
  );
}

async function sendUiAddMenu(context, sessionId) {
  await renderUiPanel(
    context,
    sessionId,
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


async function sendUiForwardingMenu(context, sessionId, notice = '') {
  const text = '📨 <b>消息转发</b>\n\n' +
    '“默认转发”适用于仍在继承规则的订阅；\n' +
    '“分别管理”可以为某条订阅设置独立目标。\n\n' +
    '独立规则优先于默认规则。';
  await renderUiPanel(
    context,
    sessionId,
    text,
    {
      inline_keyboard: [
        [uiButton('🌐 默认转发', sessionId, 'df')],
        [uiButton('🧩 分别管理每条订阅', sessionId, 'fl:0')],
        [uiButton('🏠 主菜单', sessionId, 'h')]
      ]
    },
    notice
  );
}

function defaultForwardScopeAvailable(context, scope) {
  return scope === 'global' ||
    (scope === 'topic' && context.threadId !== null);
}

function defaultForwardScopeCode(scope) {
  if (scope === 'topic') {
    return 't';
  }
  if (scope === 'global') {
    return 'g';
  }
  throw new TypeError('Default forward scope is invalid');
}

function defaultForwardScopeLabel(context, scope) {
  if (scope === 'topic') {
    return '当前 Topic #' + String(context.threadId);
  }
  return 'Global（当前聊天及所有 Topics）';
}

function defaultForwardKey(context, scope) {
  if (!defaultForwardScopeAvailable(context, scope)) {
    throw new TypeError('Default forward scope is unavailable');
  }
  return scope === 'topic'
    ? 'forward_config:' + context.chatId + ':' + context.threadId
    : 'forward_config:' + context.chatId;
}

async function readDefaultForwardAtScope(context, scope) {
  if (!defaultForwardScopeAvailable(context, scope)) {
    return null;
  }
  return normalizeLegacyForwardConfig(
    parseStoredObject(
      await context.env.DB.get(defaultForwardKey(context, scope))
    )
  );
}

function defaultForwardVersion(config) {
  const fingerprint = renderFingerprint(
    JSON.stringify(config ?? null),
    null
  );
  return fingerprint.slice(fingerprint.indexOf(':') + 1).slice(0, 8);
}

function formatDefaultForwardRule(config, ignoredByTopic = false) {
  if (!config) {
    return '未设置';
  }
  let text = '目标 ' + formatTarget({
    chatId: config.targetChatId,
    threadId: config.targetThreadId
  }) + '\n模式：' +
    (config.onlyForward ? '仅目标' : '源会话 + 目标');
  if (ignoredByTopic) {
    text += '\n⚠️ 这是旧的聊天默认规则，未标记覆盖 Topics。';
  }
  return text;
}

async function sendUiDefaultForwarding(
  context,
  sessionId,
  notice = ''
) {
  const hasTopic = context.threadId !== null;
  const [topicConfig, globalConfig] = await Promise.all([
    hasTopic
      ? readDefaultForwardAtScope(context, 'topic')
      : Promise.resolve(null),
    readDefaultForwardAtScope(context, 'global')
  ]);
  const globalApplies = Boolean(
    globalConfig && (!hasTopic || globalConfig.isGlobal)
  );
  const effectiveConfig = topicConfig ??
    (globalApplies ? globalConfig : null);
  const effectiveScope = topicConfig
    ? '当前 Topic'
    : (globalApplies ? 'Global' : '无');
  let text = '🌐 <b>默认消息转发</b>\n\n' +
    '<b>当前范围：</b>' +
    (hasTopic ? 'Topic #' + safe(context.threadId) : '当前聊天') + '\n' +
    '<b>当前有效规则：</b>' + effectiveScope + '\n';
  if (effectiveConfig) {
    text += formatDefaultForwardRule(effectiveConfig) + '\n';
  } else {
    text += '未设置；文章继续投递到源会话。\n';
  }
  text += '\n';
  if (hasTopic) {
    text += '<b>当前 Topic 规则：</b>\n' +
      formatDefaultForwardRule(topicConfig) + '\n\n';
  }
  text += '<b>Global 规则：</b>\n' +
    formatDefaultForwardRule(
      globalConfig,
      Boolean(hasTopic && globalConfig && !globalConfig.isGlobal)
    ) +
    '\n\n已有独立规则的订阅不会受这里的修改影响。';

  const rows = [];
  if (hasTopic) {
    rows.push([
      uiButton('Topic：源 + 目标', sessionId, 'ds:t:0'),
      uiButton('Topic：仅目标', sessionId, 'ds:t:1')
    ]);
    if (topicConfig) {
      rows.push([
        uiButton('🗑 删除 Topic 默认', sessionId, 'ddc:t')
      ]);
    }
  }
  rows.push([
    uiButton('Global：源 + 目标', sessionId, 'ds:g:0'),
    uiButton('Global：仅目标', sessionId, 'ds:g:1')
  ]);
  if (globalConfig) {
    rows.push([
      uiButton('🗑 删除 Global 默认', sessionId, 'ddc:g')
    ]);
  }
  rows.push([
    uiButton('🧩 分别管理', sessionId, 'fl:0'),
    uiButton('⬅ 转发菜单', sessionId, 'fw')
  ]);
  rows.push([uiButton('🏠 主菜单', sessionId, 'h')]);

  await renderUiPanel(
    context,
    sessionId,
    text,
    { inline_keyboard: rows },
    notice
  );
}

async function sendUiDefaultForwardDeleteConfirmation(
  context,
  sessionId,
  scope
) {
  if (!defaultForwardScopeAvailable(context, scope)) {
    await sendUiDefaultForwarding(
      context,
      sessionId,
      '⚠️ 当前会话没有该作用域。'
    );
    return;
  }
  const config = await readDefaultForwardAtScope(context, scope);
  if (!config) {
    await sendUiDefaultForwarding(
      context,
      sessionId,
      'ℹ️ 该默认规则已经不存在。'
    );
    return;
  }
  const nonce = uiConfirmationNonce();
  const version = defaultForwardVersion(config);
  const code = defaultForwardScopeCode(scope);
  await renderUiPanel(
    context,
    sessionId,
    '⚠️ <b>删除默认转发规则？</b>\n\n' +
      '<b>作用域：</b>' + safe(defaultForwardScopeLabel(context, scope)) +
      '\n' + formatDefaultForwardRule(config) +
      '\n\n仍在继承的订阅将改用下一层规则或源会话。',
    {
      inline_keyboard: [
        [
          uiButton(
            '确认删除',
            sessionId,
            'ddx:' + code + ':' + nonce + ':' + version
          ),
          uiButton('取消', sessionId, 'df')
        ]
      ]
    }
  );
}

async function confirmUiDefaultForwardDelete(
  context,
  sessionId,
  scope,
  expectedVersion
) {
  const mutation = await runCurrentUiCallbackMutation(
    context,
    sessionId,
    async () => {
      const current = await readDefaultForwardAtScope(context, scope);
      if (
        !current ||
        defaultForwardVersion(current) !== String(expectedVersion)
      ) {
        return { deleted: false, changed: true };
      }
      await context.env.DB.delete(defaultForwardKey(context, scope));
      return { deleted: true, changed: false };
    }
  );
  if (!mutation.executed) {
    return;
  }
  const result = mutation.value;
  const notice = result.deleted
    ? '✅ 已删除' + defaultForwardScopeLabel(context, scope) + '默认规则。'
    : (result.changed
        ? '⚠️ 规则已发生变化，请重新确认。'
        : 'ℹ️ 该规则已经不存在。');
  await sendUiDefaultForwarding(context, sessionId, notice);
}
async function sendUiSubscriptionList(
  context,
  sessionId,
  requestedPage,
  forwarding,
  notice = ''
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
  await renderUiPanel(
    context,
    sessionId,
    text,
    { inline_keyboard: rows },
    notice
  );
}

async function sendUiSubscriptionDetail(
  context,
  sessionId,
  id,
  page,
  notice = ''
) {
  const subscription = await findScopedSubscription(context, id);
  if (!subscription) {
    await renderUiPanel(
      context,
      sessionId,
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
  await renderUiPanel(context, sessionId, text, {
    inline_keyboard: [
      [uiButton('📨 管理此订阅的转发', sessionId, 'f:' + id + ':' + page)],
      [uiButton('🗑 删除订阅', sessionId, 'dc:' + id + ':' + page)],
      [
        uiButton('⬅ 返回列表', sessionId, 'l:' + page),
        uiButton('🏠 主菜单', sessionId, 'h')
      ]
    ]
  }, notice);
}

async function sendUiDeleteConfirmation(
  context,
  sessionId,
  id,
  page
) {
  const subscription = await findScopedSubscription(context, id);
  if (!subscription) {
    await renderUiPanel(
      context,
      sessionId,
      '⚠️ 订阅 #' + id + ' 已不存在。',
      { inline_keyboard: [[uiButton('⬅ 返回列表', sessionId, 'l:' + page)]] }
    );
    return;
  }
  await renderUiPanel(
    context,
    sessionId,
    '⚠️ <b>确认删除订阅？</b>\n\n' +
      subscriptionListLine(subscription, context.services) + '\n\n' +
      '删除会停止未来抓取和入队；已经进入 Outbox 的消息不会被撤回。',
    {
      inline_keyboard: [[
        uiButton(
          '🗑 确认删除', sessionId,
          'dx:' + id + ':' + page + ':' + uiConfirmationNonce()
        ),
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
  const mutation = await runCurrentUiCallbackMutation(
    context,
    sessionId,
    () => context.services.removeSubscriptions(
      context.env,
      {
        id,
        chatId: context.chatId,
        threadId: context.threadId
      }
    )
  );
  if (!mutation.executed) {
    return;
  }
  const removed = mutation.value;
  const notice = removed > 0
    ? '🗑️ 已删除订阅 #' + id + '。'
    : '⚠️ 订阅 #' + id + ' 已不存在。';
  await sendUiSubscriptionList(
    context, sessionId, page, false, notice
  );
}

async function sendUiRoutingDetail(
  context,
  sessionId,
  id,
  page,
  notice = ''
) {
  const subscription = await findScopedSubscription(context, id);
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    routingScope(context, id)
  );
  if (!subscription || !routing) {
    await sendUiSubscriptionList(
      context,
      sessionId,
      page,
      true,
      '⚠️ 订阅 #' + id + ' 已不存在。'
    );
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
  await renderUiPanel(
    context,
    sessionId,
    text,
    { inline_keyboard: rows },
    notice
  );
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
    await sendUiSubscriptionList(
      context,
      sessionId,
      0,
      true,
      '⚠️ 订阅 #' + id + ' 已不存在。'
    );
    return;
  }
  if (
    routing.independent &&
    routing.includeSource === includeSource
  ) {
    await sendUiRoutingDetail(
      context,
      sessionId,
      id,
      0,
      includeSource
        ? 'ℹ️ 源会话投递已经开启。'
        : 'ℹ️ 源会话投递已经关闭。'
    );
    return;
  }


  let changed;
  if (routing.independent) {
    const mutation = await runCurrentUiCallbackMutation(
      context,
      sessionId,
      () => context.services.setSubscriptionIncludeSource(
        context.env,
        routingScope(context, id),
        includeSource
      )
    );
    if (!mutation.executed) {
      return;
    }
    changed = mutation.value;
  } else {
    const snapshot = await inheritedRoutingSnapshot(context);
    snapshot.includeSource = includeSource;
    if (!includeSource && snapshot.targets.length === 0) {
      await sendUiRoutingDetail(
        context,
        sessionId,
        id,
        0,
        '⚠️ 请先添加至少一个转发目标，再关闭源会话投递。'
      );
      return;
    }
    const mutation = await runCurrentUiCallbackMutation(
      context,
      sessionId,
      () => context.services.initializeSubscriptionRouting(
        context.env,
        routingScope(context, id),
        snapshot
      )
    );
    if (!mutation.executed) {
      return;
    }
    const result = mutation.value;
    changed = result.created || result.targetsAdded > 0;
  }

  const notice = !changed && !includeSource
    ? '⚠️ 请先添加至少一个转发目标，再关闭源会话投递。'
    : (includeSource
        ? '✅ 已恢复源会话投递。'
        : '✅ 之后的新文章将不再投递到源会话。');
  await sendUiRoutingDetail(
    context, sessionId, id, 0, notice
  );
}

async function setUiSourceOnly(context, sessionId, id) {
  const scope = routingScope(context, id);
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    scope
  );
  if (!routing) {
    await sendUiSubscriptionList(
      context,
      sessionId,
      0,
      true,
      '⚠️ 订阅 #' + id + ' 已不存在。'
    );
    return;
  }
  if (routing.independent) {
    await sendUiRoutingDetail(
      context,
      sessionId,
      id,
      0,
      routing.includeSource && routing.targets.length === 0
        ? 'ℹ️ 该订阅已经仅投递到源会话。'
        : 'ℹ️ 该订阅已经使用独立规则，请直接管理它的目标。'
    );
    return;
  }

  const mutation = await runCurrentUiCallbackMutation(
    context,
    sessionId,
    () => context.services.initializeSubscriptionRouting(
      context.env,
      scope,
      { includeSource: true, targets: [] }
    )
  );
  if (!mutation.executed) {
    return;
  }
  const result = mutation.value;
  await sendUiRoutingDetail(
    context,
    sessionId,
    id,
    0,
    result.created
      ? '✅ 已停止继承默认转发；之后仅投递到源会话。'
      : 'ℹ️ 转发规则刚刚发生变化，请按下面的最新状态继续管理。'
  );
}

async function removeUiForwardTarget(
  context,
  sessionId,
  subscriptionIdValue,
  targetId
) {
  const mutation = await runCurrentUiCallbackMutation(
    context,
    sessionId,
    () => context.services.removeSubscriptionForwardTarget(
      context.env,
      {
        ...routingScope(context, subscriptionIdValue),
        targetId
      }
    )
  );
  if (!mutation.executed) {
    return;
  }
  const removed = mutation.value;
  await sendUiRoutingDetail(
    context,
    sessionId,
    subscriptionIdValue,
    0,
    removed
      ? '🗑️ 已删除该转发目标。'
      : '⚠️ 无法删除：目标已不存在，或它是关闭源投递后的最后一个目标。'
  );
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
    await sendUiRoutingDetail(
      context,
      sessionId,
      id,
      0,
      'ℹ️ 该订阅已经在继承聊天/Topic 规则。'
    );
    return;
  }
  await renderUiPanel(
    context,
    sessionId,
    '⚠️ <b>恢复继承聊天规则？</b>\n\n' +
      '这会删除此订阅的全部独立目标和源投递设置。\n' +
      '之后它会重新跟随 /set_forward 的当前规则。',
    {
      inline_keyboard: [[
        uiButton(
          '↩️ 确认恢复继承', sessionId,
          'rx:' + id + ':' + uiConfirmationNonce()
        ),
        uiButton('取消', sessionId, 'f:' + id + ':0')
      ]]
    }
  );
}

async function confirmUiResetRouting(context, sessionId, id) {
  const mutation = await runCurrentUiCallbackMutation(
    context,
    sessionId,
    () => context.services.resetSubscriptionRouting(
      context.env,
      routingScope(context, id)
    )
  );
  if (!mutation.executed) {
    return;
  }
  const removed = mutation.value;
  await sendUiRoutingDetail(
    context,
    sessionId,
    id,
    0,
    removed > 0
      ? '✅ 已恢复继承聊天/Topic 转发规则。'
      : 'ℹ️ 该订阅已在继承规则，或已经不存在。'
  );
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
  const inputStartedAt = Math.floor(Date.now() / 1000);
  await extendUiSessionForInput(
    context,
    sessionId,
    inputStartedAt + UI_INPUT_TTL_SECONDS
  );
  await clearUiInput(context);
  const cancelNonce = uiConfirmationNonce();
  const cancelAction = uiInputCancelAction(cancelNonce);
  const inputCancelCallbackData = uiCallback(sessionId, cancelAction);
  const inputKeyboard = {
    inline_keyboard: [[uiButton('取消输入', sessionId, cancelAction)]]
  };
  const rendered = await renderUiPanel(
    context,
    sessionId,
    prompt,
    inputKeyboard
  );
  if (rendered?.ok !== true) {
    return rendered;
  }
  let result;
  try {
    result = await send(
      context,
      '✍️ 请回复这条临时提示完成输入。',
      {
        force_reply: true,
        input_field_placeholder: '回复此消息，或发送 /cancel'
      }
    );
  } catch (error) {
    await compensateUiInputFailure(context, sessionId);
    throw error;
  }
  if (result?.ok !== true) {
    await compensateUiInputFailure(context, sessionId);
    return;
  }

  const promptMessageId = optionalId(result?.result?.message_id);
  if (
    context.message?.chat?.type !== 'private' &&
    promptMessageId === null
  ) {
    await renderUiPanel(
      context,
      sessionId,
      prompt,
      inputKeyboard,
      '⚠️ 无法建立安全的群聊输入会话，请返回主菜单后重试。'
    );
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + UI_INPUT_TTL_SECONDS;
  const input = {
    v: 2,
    phase: 'open',
    revision: createOperationToken(),
    claimToken: null,
    claimExpiresAt: 0,
    ...fields,
    cancelNonce,
    menuSessionId: sessionId,
    sourceChatId: context.chatId,
    sourceThreadId: context.threadId,
    initiatorUserId: String(context.message.from.id),
    promptMessageId,
    createdAt: now,
    promptText: prompt,
    expiresAt
  };
  let finalized;
  try {
    finalized = await runCurrentUiCallbackMutation(
      context,
      sessionId,
      async () => {
        await extendUiSessionForInput(
          context,
          sessionId,
          expiresAt
        );
        const changed = await context.services.applyOperationalStateChanges(
          context.env,
          [{
            name: uiInputKey(context),
            value: JSON.stringify(input),
            expirationTtl: UI_INPUT_CLEANUP_TTL_SECONDS
          }]
        );
        return changed > 0;
      },
      { expectedCallbackData: inputCancelCallbackData }
    );
  } catch (error) {
    await runUiMessageCleanupBestEffort(
      context,
      sessionId,
      [promptMessageId]
    );
    throw error;
  }
  if (!finalized.executed || finalized.value !== true) {
    await runUiMessageCleanupBestEffort(
      context,
      sessionId,
      [promptMessageId]
    );
    return { ok: false, stale: true };
  }
}

async function compensateUiInputFailure(
  context,
  sessionId,
  promptMessageId = null
) {
  const compensations = [];
  if (telegramMessageId(promptMessageId) !== null) {
    compensations.push(
      runUiMessageCleanup(context, sessionId, [promptMessageId])
    );
  }
  compensations.push(
    sendUiHome(
      context,
      sessionId,
      '⚠️ 无法启动输入，请稍后重试。'
    )
  );
  await Promise.allSettled(compensations);
}

async function renderUiInputPanel(context, input, notice = '') {
  const prompt = typeof input?.promptText === 'string' && input.promptText
    ? input.promptText
    : '✍️ 请回复临时输入提示，或取消后重新开始。';
  const cancelNonce = normalizeUiInputCancelNonce(input?.cancelNonce);
  await renderUiPanel(
    context,
    input.menuSessionId,
    prompt,
    cancelNonce === null
      ? null
      : {
          inline_keyboard: [[
            uiButton(
              '取消输入',
              input.menuSessionId,
              uiInputCancelAction(cancelNonce)
            )
          ]]
        },
    notice
  );
}

async function claimUiInput(context, key, expectedRaw, input) {
  const now = Math.floor(Date.now() / 1000);
  if (
    input?.phase === 'processing' &&
    Number(input.claimExpiresAt) > now
  ) {
    return null;
  }
  const expiresAt = now + UI_INPUT_TTL_SECONDS;
  await extendUiSessionForInput(
    context,
    input?.menuSessionId,
    expiresAt
  );
  const claimed = {
    ...input,
    v: 2,
    phase: 'processing',
    revision: createOperationToken(),
    claimToken: createOperationToken(),
    claimExpiresAt: now + UI_INPUT_CLAIM_SECONDS,
    expiresAt
  };
  const raw = JSON.stringify(claimed);
  const changed = await context.services.applyOperationalStateChanges(
    context.env,
    [{
      name: key,
      value: raw,
      expectedValue: String(expectedRaw),
      expirationTtl: UI_INPUT_CLEANUP_TTL_SECONDS
    }]
  );
  return changed > 0 ? { input: claimed, raw } : null;
}

async function uiInputClaimIsCurrent(context, key, expectedRaw) {
  const currentRaw = await context.services.readOperationalState(
    context.env,
    key
  );
  if (String(currentRaw ?? '') !== String(expectedRaw)) {
    return false;
  }
  const current = parseStoredObject(currentRaw);
  const expected = parseStoredObject(expectedRaw);
  const now = Math.floor(Date.now() / 1000);
  return Boolean(
    current &&
    expected &&
    current.phase === 'processing' &&
    typeof current.claimToken === 'string' &&
    current.claimToken.length > 0 &&
    current.claimToken === expected.claimToken &&
    Number(current.claimExpiresAt) > now &&
    Number(current.expiresAt) > now
  );
}

async function renewUiInputClaim(context, key, claim) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + UI_INPUT_TTL_SECONDS;
  await extendUiSessionForInput(
    context,
    claim?.input?.menuSessionId,
    expiresAt
  );
  const renewedInput = {
    ...claim.input,
    revision: createOperationToken(),
    claimToken: createOperationToken(),
    claimExpiresAt: now + UI_INPUT_CLAIM_SECONDS,
    expiresAt
  };
  const renewedRaw = JSON.stringify(renewedInput);
  const changed = await context.services.applyOperationalStateChanges(
    context.env,
    [{
      name: key,
      value: renewedRaw,
      expectedValue: String(claim.raw),
      expirationTtl: UI_INPUT_CLEANUP_TTL_SECONDS
    }]
  );
  return changed > 0
    ? { input: renewedInput, raw: renewedRaw }
    : null;
}

async function reopenUiInput(context, key, expectedRaw, input) {
  const reopened = {
    ...input,
    cancelNonce: normalizeUiInputCancelNonce(input?.cancelNonce) ??
      uiConfirmationNonce(),
    v: 2,
    phase: 'open',
    revision: createOperationToken(),
    claimToken: null,
    claimExpiresAt: 0
  };
  const raw = JSON.stringify(reopened);
  const changed = await context.services.applyOperationalStateChanges(
    context.env,
    [{
      name: key,
      value: raw,
      expectedValue: String(expectedRaw),
      expirationTtl: UI_INPUT_CLEANUP_TTL_SECONDS
    }]
  );
  return changed > 0 ? { input: reopened, raw } : null;
}

async function finishUiInput(
  context,
  key,
  input,
  deleteUserMessage = true,
  expectedRaw = JSON.stringify(input)
) {
  const changed = await context.services.applyOperationalStateChanges(
    context.env,
    [{
      name: key,
      delete: true,
      expectedValue: String(expectedRaw)
    }]
  );
  if (changed === 0) {
    return false;
  }
  const messageIds = [input?.promptMessageId];
  if (deleteUserMessage) {
    const userMessageId = telegramMessageId(context.message?.message_id);
    if (
      userMessageId !== null &&
      userMessageId !== telegramMessageId(input?.promptMessageId) &&
      userMessageId !== telegramMessageId(context.panelMessageId)
    ) {
      messageIds.push(userMessageId);
    }
  }
  await runUiMessageCleanupBestEffort(
    context,
    input?.menuSessionId,
    messageIds
  );
  return true;
}

async function cancelUiInput(
  context,
  input,
  expectedRaw = JSON.stringify(input)
) {
  if (!input) {
    return false;
  }
  return finishUiInput(
    context, uiInputKey(context), input, false, expectedRaw
  );
}

async function withUiInputClaimCompensation(
  context,
  key,
  claim,
  operation
) {
  try {
    return await operation();
  } catch (error) {
    try {
      await reopenUiInput(
        context,
        key,
        claim.raw,
        claim.input
      );
    } catch {
      console.error({
        source: 'webhook',
        operation: 'reopenUiInput',
        message: 'Unable to reopen a failed UI input claim.'
      });
    }
    throw error;
  }
}

async function handleUiTextInput(context, text) {
  return runWithRequiredUiPanelLease(
    context,
    () => handleUiTextInputWithPanelLease(context, text)
  );
}

async function handleUiTextInputWithPanelLease(context, text) {
  const key = uiInputKey(context);
  const inputRaw = await context.services.readOperationalState(
    context.env,
    key
  );
  const input = parseStoredObject(inputRaw);
  if (!isValidUiInput(input) || !uiInputMatches(input, context)) {
    if (input) {
      await cancelUiInput(context, input, inputRaw);
    } else {
      await runUiMessageCleanupBestEffort(context);
    }
    return false;
  }

  const menuSession = parseStoredObject(
    await context.services.readOperationalState(
      context.env,
      UI_SESSION_PREFIX + input.menuSessionId
    )
  );
  const activeSession = await context.services.readOperationalState(
    context.env,
    uiActiveKey(context)
  );
  if (
    !isValidUiSession(menuSession) ||
    !uiSessionMatches(menuSession, context) ||
    String(activeSession ?? '') !== String(input.menuSessionId)
  ) {
    await cancelUiInput(context, input, inputRaw);
    return false;
  }
  context.panelMessageId = optionalId(menuSession.panelMessageId);

  const isPrivate = context.message?.chat?.type === 'private';
  const replyMessageId = optionalId(
    context.message?.reply_to_message?.message_id
  );
  if (
    !isPrivate &&
    input.promptMessageId === null
  ) {
    await finishUiInput(
      context,
      key,
      input,
      false,
      inputRaw
    );
    await sendUiHome(
      context,
      input.menuSessionId,
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
    await finishUiInput(
      context,
      key,
      input,
      false,
      inputRaw
    );
    await renderUiPanel(
      context,
      input.menuSessionId,
      '⛔ 管理权限已失效，输入会话已取消。',
      null
    );
    await expireUiSession(context, input.menuSessionId);
    return true;
  }

  const claim = await claimUiInput(context, key, inputRaw, input);
  if (!claim) {
    await deleteMessageBestEffort(context, context.message?.message_id);
    return true;
  }

  return withUiInputClaimCompensation(context, key, claim, async () => {
    const claimedInput = claim.input;
    if (claimedInput.action === 'add_subscription') {
      const result = await handleAdd(
        context,
        [claimedInput.subscriptionType, text],
        { silent: true }
      );
      if (result.status === 'invalid') {
        const reopened = await reopenUiInput(
          context,
          key,
          claim.raw,
          claimedInput
        );
        if (reopened) {
          await renderUiInputPanel(context, reopened.input, result.notice);
        }
        return true;
      }
      const consumed = await finishUiInput(
        context,
        key,
        claimedInput,
        true,
        claim.raw
      );
      if (!consumed) {
        return true;
      }
      await renderUiPanel(
        context,
        claimedInput.menuSessionId,
        '请选择下一步：',
        {
          inline_keyboard: [
            [
              uiButton('📚 查看订阅', claimedInput.menuSessionId, 'l:0'),
              uiButton('➕ 继续添加', claimedInput.menuSessionId, 'a')
            ],
            [uiButton('🏠 主菜单', claimedInput.menuSessionId, 'h')]
          ]
        },
        result.notice
      );
      return true;
    }


    if (claimedInput.action === 'set_default_forward') {
      const scope = String(claimedInput.forwardScope ?? '');
      const target = parseTargetInput(text);
      if (!target) {
        const reopened = await reopenUiInput(
          context,
          key,
          claim.raw,
          claimedInput
        );
        if (reopened) {
          await renderUiInputPanel(
            context,
            reopened.input,
            '⚠️ 格式无效。请回复：<code>&lt;Chat ID&gt; [Topic ID]</code>'
          );
        }
        return true;
      }
      if (!defaultForwardScopeAvailable(context, scope)) {
        const consumed = await finishUiInput(
          context,
          key,
          claimedInput,
          true,
          claim.raw
        );
        if (consumed) {
          await sendUiDefaultForwarding(
            context,
            claimedInput.menuSessionId,
            '⚠️ 当前会话没有该默认转发作用域。'
          );
        }
        return true;
      }
      if (!await authorizeTargetChat(context, target.chatId)) {
        const reopened = await reopenUiInput(
          context,
          key,
          claim.raw,
          claimedInput
        );
        if (reopened) {
          await renderUiInputPanel(
            context,
            reopened.input,
            '⛔ 你没有目标聊天的管理权限，请重新输入。'
          );
        }
        return true;
      }

      const renewedClaim = await renewUiInputClaim(context, key, claim);
      if (!renewedClaim) {
        await deleteMessageBestEffort(
          context,
          context.message?.message_id
        );
        return true;
      }
      claim.input = renewedClaim.input;
      claim.raw = renewedClaim.raw;
      if (!await uiInputClaimIsCurrent(context, key, claim.raw)) {
        await deleteMessageBestEffort(
          context,
          context.message?.message_id
        );
        return true;
      }

      const onlyForward = claimedInput.onlyForward === true;
      await context.env.DB.put(
        defaultForwardKey(context, scope),
        JSON.stringify({
          targetChatId: target.chatId,
          targetThreadId: target.threadId,
          onlyForward,
          isGlobal: scope === 'global'
        })
      );
      const consumed = await finishUiInput(
        context,
        key,
        claim.input,
        true,
        claim.raw
      );
      if (consumed) {
        await sendUiDefaultForwarding(
          context,
          claimedInput.menuSessionId,
          '✅ 已设置' + defaultForwardScopeLabel(context, scope) +
            '默认规则：' + formatTarget(target) + ' · ' +
            (onlyForward ? '仅目标' : '源会话 + 目标')
        );
      }
      return true;
    }
    if (claimedInput.action === 'add_forward_target') {
      const outcome = await handleUiForwardTargetInput(
        context,
        claimedInput,
        claimedInput.subscriptionId,
        text
      );
      if (!outcome.complete) {
        const reopened = await reopenUiInput(
          context,
          key,
          claim.raw,
          claimedInput
        );
        if (reopened) {
          await outcome.render(reopened.input);
        }
        return true;
      }
      const consumed = await finishUiInput(
        context,
        key,
        claimedInput,
        true,
        claim.raw
      );
      if (consumed) {
        await outcome.render(claimedInput);
      }
      return true;
    }

    if (claimedInput.action === 'copy_subscriptions_target') {
      const target = parseTargetInput(text);
      if (!target) {
        const reopened = await reopenUiInput(
          context,
          key,
          claim.raw,
          claimedInput
        );
        if (reopened) {
          await renderUiInputPanel(
            context,
            reopened.input,
            '⚠️ 格式无效。请回复：<code>&lt;Chat ID&gt; [Topic ID]</code>'
          );
        }
        return true;
      }
      if (!await authorizeTargetChat(context, target.chatId)) {
        const reopened = await reopenUiInput(
          context,
          key,
          claim.raw,
          claimedInput
        );
        if (reopened) {
          await renderUiInputPanel(
            context,
            reopened.input,
            '⛔ 你没有目标聊天的管理权限，请重新输入。'
          );
        }
        return true;
      }
      const renewedClaim = await renewUiInputClaim(context, key, claim);
      if (!renewedClaim) {
        await deleteMessageBestEffort(
          context,
          context.message?.message_id
        );
        return true;
      }
      claim.input = renewedClaim.input;
      claim.raw = renewedClaim.raw;
      const started = await startForwardCopySession(
        context,
        target.chatId,
        target.threadId,
        {
          menuSessionId: claimedInput.menuSessionId,
          inputClaim: { key, raw: claim.raw }
        }
      );
      if (started?.ok === false) {
        const reopened = await reopenUiInput(
          context,
          key,
          claim.raw,
          claimedInput
        );
        if (reopened && started?.stale !== true) {
          await renderUiInputPanel(
            context,
            reopened.input,
            '⚠️ 无法打开复制选择器，请稍后重试。'
          );
        }
        if (!reopened) {
          await deleteMessageBestEffort(
            context,
            context.message?.message_id
          );
        }
        return true;
      }
      await finishUiInput(
        context,
        key,
        claimedInput,
        true,
        claim.raw
      );
      return true;
    }

    await finishUiInput(
      context,
      key,
      claimedInput,
      true,
      claim.raw
    );
    return false;
  });
}

async function handleUiForwardTargetInput(
  context,
  input,
  subscriptionIdValue,
  text
) {
  const sessionId = input.menuSessionId;
  const invalid = (notice) => ({
    complete: false,
    render: (currentInput) => renderUiInputPanel(
      context,
      currentInput,
      notice
    )
  });
  const detail = (notice) => ({
    complete: true,
    render: () => sendUiRoutingDetail(
      context,
      sessionId,
      subscriptionIdValue,
      0,
      notice
    )
  });

  const target = parseTargetInput(text);
  if (!target) {
    return invalid(
      '⚠️ 格式无效。请回复：<code>&lt;Chat ID&gt; [Topic ID]</code>'
    );
  }
  if (
    target.chatId === context.chatId &&
    String(target.threadId ?? '') === String(context.threadId ?? '')
  ) {
    return invalid(
      '⚠️ 目标与源会话相同。请使用“源会话投递”开关管理它。'
    );
  }
  if (!await authorizeTargetChat(context, target.chatId)) {
    return invalid('⛔ 你没有目标聊天的管理权限，请重新输入。');
  }

  const scope = routingScope(context, subscriptionIdValue);
  const routing = await context.services.getSubscriptionRouting(
    context.env,
    scope
  );
  if (!routing) {
    return {
      complete: true,
      render: () => sendUiSubscriptionList(
        context,
        sessionId,
        0,
        true,
        '⚠️ 订阅 #' + subscriptionIdValue + ' 已不存在。'
      )
    };
  }
  if (
    routing.independent &&
    routing.targets.some((existing) => sameTarget(existing, target))
  ) {
    return detail('ℹ️ 该目标已经存在。');
  }
  if (
    routing.independent &&
    routing.targets.length >= MAX_FORWARD_TARGETS
  ) {
    return detail(
      '⚠️ 每条订阅最多 ' + MAX_FORWARD_TARGETS + ' 个独立目标。'
    );
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
      return detail('ℹ️ 该目标已由默认规则提供，订阅仍保持继承。');
    }
    snapshot.targets.push(target);
    const result = await context.services.initializeSubscriptionRouting(
      context.env,
      scope,
      snapshot
    );
    added = result.targetsAdded > 0;
  }

  return detail(
    added
      ? '✅ 已添加独立转发目标：' + formatTarget(target)
      : 'ℹ️ 该目标已经存在，或目标数量已达到上限。'
  );
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
    (input.v === 1 || input.v === 2) &&
    (
      input.phase === undefined ||
      input.phase === 'open' ||
      input.phase === 'processing'
    ) &&
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

async function runWithUiPanelLease(context, operation) {
  const leaseName = UI_PANEL_LEASE_PREFIX + uiScopeKey(context);
  const existingToken = context.uiPanelLeaseToken;
  if (existingToken) {
    let renewed;
    try {
      renewed = await context.services.renewOperationalLease(
        context.env,
        leaseName,
        {
          leaseToken: existingToken,
          leaseSeconds: UI_PANEL_LEASE_SECONDS
        }
      );
    } catch (error) {
      delete context.uiPanelLeaseToken;
      delete context.uiPanelLeaseExpiresAt;
      throw error;
    }
    if (!renewed) {
      delete context.uiPanelLeaseToken;
      delete context.uiPanelLeaseExpiresAt;
      return {
        ok: false,
        panelBusy: true,
        retryable: true
      };
    }
    context.uiPanelLeaseExpiresAt =
      Math.floor(Date.now() / 1000) + UI_PANEL_LEASE_SECONDS;
    return operation();
  }

  const leaseToken = createOperationToken();
  const acquired = await context.services.acquireOperationalLease(
    context.env,
    leaseName,
    {
      leaseToken,
      leaseSeconds: UI_PANEL_LEASE_SECONDS
    }
  );
  if (!acquired) {
    return {
      ok: false,
      panelBusy: true,
      retryable: true
    };
  }

  context.uiPanelLeaseToken = leaseToken;
  context.uiPanelLeaseExpiresAt =
    Math.floor(Date.now() / 1000) + UI_PANEL_LEASE_SECONDS;
  try {
    return await operation();
  } finally {
    if (context.uiPanelLeaseToken === leaseToken) {
      delete context.uiPanelLeaseToken;
      delete context.uiPanelLeaseExpiresAt;
      await releaseUiPanelLeaseBestEffort(
        context,
        leaseName,
        leaseToken
      );
    }
  }
}

async function releaseUiPanelLeaseBestEffort(
  context,
  leaseName,
  leaseToken
) {
  try {
    await context.services.releaseOperationalLease(
      context.env,
      leaseName,
      { leaseToken }
    );
  } catch {
    console.error({
      source: 'webhook',
      operation: 'releaseUiPanelLease',
      message: 'Unable to release the UI panel lease.'
    });
  }
}

async function runWithRequiredUiPanelLease(context, operation) {
  const result = await runWithUiPanelLease(context, operation);
  if (result?.panelBusy === true) {
    throw new Error('UI panel is busy; retry the Telegram update');
  }
  return result;
}

async function runCurrentUiCallbackMutation(
  context,
  sessionId,
  operation,
  { expectedCallbackData = context.uiCallbackData } = {}
) {
  const result = await runWithUiPanelLease(context, async () => {
    const sessionKey = UI_SESSION_PREFIX + sessionId;
    const [sessionRaw, activeSessionId] = await Promise.all([
      context.services.readOperationalState(
        context.env,
        sessionKey
      ),
      context.services.readOperationalState(
        context.env,
        uiActiveKey(context)
      )
    ]);
    const session = parseStoredObject(sessionRaw);
    const storedPanelMessageId = telegramMessageId(
      session?.panelMessageId
    );
    const callbackPanelMessageId = telegramMessageId(
      context.panelMessageId
    );
    const allowedCallbacks = Array.isArray(session?.callbackAllowlist)
      ? session.callbackAllowlist
      : [];
    if (
      !isValidUiSession(session) ||
      !uiSessionMatches(session, context) ||
      String(activeSessionId ?? '') !== String(sessionId) ||
      (
        callbackPanelMessageId !== null &&
        storedPanelMessageId !== null &&
        callbackPanelMessageId !== storedPanelMessageId
      ) ||
      !allowedCallbacks.includes(String(expectedCallbackData ?? ''))
    ) {
      return { executed: false, stale: true };
    }
    return {
      executed: true,
      value: await operation()
    };
  });
  return result?.executed === true
    ? result
    : { executed: false, stale: true };
}

function uiActiveKey(context) {
  return UI_ACTIVE_PREFIX + uiScopeKey(context);
}

function uiInputKey(context) {
  return UI_INPUT_PREFIX + uiScopeKey(context);
}

function uiInputCleanupKey(context) {
  return UI_INPUT_CLEANUP_PREFIX + uiScopeKey(context);
}

function parseUiCleanupEntries(raw) {
  const record = parseStoredObject(raw);
  if (record?.v !== 1 || !Array.isArray(record.entries)) {
    return [];
  }
  const entries = new Map();
  for (const entry of record.entries) {
    const messageId = telegramMessageId(entry?.messageId);
    const menuSessionId = String(entry?.menuSessionId ?? '');
    if (messageId === null || !/^[A-Za-z0-9_-]{1,24}$/.test(menuSessionId)) {
      continue;
    }
    entries.set(menuSessionId + ':' + messageId, {
      messageId,
      menuSessionId
    });
  }
  return [...entries.values()];
}

async function runUiMessageCleanup(
  context,
  menuSessionId = null,
  messageIds = []
) {
  const key = uiInputCleanupKey(context);
  const stored = await context.env.DB.get(key);
  const record = parseStoredObject(stored);
  const originalEntries = parseUiCleanupEntries(stored);
  const entries = new Map(originalEntries.map((entry) => [
    entry.menuSessionId + ':' + entry.messageId,
    entry
  ]));
  const normalizedSessionId = String(menuSessionId ?? '');
  let additions = 0;
  if (/^[A-Za-z0-9_-]{1,24}$/.test(normalizedSessionId)) {
    for (const value of messageIds) {
      const messageId = telegramMessageId(value);
      if (messageId !== null) {
        const entryKey = normalizedSessionId + ':' + messageId;
        if (!entries.has(entryKey)) {
          additions += 1;
        }
        entries.set(entryKey, {
          messageId,
          menuSessionId: normalizedSessionId
        });
      }
    }
  }
  if (entries.size === 0) {
    if (stored !== null && stored !== undefined) {
      await context.env.DB.delete(key);
    }
    return 0;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    additions === 0 &&
    Number(record?.updatedAt) >= now - 1
  ) {
    return 0;
  }
  const allEntries = [...entries.values()];
  const selected = allEntries.filter((entry) =>
    menuSessionId === null ||
    entry.menuSessionId === String(menuSessionId)
  );
  const selectedKeys = new Set(selected.map((entry) =>
    entry.menuSessionId + ':' + entry.messageId
  ));
  const retained = allEntries.filter((entry) =>
    !selectedKeys.has(entry.menuSessionId + ':' + entry.messageId)
  );
  const results = await Promise.all(selected.map((entry) =>
    deleteMessageBestEffort(context, entry.messageId)
  ));
  let removed = 0;
  for (let index = 0; index < selected.length; index += 1) {
    if (results[index]) {
      removed += 1;
    } else {
      retained.push(selected[index]);
    }
  }

  const originalKeys = new Set(originalEntries.map((entry) =>
    entry.menuSessionId + ':' + entry.messageId
  ));
  const retainedKeys = new Set(retained.map((entry) =>
    entry.menuSessionId + ':' + entry.messageId
  ));
  const changed = originalKeys.size !== retainedKeys.size ||
    [...originalKeys].some((entryKey) => !retainedKeys.has(entryKey));
  if (!changed) {
    return removed;
  }
  if (retained.length > 0) {
    await context.env.DB.put(
      key,
      JSON.stringify({ v: 1, updatedAt: now, entries: retained }),
      { expirationTtl: UI_INPUT_CLEANUP_TTL_SECONDS }
    );
  } else if (stored !== null && stored !== undefined) {
    await context.env.DB.delete(key);
  }
  return removed;
}

async function runUiMessageCleanupBestEffort(
  context,
  menuSessionId = null,
  messageIds = []
) {
  try {
    return await runUiMessageCleanup(context, menuSessionId, messageIds);
  } catch {
    console.error({
      source: 'webhook',
      operation: 'cleanupUiMessages',
      message: 'Unable to finish UI message cleanup.'
    });
    return 0;
  }
}


function uiPanelKey(context) {
  return UI_PANEL_PREFIX + uiScopeKey(context);
}

async function loadUiPanelMessageId(context) {
  const key = uiPanelKey(context);
  const stored = await context.env.DB.get(key);
  return telegramMessageId(stored);
}

async function rememberUiPanelMessageId(context, messageId) {
  const normalized = telegramMessageId(messageId);
  if (normalized === null) {
    return false;
  }
  await context.env.DB.put(uiPanelKey(context), normalized);
  return true;
}

async function clearUiInput(
  context,
  menuSessionId = null,
  additionalMessageIds = []
) {
  if (
    context?.message?.from?.id === null ||
    context?.message?.from?.id === undefined
  ) {
    return null;
  }
  const key = uiInputKey(context);
  const existing = await context.services.readOperationalState(
    context.env,
    key
  );
  const input = parseStoredObject(existing);
  const inputMatches = menuSessionId === null ||
    String(input?.menuSessionId ?? '') === String(menuSessionId);
  if (
    existing !== null &&
    existing !== undefined &&
    inputMatches
  ) {
    const changed = await context.services.applyOperationalStateChanges(
      context.env,
      [{
        name: key,
        delete: true,
        expectedValue: String(existing)
      }]
    );
    if (changed === 0) {
      return null;
    }
    await runUiMessageCleanupBestEffort(
      context,
      input?.menuSessionId,
      [input?.promptMessageId, ...additionalMessageIds]
    );
    return input;
  }
  await runUiMessageCleanupBestEffort(context, menuSessionId);
  return null;
}

async function clearUiInputForCallback(
  context,
  menuSessionId,
  cancelNonce
) {
  if (
    context?.message?.from?.id === null ||
    context?.message?.from?.id === undefined
  ) {
    return false;
  }
  const normalizedSessionId = String(menuSessionId ?? '');
  const normalizedNonce = normalizeUiInputCancelNonce(cancelNonce);
  if (
    !/^[A-Za-z0-9_-]{1,24}$/.test(normalizedSessionId) ||
    normalizedNonce === null
  ) {
    return false;
  }

  const key = uiInputKey(context);
  const existing = await context.services.readOperationalState(
    context.env,
    key
  );
  if (existing === null || existing === undefined) {
    await runUiMessageCleanupBestEffort(context, normalizedSessionId);
    return true;
  }

  const input = parseStoredObject(existing);
  if (
    String(input?.menuSessionId ?? '') !== normalizedSessionId ||
    normalizeUiInputCancelNonce(input?.cancelNonce) !== normalizedNonce
  ) {
    return false;
  }
  const changed = await context.services.applyOperationalStateChanges(
    context.env,
    [{
      name: key,
      delete: true,
      expectedValue: String(existing)
    }]
  );
  if (changed === 0) {
    return false;
  }
  await runUiMessageCleanupBestEffort(
    context,
    normalizedSessionId,
    [input?.promptMessageId]
  );
  return true;
}

async function handleCancel(context) {
  return runWithRequiredUiPanelLease(
    context,
    () => handleCancelWithPanelLease(context)
  );
}

async function handleCancelWithPanelLease(context) {
  const cancelMessageId = telegramMessageId(context.message?.message_id);
  const input = await clearUiInput(
    context,
    null,
    [cancelMessageId]
  );
  if (!input) {
    await deleteMessageBestEffort(context, cancelMessageId);
  }
  const activeSessionId = await context.services.readOperationalState(
    context.env,
    uiActiveKey(context)
  );
  const sessionId = String(
    input?.menuSessionId ?? activeSessionId ?? ''
  );
  const session = sessionId
    ? parseStoredObject(
        await context.services.readOperationalState(
          context.env,
          UI_SESSION_PREFIX + sessionId
        )
      )
    : null;
  if (isValidUiSession(session) && uiSessionMatches(session, context)) {
    context.panelMessageId = optionalId(session.panelMessageId);
    await sendUiHome(context, sessionId, '✅ 已取消当前输入。');
    return;
  }
  await send(
    context,
    input ? '✅ 已取消当前输入。' : 'ℹ️ 当前没有等待中的输入。'
  );
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
  await send(context, chatInfoText(context));
}

function chatInfoText(context) {
  let text = '🆔 <b>Chat Info</b>\n\n<b>Chat ID:</b> <code>' +
    safe(context.chatId) + '</code>';
  if (context.threadId !== null) {
    text += '\n<b>Thread ID:</b> <code>' + safe(context.threadId) + '</code>';
  }
  return text;
}

async function handleAdd(context, args, { silent = false } = {}) {
  const finish = async (status, notice) => {
    if (!silent) {
      await send(context, notice);
    }
    return { status, notice };
  };
  if (args.length < 2) {
    return finish(
      'invalid',
      'Usage:\n/add rss &lt;url&gt;\n/add x &lt;username&gt;\n' +
        '/add youtube &lt;channel_name&gt;'
    );
  }

  const type = String(args[0]).toLowerCase();
  const argument = String(args[1]);
  if (!TYPES.has(type)) {
    return finish('invalid', 'Unknown type. Use rss, x, or youtube.');
  }
  if (type !== 'rss' && args.length !== 2) {
    return finish(
      'invalid',
      '⚠️ Username or channel name must be one value without whitespace.'
    );
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
    return finish(
      'invalid',
      '⚠️ Invalid feed: ' + safe(errorMessage(error), 500)
    );
  }

  const added = await context.services.addSubscription(context.env, {
    type,
    channelName,
    rssUrl,
    chatId: context.chatId,
    threadId: context.threadId
  });
  return finish(
    added ? 'added' : 'duplicate',
    added
      ? '✅ Added ' + safe(type) + ' subscription: ' + safe(channelName, 700)
      : '⚠️ Subscription already exists.'
  );
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
  targetThreadId,
  { menuSessionId = null, inputClaim = null } = {}
) {
  const current = await context.services.listSubscriptions(context.env, {
    chatId: context.chatId,
    threadId: context.threadId
  });
  if (current.length === 0) {
    if (menuSessionId) {
      return runWithUiPanelLease(
        context,
        async () => {
          if (
            inputClaim &&
            !await uiInputClaimIsCurrent(
              context,
              inputClaim.key,
              inputClaim.raw
            )
          ) {
            return { ok: false, stale: true };
          }
          return sendUiHome(
            context,
            menuSessionId,
            '⚠️ 当前会话没有可复制的订阅。'
          );
        }
      );
    }
    return send(
      context,
      '⚠️ No subscriptions found in this chat to forward.'
    );
  }

  const sessionId = createSessionId(context.services).slice(0, 48);
  const now = Math.floor(Date.now() / 1000);
  const session = {
    v: 2,
    sessionId,
    phase: 'initializing',
    revision: createOperationToken(),
    claimToken: null,
    claimExpiresAt: 0,
    targetChatId,
    targetThreadId,
    sourceChatId: context.chatId,
    menuSessionId,
    selectorMessageId: telegramMessageId(context.panelMessageId),
    sourceThreadId: context.threadId,
    initiatorUserId: String(context.message.from.id),
    subMap: current.map((subscription) => ({
      type: subscriptionType(subscription, context.services),
      channelName: subscriptionDisplayName(subscription, context.services),
      rssUrl: subscription.rssUrl
    })),
    expiresAt: now + SESSION_TTL_SECONDS
  };
  const sessionKey = SESSION_PREFIX + sessionId;
  const sessionRaw = JSON.stringify(session);
  await context.services.applyOperationalStateChanges(context.env, [{
    name: sessionKey,
    value: sessionRaw,
    expirationTtl: SESSION_TTL_SECONDS
  }]);
  const rendered = await sendForwardCopyPage(
    context,
    sessionId,
    session,
    0,
    { persistSession: true, stateRaw: sessionRaw, inputClaim }
  );
  if (rendered?.ok !== true) {
    await context.services.applyOperationalStateChanges(context.env, [{
      name: sessionKey,
      delete: true,
      expectedValue: sessionRaw
    }]);
  }
  return rendered;
}

async function sendForwardCopyPage(
  context,
  sessionId,
  session,
  requestedPage,
  options = {}
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
  return renderForwardCopyPanel(
    context,
    SESSION_PREFIX + sessionId,
    session,
    text,
    { inline_keyboard: rows },
    options
  );
}

async function renderForwardCopyPanel(
  context,
  sessionKey,
  session,
  text,
  replyMarkup = null,
  options = {}
) {
  return runWithUiPanelLease(
    context,
    () => renderForwardCopyPanelWithLease(
      context,
      sessionKey,
      session,
      text,
      replyMarkup,
      options
    )
  );
}

async function renderForwardCopyPanelWithLease(
  context,
  sessionKey,
  session,
  text,
  replyMarkup,
  {
    persistSession = false,
    stateRaw = null,
    inputClaim = null
  } = {}
) {
  if (
    inputClaim &&
    !await uiInputClaimIsCurrent(
      context,
      inputClaim.key,
      inputClaim.raw
    )
  ) {
    return { ok: false, stale: true };
  }
  const currentRaw = await context.services.readOperationalState(
    context.env,
    sessionKey
  );
  if (
    (stateRaw !== null && String(currentRaw ?? '') !== String(stateRaw)) ||
    !await menuOwnedForwardSessionIsActive(
      context.env,
      context.services,
      {
        from: context.message?.from,
        message: {
          ...context.message,
          message_id: context.panelMessageId ?? session.selectorMessageId
        }
      },
      session,
      { allowUnboundView: persistSession }
    )
  ) {
    return { ok: false, stale: true };
  }
  const fingerprint = renderFingerprint(text, replyMarkup);
  const selectorCallbackAllowlist = callbackDataAllowlist(replyMarkup);
  const selectorMessageId = telegramMessageId(
    session.selectorMessageId ?? context.panelMessageId
  );

  if (selectorMessageId !== null) {
    const edited = await context.services.editTelegramMessage(
      context.token,
      context.chatId,
      selectorMessageId,
      text,
      replyMarkup,
      telegramOptions(context.services)
    );
    if (edited?.ok === true || isTelegramMessageNotModified(edited)) {
      await persistForwardCopyPanel(
        context,
        sessionKey,
        session,
        selectorMessageId,
        fingerprint,
        selectorCallbackAllowlist,
        { persistSession, stateRaw, inputClaim }
      );
      return edited?.ok === true ? edited : { ok: true };
    }
    reportTelegramFailure(
      context.services,
      context.token,
      'editMessageText',
      edited
    );
    if (!shouldRecreateEditedMessage(edited)) {
      return edited;
    }
  }

  const sent = await send(context, text, replyMarkup);
  const sentMessageId = telegramMessageId(sent?.result?.message_id);
  if (sent?.ok === true && sentMessageId !== null) {
    try {
      await persistForwardCopyPanel(
        context,
        sessionKey,
        session,
        sentMessageId,
        fingerprint,
        selectorCallbackAllowlist,
        { persistSession, stateRaw, inputClaim }
      );
    } catch (error) {
      await deleteMessageBestEffort(context, sentMessageId);
      throw error;
    }
  }
  return sent;
}

async function persistForwardCopyPanel(
  context,
  sessionKey,
  session,
  selectorMessageId,
  selectorFingerprint,
  selectorCallbackAllowlist,
  {
    persistSession = false,
    stateRaw = null,
    inputClaim = null
  } = {}
) {
  const normalizedSelectorMessageId = telegramMessageId(selectorMessageId);
  if (normalizedSelectorMessageId === null) {
    throw new TypeError('Telegram selector message ID is invalid');
  }
  if (stateRaw === null) {
    throw new TypeError('Forward panel state is required');
  }

  const previousSelectorMessageId = telegramMessageId(
    session.selectorMessageId
  );
  const bindingChanged =
    previousSelectorMessageId !== normalizedSelectorMessageId;
  const sessionId = String(
    session.sessionId ??
      (sessionKey.startsWith(SESSION_PREFIX)
        ? sessionKey.slice(SESSION_PREFIX.length)
        : '')
  );
  if (!sessionId) {
    throw new TypeError('Forward session ID is invalid');
  }
  const nextSession = {
    ...session,
    sessionId,
    ...(persistSession && session.phase === 'initializing'
      ? {
          phase: 'open',
          revision: createOperationToken(),
          claimToken: null,
          claimExpiresAt: 0
        }
      : {}),
    selectorMessageId: normalizedSelectorMessageId,
    selectorFingerprint,
    selectorCallbackAllowlist
  };
  const nextSessionRaw = JSON.stringify(nextSession);
  const changes = [{
    name: sessionKey,
    value: nextSessionRaw,
    expectedValue: String(stateRaw),
    expirationTtl: forwardStateTtl(nextSession)
  }];
  const rollbackChanges = [{
    name: sessionKey,
    value: String(stateRaw),
    expectedValue: nextSessionRaw,
    expirationTtl: forwardStateTtl(session)
  }];

  if (inputClaim) {
    changes.push({
      name: inputClaim.key,
      value: inputClaim.raw,
      expectedValue: inputClaim.raw,
      expirationTtl: UI_INPUT_CLEANUP_TTL_SECONDS
    });
  }

  if (session.menuSessionId) {
    const uiSessionKey = UI_SESSION_PREFIX + session.menuSessionId;
    const [uiSessionRaw, activeSessionId] = await Promise.all([
      context.services.readOperationalState(context.env, uiSessionKey),
      context.services.readOperationalState(
        context.env,
        uiActiveKey(context)
      )
    ]);
    const uiSession = parseStoredObject(uiSessionRaw);
    if (
      !isValidUiSession(uiSession) ||
      !uiSessionMatches(uiSession, context) ||
      String(activeSessionId ?? '') !== String(session.menuSessionId)
    ) {
      throw new Error('Forward selector no longer owns the active menu');
    }
    const remainingTtl = Math.max(
      60,
      Number(uiSession.expiresAt) - Math.floor(Date.now() / 1000)
    );
    const nextUiSessionRaw = JSON.stringify({
      ...uiSession,
      panelMessageId: normalizedSelectorMessageId,
      renderFingerprint: selectorFingerprint,
      forwardSessionId: sessionId,
      callbackAllowlist: selectorCallbackAllowlist
    });
    changes.push({
      name: uiSessionKey,
      value: nextUiSessionRaw,
      expectedValue: String(uiSessionRaw),
      expirationTtl: Math.floor(remainingTtl)
    });
    rollbackChanges.unshift({
      name: uiSessionKey,
      value: String(uiSessionRaw),
      expectedValue: nextUiSessionRaw,
      expirationTtl: Math.floor(remainingTtl)
    });
  }

  let changed;
  try {
    changed = await context.services.applyOperationalStateChanges(
      context.env,
      changes
    );
  } catch (error) {
    await rollbackForwardPanelChanges(context, rollbackChanges);
    throw error;
  }
  if (changed !== changes.length) {
    await rollbackForwardPanelChanges(context, rollbackChanges);
    throw new Error('Forward panel view changed before persistence');
  }
  context.panelMessageId = normalizedSelectorMessageId;

  if (session.menuSessionId && bindingChanged) {
    try {
      await rememberUiPanelMessageId(context, normalizedSelectorMessageId);
    } catch {
      console.error({
        source: 'webhook',
        operation: 'rememberForwardPanelMessageId',
        message: 'Unable to remember the forward panel message ID.'
      });
    }
  }
}

async function rollbackForwardPanelChanges(context, changes) {
  try {
    await context.services.applyOperationalStateChanges(context.env, changes);
  } catch {
    console.error({
      source: 'webhook',
      operation: 'rollbackForwardPanelChanges',
      message: 'Unable to fully roll back a partial forward panel binding.'
    });
  }
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

async function renderUiPanel(
  context,
  sessionId,
  text,
  replyMarkup = null,
  notice = ''
) {
  return runWithUiPanelLease(
    context,
    () => renderUiPanelWithLease(
      context,
      sessionId,
      text,
      replyMarkup,
      notice
    )
  );
}

async function renderUiPanelWithLease(
  context,
  sessionId,
  text,
  replyMarkup,
  notice
) {
  const sessionKey = UI_SESSION_PREFIX + sessionId;
  const sessionRaw = await context.services.readOperationalState(
    context.env,
    sessionKey
  );
  const session = parseStoredObject(sessionRaw);
  const activeSessionId = await context.services.readOperationalState(
    context.env,
    uiActiveKey(context)
  );
  if (
    !isValidUiSession(session) ||
    !uiSessionMatches(session, context) ||
    String(activeSessionId ?? '') !== String(sessionId)
  ) {
    return { ok: false, stale: true };
  }
  const renderedText = notice ? notice + '\n\n' + text : text;
  const fingerprint = renderFingerprint(renderedText, replyMarkup);
  const callbackAllowlist = callbackDataAllowlist(replyMarkup);
  const panelMessageId = telegramMessageId(
    session.panelMessageId ?? context.panelMessageId
  );

  if (panelMessageId !== null) {
    const edited = await context.services.editTelegramMessage(
      context.token,
      context.chatId,
      panelMessageId,
      renderedText,
      replyMarkup,
      telegramOptions(context.services)
    );
    if (edited?.ok === true || isTelegramMessageNotModified(edited)) {
      await persistUiPanel(
        context,
        sessionKey,
        sessionRaw,
        session,
        panelMessageId,
        fingerprint,
        callbackAllowlist
      );
      return edited?.ok === true
        ? edited
        : { ok: true, result: { message_id: Number(panelMessageId) } };
    }
    reportTelegramFailure(
      context.services,
      context.token,
      'editMessageText',
      edited
    );
    if (!shouldRecreateEditedMessage(edited)) {
      return edited;
    }
  }

  const sent = await send(context, renderedText, replyMarkup);
  const sentMessageId = telegramMessageId(sent?.result?.message_id);
  if (sent?.ok === true && sentMessageId !== null) {
    try {
      await persistUiPanel(
        context,
        sessionKey,
        sessionRaw,
        session,
        sentMessageId,
        fingerprint,
        callbackAllowlist
      );
    } catch (error) {
      await deleteMessageBestEffort(context, sentMessageId);
      throw error;
    }
  }
  return sent;
}

async function persistUiPanel(
  context,
  sessionKey,
  sessionRaw,
  session,
  panelMessageId,
  fingerprint,
  callbackAllowlist
) {
  const normalizedPanelMessageId = telegramMessageId(panelMessageId);
  if (normalizedPanelMessageId === null) {
    throw new TypeError('Telegram panel message ID is invalid');
  }
  const previousPanelMessageId = telegramMessageId(session.panelMessageId);
  const bindingChanged = previousPanelMessageId !== normalizedPanelMessageId;
  const forwardViewChanged = Boolean(session.forwardSessionId);
  const callbackViewChanged =
    JSON.stringify(session.callbackAllowlist ?? []) !==
    JSON.stringify(callbackAllowlist);
  const viewFenceChanged =
    forwardViewChanged || callbackViewChanged;
  const nextSession = {
    ...session,
    panelMessageId: normalizedPanelMessageId,
    renderFingerprint: fingerprint,
    callbackAllowlist
  };
  delete nextSession.forwardSessionId;
  context.panelMessageId = normalizedPanelMessageId;
  const remainingTtl = Math.max(
    60,
    Number(session.expiresAt) - Math.floor(Date.now() / 1000)
  );
  let changed = 0;
  try {
    changed = await context.services.applyOperationalStateChanges(context.env, [{
      name: sessionKey,
      value: JSON.stringify(nextSession),
      expectedValue: String(sessionRaw),
      expirationTtl: Math.floor(remainingTtl)
    }]);
  } catch (error) {
    if (bindingChanged || viewFenceChanged) {
      throw error;
    }
    console.error({
      source: 'webhook',
      operation: 'persistUiPanelMetadata',
      message: 'Unable to persist non-critical UI render metadata.'
    });
  }
  if ((bindingChanged || viewFenceChanged) && changed === 0) {
    throw new Error(
      'UI panel binding or active view changed before persistence'
    );
  }
  const rememberedPanelDiffers =
    context.rememberedPanelMessageId !== undefined &&
    context.rememberedPanelMessageId !== normalizedPanelMessageId;
  if (bindingChanged || rememberedPanelDiffers) {
    try {
      await rememberUiPanelMessageId(context, normalizedPanelMessageId);
      context.rememberedPanelMessageId = normalizedPanelMessageId;
    } catch {
      console.error({
        source: 'webhook',
        operation: 'rememberUiPanelMessageId',
        message: 'Unable to remember the UI panel message ID.'
      });
    }
  }
  return changed > 0;
}

function callbackDataAllowlist(replyMarkup) {
  const rows = Array.isArray(replyMarkup?.inline_keyboard)
    ? replyMarkup.inline_keyboard
    : [];
  const callbacks = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (typeof button?.callback_data === 'string') {
        callbacks.push(button.callback_data);
      }
    }
  }
  return [...new Set(callbacks)];
}

function renderFingerprint(text, replyMarkup) {
  const value = String(text) + '\n' + JSON.stringify(replyMarkup ?? null);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return value.length.toString(36) + ':' + (hash >>> 0).toString(36);
}

function isTelegramMessageNotModified(result) {
  return result?.status === 400 &&
    /message is not modified/i.test(String(result?.apiDescription ?? ''));
}

function shouldRecreateEditedMessage(result) {
  if (result?.retryable === true || result?.status === 429) {
    return false;
  }
  return /message to edit not found|message can(?:not|'t) be edited|message_id_invalid/i
    .test(String(result?.apiDescription ?? ''));
}

async function deleteMessageBestEffort(context, messageId) {
  const normalizedMessageId = telegramMessageId(messageId);
  if (normalizedMessageId === null) {
    return true;
  }
  let result;
  try {
    result = await context.services.deleteTelegramMessage(
      context.token,
      context.chatId,
      normalizedMessageId,
      telegramOptions(context.services, { timeoutMs: 2_500 })
    );
  } catch {
    return false;
  }
  if (result?.ok !== true && result?.retryable === true) {
    reportTelegramFailure(
      context.services,
      context.token,
      'deleteMessage',
      result
    );
  }
  return result?.ok === true || result?.retryable !== true;
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

function telegramOptions(services, overrides = {}) {
  return {
    ...(services.fetchFn ? { fetchFn: services.fetchFn } : {}),
    ...overrides
  };
}

function optionalId(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function telegramMessageId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const normalized = String(value);
  if (!/^[1-9]\d{0,15}$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? String(parsed)
    : null;
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

function createOperationToken() {
  return createSessionId({});
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
  '菜单先选择“默认转发”或“分别管理每条订阅”。\n' +
  '默认转发可查看、设置或删除当前 Topic/Global 规则，并选择“源会话 + 目标”或“仅目标”。\n' +
  '分别管理可为每条订阅设置最多 10 个目标、控制源会话投递、停止继承或恢复继承。\n' +
  '快捷命令：\n' +
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
