import assert from 'node:assert/strict';
import test from 'node:test';

import worker, {
  createWorkerHandlers,
  workerFetch,
  workerScheduled
} from '../index.js';

const WEBHOOK_SECRET = 'webhook_secret';

function validConfig(overrides = {}) {
  return {
    telegramBotToken: 'telegram-token',
    webhookSecret: WEBHOOK_SECRET,
    ...overrides
  };
}

function dependencies(overrides = {}) {
  return {
    loadConfig: () => validConfig(),
    verifyWebhookRequest: () => true,
    ensureLegacySubscriptionsMigrated: async () => {},
    createUpdateLeaseToken: () => 'test-lease-token',
    claimUpdate: async () => true,
    getUpdateState: async () => ({ status: 'completed', leaseExpiresAt: 0 }),
    completeUpdate: async () => true,
    releaseUpdate: async () => true,
    handleMessage: async () => {},
    handleCallback: async () => {},
    runScheduled: async () => {},
    ...overrides
  };
}

function requestWithJson(value, overrides = {}) {
  return {
    method: 'POST',
    headers: new Headers(),
    async json() {
      return value;
    },
    ...overrides
  };
}

async function withCapturedErrors(callback) {
  const original = console.error;
  const messages = [];
  console.error = (...args) => {
    messages.push(args.map(String).join(' '));
  };

  try {
    const result = await callback();
    return { messages, result };
  } finally {
    console.error = original;
  }
}

test('default export exposes the named Worker handlers', () => {
  assert.equal(worker.fetch, workerFetch);
  assert.equal(worker.scheduled, workerScheduled);
});

test('fetch accepts POST only and does not load configuration for other methods', async () => {
  let configLoads = 0;
  const handlers = createWorkerHandlers(dependencies({
    loadConfig() {
      configLoads += 1;
      return validConfig();
    }
  }));

  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const response = await handlers.workerFetch({ method }, {});
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
  }

  assert.equal(configLoads, 0);
});

test('configuration failures return a generic 500 without leaking secrets', async () => {
  const leakedValue = 'telegram-token-must-not-leak';
  const handlers = createWorkerHandlers(dependencies({
    loadConfig() {
      throw new Error(leakedValue);
    }
  }));

  const { messages, result: response } = await withCapturedErrors(() =>
    handlers.workerFetch(requestWithJson({ update_id: 1 }), {})
  );

  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Internal Server Error');
  assert.doesNotMatch(messages.join('\n'), new RegExp(leakedValue));
});

test('webhook secret is verified before JSON parsing or state access', async () => {
  const calls = [];
  let parsed = false;
  const handlers = createWorkerHandlers(dependencies({
    loadConfig() {
      calls.push('config');
      return validConfig();
    },
    verifyWebhookRequest() {
      calls.push('verify');
      return false;
    },
    ensureLegacySubscriptionsMigrated: async () => {
      calls.push('migrate');
    },
    claimUpdate: async () => {
      calls.push('claim');
      return true;
    }
  }));
  const request = requestWithJson(
    { update_id: 1 },
    {
      async json() {
        parsed = true;
        throw new Error('body must not be parsed');
      }
    }
  );

  const response = await handlers.workerFetch(request, {});

  assert.equal(response.status, 403);
  assert.equal(parsed, false);
  assert.deepEqual(calls, ['config', 'verify']);
});

test('malformed JSON returns 400 without reading or writing state', async () => {
  let stateCalls = 0;
  const handlers = createWorkerHandlers(dependencies({
    ensureLegacySubscriptionsMigrated: async () => {
      stateCalls += 1;
    },
    claimUpdate: async () => {
      stateCalls += 1;
      return true;
    }
  }));

  const response = await handlers.workerFetch(
    requestWithJson(null, {
      async json() {
        throw new SyntaxError('invalid JSON');
      }
    }),
    {}
  );

  assert.equal(response.status, 400);
  assert.equal(stateCalls, 0);
});

