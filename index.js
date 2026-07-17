import { handleCallback, handleMessage } from './src/commands.js';
import { loadConfig } from './src/config.js';
import { runScheduled } from './src/poller.js';
import { verifyWebhookRequest } from './src/security.js';
import {
  claimUpdate,
  completeUpdate,
  ensureLegacySubscriptionsMigrated,
  getUpdateState,
  releaseUpdate
} from './src/storage.js';

const DEFAULT_DEPENDENCIES = Object.freeze({
  claimUpdate,
  completeUpdate,
  createUpdateLeaseToken,
  ensureLegacySubscriptionsMigrated,
  getUpdateState,
  handleCallback,
  handleMessage,
  loadConfig,
  releaseUpdate,
  runScheduled,
  verifyWebhookRequest
});

export function createWorkerHandlers(overrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  const workerFetch = async (request, env, ctx) => {
    if (request?.method !== 'POST') {
      return textResponse('Method Not Allowed', 405, { Allow: 'POST' });
    }

    let config;
    try {
      config = dependencies.loadConfig(env);
    } catch {
      logError('Worker configuration is invalid.');
      return textResponse('Internal Server Error', 500);
    }

    if (!dependencies.verifyWebhookRequest(request, config.webhookSecret)) {
      return textResponse('Forbidden', 403);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return textResponse('Bad Request', 400);
    }

    const updateId = normalizeUpdateId(update?.update_id);
    if (updateId === null) {
      return textResponse('Bad Request', 400);
    }

    let leaseToken = null;
    let claimed = false;

    try {
      leaseToken = dependencies.createUpdateLeaseToken();
      await dependencies.ensureLegacySubscriptionsMigrated(env);

      claimed = await dependencies.claimUpdate(env, updateId, { leaseToken });
      if (!claimed) {
        const state = await dependencies.getUpdateState(env, updateId);
        if (state?.status === 'completed') {
          return textResponse('OK', 200);
        }
        return textResponse(
          'Update In Progress',
          409,
          { 'Retry-After': '5' }
        );
      }

      if (update?.message) {
        await dependencies.handleMessage(update.message, env, config);
      } else if (update?.callback_query) {
        await dependencies.handleCallback(update.callback_query, env, config);
      }

      const completed = await dependencies.completeUpdate(env, updateId, {
        leaseToken
      });
      if (!completed) {
        throw new Error('Unable to complete webhook update lease');
      }

      return textResponse('OK', 200);
    } catch {
      if (claimed) {
        try {
          await dependencies.releaseUpdate(env, updateId, { leaseToken });
        } catch {
          logError('Unable to release webhook update lease.');
        }
      }
      logError('Webhook processing failed.');
      return textResponse('Internal Server Error', 500);
    }
  };

  const workerScheduled = async (event, env, ctx) => {
    let config;
    try {
      config = dependencies.loadConfig(env);
    } catch {
      logError('Worker configuration is invalid for scheduled execution.');
      return;
    }

    try {
      await dependencies.runScheduled(env, config);
    } catch {
      logError('Scheduled execution failed.');
    }
  };

  return {
    fetch: workerFetch,
    scheduled: workerScheduled,
    workerFetch,
    workerScheduled
  };
}

function createUpdateLeaseToken() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Web Crypto randomUUID is required');
  }
  return globalThis.crypto.randomUUID();
}

function normalizeUpdateId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return value.replace(/^0+(?=\d)/, '');
  }

  return null;
}

function textResponse(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...headers
    }
  });
}

function logError(message) {
  console.error(message);
}

const handlers = createWorkerHandlers();

export const workerFetch = handlers.workerFetch;
export const workerScheduled = handlers.workerScheduled;

export default {
  fetch: workerFetch,
  scheduled: workerScheduled
};
