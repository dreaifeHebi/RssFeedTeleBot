const LEGACY_SUBSCRIPTIONS_KEY = 'subscriptions';
const LEGACY_MIGRATION_KEY = 'legacy_subscriptions_v1';
const DEFAULT_PENDING_LIMIT = 35;
const MAX_PENDING_LIMIT = 100;
const DEFAULT_UPDATE_LEASE_SECONDS = 5 * 60;
const MIN_UPDATE_LEASE_SECONDS = 30;
const MAX_UPDATE_LEASE_SECONDS = 60 * 60;
const DEFAULT_OPERATIONAL_LEASE_SECONDS = 20 * 60;
const MIN_OPERATIONAL_LEASE_SECONDS = 60;
const MAX_OPERATIONAL_LEASE_SECONDS = 60 * 60;
const MAX_OPERATIONAL_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_OPERATIONAL_STATE_CHANGES = 12;
const MAX_OPERATIONAL_STATE_VALUE_BYTES = 1_500_000;
const DEFAULT_PROCESSED_UPDATE_RETENTION_DAYS = 7;
const DEFAULT_SENT_DELIVERY_RETENTION_DAYS = 7;
const DEFAULT_DEAD_DELIVERY_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3_650;
const MAX_SUBSCRIPTION_FORWARD_TARGETS = 10;
const SECONDS_PER_DAY = 24 * 60 * 60;

const INSERT_SUBSCRIPTION_SQL = `
  INSERT INTO subscriptions (type, channel_name, rss_url, chat_id, thread_id)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(rss_url, chat_id, thread_id) DO NOTHING
`;

const INSERT_DELIVERY_SQL = `
  INSERT INTO deliveries (
    feed_key,
    item_key,
    message,
    target_chat_id,
    target_thread_id
  )
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(feed_key, item_key, target_chat_id, target_thread_id) DO NOTHING
`;

/**
 * Copy the legacy KV subscription array into D1 exactly once.
 *
 * The KV key is intentionally retained. The D1 batch makes the subscription
 * inserts and completion marker atomic; if reading, parsing, validation, or the
 * batch fails, a later request can safely retry the migration.
 *
 * @returns {Promise<number>} number of rows inserted by this invocation
 */
export async function ensureLegacySubscriptionsMigrated(env) {
  const database = getDatabase(env);
  const kv = getLegacyKv(env);

  const marker = await database
    .prepare('SELECT value FROM app_meta WHERE key = ? LIMIT 1')
    .bind(LEGACY_MIGRATION_KEY)
    .first();

  if (marker) {
    return 0;
  }

  const raw = await kv.get(LEGACY_SUBSCRIPTIONS_KEY);
  const legacySubscriptions = parseLegacySubscriptions(raw);
  const normalized = legacySubscriptions.map((subscription, index) => {
    try {
      return normalizeSubscription(subscription);
    } catch (error) {
      throw new TypeError(
        `Invalid legacy subscription at index ${index}: ${errorMessage(error)}`
      );
    }
  });

  const subscriptionStatements = normalized.map((subscription) =>
    bindSubscriptionInsert(database, subscription)
  );
  const markerValue = JSON.stringify({
    source: `kv:${LEGACY_SUBSCRIPTIONS_KEY}`,
    rows: normalized.length
  });
  const markerStatement = database
    .prepare(`
      INSERT INTO app_meta (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO NOTHING
    `)
    .bind(LEGACY_MIGRATION_KEY, markerValue);

  const results = await database.batch([
    ...subscriptionStatements,
    markerStatement
  ]);

  return results
    .slice(0, subscriptionStatements.length)
    .reduce((total, result) => total + getChanges(result), 0);
}

export async function listSubscriptions(env, filter = null) {
  const database = getDatabase(env);
  let whereClause = '';
  let params = [];
  if (filter !== null && filter !== undefined) {
    const normalized = normalizeSubscriptionFilter(filter);
    whereClause = `WHERE ${normalized.clauses.join(' AND ')}`;
    params = normalized.params;
  }

  const statement = database.prepare(`
      SELECT id, type, channel_name, rss_url, chat_id, thread_id, created_at
      FROM subscriptions
      ${whereClause}
      ORDER BY id ASC
    `);
  const result = params.length > 0
    ? await statement.bind(...params).all()
    : await statement.all();

  return getRows(result).map(mapSubscriptionRow);
}

export async function addSubscription(env, subscription) {
  const database = getDatabase(env);
  const normalized = normalizeSubscription(subscription);
  const result = await bindSubscriptionInsert(database, normalized).run();
  return getChanges(result) > 0;
}

export async function removeSubscriptions(env, filter) {
  const database = getDatabase(env);
  const { clauses, params } = normalizeSubscriptionFilter(filter);
  const result = await database
    .prepare(`DELETE FROM subscriptions WHERE ${clauses.join(' AND ')}`)
    .bind(...params)
    .run();

  return getChanges(result);
}

