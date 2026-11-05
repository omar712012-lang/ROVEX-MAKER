'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../src/config/saasSchema');
let Database = null;
try { Database = require('better-sqlite3'); }
catch { try { Database = require('node:sqlite').DatabaseSync; } catch {} }

function createDatabase() {
  if (!Database) return null;
  const db = new Database(':memory:');
  if (typeof db.pragma === 'function') db.pragma('foreign_keys = ON');
  else db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE bots (id TEXT PRIMARY KEY);');
  db.exec(schema.sqlite);
  return db;
}

test('SaaS SQLite schema creates all core marketplace and workspace tables', { skip: !Database && 'Install better-sqlite3 or run on Node.js 22+ for the built-in SQLite smoke test.' }, () => {
  const db = createDatabase();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const name of ['templates','template_versions','user_favorites','plans','subscriptions','usage_records','invoices','payment_events','workspaces','workspace_bots','workspace_members','notifications','integrations','platform_announcements','platform_audit_logs']) {
    assert.ok(names.includes(name), `missing table ${name}`);
  }
  db.close();
});

test('template versions, favorites and notifications have valid relationships', { skip: !Database && 'SQLite driver is unavailable.' }, () => {
  const db = createDatabase();
  db.exec("INSERT INTO users(id) VALUES (1); INSERT INTO plans(plan_key,name,bot_limit,running_limit,log_limit) VALUES ('free','Free',2,1,200);");
  db.prepare("INSERT INTO templates(id,name,category,description,version,status,min_plan,definition_json) VALUES ('general','General','Community','A valid description for testing.','1.0.0','published','free','{}')").run();
  db.prepare("INSERT INTO user_favorites(user_id,template_id) VALUES (?,?)").run(1, 'general');
  db.prepare("INSERT INTO template_versions(id,template_id,version,definition_json) VALUES (?,?,?,?)").run('v1', 'general', '1.0.0', '{}');
  db.prepare("INSERT INTO notifications(id,user_id,kind,title,message) VALUES (?,?,?,?,?)").run('n1', 1, 'test', 'Test', 'Message');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_favorites').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM template_versions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1);
  assert.throws(() => db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ('missing',1,'unknown')").run());
  db.close();
});

test('one active subscription per user is enforced by the migration index', { skip: !Database && 'SQLite driver is unavailable.' }, () => {
  const db = createDatabase();
  db.exec("INSERT INTO users(id) VALUES (1); INSERT INTO plans(plan_key,name,bot_limit,running_limit,log_limit) VALUES ('free','Free',2,1,200),('pro','Pro',15,8,5000);");
  db.prepare("INSERT INTO subscriptions(id,user_id,plan_key,status) VALUES ('s1',1,'free','active')").run();
  db.prepare("INSERT INTO subscriptions(id,user_id,plan_key,status) VALUES ('s2',1,'pro','active')").run();
  db.exec(`UPDATE subscriptions SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP WHERE status='active' AND id NOT IN (
    SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS position FROM subscriptions WHERE status='active') ranked WHERE position=1
  )`);
  db.exec("CREATE UNIQUE INDEX idx_subscriptions_one_active_user ON subscriptions(user_id) WHERE status='active'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=1 AND status='active'").get().n, 1);
  assert.throws(() => db.prepare("INSERT INTO subscriptions(id,user_id,plan_key,status) VALUES ('s3',1,'free','active')").run());
  db.close();
});
