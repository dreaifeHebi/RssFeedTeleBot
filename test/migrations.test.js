import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  acquireOperationalLease,
  applyOperationalStateChanges,
  initializeSubscriptionRouting,
  readOperationalState,
  releaseOperationalLease
} from '../src/storage.js';

const INITIAL_MIGRATION = readFileSync(
  new URL('../migrations/0001_initial.sql', import.meta.url),
  'utf8'
);
const FORWARDING_MIGRATION = readFileSync(
  new URL('../migrations/0002_subscription_forwarding.sql', import.meta.url),
  'utf8'
);

function createSqliteD1(database) {
  const prepare = (sql, params = []) => ({
    sql,
    params,
    bind(...nextParams) {
      return prepare(sql, nextParams);
    },
    async first() {
      return database.prepare(sql).get(...params) ?? null;
    },
    async all() {
      return { results: database.prepare(sql).all(...params) };
    },
    async run() {
      const result = database.prepare(sql).run(...params);
      return {
        meta: {
          changes: Number(result.changes)
        }
      };
    }
  });
  const binding = {
    prepare(sql) {
      return prepare(sql);
    },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          const result = database
            .prepare(statement.sql)
            .run(...statement.params);
          return {
            meta: {
              changes: Number(result.changes)
            }
          };
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    withSession() {
      return binding;
    }
  };
  return binding;
}

test('subscription forwarding migrations enforce target uniqueness and cleanup', () => {
  const database = new DatabaseSync(':memory:');

  try {
    // Exercise the explicit cleanup trigger rather than relying on connection-level
    // foreign-key settings that can differ between SQLite and D1 environments.
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec(INITIAL_MIGRATION);
    database.exec(FORWARDING_MIGRATION);

    const subscriptionInsert = database.prepare(`
      INSERT INTO subscriptions (type, channel_name, rss_url, chat_id, thread_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const firstSubscriptionId = Number(
      subscriptionInsert.run(
        'rss',
        'example.com',
        'https://example.com/feed.xml',
        '-1001',
        ''
      ).lastInsertRowid
    );

    database.prepare(`
      INSERT INTO subscription_routing_settings (subscription_id, include_source)
      VALUES (?, 0)
    `).run(firstSubscriptionId);

    const targetInsert = database.prepare(`
      INSERT INTO subscription_forward_targets (
        subscription_id,
        target_chat_id,
        target_thread_id
      )
      VALUES (?, ?, ?)
    `);
    targetInsert.run(firstSubscriptionId, '-2001', '7');

    assert.throws(
      () => targetInsert.run(firstSubscriptionId, '-2001', '7'),
      /UNIQUE constraint failed/
    );

    const secondSubscriptionId = Number(
      subscriptionInsert.run(
        'rss',
        'example.net',
        'https://example.net/feed.xml',
        '-1002',
        ''
      ).lastInsertRowid
    );
    database.prepare(`
      INSERT INTO subscription_routing_settings (subscription_id, include_source)
      VALUES (?, 1)
    `).run(secondSubscriptionId);
    targetInsert.run(secondSubscriptionId, '-2001', '7');

    database.prepare('DELETE FROM subscriptions WHERE id = ?')
      .run(firstSubscriptionId);

    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM subscription_routing_settings
        WHERE subscription_id = ?
      `).get(firstSubscriptionId).count,
      0
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM subscription_forward_targets
        WHERE subscription_id = ?
      `).get(firstSubscriptionId).count,
      0
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM subscription_forward_targets
        WHERE subscription_id = ?
      `).get(secondSubscriptionId).count,
      1,
      'cleanup remains scoped to the deleted subscription'
    );
  } finally {
    database.close();
  }
});

test('routing initialization keeps the target cap across repeated snapshots', async () => {
  const database = new DatabaseSync(':memory:');

  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(INITIAL_MIGRATION);
    database.exec(FORWARDING_MIGRATION);
    const subscriptionId = Number(
      database.prepare(
        'INSERT INTO subscriptions ' +
        '(type, channel_name, rss_url, chat_id, thread_id) ' +
        'VALUES (?, ?, ?, ?, ?)'
      ).run(
        'rss',
        'cap.example',
        'https://cap.example/feed.xml',
        '-100',
        '9'
      ).lastInsertRowid
    );
    const env = { SQL: createSqliteD1(database) };
    const scope = {
      subscriptionId,
      chatId: '-100',
      threadId: '9'
    };
    const first = await initializeSubscriptionRouting(
      env,
      scope,
      {
        includeSource: true,
        targets: Array.from({ length: 9 }, (_, index) => ({
          chatId: String(-200 - index),
          threadId: null
        }))
      }
    );
    const second = await initializeSubscriptionRouting(
      env,
      scope,
      {
        includeSource: true,
        targets: [
          { chatId: '-500', threadId: null },
          { chatId: '-501', threadId: null }
        ]
      }
    );

    assert.deepEqual(first, { created: true, targetsAdded: 9 });
    assert.deepEqual(second, { created: false, targetsAdded: 1 });
    assert.equal(
      database.prepare(
        'SELECT COUNT(*) AS count FROM subscription_forward_targets ' +
        'WHERE subscription_id = ?'
      ).get(subscriptionId).count,
      10
    );
  } finally {
    database.close();
  }
});

test('interaction CAS and panel leases serialize on real SQLite', async () => {
  const database = new DatabaseSync(':memory:');

  try {
    database.exec(INITIAL_MIGRATION);
    const SQL = createSqliteD1(database);
    const env = { SQL };
    const open = JSON.stringify({ phase: 'open', revision: 'one' });
    const claimedA = JSON.stringify({
      phase: 'processing',
      revision: 'two',
      claimToken: 'a'
    });
    const claimedB = JSON.stringify({
      phase: 'processing',
      revision: 'three',
      claimToken: 'b'
    });

    assert.equal(
      await applyOperationalStateChanges(env, [{
        name: 'fwd_session:sqlite',
        value: open,
        expirationTtl: 3600
      }]),
      1
    );
    assert.equal(
      await applyOperationalStateChanges(env, [{
        name: 'fwd_session:sqlite',
        value: claimedA,
        expectedValue: open,
        expirationTtl: 3600
      }]),
      1
    );
    assert.equal(
      await applyOperationalStateChanges(env, [{
        name: 'fwd_session:sqlite',
        value: claimedB,
        expectedValue: open,
        expirationTtl: 3600
      }]),
      0
    );
    assert.equal(
      await readOperationalState(env, 'fwd_session:sqlite'),
      claimedA
    );

    assert.equal(
      await acquireOperationalLease(
        env,
        'ui-panel:sqlite',
        { leaseToken: 'owner-a', leaseSeconds: 60 }
      ),
      true
    );
    assert.equal(
      await acquireOperationalLease(
        env,
        'ui-panel:sqlite',
        { leaseToken: 'owner-b', leaseSeconds: 60 }
      ),
      false
    );
    assert.equal(
      await releaseOperationalLease(
        env,
        'ui-panel:sqlite',
        { leaseToken: 'owner-b' }
      ),
      false
    );
    assert.equal(
      await releaseOperationalLease(
        env,
        'ui-panel:sqlite',
        { leaseToken: 'owner-a' }
      ),
      true
    );
  } finally {
    database.close();
  }
});