export async function copySubscriptions(
  env,
  subscriptions,
  targetChatId,
  targetThreadId
) {
  if (!Array.isArray(subscriptions)) {
    throw new TypeError('subscriptions must be an array');
  }

  const database = getDatabase(env);
  const chatId = normalizeChatId(targetChatId);
  const threadId = normalizeThreadId(targetThreadId);
  const unique = new Map();

  for (const subscription of subscriptions) {
    const normalized = normalizeSubscription({
      ...subscription,
      chatId,
      threadId
    });
    const key = `${normalized.rssUrl}\u0000${chatId}\u0000${threadId}`;
    if (!unique.has(key)) {
      unique.set(key, normalized);
    }
  }

  if (unique.size === 0) {
    return 0;
  }

  const payload = JSON.stringify(Array.from(unique.values()));
  const result = await database
    .prepare(`
      INSERT INTO subscriptions (
        type,
        channel_name,
        rss_url,
        chat_id,
        thread_id
      )
      SELECT
        json_extract(value, '$.type'),
        json_extract(value, '$.channelName'),
        json_extract(value, '$.rssUrl'),
        json_extract(value, '$.chatId'),
        json_extract(value, '$.threadId')
      FROM json_each(?)
      WHERE 1
      ON CONFLICT(rss_url, chat_id, thread_id) DO NOTHING
    `)
    .bind(payload)
    .run();

  return getChanges(result);
}

/**
 * Return a single consistent snapshot of subscriptions and routing settings.
 *
 * Subscriptions without a settings row have routing=null and continue to
 * inherit the legacy chat/topic KV rule.
 */
export async function listSubscriptionsWithRouting(env) {
  const database = getDatabase(env);
  const result = await database.prepare(`
      SELECT
        subscriptions.id,
        subscriptions.type,
        subscriptions.channel_name,
        subscriptions.rss_url,
        subscriptions.chat_id,
        subscriptions.thread_id,
        subscriptions.created_at,
        settings.subscription_id AS routing_subscription_id,
        settings.include_source,
        settings.created_at AS routing_created_at,
        settings.updated_at AS routing_updated_at,
        targets.id AS target_id,
        targets.target_chat_id,
        targets.target_thread_id,
        targets.created_at AS target_created_at
      FROM subscriptions
      LEFT JOIN subscription_routing_settings AS settings
        ON settings.subscription_id = subscriptions.id
      LEFT JOIN subscription_forward_targets AS targets
        ON targets.subscription_id = subscriptions.id
      ORDER BY subscriptions.id ASC, targets.id ASC
    `).all();

  return mapSubscriptionsWithRoutingRows(getRows(result));
}

/**
 * Read one subscription and its routing state while enforcing source scope.
 *
 * @returns {Promise<null | {
 *   subscriptionId: number,
 *   independent: boolean,
 *   includeSource: boolean,
 *   targets: Array<{id: number, chatId: string, threadId: string | null}>
 * }>}
 */
export async function getSubscriptionRouting(env, scope) {
  const database = getDatabase(env);
  const normalized = normalizeRoutingScope(scope);
  const result = await database
    .prepare(`
      SELECT
        subscriptions.id AS subscription_id,
        settings.subscription_id AS routing_subscription_id,
        COALESCE(settings.include_source, 1) AS include_source,
        targets.id AS target_id,
        targets.target_chat_id,
        targets.target_thread_id
      FROM subscriptions
      LEFT JOIN subscription_routing_settings AS settings
        ON settings.subscription_id = subscriptions.id
      LEFT JOIN subscription_forward_targets AS targets
        ON targets.subscription_id = settings.subscription_id
      WHERE subscriptions.id = ?
        AND subscriptions.chat_id = ?
        AND subscriptions.thread_id = ?
      ORDER BY targets.id ASC
    `)
    .bind(
      normalized.subscriptionId,
      normalized.chatId,
      normalized.threadId
    )
    .all();
  const routings = mapSubscriptionRoutingRows(getRows(result));
  return routings[0] ?? null;
}

/**
 * Add one target and implicitly opt the subscription into independent routing.
 *
 * The two D1 batch statements are atomic. Both statements scope the
 * subscription by id/chat/thread so a forged callback cannot mutate another
 * chat's routing state.
 *
 * @returns {Promise<boolean>} true when a new target was inserted
 */
export async function addSubscriptionForwardTarget(env, scope, target) {
  const database = getDatabase(env);
  const normalized = normalizeRoutingScope(scope);
  const normalizedTarget = normalizeTarget(target);
  const results = await database.batch([
    database
      .prepare(`
        INSERT INTO subscription_routing_settings (
          subscription_id,
          include_source,
          created_at,
          updated_at
        )
        SELECT id, 1, unixepoch(), unixepoch()
        FROM subscriptions
        WHERE id = ? AND chat_id = ? AND thread_id = ?
        ON CONFLICT(subscription_id) DO NOTHING
      `)
      .bind(
        normalized.subscriptionId,
        normalized.chatId,
        normalized.threadId
      ),
    database
      .prepare(`
        INSERT INTO subscription_forward_targets (
          subscription_id,
          target_chat_id,
          target_thread_id
        )
        SELECT id, ?, ?
        FROM subscriptions
        WHERE id = ?
          AND chat_id = ?
          AND thread_id = ?
          AND (
            SELECT COUNT(*)
            FROM subscription_forward_targets
            WHERE subscription_id = subscriptions.id
          ) < ?
        ON CONFLICT(subscription_id, target_chat_id, target_thread_id)
        DO NOTHING
      `)
      .bind(
        normalizedTarget.chatId,
        normalizedTarget.threadId,
        normalized.subscriptionId,
        normalized.chatId,
        normalized.threadId,
        MAX_SUBSCRIPTION_FORWARD_TARGETS
      )
  ]);

  return getChanges(results[1]) > 0;
}

/**
 * Materialize an inherited routing snapshot as one independent D1 rule.
 *
 * Used only for the first menu-driven customization so the subscription keeps
 * its effective legacy chat/topic behavior while gaining independent targets.
 */
