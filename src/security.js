const WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

function constantTimeEqual(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  const maxLength = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export function verifyWebhookRequest(request, secret) {
  const received = request?.headers?.get?.(WEBHOOK_SECRET_HEADER) ?? '';
  return Boolean(secret) && constantTimeEqual(received, secret);
}

export function parseCommand(text, botUsername = '') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const [token, ...args] = trimmed.split(/\s+/);
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?$/i.exec(token);
  if (!match) {
    return null;
  }

  const mentionedBot = String(match[2] ?? '').toLowerCase();
  const expectedBot = String(botUsername ?? '').replace(/^@/, '').toLowerCase();
  if (mentionedBot && (!expectedBot || mentionedBot !== expectedBot)) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    args,
    mentionedBot: mentionedBot || null
  };
}

const MANAGEMENT_COMMANDS = new Set([
  'start',
  'menu',
  'add',
  'del',
  'remove',
  'set_forward',
  'del_forward',
  'forward_to'
]);

export function isManagementCommand(name) {
  return MANAGEMENT_COMMANDS.has(String(name ?? '').toLowerCase());
}

export async function canManageChat({ message, config, getChatMemberFn }) {
  const userId = message?.from?.id;
  const chat = message?.chat;
  if (userId === null || userId === undefined || !chat) {
    return false;
  }

  const normalizedUserId = String(userId);
  if (config?.adminUserIds?.size > 0) {
    return config.adminUserIds.has(normalizedUserId);
  }

  if (chat.type === 'private') {
    return String(chat.id) === normalizedUserId;
  }

  return verifyChatAdministrator(
    chat.id, userId, getChatMemberFn, 'source'
  );
}

export async function canManageTargetChat({
  message,
  targetChatId,
  config,
  getChatMemberFn
}) {
  const userId = message?.from?.id;
  const sourceChatId = message?.chat?.id;
  if (
    userId === null || userId === undefined ||
    sourceChatId === null || sourceChatId === undefined ||
    targetChatId === null || targetChatId === undefined
  ) {
    return false;
  }

  const normalizedUserId = String(userId);
  if (config?.adminUserIds?.size > 0) {
    return config.adminUserIds.has(normalizedUserId);
  }

  const normalizedTargetChatId = String(targetChatId);
  if (
    normalizedTargetChatId === String(sourceChatId) ||
    normalizedTargetChatId === normalizedUserId
  ) {
    return true;
  }

  return verifyChatAdministrator(
    normalizedTargetChatId, normalizedUserId, getChatMemberFn, 'target'
  );
}

export function canUseForwardSession(callbackQuery, session) {
  if (!callbackQuery?.message?.chat || !callbackQuery?.from || !session) {
    return false;
  }

  const callbackThreadId = callbackQuery.message.message_thread_id ?? null;
  return (
    String(session.sourceChatId) === String(callbackQuery.message.chat.id) &&
    String(session.initiatorUserId) === String(callbackQuery.from.id) &&
    String(session.sourceThreadId ?? '') === String(callbackThreadId ?? '')
  );
}

async function verifyChatAdministrator(chatId, userId, getChatMemberFn, label) {
  if (typeof getChatMemberFn !== 'function') {
    return false;
  }

  try {
    const member = await getChatMemberFn(chatId, userId);
    return member?.status === 'creator' || member?.status === 'administrator';
  } catch {
    console.error(
      'Unable to verify Telegram ' + label + ' chat administrator.'
    );
    return false;
  }
}

export { WEBHOOK_SECRET_HEADER };