test('invalid update_id values are rejected before state access', async () => {
  const invalidValues = [
    undefined,
    null,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '',
    '-1',
    '+1',
    '1.0',
    '1e3',
    ' 1 ',
    true,
    {}
  ];
  let stateCalls = 0;
  const handlers = createWorkerHandlers(dependencies({
    ensureLegacySubscriptionsMigrated: async () => {
      stateCalls += 1;
    },
    claimUpdate: async () => {
      stateCalls += 1;
      return true;
    }
  }));

  for (const updateId of invalidValues) {
    const response = await handlers.workerFetch(
      requestWithJson({ update_id: updateId }),
      {}
    );
    assert.equal(response.status, 400, String(updateId));
  }

  assert.equal(stateCalls, 0);
});

test('safe integer and digit-string update IDs are normalized and claimed after migration', async () => {
  const cases = [
    [0, '0'],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ['00042', '42'],
    ['900719925474099312345', '900719925474099312345']
  ];

  for (const [input, expected] of cases) {
    const calls = [];
    const env = { name: 'env' };
    const handlers = createWorkerHandlers(dependencies({
      ensureLegacySubscriptionsMigrated: async (receivedEnv) => {
        assert.equal(receivedEnv, env);
        calls.push('migrate');
      },
      claimUpdate: async (receivedEnv, updateId) => {
        assert.equal(receivedEnv, env);
        calls.push(['claim', updateId]);
        return true;
      }
    }));

    const response = await handlers.workerFetch(
      requestWithJson({ update_id: input }),
      env
    );

    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['migrate', ['claim', expected]]);
  }
});

test('successful updates complete the same lease that was claimed', async () => {
  const calls = [];
  const env = { name: 'env' };
  const handlers = createWorkerHandlers(dependencies({
    createUpdateLeaseToken: () => 'lease-123',
    ensureLegacySubscriptionsMigrated: async () => {
      calls.push('migrate');
    },
    claimUpdate: async (receivedEnv, updateId, options) => {
      calls.push(['claim', receivedEnv, updateId, options]);
      return true;
    },
    handleMessage: async () => {
      calls.push('message');
    },
    completeUpdate: async (receivedEnv, updateId, options) => {
      calls.push(['complete', receivedEnv, updateId, options]);
      return true;
    }
  }));

  const response = await handlers.workerFetch(
    requestWithJson({ update_id: 6, message: { text: '/start' } }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    'migrate',
    ['claim', env, '6', { leaseToken: 'lease-123' }],
    'message',
    ['complete', env, '6', { leaseToken: 'lease-123' }]
  ]);
});

test('completed duplicate updates are acknowledged without routing', async () => {
  const calls = [];
  const handlers = createWorkerHandlers(dependencies({
    ensureLegacySubscriptionsMigrated: async () => {
      calls.push('migrate');
    },
    claimUpdate: async () => {
      calls.push('claim');
      return false;
    },
    getUpdateState: async () => {
      calls.push('state');
      return { status: 'completed', leaseExpiresAt: 0 };
    },
    handleMessage: async () => {
      calls.push('message');
    },
    handleCallback: async () => {
      calls.push('callback');
    }
  }));

  const response = await handlers.workerFetch(
    requestWithJson({ update_id: 7, message: { text: '/start' } }),
    {}
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['migrate', 'claim', 'state']);
});

test('active or concurrently released updates return retryable non-2xx responses', async () => {
  for (const state of [
    { status: 'processing', leaseExpiresAt: 1234 },
    null
  ]) {
    const calls = [];
    const handlers = createWorkerHandlers(dependencies({
      claimUpdate: async () => {
        calls.push('claim');
        return false;
      },
      getUpdateState: async (_env, updateId) => {
        calls.push(['state', updateId]);
        return state;
      },
      handleMessage: async () => {
        calls.push('message');
      }
    }));

    const response = await handlers.workerFetch(
      requestWithJson({
        update_id: state ? 70 : 71,
        message: { text: '/start' }
      }),
      {}
    );

    assert.equal(response.status, 409);
    assert.equal(response.headers.get('Retry-After'), '5');
    assert.equal(await response.text(), 'Update In Progress');
    assert.deepEqual(calls, [
      'claim',
      ['state', state ? '70' : '71']
    ]);
  }
});