export async function initializeSubscriptionRouting(env, scope, routing) {
  const database = getDatabase(env);
  const normalized = normalizeRoutingScope(scope);
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    throw new TypeError('routing must be an object');
  }
  const includeSource = normalizeBoolean(
    routing.includeSource,
    'routing.includeSource'
  );
  if (!Array.isArray(routing.targets)) {
    throw new TypeError('routing.targets must be an array');
  }
  const uniqueTargets = new Map();
  for (const target of routing.targets) {
    const normalizedTarget = normalizeTarget(target);
    const key = normalizedTarget.chatId + '\u0000' + normalizedTarget.threadId;
    if (!uniqueTargets.has(key)) {
      uniqueTargets.set(key, normalizedTarget);
    }
  }
  if (uniqueTargets.size > MAX_SUBSCRIPTION_FORWARD_TARGETS) {
    throw new TypeError(
      `routing.targets must contain at most ${MAX_SUBSCRIPTION_FORWARD_TARGETS} unique targets`
    );
  }
  if (!includeSource && uniqueTargets.size === 0) {
    throw new TypeError(
      'routing must keep the source or contain at least one target'
    );
  }

  const statements = [
    database
      .prepare(`
        INSERT INTO subscription_routing_settings (
          subscription_id,
          include_source,
          created_at,
          updated_at
        )
        SELECT id, ?, unixepoch(), unixepoch()
        FROM subscriptions
        WHERE id = ? AND chat_id = ? AND thread_id = ?
        ON CONFLICT(subscription_id) DO NOTHING
      `)
      .bind(
        includeSource ? 1 : 0,
        normalized.subscriptionId,
        normalized.chatId,
        normalized.threadId
      ),
    ...Array.from(uniqueTargets.values(), (target) =>
      database
        .prepare(`
          INSERT INTO subscription_forward_targets (
            subscription_id,
            target_chat_id,
            target_thread_id
          )
          SELECT subscriptions.id, ?, ?
          FROM subscriptions
          INNER JOIN subscription_routing_settings AS settings
            ON settings.subscription_id = subscriptions.id
          WHERE subscriptions.id = ?
            AND subscriptions.chat_id = ?
            AND subscriptions.thread_id = ?
            AND (
              SELECT COUNT(*)
              FROM subscription_forward_targets
              WHERE subscription_id = subscriptions.id
            ) < ?
          ON CONFLICT(subscription_id, target_chat_id, target_thread_id)
          DO NOTHING
        `)
        .bind(
          target.chatId,
          target.threadId,
          normalized.subscriptionId,
          normalized.chatId,
          normalized.threadId,
          MAX_SUBSCRIPTION_FORWARD_TARGETS
        )
    )
  ];
  const results = await database.batch(statements);
  return {
    created: getChanges(results[0]) > 0,
    targetsAdded: results
      .slice(1)
      .reduce((total, result) => total + getChanges(result), 0)
  };
}

export async function removeSubscriptionForwardTarget(env, scope) {
  const database = getDatabase(env);
  const normalized = normalizeRoutingTargetScope(scope);
  const result = await database
    .prepare(`
      DELETE FROM subscription_forward_targets
      WHERE id = ?
        AND subscription_id IN (
          SELECT id
          FROM subscriptions
          WHERE id = ? AND chat_id = ? AND thread_id = ?
        )
        AND (
          EXISTS (
            SELECT 1
            FROM subscription_routing_settings
            WHERE subscription_id = ?
              AND include_source = 1
          )
          OR EXISTS (
            SELECT 1
            FROM subscription_forward_targets AS sibling
            WHERE sibling.subscription_id = ?
              AND sibling.id <> ?
          )
        )
    `)
    .bind(
      normalized.targetId,
      normalized.subscriptionId,
      normalized.chatId,
      normalized.threadId,
      normalized.subscriptionId,
      normalized.subscriptionId,
      normalized.targetId
    )
    .run();

  return getChanges(result) > 0;
}

export async function setSubscriptionIncludeSource(env, scope, includeSource) {
  const database = getDatabase(env);
  const normalized = normalizeRoutingScope(scope);
  const normalizedIncludeSource = normalizeBoolean(
    includeSource,
    'includeSource'
  );
  const encodedIncludeSource = normalizedIncludeSource ? 1 : 0;
  const result = await database
    .prepare(`
      INSERT INTO subscription_routing_settings (
        subscription_id,
        include_source,
        created_at,
        updated_at
      )
      SELECT id, ?, unixepoch(), unixepoch()
      FROM subscriptions
      WHERE id = ?
        AND chat_id = ?
        AND thread_id = ?
        AND (
          ? = 1 OR EXISTS (
            SELECT 1
            FROM subscription_forward_targets
            WHERE subscription_id = subscriptions.id
          )
        )
      ON CONFLICT(subscription_id) DO UPDATE SET
        include_source = excluded.include_source,
        updated_at = unixepoch()
      WHERE include_source <> excluded.include_source
    `)
    .bind(
      encodedIncludeSource,
      normalized.subscriptionId,
      normalized.chatId,
      normalized.threadId,
      encodedIncludeSource
    )
    .run();

  return getChanges(result) > 0;
}

export async function resetSubscriptionRouting(env, scope) {
  const database = getDatabase(env);
  const normalized = normalizeRoutingScope(scope);
  const ownershipSql = `
    SELECT id
    FROM subscriptions
    WHERE id = ? AND chat_id = ? AND thread_id = ?
  `;
  const params = [
    normalized.subscriptionId,
    normalized.chatId,
    normalized.threadId
  ];
  const results = await database.batch([
    database
      .prepare(`
        DELETE FROM subscription_forward_targets
        WHERE subscription_id IN (${ownershipSql})
      `)
      .bind(...params),
    database
      .prepare(`
        DELETE FROM subscription_routing_settings
        WHERE subscription_id IN (${ownershipSql})
      `)
      .bind(...params)
  ]);

  return results.reduce((total, result) => total + getChanges(result), 0);
}

