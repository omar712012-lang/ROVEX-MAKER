'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { env } = require('./env');
const saasSchema = require('./saasSchema');

let sqlite;
let pool;
let initialized = false;
const dialect = env.databaseUrl ? 'postgres' : 'sqlite';

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
  global_name TEXT, avatar TEXT, is_suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', avatar_url TEXT, client_id TEXT NOT NULL,
  encrypted_token TEXT NOT NULL, token_iv TEXT NOT NULL, token_tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline', last_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, auto_start INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_client_id ON bots(client_id);
CREATE TABLE IF NOT EXISTS bot_settings (bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, settings_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS bot_features (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, feature_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (bot_id, feature_key));
CREATE TABLE IF NOT EXISTS bot_commands (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, command_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (bot_id, command_name));
CREATE TABLE IF NOT EXISTS bot_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, level TEXT NOT NULL DEFAULT 'info', category TEXT NOT NULL DEFAULT 'system', message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_bot_logs ON bot_logs(bot_id, id DESC);
CREATE TABLE IF NOT EXISTS bot_guilds (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, guild_name TEXT NOT NULL, member_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (bot_id, guild_id));
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
CREATE TABLE IF NOT EXISTS system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS guild_settings (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  welcome_channel_id TEXT, log_channel_id TEXT, ticket_staff_role_id TEXT,
  welcome_message TEXT NOT NULL DEFAULT 'Welcome {user} to **{server}**!',
  leave_message TEXT NOT NULL DEFAULT '{user} left the server.', welcome_image_url TEXT,
  automod_json TEXT NOT NULL DEFAULT '{"antiSpam":true,"antiLinks":false,"antiMassMention":true,"antiCaps":false,"badWords":[]}',
  PRIMARY KEY (bot_id, guild_id)
);
CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, moderator_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS levels (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, last_xp_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bot_id, guild_id, user_id));
CREATE TABLE IF NOT EXISTS economy (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0, last_daily_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bot_id, guild_id, user_id));
CREATE TABLE IF NOT EXISTS giveaways (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, prize TEXT NOT NULL, winner_count INTEGER NOT NULL DEFAULT 1, ends_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS giveaway_entries (giveaway_id TEXT NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE, user_id TEXT NOT NULL, PRIMARY KEY (giveaway_id, user_id));
CREATE TABLE IF NOT EXISTS economy_shop_items (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK(price > 0), reward_role_id TEXT, stock INTEGER NOT NULL DEFAULT -1,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bot_id, guild_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_item_name_ci ON economy_shop_items(bot_id, guild_id, lower(name));
CREATE TABLE IF NOT EXISTS economy_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES economy_shop_items(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL, price INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS level_rewards (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK(level > 0), role_id TEXT NOT NULL,
  PRIMARY KEY(bot_id, guild_id, level), UNIQUE(bot_id, guild_id, role_id)
);
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_discord_id TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const pgSchema = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
  global_name TEXT, avatar TEXT, is_suspended INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', avatar_url TEXT, client_id TEXT NOT NULL,
  encrypted_token TEXT NOT NULL, token_iv TEXT NOT NULL, token_tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline', last_started_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, auto_start INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_client_id ON bots(client_id);
CREATE TABLE IF NOT EXISTS bot_settings (bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, settings_json TEXT NOT NULL DEFAULT '{}', updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS bot_features (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, feature_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (bot_id, feature_key));
CREATE TABLE IF NOT EXISTS bot_commands (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, command_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (bot_id, command_name));
CREATE TABLE IF NOT EXISTS bot_logs (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, level TEXT NOT NULL DEFAULT 'info', category TEXT NOT NULL DEFAULT 'system', message TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_bot_logs ON bot_logs(bot_id, id DESC);
CREATE TABLE IF NOT EXISTS bot_guilds (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, guild_name TEXT NOT NULL, member_count INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (bot_id, guild_id));
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
CREATE TABLE IF NOT EXISTS system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS guild_settings (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  welcome_channel_id TEXT, log_channel_id TEXT, ticket_staff_role_id TEXT,
  welcome_message TEXT NOT NULL DEFAULT 'Welcome {user} to **{server}**!',
  leave_message TEXT NOT NULL DEFAULT '{user} left the server.', welcome_image_url TEXT,
  automod_json TEXT NOT NULL DEFAULT '{"antiSpam":true,"antiLinks":false,"antiMassMention":true,"antiCaps":false,"badWords":[]}',
  PRIMARY KEY (bot_id, guild_id)
);
CREATE TABLE IF NOT EXISTS warnings (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, moderator_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS levels (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, last_xp_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (bot_id, guild_id, user_id));
CREATE TABLE IF NOT EXISTS economy (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, coins BIGINT NOT NULL DEFAULT 0, last_daily_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (bot_id, guild_id, user_id));
CREATE TABLE IF NOT EXISTS giveaways (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, prize TEXT NOT NULL, winner_count INTEGER NOT NULL DEFAULT 1, ends_at BIGINT NOT NULL, ended INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS giveaway_entries (giveaway_id TEXT NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE, user_id TEXT NOT NULL, PRIMARY KEY (giveaway_id, user_id));
CREATE TABLE IF NOT EXISTS economy_shop_items (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price BIGINT NOT NULL CHECK(price > 0), reward_role_id TEXT, stock INTEGER NOT NULL DEFAULT -1,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bot_id, guild_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_item_name_ci ON economy_shop_items(bot_id, guild_id, lower(name));
CREATE TABLE IF NOT EXISTS economy_purchases (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, item_id TEXT NOT NULL REFERENCES economy_shop_items(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL, price BIGINT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS level_rewards (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK(level > 0), role_id TEXT NOT NULL,
  PRIMARY KEY(bot_id, guild_id, level), UNIQUE(bot_id, guild_id, role_id)
);
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, admin_discord_id TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;


const featureSchemaSqlite = `
CREATE TABLE IF NOT EXISTS bot_module_settings (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL, module_key TEXT NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(bot_id,guild_id,module_key)
);
CREATE TABLE IF NOT EXISTS bot_birthdays (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL, month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12), day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31),
  last_wished_year INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_birthdays_date ON bot_birthdays(bot_id,month,day);
CREATE TABLE IF NOT EXISTS bot_counting_state (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, next_number INTEGER NOT NULL DEFAULT 1, last_user_id TEXT,
  PRIMARY KEY(bot_id,guild_id)
);
CREATE TABLE IF NOT EXISTS bot_suggestions (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bot_suggestion_votes (
  suggestion_id TEXT NOT NULL REFERENCES bot_suggestions(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK(vote IN (-1,1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(suggestion_id,user_id)
);
CREATE TABLE IF NOT EXISTS bot_starboard_posts (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL, starboard_message_id TEXT, channel_id TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,source_message_id)
);
CREATE TABLE IF NOT EXISTS bot_invite_cache (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  invite_code TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, inviter_id TEXT,
  PRIMARY KEY(bot_id,guild_id,invite_code)
);
CREATE TABLE IF NOT EXISTS bot_invite_joins (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL, invite_code TEXT, inviter_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS bot_temp_voice_rooms (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,channel_id)
);
CREATE TABLE IF NOT EXISTS bot_reaction_roles (
  button_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL, message_id TEXT NOT NULL, role_id TEXT NOT NULL, label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(bot_id,guild_id,message_id,role_id)
);
`;

const featureSchemaPostgres = `
CREATE TABLE IF NOT EXISTS bot_module_settings (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL, module_key TEXT NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(bot_id,guild_id,module_key)
);
CREATE TABLE IF NOT EXISTS bot_birthdays (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL, month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12), day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31),
  last_wished_year INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_birthdays_date ON bot_birthdays(bot_id,month,day);
CREATE TABLE IF NOT EXISTS bot_counting_state (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, next_number INTEGER NOT NULL DEFAULT 1, last_user_id TEXT,
  PRIMARY KEY(bot_id,guild_id)
);
CREATE TABLE IF NOT EXISTS bot_suggestions (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bot_suggestion_votes (
  suggestion_id TEXT NOT NULL REFERENCES bot_suggestions(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK(vote IN (-1,1)), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(suggestion_id,user_id)
);
CREATE TABLE IF NOT EXISTS bot_starboard_posts (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL, starboard_message_id TEXT, channel_id TEXT NOT NULL,
  reaction_count INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,source_message_id)
);
CREATE TABLE IF NOT EXISTS bot_invite_cache (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  invite_code TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, inviter_id TEXT,
  PRIMARY KEY(bot_id,guild_id,invite_code)
);
CREATE TABLE IF NOT EXISTS bot_invite_joins (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL, invite_code TEXT, inviter_id TEXT, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS bot_temp_voice_rooms (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bot_id,guild_id,channel_id)
);
CREATE TABLE IF NOT EXISTS bot_reaction_roles (
  button_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL, message_id TEXT NOT NULL, role_id TEXT NOT NULL, label TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(bot_id,guild_id,message_id,role_id)
);
`;

function pgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function makePrepared(sql, executor = pool) {
  return {
    async get(...params) {
      if (dialect === 'sqlite') return sqlite.prepare(sql).get(...params);
      const result = await executor.query(pgSql(sql), params);
      return result.rows[0];
    },
    async all(...params) {
      if (dialect === 'sqlite') return sqlite.prepare(sql).all(...params);
      const result = await executor.query(pgSql(sql), params);
      return result.rows;
    },
    async run(...params) {
      if (dialect === 'sqlite') {
        const statement = sqlite.prepare(sql);
        if (/\bRETURNING\b/i.test(sql)) {
          const row = statement.get(...params);
          return { changes: row ? 1 : 0, rows: row ? [row] : [], lastInsertRowid: row?.id };
        }
        const result = statement.run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      }
      const result = await executor.query(pgSql(sql), params);
      return { changes: result.rowCount, rows: result.rows, lastInsertRowid: result.rows[0]?.id };
    }
  };
}

function prepare(sql) { return makePrepared(sql); }

async function init() {
  if (initialized) return;
  if (dialect === 'sqlite') {
    const Database = require('better-sqlite3');
    fs.mkdirSync(env.dataDir, { recursive: true });
    sqlite = new Database(path.join(env.dataDir, 'bot-maker-studio.sqlite'));
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.exec(sqliteSchema);
    sqlite.exec(saasSchema.sqlite);
    sqlite.exec(featureSchemaSqlite);
    sqlite.exec(`UPDATE subscriptions SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP WHERE status='active' AND id NOT IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS position FROM subscriptions WHERE status='active') ranked WHERE position=1
    )`);
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_active_user ON subscriptions(user_id) WHERE status='active'");
    const columns = sqlite.prepare('PRAGMA table_info(guild_settings)').all().map(row => row.name);
    if (!columns.includes('ticket_staff_role_id')) sqlite.exec('ALTER TABLE guild_settings ADD COLUMN ticket_staff_role_id TEXT');
    if (!columns.includes('welcome_image_url')) sqlite.exec('ALTER TABLE guild_settings ADD COLUMN welcome_image_url TEXT');
    const userColumns = sqlite.prepare('PRAGMA table_info(users)').all().map(row => row.name);
    if (!userColumns.includes('is_suspended')) sqlite.exec('ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0');
  } else {
    const { Pool, types } = require('pg');
    types.setTypeParser(1114, value => value);
    pool = new Pool({ connectionString: env.databaseUrl, ssl: env.databaseSsl ? { rejectUnauthorized: env.databaseSslStrict } : undefined, max: env.databasePoolSize, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    await pool.query(pgSchema);
    await pool.query(saasSchema.postgres);
    await pool.query(featureSchemaPostgres);
    await pool.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP WHERE status='active' AND id NOT IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS position FROM subscriptions WHERE status='active') ranked WHERE position=1
    )`);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_active_user ON subscriptions(user_id) WHERE status='active'");
    await pool.query('ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS ticket_staff_role_id TEXT');
    await pool.query('ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS welcome_image_url TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended INTEGER NOT NULL DEFAULT 0');
  }
  initialized = true;
}

async function withTransaction(callback) {
  if (dialect === 'sqlite') {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const value = await callback({ prepare }); sqlite.exec('COMMIT'); return value; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await callback({ prepare: sql => makePrepared(sql, client) }); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function close() {
  if (dialect === 'sqlite' && sqlite?.open) sqlite.close();
  if (dialect === 'postgres' && pool) await pool.end();
  initialized = false;
}

module.exports = { dialect, init, prepare, withTransaction, close, get ready() { return initialized; } };