test('message and callback updates route to their matching command handlers', async () => {
  const env = { name: 'env' };
  const config = validConfig();
  const message = { text: '/start' };
  const callbackQuery = { id: 'callback' };
  const routed = [];
  const handlers = createWorkerHandlers(dependencies({
    loadConfig: () => config,
    handleMessage: async (...args) => {
      routed.push(['message', args]);
    },
    handleCallback: async (...args) => {
      routed.push(['callback', args]);
    }
  }));

  assert.equal(
    (
      await handlers.workerFetch(
        requestWithJson({ update_id: 8, message }),
        env,
        { waitUntil() {} }
      )
    ).status,
    200
  );
  assert.equal(
    (
      await handlers.workerFetch(
        requestWithJson({ update_id: '9', callback_query: callbackQuery }),
        env,
        { waitUntil() {} }
      )
    ).status,
    200
  );

  assert.deepEqual(routed, [
    ['message', [message, env, config]],
    ['callback', [callbackQuery, env, config]]
  ]);
});

test('unknown but valid Telegram updates are claimed and acknowledged', async () => {
  const calls = [];
  const handlers = createWorkerHandlers(dependencies({
    ensureLegacySubscriptionsMigrated: async () => {
      calls.push('migrate');
    },
    claimUpdate: async (_env, updateId) => {
      calls.push(['claim', updateId]);
      return true;
    },
    handleMessage: async () => {
      calls.push('message');
    },
    handleCallback: async () => {
      calls.push('callback');
    }
  }));

  const response = await handlers.workerFetch(
    requestWithJson({ update_id: 10, edited_message: {} }),
    {}
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['migrate', ['claim', '10']]);
});

test('processing failures release the lease and return a sanitized 500', async () => {
  const leakedValue = 'telegram-token-must-not-leak';
  const env = { name: 'env' };
  const released = [];
  const handlers = createWorkerHandlers(dependencies({
    loadConfig: () => validConfig({ telegramBotToken: leakedValue }),
    createUpdateLeaseToken: () => 'lease-to-release',
    handleMessage: async () => {
      throw new Error(leakedValue);
    },
    releaseUpdate: async (...args) => {
      released.push(args);
      return true;
    }
  }));

  const { messages, result: response } = await withCapturedErrors(() =>
    handlers.workerFetch(
      requestWithJson({ update_id: 11, message: { text: '/start' } }),
      env
    )
  );

  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Internal Server Error');
  assert.deepEqual(released, [
    [env, '11', { leaseToken: 'lease-to-release' }]
  ]);
  assert.doesNotMatch(messages.join('\n'), new RegExp(leakedValue));
});

test('scheduled loads configuration and delegates to runScheduled', async () => {
  const env = { name: 'scheduled-env' };
  const config = validConfig();
  const calls = [];
  const handlers = createWorkerHandlers(dependencies({
    loadConfig(receivedEnv) {
      assert.equal(receivedEnv, env);
      calls.push('config');
      return config;
    },
    async runScheduled(...args) {
      calls.push(['scheduled', args]);
    }
  }));

  await handlers.workerScheduled({ cron: '* * * * *' }, env, {
    waitUntil() {}
  });

  assert.deepEqual(calls, ['config', ['scheduled', [env, config]]]);
});

test('scheduled configuration and execution errors are contained and sanitized', async () => {
  const leakedValue = 'scheduled-token-must-not-leak';
  let scheduledCalls = 0;
  const configFailure = createWorkerHandlers(dependencies({
    loadConfig() {
      throw new Error(leakedValue);
    },
    runScheduled: async () => {
      scheduledCalls += 1;
    }
  }));

  const first = await withCapturedErrors(() =>
    configFailure.workerScheduled({}, {}, {})
  );
  assert.equal(first.result, undefined);
  assert.equal(scheduledCalls, 0);
  assert.doesNotMatch(first.messages.join('\n'), new RegExp(leakedValue));

  const executionFailure = createWorkerHandlers(dependencies({
    runScheduled: async () => {
      scheduledCalls += 1;
      throw new Error(leakedValue);
    }
  }));
  const second = await withCapturedErrors(() =>
    executionFailure.workerScheduled({}, {}, {})
  );

  assert.equal(second.result, undefined);
  assert.equal(scheduledCalls, 1);
  assert.doesNotMatch(second.messages.join('\n'), new RegExp(leakedValue));
});