export async function claimUpdate(env, updateId, options = {}) {
  const database = getDatabase(env);
  const normalizedUpdateId = normalizeRequiredText(updateId, 'updateId');
  const { leaseSeconds, leaseToken } = normalizeUpdateClaimOptions(options);
  const result = await database
    .prepare(`
      INSERT INTO processed_updates (
        update_id,
        status,
        lease_token,
        claimed_at,
        lease_expires_at,
        updated_at,
        completed_at
      )
      VALUES (?, 'processing', ?, unixepoch(), unixepoch() + ?, unixepoch(), NULL)
      ON CONFLICT(update_id) DO UPDATE SET
        status = 'processing',
        lease_token = excluded.lease_token,
        claimed_at = excluded.claimed_at,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at,
        completed_at = NULL
      WHERE processed_updates.status = 'processing'
        AND processed_updates.lease_expires_at <= unixepoch()
    `)
    .bind(normalizedUpdateId, leaseToken, leaseSeconds)
    .run();

  return getChanges(result) > 0;
}

export async function getUpdateState(env, updateId) {
  const database = getDatabase(env);
  const normalizedUpdateId = normalizeRequiredText(updateId, 'updateId');
  const row = await database
    .prepare(`
      SELECT status, lease_expires_at
      FROM processed_updates
      WHERE update_id = ?
      LIMIT 1
    `)
    .bind(normalizedUpdateId)
    .first();

  if (!row) {
    return null;
  }

  const leaseExpiresAt = Number(row.lease_expires_at);
  return {
    status: String(row.status),
    leaseExpiresAt: Number.isFinite(leaseExpiresAt) ? leaseExpiresAt : null
  };
}

export async function completeUpdate(env, updateId, options = {}) {
  const database = getDatabase(env);
  const normalizedUpdateId = normalizeRequiredText(updateId, 'updateId');
  const leaseToken = normalizeOptionalLeaseToken(options);
  const tokenClause = leaseToken ? ' AND lease_token = ?' : '';
  const params = leaseToken
    ? [normalizedUpdateId, leaseToken]
    : [normalizedUpdateId];
  const result = await database
    .prepare(`
      UPDATE processed_updates
      SET
        status = 'completed',
        lease_token = '',
        lease_expires_at = 0,
        updated_at = unixepoch(),
        completed_at = unixepoch()
      WHERE update_id = ?
        AND status = 'processing'${tokenClause}
    `)
    .bind(...params)
    .run();

  return getChanges(result) > 0;
}

export async function releaseUpdate(env, updateId, options = {}) {
  const database = getDatabase(env);
  const normalizedUpdateId = normalizeRequiredText(updateId, 'updateId');
  const leaseToken = normalizeOptionalLeaseToken(options);
  const tokenClause = leaseToken ? ' AND lease_token = ?' : '';
  const params = leaseToken
    ? [normalizedUpdateId, leaseToken]
    : [normalizedUpdateId];
  const result = await database
    .prepare(`
      DELETE FROM processed_updates
      WHERE update_id = ?
        AND status = 'processing'${tokenClause}
    `)
    .bind(...params)
    .run();

  return getChanges(result) > 0;
}

export async function acquireOperationalLease(env, name, options = {}) {
  const database = getDatabase(env);
  const normalizedName = normalizeRequiredText(name, 'lease name');
  if (normalizedName.length > 100) {
    throw new TypeError('lease name must be at most 100 characters');
  }
  const { leaseSeconds, leaseToken } = normalizeOperationalLeaseOptions(options);
  const result = await database
    .prepare(`
      INSERT INTO operational_leases (
        name,
        lease_token,
        lease_expires_at,
        updated_at
      )
      VALUES (?, ?, unixepoch() + ?, unixepoch())
      ON CONFLICT(name) DO UPDATE SET
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE operational_leases.lease_expires_at <= unixepoch()
    `)
    .bind(normalizedName, leaseToken, leaseSeconds)
    .run();

  return getChanges(result) > 0;
}

export async function renewOperationalLease(env, name, options = {}) {
  const database = getDatabase(env);
  const normalizedName = normalizeRequiredText(name, 'lease name');
  if (normalizedName.length > 100) {
    throw new TypeError('lease name must be at most 100 characters');
  }
  const { leaseSeconds, leaseToken } = normalizeOperationalLeaseOptions(options);
  const result = await database
    .prepare(`
      UPDATE operational_leases
      SET
        lease_expires_at = unixepoch() + ?,
        updated_at = unixepoch()
      WHERE name = ?
        AND lease_token = ?
        AND lease_expires_at > unixepoch()
    `)
    .bind(leaseSeconds, normalizedName, leaseToken)
    .run();

  return getChanges(result) > 0;
}

export async function releaseOperationalLease(env, name, options = {}) {
  const database = getDatabase(env);
  const normalizedName = normalizeRequiredText(name, 'lease name');
  if (normalizedName.length > 100) {
    throw new TypeError('lease name must be at most 100 characters');
  }
  const { leaseToken } = normalizeOperationalLeaseOptions({
    ...options,
    leaseSeconds: options?.leaseSeconds ?? DEFAULT_OPERATIONAL_LEASE_SECONDS
  });
  const result = await database
    .prepare(`
      DELETE FROM operational_leases
      WHERE name = ?
        AND lease_token = ?
    `)
    .bind(normalizedName, leaseToken)
    .run();

  return getChanges(result) > 0;
}

