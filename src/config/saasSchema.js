'use strict';

const sqlite = `
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
  version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'preview', min_plan TEXT NOT NULL DEFAULT 'free',
  definition_json TEXT NOT NULL, uses_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_templates_status_category ON templates(status, category);
CREATE TABLE IF NOT EXISTS template_versions (
  id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version TEXT NOT NULL, definition_json TEXT NOT NULL, changelog TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(template_id, version)
);
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id, template_id)
);
CREATE TABLE IF NOT EXISTS plans (
  plan_key TEXT PRIMARY KEY, name TEXT NOT NULL, bot_limit INTEGER NOT NULL,
  running_limit INTEGER NOT NULL, log_limit INTEGER NOT NULL, team_enabled INTEGER NOT NULL DEFAULT 0,
  premium_templates INTEGER NOT NULL DEFAULT 0, features_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL REFERENCES plans(plan_key), status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renews_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_key TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
  period_start TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_usage_user_period ON usage_records(user_id, usage_key, period_start);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_ref TEXT, status TEXT NOT NULL, amount_minor INTEGER, currency TEXT,
  hosted_url TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_events (
  event_id TEXT PRIMARY KEY, provider TEXT NOT NULL, payload_hash TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspace_bots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(workspace_id,bot_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_bots_bot ON workspace_bots(bot_id);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','administrator','developer','viewer')),
  status TEXT NOT NULL DEFAULT 'active', added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
  read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, encrypted_value TEXT, iv TEXT, auth_tag TEXT,
  config_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bot_id, provider)
);
CREATE TABLE IF NOT EXISTS platform_announcements (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', published_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id TEXT PRIMARY KEY, actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs(created_at DESC);
`;

const postgres = `
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
  version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'preview', min_plan TEXT NOT NULL DEFAULT 'free',
  definition_json TEXT NOT NULL, uses_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_templates_status_category ON templates(status, category);
CREATE TABLE IF NOT EXISTS template_versions (
  id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version TEXT NOT NULL, definition_json TEXT NOT NULL, changelog TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(template_id, version)
);
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id, template_id)
);
CREATE TABLE IF NOT EXISTS plans (
  plan_key TEXT PRIMARY KEY, name TEXT NOT NULL, bot_limit INTEGER NOT NULL,
  running_limit INTEGER NOT NULL, log_limit INTEGER NOT NULL, team_enabled INTEGER NOT NULL DEFAULT 0,
  premium_templates INTEGER NOT NULL DEFAULT 0, features_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL REFERENCES plans(plan_key), status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT, started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renews_at TIMESTAMP, cancelled_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_key TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
  period_start TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_usage_user_period ON usage_records(user_id, usage_key, period_start);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_ref TEXT, status TEXT NOT NULL, amount_minor BIGINT, currency TEXT,
  hosted_url TEXT, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_events (
  event_id TEXT PRIMARY KEY, provider TEXT NOT NULL, payload_hash TEXT NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspace_bots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(workspace_id,bot_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_bots_bot ON workspace_bots(bot_id);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','administrator','developer','viewer')),
  status TEXT NOT NULL DEFAULT 'active', added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
  read_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, encrypted_value TEXT, iv TEXT, auth_tag TEXT,
  config_json TEXT NOT NULL DEFAULT '{}', updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bot_id, provider)
);
CREATE TABLE IF NOT EXISTS platform_announcements (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', published_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id TEXT PRIMARY KEY, actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs(created_at DESC);
`;

module.exports = { sqlite, postgres };
