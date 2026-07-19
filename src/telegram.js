const TELEGRAM_API_HOST = 'api.telegram.org';
const TELEGRAM_API_BASE = `https://${TELEGRAM_API_HOST}`;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_CALLBACK_TEXT_LENGTH = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 500;
const TELEGRAM_FAILURE_KINDS = new Set([
  'network_exception',
  'timeout',
  'unexpected_redirect',
  'invalid_response',
  'invalid_json',
  'invalid_api_response',
  'http_error',
  'caller_exception'
]);
const TELEGRAM_FAILURE_PHASES = new Set([
  'fetch',
  'redirect',
  'response_body',
  'response_parse',
  'response_validate',
  'send'
]);

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

/**
 * Build an allowlisted, query-friendly Workers Logs object. Unknown fields on
 * result/context are deliberately ignored so URLs, payloads, and stack traces
 * cannot be logged by accidentally spreading an Error or API result.
 */
export function buildTelegramFailureLogDetails(
  token,
  operation,
  result,
  context = {}
) {
  const sensitiveValues = Array.isArray(context?.sensitiveValues)
    ? context.sensitiveValues
    : [];
  const details = {
    message: sanitizeTelegramLogValue(
      context?.message || 'Telegram API request failed.',
      token,
      sensitiveValues
    ),
    operation: sanitizeTelegramLogValue(operation, token, sensitiveValues),
    status: nonNegativeInteger(result?.status),
    retryable: Boolean(result?.retryable),
    permanent: Boolean(result?.permanent),
    retryAfterSeconds: nonNegativeInteger(result?.retryAfterSeconds),
    error: sanitizeTelegramLogValue(
      result?.error || 'Unknown Telegram API error',
      token,
      sensitiveValues
    )
  };

  const source = sanitizeTelegramLogValue(
    context?.source || '',
    token,
    sensitiveValues
  );
  if (source) {
    details.source = source;
  }

  const diagnostic = normalizeTelegramDiagnostic(
    result?.diagnostic,
    token,
    sensitiveValues
  );
  if (diagnostic) {
    Object.assign(details, diagnostic);
  }

  for (const key of ['deliveryId', 'attempt', 'maxAttempts']) {
    const value = nonNegativeIntegerOrNull(context?.[key]);
    if (value !== null) {
      details[key] = value;
    }
  }
  if (typeof context?.exhausted === 'boolean') {
    details.exhausted = context.exhausted;
  }
  return details;
}

/**
 * Redact before truncating. This ordering prevents a token crossing the
 * truncation boundary from leaving a partial secret in logs or D1.
 */