/**
 * Read short-lived interaction state from D1's primary so callbacks never rely
 * on eventually-consistent KV propagation for authorization or fencing.
 */
export async function readOperationalState(env, name) {
  const database = getPrimaryDatabase(env);
  const normalizedName = normalizeOperationalStateName(name);
  const row = await database
    .prepare(`
      SELECT lease_token AS value
      FROM operational_leases
      WHERE name = ?
        AND lease_expires_at > unixepoch()
      LIMIT 1
    `)
    .bind(normalizedName)
    .first();

  return row?.value === null || row?.value === undefined
    ? null
    : String(row.value);
}

/**
 * Apply a small set of interaction-state mutations atomically. A change may
 * put a value, conditionally replace one value, or delete a value. The shared
 * operational_leases table provides expiry without requiring another schema.
 */
export async function applyOperationalStateChanges(env, changes) {
  if (
    !Array.isArray(changes) ||
    changes.length === 0 ||
    changes.length > MAX_OPERATIONAL_STATE_CHANGES
  ) {
    throw new TypeError(
      `state changes must contain 1-${MAX_OPERATIONAL_STATE_CHANGES} entries`
    );
  }

  const database = getDatabase(env);
  const statements = changes.map((change, index) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      throw new TypeError(`state change ${index} must be an object`);
    }
    const name = normalizeOperationalStateName(change.name);
    if (change.delete === true) {
      if (change.expectedValue === null || change.expectedValue === undefined) {
        return database
          .prepare('DELETE FROM operational_leases WHERE name = ?')
          .bind(name);
      }
      const expectedValue = normalizeOperationalStateValue(
        change.expectedValue,
        `state change ${index} expectedValue`
      );
      return database
        .prepare(`
          DELETE FROM operational_leases
          WHERE name = ? AND lease_token = ?
        `)
        .bind(name, expectedValue);
    }

    const value = normalizeOperationalStateValue(
      change.value,
      `state change ${index} value`
    );
    const expirationTtl = normalizeOperationalStateTtl(
      change.expirationTtl,
      `state change ${index} expirationTtl`
    );
    if (change.expectedValue !== null && change.expectedValue !== undefined) {
      const expectedValue = normalizeOperationalStateValue(
        change.expectedValue,
        `state change ${index} expectedValue`
      );
      return database
        .prepare(`
          UPDATE operational_leases
          SET
            lease_token = ?,
            lease_expires_at = unixepoch() + ?,
            updated_at = unixepoch()
          WHERE name = ?
            AND lease_token = ?
            AND lease_expires_at > unixepoch()
        `)
        .bind(value, expirationTtl, name, expectedValue);
    }

    return database
      .prepare(`
        INSERT INTO operational_leases (
          name,
          lease_token,
          lease_expires_at,
          updated_at
        )
        VALUES (?, ?, unixepoch() + ?, unixepoch())
        ON CONFLICT(name) DO UPDATE SET
          lease_token = excluded.lease_token,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
      `)
      .bind(name, value, expirationTtl);
  });
  const results = await database.batch(statements);
  return results.reduce((total, result) => total + getChanges(result), 0);
}

export async function pruneOperationalState(env, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('prune options must be an object');
  }

  const database = getDatabase(env);
  const processedUpdateAge = SECONDS_PER_DAY * normalizeRetentionDays(
    options.processedUpdateRetentionDays,
    DEFAULT_PROCESSED_UPDATE_RETENTION_DAYS,
    'processedUpdateRetentionDays'
  );
  const sentDeliveryAge = SECONDS_PER_DAY * normalizeRetentionDays(
    options.sentDeliveryRetentionDays,
    DEFAULT_SENT_DELIVERY_RETENTION_DAYS,
    'sentDeliveryRetentionDays'
  );
  const deadDeliveryAge = SECONDS_PER_DAY * normalizeRetentionDays(
    options.deadDeliveryRetentionDays,
    DEFAULT_DEAD_DELIVERY_RETENTION_DAYS,
    'deadDeliveryRetentionDays'
  );

  const results = await database.batch([
    database
      .prepare(`
        DELETE FROM processed_updates
        WHERE (
            status = 'completed'
            AND completed_at IS NOT NULL
            AND completed_at < unixepoch() - ?
          )
          OR (
            status = 'processing'
            AND lease_expires_at < unixepoch() - ?
          )
      `)
      .bind(processedUpdateAge, processedUpdateAge),
    database
      .prepare(`
        DELETE FROM deliveries
        WHERE status = 'sent'
          AND COALESCE(sent_at, updated_at) < unixepoch() - ?
      `)
      .bind(sentDeliveryAge),
    database
      .prepare(`
        DELETE FROM deliveries
        WHERE status = 'dead'
          AND updated_at < unixepoch() - ?
      `)
      .bind(deadDeliveryAge),
    database.prepare(`
      DELETE FROM operational_leases
      WHERE lease_expires_at <= unixepoch()
    `)
  ]);

  const summary = {
    processedUpdates: getChanges(results[0]),
    sentDeliveries: getChanges(results[1]),
    deadDeliveries: getChanges(results[2]),
    operationalLeases: getChanges(results[3])
  };
  return {
    ...summary,
    total:
      summary.processedUpdates +
      summary.sentDeliveries +
      summary.deadDeliveries +
      summary.operationalLeases
  };
}

