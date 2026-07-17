const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_CALLBACK_TEXT_LENGTH = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render a bounded Telegram HTML message. All feed-controlled fields are
 * escaped independently, so a malicious title/link cannot inject markup.
 */
export function renderFeedMessage(item = {}, sourceName = '') {
  const fields = {
    title: boundedEscapedText(item?.title || 'Untitled', 1_100),
    source: boundedEscapedText(sourceName || item?.source || 'Unknown', 650),
    link: boundedEscapedText(item?.link || '', 1_550),
    date: boundedEscapedText(item?.pubDate || '', 350)
  };

  const message = `🔴 <b>New Update!</b>\n\n` +
    `<b>Title:</b> ${fields.title}\n` +
    `<b>Source:</b> ${fields.source}\n` +
    `<b>Link:</b> ${fields.link}\n` +
    `<b>Date:</b> ${fields.date}`;

  // Field budgets above keep this below the Bot API limit. Keep an explicit
  // assertion so future template edits cannot silently produce invalid sends.
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`Rendered Telegram message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }
  return message;
}

/**
 * Send one Telegram message. This function deliberately does not sleep,
 * retry, or consume any caller-owned budget; its structured result lets the
 * poller make those scheduling decisions.
 */
export async function sendTelegramMessage(
  token,
  chatId,
  threadId,
  text,
  replyMarkup = null,
  options = {}
) {
  const message = String(text ?? '');
  if (!message) {
    return localFailure('Telegram message text is required');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return localFailure(`Telegram message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }

  let normalizedThreadId = null;
  if (threadId !== null && threadId !== undefined && threadId !== '') {
    normalizedThreadId = parsePositiveSafeInteger(threadId);
    if (normalizedThreadId === null) {
      return localFailure('message_thread_id must be a positive safe integer');
    }
  }

  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML'
  };
  if (normalizedThreadId !== null) {
    payload.message_thread_id = normalizedThreadId;
  }
  if (replyMarkup !== null && replyMarkup !== undefined) {
    payload.reply_markup = replyMarkup;
  }

  return callTelegramApi(token, 'sendMessage', payload, options);
}

export async function answerCallbackQuery(token, callbackQueryId, text, options = {}) {
  const payload = {
    callback_query_id: callbackQueryId,
    text: truncatePlainText(text, MAX_CALLBACK_TEXT_LENGTH)
  };
  return callTelegramApi(token, 'answerCallbackQuery', payload, options);
}

/**
 * Return the common Telegram result plus `member` for permission checks.
 */
export async function getChatMember(token, chatId, userId, options = {}) {
  const normalizedUserId = parsePositiveSafeInteger(userId);
  if (normalizedUserId === null) {
    return {
      ...localFailure('user_id must be a positive safe integer'),
      member: null
    };
  }
  const result = await callTelegramApi(token, 'getChatMember', {
    chat_id: chatId,
    user_id: normalizedUserId
  }, options);
  return {
    ...result,
    member: result.ok ? (result.result ?? null) : null
  };
}

/** Accept either a raw ChatMember or the object returned by getChatMember. */
export function isChatAdministrator(memberOrResponse) {
  const member = memberOrResponse?.member ?? memberOrResponse?.result ?? memberOrResponse;
  return member?.status === 'creator' || member?.status === 'administrator';
}

async function callTelegramApi(token, method, payload, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!String(token ?? '').trim()) {
    return localFailure('Telegram bot token is required');
  }
  if (typeof fetchFn !== 'function') {
    return localFailure('fetchFn must be a function');
  }

  const safeTimeoutMs = Number(timeoutMs);
  if (!Number.isSafeInteger(safeTimeoutMs) || safeTimeoutMs <= 0) {
    return localFailure('timeoutMs must be a positive integer');
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Telegram request timed out after ${safeTimeoutMs}ms`));
  }, safeTimeoutMs);

  try {
    const response = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response || typeof response.ok !== 'boolean') {
      return networkFailure('Telegram returned an invalid response');
    }

    const status = Number(response.status) || (response.ok ? 200 : 0);
    if (typeof response.text !== 'function') {
      return {
        ...networkFailure('Telegram returned an invalid response'),
        status
      };
    }
    const rawBody = await response.text();
    const body = parseJsonSafely(rawBody);
    if (response.ok && body?.ok !== true) {
      return {
        ...networkFailure('Telegram returned an invalid response'),
        status
      };
    }
    if (response.ok) {
      return {
        ok: true,
        status,
        retryable: false,
        permanent: false,
        retryAfterSeconds: 0,
        error: null,
        result: body?.result ?? null
      };
    }

    const retryAfterSeconds = extractRetryAfterSeconds(body, response);
    const retryable = isRetryableStatus(status);
    const description = String(body?.description || rawBody || `Telegram HTTP ${status}`).trim();
    return {
      ok: false,
      status,
      retryable,
      permanent: !retryable,
      retryAfterSeconds,
      error: description,
      result: null
    };
  } catch {
    const message = timedOut
      ? `Telegram request timed out after ${safeTimeoutMs}ms`
      : 'Telegram network request failed';
    return networkFailure(message);
  } finally {
    clearTimeout(timeout);
  }
}

function localFailure(error) {
  return {
    ok: false,
    status: 0,
    retryable: false,
    permanent: true,
    retryAfterSeconds: 0,
    error,
    result: null
  };
}

function networkFailure(error) {
  return {
    ok: false,
    status: 0,
    retryable: true,
    permanent: false,
    retryAfterSeconds: 0,
    error,
    result: null
  };
}

function isRetryableStatus(status) {
  return status === 0 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
}

function extractRetryAfterSeconds(body, response) {
  const apiValue = Number(body?.parameters?.retry_after);
  if (Number.isFinite(apiValue) && apiValue > 0) {
    return Math.ceil(apiValue);
  }

  const header = String(response.headers?.get?.('retry-after') ?? '').trim();
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds);
  }
  if (header) {
    const retryAt = Date.parse(header);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    }
  }
  return 0;
}

function parseJsonSafely(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function parsePositiveSafeInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedEscapedText(value, maxLength) {
  const raw = String(value ?? '');
  const tokens = [...raw].map((character) => escapeHtml(character));
  const totalLength = tokens.reduce((sum, token) => sum + token.length, 0);
  if (totalLength <= maxLength) {
    return tokens.join('');
  }

  const suffix = '…';
  const available = Math.max(0, maxLength - suffix.length);
  let result = '';
  for (const token of tokens) {
    if (result.length + token.length > available) {
      break;
    }
    result += token;
  }
  return `${result}${suffix}`;
}

function truncatePlainText(value, maxLength) {
  const characters = [...String(value ?? '')];
  if (characters.length <= maxLength) {
    return characters.join('');
  }
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}
