import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

function validEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_SECRET: 'safe_secret-1',
    DB: { get() {}, put() {} },
    SQL: { prepare() {} },
    ...overrides
  };
}

test('loadConfig requires the security and storage bindings', () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => loadConfig(validEnv({ TELEGRAM_WEBHOOK_SECRET: '' })), /TELEGRAM_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig(validEnv({ DB: null })), /KV binding/);
  assert.throws(() => loadConfig(validEnv({ SQL: null })), /D1 binding/);
});

test('loadConfig validates webhook secret and parses bounded settings', () => {
  assert.throws(
    () => loadConfig(validEnv({ TELEGRAM_WEBHOOK_SECRET: 'not allowed!' })),
    /must contain only/
  );

  const config = loadConfig(validEnv({
    ADMIN_USER_IDS: '12, 34',
    ALLOWED_FEED_HOSTS: 'Example.com, *.trusted.test',
    FEED_TIMEOUT_MS: '999999',
    MAX_ITEMS_PER_FEED: '0',
    MAX_FEEDS_PER_RUN: '999',
    MAX_DELIVERY_ATTEMPTS: '0',
    TELEGRAM_BOT_USERNAME: '@MyBot'
  }));

  assert.deepEqual([...config.adminUserIds], ['12', '34']);
  assert.deepEqual([...config.allowedFeedHosts], ['example.com', '*.trusted.test']);
  assert.equal(config.feedTimeoutMs, 30_000);
  assert.equal(config.maxItemsPerFeed, 1);
  assert.equal(config.maxFeedsPerRun, 100);
  assert.equal(config.maxDeliveryAttempts, 1);
  assert.equal(config.botUsername, 'mybot');
});

test('loadConfig uses conservative scheduler defaults', () => {
  const config = loadConfig(validEnv());

  assert.equal(config.maxFeedsPerRun, 3);
  assert.equal(config.maxTelegramSendsPerRun, 35);
  assert.equal(config.maxDeliveryAttempts, 10);
  assert.equal(config.maxItemsPerFeed, 20);
  assert.equal(config.feedTimeoutMs, 10_000);
  assert.equal(config.maxFeedBytes, 1_048_576);
  assert.equal(config.sentHistoryLimit, 2_000);
});