export async function enqueueDeliveries(
  env,
  { feedKey, itemKey, message, targets } = {}
) {
  if (!Array.isArray(targets)) {
    throw new TypeError('targets must be an array');
  }

  const database = getDatabase(env);
  const normalizedFeedKey = normalizeRequiredText(feedKey, 'feedKey');
  const normalizedItemKey = normalizeRequiredText(itemKey, 'itemKey');
  const normalizedMessage = normalizeMessage(message);
  const uniqueTargets = new Map();

  for (const target of targets) {
    const normalized = normalizeTarget(target);
    const key = `${normalized.chatId}\u0000${normalized.threadId}`;
    if (!uniqueTargets.has(key)) {
      uniqueTargets.set(key, normalized);
    }
  }

  const statements = Array.from(uniqueTargets.values(), (target) =>
    database
      .prepare(INSERT_DELIVERY_SQL)
      .bind(
        normalizedFeedKey,
        normalizedItemKey,
        normalizedMessage,
        target.chatId,
        target.threadId
      )
  );
  if (statements.length === 0) {
    return 0;
  }

  const results = await database.batch(statements);
  return results.reduce((total, result) => total + getChanges(result), 0);
}

export async function listPendingDeliveries(env, limit = DEFAULT_PENDING_LIMIT) {
  const database = getDatabase(env);
  const normalizedLimit = normalizeLimit(limit);
  const result = await database
    .prepare(`
      SELECT
        id,
        feed_key,
        item_key,
        message,
        target_chat_id,
        target_thread_id,
        status,
        attempts,
        next_attempt_at,
        last_error,
        created_at,
        updated_at
      FROM deliveries
      WHERE status = 'pending'
        AND next_attempt_at <= unixepoch()
      ORDER BY next_attempt_at ASC, id ASC
      LIMIT ?
    `)
    .bind(normalizedLimit)
    .all();

  return getRows(result).map(mapDeliveryRow);
}

export async function markDeliverySent(env, id) {
  const database = getDatabase(env);
  const deliveryId = normalizeDeliveryId(id);
  const result = await database
    .prepare(`
      UPDATE deliveries
      SET
        status = 'sent',
        attempts = attempts + 1,
        sent_at = unixepoch(),
        updated_at = unixepoch(),
        last_error = NULL
      WHERE id = ? AND status = 'pending'
    `)
    .bind(deliveryId)
    .run();

  return getChanges(result) > 0;
}

export async function markDeliveryRetry(
  env,
  id,
  { error, retryAfterSeconds = 0, permanent = false } = {}
) {
  const database = getDatabase(env);
  const deliveryId = normalizeDeliveryId(id);
  const delay = normalizeRetryDelay(retryAfterSeconds);
  const status = permanent ? 'dead' : 'pending';
  const lastError = errorMessage(error).slice(0, 2000);
  const result = await database
    .prepare(`
      UPDATE deliveries
      SET
        status = ?,
        attempts = attempts + 1,
        next_attempt_at = unixepoch() + ?,
        updated_at = unixepoch(),
        last_error = ?
      WHERE id = ? AND status = 'pending'
    `)
    .bind(status, delay, lastError, deliveryId)
    .run();

  return getChanges(result) > 0;
}

function bindSubscriptionInsert(database, subscription) {
  return database
    .prepare(INSERT_SUBSCRIPTION_SQL)
    .bind(
      subscription.type,
      subscription.channelName,
      subscription.rssUrl,
      subscription.chatId,
      subscription.threadId
    );
}

function normalizeSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
    throw new TypeError('subscription must be an object');
  }

  const rssUrl = normalizeRequiredText(
    subscription.rssUrl ?? subscription.rss_url,
    'subscription.rssUrl'
  );
  const type = normalizeRequiredText(
    subscription.type ?? 'rss',
    'subscription.type'
  ).toLowerCase();
  const channelName = type === 'rss'
    ? deriveRssChannelName(rssUrl)
    : normalizeRequiredText(
        subscription.channelName ?? subscription.channel_name ?? rssUrl,
        'subscription.channelName'
      );

  return {
    type,
    channelName,
    rssUrl,
    chatId: normalizeChatId(subscription.chatId ?? subscription.chat_id),
    threadId: normalizeThreadId(subscription.threadId ?? subscription.thread_id)
  };
}

function deriveRssChannelName(rssUrl) {
  try {
    const hostname = new URL(rssUrl).hostname;
    if (hostname) {
      return hostname;
    }
  } catch {
    // URL validation is owned by the feed boundary. Keep storage permissive.
  }
  return 'rss';
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('each target must be an object');
  }

  return {
    chatId: normalizeChatId(
      target.chatId ?? target.chat_id ?? target.targetChatId ?? target.target_chat_id
    ),
    threadId: normalizeThreadId(
      target.threadId ??
        target.thread_id ??
        target.targetThreadId ??
        target.target_thread_id
    )
  };
}

