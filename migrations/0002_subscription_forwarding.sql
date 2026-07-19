CREATE TABLE IF NOT EXISTS subscription_routing_settings (
  subscription_id INTEGER PRIMARY KEY,
  include_source INTEGER NOT NULL DEFAULT 1
    CHECK (include_source IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (subscription_id)
    REFERENCES subscriptions(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_forward_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  target_chat_id TEXT NOT NULL,
  target_thread_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (subscription_id)
    REFERENCES subscription_routing_settings(subscription_id)
    ON DELETE CASCADE,
  UNIQUE (subscription_id, target_chat_id, target_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_subscription_forward_targets_subscription
  ON subscription_forward_targets (subscription_id, id);

-- D1 does not guarantee that foreign-key enforcement is enabled for every
-- connection. A trigger keeps routing state bounded even when an older Worker
-- version removes a subscription without knowing about the new tables.
CREATE TRIGGER IF NOT EXISTS cleanup_subscription_routing_after_delete
AFTER DELETE ON subscriptions
BEGIN
  DELETE FROM subscription_forward_targets
  WHERE subscription_id = OLD.id;

  DELETE FROM subscription_routing_settings
  WHERE subscription_id = OLD.id;
END;