export function sanitizeTelegramLogValue(value, token = '', sensitiveValues = []) {
  let normalized = safeString(value);
  const rawSecrets = [
    safeString(token),
    ...(Array.isArray(sensitiveValues)
      ? sensitiveValues.map((entry) => safeString(entry))
      : [])
  ];
  const secrets = new Set(rawSecrets.flatMap(sensitiveStringVariants));
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    normalized = normalized.replaceAll(secret, '[REDACTED]');
  }

  normalized = normalized
    .replace(
      /https?:\/\/api\.telegram\.org\/bot[^\s/?#]+\/[^\s?#]*/gi,
      '[REDACTED_TELEGRAM_URL]'
    )
    .replace(
      /\/bot[0-9A-Za-z:_-]+\/[A-Za-z][A-Za-z0-9_]*/g,
      '/bot[REDACTED]/[METHOD]'
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
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
  const startedAt = Date.now();
  const sensitiveValues = collectPayloadSensitiveValues(payload);
  let failurePhase = 'fetch';
  let upstreamStatus = 0;
  let responseContentType = '';
  let responseBodyLength = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Telegram request timed out after ${safeTimeoutMs}ms`));
  }, safeTimeoutMs);

  try {
    const response = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    failurePhase = 'response_validate';
    if (!response || typeof response.ok !== 'boolean') {
      return networkFailure(
        'Telegram returned an invalid response',
        createTelegramDiagnostic({
          failureKind: 'invalid_response',
          failurePhase,
          startedAt,
          timeoutMs: safeTimeoutMs,
          token,
          sensitiveValues
        })
      );
    }

    upstreamStatus = Number(response.status) || (response.ok ? 200 : 0);
    responseContentType = sanitizeTelegramLogValue(
      response.headers?.get?.('content-type') || '',
      token,
      sensitiveValues
    ).slice(0, 120);

    if (upstreamStatus >= 300 && upstreamStatus < 400) {
      failurePhase = 'redirect';
      const redirectHost = redirectHostnameFromLocation(
        response.headers?.get?.('location')
      );
      return networkFailure(
        'Telegram returned an unexpected redirect',
        createTelegramDiagnostic({
          failureKind: 'unexpected_redirect',
          failurePhase,
          startedAt,
          timeoutMs: safeTimeoutMs,
          upstreamStatus,
          redirectHost,
          responseContentType,
          token,
          sensitiveValues
        }),
        upstreamStatus
      );
    }

    if (typeof response.text !== 'function') {
      return networkFailure(
        'Telegram returned an invalid response',
        createTelegramDiagnostic({
          failureKind: 'invalid_response',
          failurePhase,
          startedAt,
          timeoutMs: safeTimeoutMs,
          upstreamStatus,
          responseContentType,
          token,
          sensitiveValues
        }),
        upstreamStatus
      );
    }

    failurePhase = 'response_body';
    const rawBody = await response.text();
    responseBodyLength = String(rawBody ?? '').length;
    failurePhase = 'response_parse';
    const parsedBody = parseJsonSafely(rawBody);
    const body = parsedBody.value;
    if (response.ok && !parsedBody.ok) {
      return networkFailure(
        'Telegram returned invalid JSON',
        createTelegramDiagnostic({
          failureKind: 'invalid_json',
          failurePhase,
          startedAt,
          timeoutMs: safeTimeoutMs,
          upstreamStatus,
          responseContentType,
          responseBodyLength,
          token,
          sensitiveValues
        }),
        upstreamStatus
      );
    }

    failurePhase = 'response_validate';
    if (response.ok && body?.ok !== true) {
      return networkFailure(
        'Telegram returned an invalid response',
        createTelegramDiagnostic({
          failureKind: 'invalid_api_response',
          failurePhase,
          startedAt,
          timeoutMs: safeTimeoutMs,
          upstreamStatus,
          responseContentType,
          responseBodyLength,
          token,
          sensitiveValues
        }),
        upstreamStatus
      );
    }

    if (response.ok) {
      return {
        ok: true,
        status: upstreamStatus,
        retryable: false,
        permanent: false,
        retryAfterSeconds: 0,
        error: null,
        result: body?.result ?? null
      };
    }

    const retryAfterSeconds = extractRetryAfterSeconds(body, response);
    const retryable = isRetryableStatus(upstreamStatus);
    const description = `Telegram HTTP ${upstreamStatus}`;
    return {
      ok: false,
      status: upstreamStatus,
      retryable,
      permanent: !retryable,
      retryAfterSeconds,
      error: description,
      result: null,
      diagnostic: createTelegramDiagnostic({
        failureKind: 'http_error',
        failurePhase,
        startedAt,
        timeoutMs: safeTimeoutMs,
        upstreamStatus,
        responseContentType,
        responseBodyLength,
        token,
        sensitiveValues
      })
    };
  } catch (error) {
    const message = timedOut
      ? `Telegram request timed out after ${safeTimeoutMs}ms`
      : 'Telegram network request failed';
    return networkFailure(
      message,
      createTelegramDiagnostic({
        failureKind: timedOut ? 'timeout' : 'network_exception',
        failurePhase,
        startedAt,
        timeoutMs: safeTimeoutMs,
        upstreamStatus,
        responseContentType,
        responseBodyLength,
        timedOut,
        error,
        token,
        sensitiveValues
      }),
      upstreamStatus
    );
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

function networkFailure(error, diagnostic = null, status = 0) {
  return {
    ok: false,
    status: nonNegativeInteger(status),
    retryable: true,
    permanent: false,
    retryAfterSeconds: 0,
    error,
    result: null,
    ...(diagnostic ? { diagnostic } : {})
  };
}

function createTelegramDiagnostic({
  failureKind,
  failurePhase,
  startedAt,
  timeoutMs,
  upstreamStatus = 0,
  redirectHost = null,
  responseContentType = '',
  responseBodyLength = 0,
  timedOut = false,
  error = null,
  token = '',
  sensitiveValues = []
}) {
  const exception = extractExceptionDetails(error, token, sensitiveValues);
  const normalizedRedirectHost = normalizeHostname(redirectHost);
  return {
    failureKind: TELEGRAM_FAILURE_KINDS.has(failureKind)
      ? failureKind
      : 'network_exception',
    failurePhase: TELEGRAM_FAILURE_PHASES.has(failurePhase)
      ? failurePhase
      : 'fetch',
    durationMs: elapsedMilliseconds(startedAt),
    timeoutMs: nonNegativeInteger(timeoutMs),
    upstreamHost: TELEGRAM_API_HOST,
    upstreamStatus: nonNegativeInteger(upstreamStatus),
    ...(normalizedRedirectHost
      ? { redirectHost: normalizedRedirectHost }
      : {}),
    responseContentType: responseContentType || null,
    responseBodyLength: nonNegativeInteger(responseBodyLength),
    timedOut: Boolean(timedOut),
    ...exception
  };
}

function extractExceptionDetails(error, token, sensitiveValues) {
  if (error === null || error === undefined) {
    return {
      exceptionName: null,
      exceptionMessage: null,
      causeName: null,
      causeCode: null,
      causeMessage: null
    };
  }

  const cause = safeProperty(error, 'cause');
  return {
    exceptionName: nullableSanitizedValue(
      safeProperty(error, 'name') ||
        (error instanceof Error ? error.constructor?.name : 'ThrownValue'),
      token,
      sensitiveValues
    ),
    exceptionMessage: nullableSanitizedValue(
      safeProperty(error, 'message') || safeString(error),
      token,
      sensitiveValues
    ),
    causeName: nullableSanitizedValue(
      safeProperty(cause, 'name'),
      token,
      sensitiveValues
    ),
    causeCode: nullableSanitizedValue(
      safeProperty(cause, 'code'),
      token,
      sensitiveValues
    ),
    causeMessage: nullableSanitizedValue(
      safeProperty(cause, 'message'),
      token,
      sensitiveValues
    )
  };
}

function normalizeTelegramDiagnostic(value, token, sensitiveValues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const redirectHost = normalizeHostname(value.redirectHost);
  return {
    failureKind: TELEGRAM_FAILURE_KINDS.has(value.failureKind)
      ? value.failureKind
      : 'network_exception',
    failurePhase: TELEGRAM_FAILURE_PHASES.has(value.failurePhase)
      ? value.failurePhase
      : 'fetch',
    durationMs: nonNegativeInteger(value.durationMs),
    timeoutMs: nonNegativeInteger(value.timeoutMs),
    upstreamHost: TELEGRAM_API_HOST,
    upstreamStatus: nonNegativeInteger(value.upstreamStatus),
    ...(redirectHost ? { redirectHost } : {}),
    responseContentType: nullableSanitizedValue(
      value.responseContentType,
      token,
      sensitiveValues
    ),
    responseBodyLength: nonNegativeInteger(value.responseBodyLength),
    timedOut: Boolean(value.timedOut),
    exceptionName: nullableSanitizedValue(
      value.exceptionName,
      token,
      sensitiveValues
    ),
    exceptionMessage: nullableSanitizedValue(
      value.exceptionMessage,
      token,
      sensitiveValues
    ),
    causeName: nullableSanitizedValue(
      value.causeName,
      token,
      sensitiveValues
    ),
    causeCode: nullableSanitizedValue(
      value.causeCode,
      token,
      sensitiveValues
    ),
    causeMessage: nullableSanitizedValue(
      value.causeMessage,
      token,
      sensitiveValues
    )
  };
}

function collectPayloadSensitiveValues(payload) {
  const values = [];
  for (const key of ['text', 'chat_id', 'user_id', 'callback_query_id']) {
    if (payload?.[key] !== null && payload?.[key] !== undefined) {
      values.push(payload[key]);
    }
  }
  collectNestedPrimitiveValues(payload?.reply_markup, values, 0);
  return values;
}

function collectNestedPrimitiveValues(value, output, depth) {
  if (output.length >= 64 || depth > 5 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNestedPrimitiveValues(entry, output, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectNestedPrimitiveValues(entry, output, depth + 1);
    }
  }
}

function redirectHostnameFromLocation(value) {
  const location = safeString(value).trim();
  if (!location) {
    return null;
  }
  try {
    return normalizeHostname(new URL(location, TELEGRAM_API_BASE).hostname);
  } catch {
    return null;
  }
}

function normalizeHostname(value) {
  const hostname = safeString(value).trim().toLowerCase();
  if (!hostname || hostname.length > 253) {
    return null;
  }
  const labels = hostname.split('.');
  if (labels.some((label) =>
    !label ||
    label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  )) {
    return null;
  }
  return hostname;
}

function nullableSanitizedValue(value, token, sensitiveValues) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return sanitizeTelegramLogValue(value, token, sensitiveValues) || null;
}

function safeProperty(value, key) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return null;
  }
  try {
    return value[key];
  } catch {
    return null;
  }
}

function safeString(value) {
  try {
    return String(value ?? '');
  } catch {
    return '[Unprintable value]';
  }
}

function sensitiveStringVariants(value) {
  const normalized = safeString(value);
  if (!normalized) {
    return [];
  }
  const variants = [normalized, safelyEncodeURIComponent(normalized)];
  try {
    const serialized = JSON.stringify(normalized);
    if (typeof serialized === 'string' && serialized.length >= 2) {
      variants.push(serialized.slice(1, -1));
    }
  } catch {
    // safeString already produced the raw fallback variant.
  }
  return variants;
}

function safelyEncodeURIComponent(value) {
  try {
    return encodeURIComponent(safeString(value));
  } catch {
    return '';
  }
}

function elapsedMilliseconds(startedAt) {
  const start = Number(startedAt);
  return Number.isFinite(start)
    ? Math.max(0, Math.round(Date.now() - start))
    : 0;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function nonNegativeIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
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
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, value: null };
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