function normalizeSubscriptionFilter(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new TypeError('filter must be an object');
  }

  const allowedKeys = new Set([
    'id',
    'chatId',
    'chat_id',
    'threadId',
    'thread_id',
    'type',
    'channelName',
    'channel_name',
    'rssUrl',
    'rss_url'
  ]);
  const unknownKeys = Object.keys(filter).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`Unsupported subscription filter: ${unknownKeys.join(', ')}`);
  }

  const clauses = [];
  const params = [];
  const addClause = (column, value) => {
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  const has = (camel, snake) =>
    Object.prototype.hasOwnProperty.call(filter, camel) ||
    Object.prototype.hasOwnProperty.call(filter, snake);
  const get = (camel, snake) => filter[camel] ?? filter[snake];
  if (Object.prototype.hasOwnProperty.call(filter, 'id')) {
    addClause('id', normalizeSubscriptionId(filter.id));
  }

  if (has('chatId', 'chat_id')) {
    addClause('chat_id', normalizeChatId(get('chatId', 'chat_id')));
  }
  if (has('threadId', 'thread_id')) {
    addClause('thread_id', normalizeThreadId(get('threadId', 'thread_id')));
  }
  if (Object.prototype.hasOwnProperty.call(filter, 'type') && filter.type != null) {
    addClause('type', normalizeRequiredText(filter.type, 'filter.type').toLowerCase());
  }
  if (has('channelName', 'channel_name')) {
    addClause(
      'channel_name',
      normalizeRequiredText(get('channelName', 'channel_name'), 'filter.channelName')
    );
  }
  if (has('rssUrl', 'rss_url')) {
    addClause(
      'rss_url',
      normalizeRequiredText(get('rssUrl', 'rss_url'), 'filter.rssUrl')
    );
  }

  if (clauses.length === 0) {
    throw new TypeError('filter must contain at least one supported value');
  }

  return { clauses, params };
}

function normalizeSubscriptionId(value) {
  const isDigitString =
    typeof value === 'string' && /^[0-9]+$/.test(value);
  const normalized =
    typeof value === 'number' || isDigitString ? Number(value) : NaN;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('filter.id must be a positive safe integer');
  }
  return normalized;
}

function parseLegacySubscriptions(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return [];
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new SyntaxError(
      `Legacy KV key "${LEGACY_SUBSCRIPTIONS_KEY}" contains invalid JSON: ${errorMessage(error)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `Legacy KV key "${LEGACY_SUBSCRIPTIONS_KEY}" must contain a JSON array`
    );
  }
  return parsed;
}

function mapSubscriptionRow(row) {
  return {
    id: Number(row.id),
    type: row.type,
    channelName: row.channel_name,
    rssUrl: row.rss_url,
    chatId: String(row.chat_id),
    threadId: denormalizeThreadId(row.thread_id),
    createdAt: Number(row.created_at)
  };
}

function mapSubscriptionsWithRoutingRows(rows) {
  const subscriptions = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      continue;
    }

    let subscription = subscriptions.get(id);
    if (!subscription) {
      subscription = {
        ...mapSubscriptionRow(row),
        routing:
          row.routing_subscription_id === null ||
          row.routing_subscription_id === undefined
            ? null
            : {
                includeSource: Number(row.include_source) !== 0,
                createdAt: Number(row.routing_created_at),
                updatedAt: Number(row.routing_updated_at),
                targets: []
              }
      };
      subscriptions.set(id, subscription);
    }

    if (!subscription.routing) {
      continue;
    }
    if (row.target_id === null || row.target_id === undefined) {
      continue;
    }
    const targetId = Number(row.target_id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      continue;
    }
    subscription.routing.targets.push({
      id: targetId,
      chatId: String(row.target_chat_id),
      threadId: denormalizeThreadId(row.target_thread_id),
      createdAt: Number(row.target_created_at)
    });
  }
  return [...subscriptions.values()];
}

function mapSubscriptionRoutingRows(rows) {
  const routings = new Map();
  for (const row of rows) {
    const subscriptionId = Number(row.subscription_id);
    if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
      continue;
    }

    let routing = routings.get(subscriptionId);
    if (!routing) {
      routing = {
        subscriptionId,
        independent:
          row.routing_subscription_id !== null &&
          row.routing_subscription_id !== undefined,
        includeSource: Number(row.include_source) !== 0,
        targets: []
      };
      routings.set(subscriptionId, routing);
    }

    if (row.target_id === null || row.target_id === undefined) {
      continue;
    }
    const targetId = Number(row.target_id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      continue;
    }
    routing.targets.push({
      id: targetId,
      chatId: String(row.target_chat_id),
      threadId: denormalizeThreadId(row.target_thread_id)
    });
  }
  return [...routings.values()];
}

function normalizeRoutingScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('routing scope must be an object');
  }
  const allowedKeys = new Set([
    'subscriptionId',
    'subscription_id',
    'id',
    'chatId',
    'chat_id',
    'threadId',
    'thread_id'
  ]);
  const unknownKeys = Object.keys(scope).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `Unsupported routing scope: ${unknownKeys.join(', ')}`
    );
  }
  return {
    subscriptionId: normalizeSubscriptionId(
      scope.subscriptionId ?? scope.subscription_id ?? scope.id
    ),
    chatId: normalizeChatId(scope.chatId ?? scope.chat_id),
    threadId: normalizeThreadId(scope.threadId ?? scope.thread_id)
  };
}

function normalizeRoutingTargetScope(scope) {
  const {
    targetId,
    target_id: targetIdSnake,
    ...routingScope
  } = scope ?? {};
  return {
    ...normalizeRoutingScope(routingScope),
    targetId: normalizePositiveId(
      targetId ?? targetIdSnake,
      'targetId'
    )
  };
}

function normalizePositiveId(value, label) {
  const isDigitString = typeof value === 'string' && /^[0-9]+$/.test(value);
  const normalized =
    typeof value === 'number' || isDigitString ? Number(value) : NaN;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function normalizeBoolean(value, label) {
  if (value !== true && value !== false) {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function mapDeliveryRow(row) {
  return {
    id: Number(row.id),
    feedKey: row.feed_key,
    itemKey: row.item_key,
    message: row.message,
    chatId: String(row.target_chat_id),
    threadId: denormalizeThreadId(row.target_thread_id),
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function normalizeChatId(value) {
  return normalizeRequiredText(value, 'chatId');
}

function normalizeThreadId(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  return normalizeRequiredText(value, 'threadId');
}

function denormalizeThreadId(value) {
  return value === null || value === undefined || value === ''
    ? null
    : String(value);
}

function normalizeRequiredText(value, label) {
  if (value === null || value === undefined) {
    throw new TypeError(`${label} is required`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeMessage(message) {
  if (message === null || message === undefined) {
    throw new TypeError('message is required');
  }
  const normalized = String(message);
  if (!normalized) {
    throw new TypeError('message must not be empty');
  }
  return normalized;
}

function normalizeUpdateClaimOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('claim options must be an object');
  }

  const leaseSeconds = Number(
    options.leaseSeconds ?? DEFAULT_UPDATE_LEASE_SECONDS
  );
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < MIN_UPDATE_LEASE_SECONDS ||
    leaseSeconds > MAX_UPDATE_LEASE_SECONDS
  ) {
    throw new TypeError(
      `leaseSeconds must be an integer between ${MIN_UPDATE_LEASE_SECONDS} and ${MAX_UPDATE_LEASE_SECONDS}`
    );
  }

  const leaseToken = normalizeRequiredText(
    options.leaseToken ?? 'unscoped',
    'leaseToken'
  );
  if (leaseToken.length > 200) {
    throw new TypeError('leaseToken must be at most 200 characters');
  }

  return { leaseSeconds, leaseToken };
}

function normalizeOptionalLeaseToken(options) {
  if (typeof options === 'string') {
    return normalizeRequiredText(options, 'leaseToken');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('update lease options must be an object');
  }
  if (options.leaseToken === null || options.leaseToken === undefined) {
    return null;
  }

  const leaseToken = normalizeRequiredText(options.leaseToken, 'leaseToken');
  if (leaseToken.length > 200) {
    throw new TypeError('leaseToken must be at most 200 characters');
  }
  return leaseToken;
}

function normalizeOperationalLeaseOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('operational lease options must be an object');
  }

  const leaseSeconds = Number(
    options.leaseSeconds ?? DEFAULT_OPERATIONAL_LEASE_SECONDS
  );
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < MIN_OPERATIONAL_LEASE_SECONDS ||
    leaseSeconds > MAX_OPERATIONAL_LEASE_SECONDS
  ) {
    throw new TypeError(
      `leaseSeconds must be an integer between ${MIN_OPERATIONAL_LEASE_SECONDS} and ${MAX_OPERATIONAL_LEASE_SECONDS}`
    );
  }

  const leaseToken = normalizeRequiredText(options.leaseToken, 'leaseToken');
  if (leaseToken.length > 200) {
    throw new TypeError('leaseToken must be at most 200 characters');
  }

  return { leaseSeconds, leaseToken };
}

function normalizeOperationalStateName(value) {
  const name = normalizeRequiredText(value, 'state name');
  if (name.length > 100) {
    throw new TypeError('state name must be at most 100 characters');
  }
  return name;
}

function normalizeOperationalStateValue(value, label) {
  const normalized = normalizeRequiredText(value, label);
  if (
    new TextEncoder().encode(normalized).length >
    MAX_OPERATIONAL_STATE_VALUE_BYTES
  ) {
    throw new TypeError(
      `${label} must be at most ${MAX_OPERATIONAL_STATE_VALUE_BYTES} bytes`
    );
  }
  return normalized;
}

function normalizeOperationalStateTtl(value, label) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_OPERATIONAL_LEASE_SECONDS ||
    parsed > MAX_OPERATIONAL_STATE_TTL_SECONDS
  ) {
    throw new TypeError(
      `${label} must be an integer between ${MIN_OPERATIONAL_LEASE_SECONDS} and ${MAX_OPERATIONAL_STATE_TTL_SECONDS}`
    );
  }
  return parsed;
}

function normalizeRetentionDays(value, fallback, label) {
  const parsed = Number(value ?? fallback);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_RETENTION_DAYS
  ) {
    throw new TypeError(
      `${label} must be an integer between 1 and ${MAX_RETENTION_DAYS}`
    );
  }
  return parsed;
}

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError('limit must be a positive integer');
  }
  return Math.min(parsed, MAX_PENDING_LIMIT);
}

function normalizeDeliveryId(id) {
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('delivery id must be a positive integer');
  }
  return parsed;
}

function normalizeRetryDelay(seconds) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError('retryAfterSeconds must be a non-negative number');
  }
  return Math.ceil(parsed);
}

function getDatabase(env) {
  if (!env?.SQL || typeof env.SQL.prepare !== 'function') {
    throw new TypeError('env.SQL D1 binding is required');
  }
  return env.SQL;
}

function getPrimaryDatabase(env) {
  const database = getDatabase(env);
  return typeof database.withSession === 'function'
    ? database.withSession('first-primary')
    : database;
}

function getLegacyKv(env) {
  if (!env?.DB || typeof env.DB.get !== 'function') {
    throw new TypeError('env.DB legacy KV binding is required');
  }
  return env.DB;
}

function getRows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function getChanges(result) {
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
  return Number.isFinite(changes) && changes > 0 ? changes : 0;
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error === null || error === undefined) {
    return '';
  }
  return String(error);
}
