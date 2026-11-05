'use strict';

const crypto = require('node:crypto');
const db = require('../config/database');
const { env } = require('../config/env');

const plans = [
  { key:'free', name:'Free', botLimit:2, runningLimit:1, logLimit:200, teams:false, premium:false, features:['Core templates','Basic dashboard'] },
  { key:'starter', name:'Starter', botLimit:5, runningLimit:3, logLimit:1000, teams:false, premium:true, features:['Starter templates','Extended logs','More runtime slots'] },
  { key:'pro', name:'Pro', botLimit:15, runningLimit:8, logLimit:5000, teams:false, premium:true, features:['Pro templates','Advanced moderation presets','Extended analytics'] },
  { key:'business', name:'Business', botLimit:50, runningLimit:15, logLimit:15000, teams:true, premium:true, features:['Business templates','Team workspaces','Highest platform limits'] }
];

async function initializePlans() {
  for (const plan of plans) {
    await db.prepare(`INSERT INTO plans (plan_key,name,bot_limit,running_limit,log_limit,team_enabled,premium_templates,features_json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(plan_key) DO UPDATE SET name=excluded.name, bot_limit=excluded.bot_limit,
      running_limit=excluded.running_limit, log_limit=excluded.log_limit, team_enabled=excluded.team_enabled,
      premium_templates=excluded.premium_templates, features_json=excluded.features_json`)
      .run(plan.key, plan.name, plan.botLimit, plan.runningLimit, plan.logLimit, plan.teams ? 1 : 0, plan.premium ? 1 : 0, JSON.stringify(plan.features));
  }
}

async function getUserPlan(userId) {
  let sub = await db.prepare(`SELECT s.plan_key, s.status, s.started_at, s.renews_at, p.name, p.bot_limit,
    p.running_limit, p.log_limit, p.team_enabled, p.premium_templates, p.features_json
    FROM subscriptions s JOIN plans p ON p.plan_key=s.plan_key
    WHERE s.user_id=? AND s.status='active' ORDER BY s.created_at DESC LIMIT 1`).get(userId);
  if (!sub) {
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO subscriptions (id,user_id,plan_key,status,provider) VALUES (?,?, 'free','active','platform') ON CONFLICT DO NOTHING").run(id, userId);
    sub = await db.prepare(`SELECT s.plan_key, s.status, s.started_at, s.renews_at, p.name, p.bot_limit,
      p.running_limit, p.log_limit, p.team_enabled, p.premium_templates, p.features_json
      FROM subscriptions s JOIN plans p ON p.plan_key=s.plan_key
      WHERE s.user_id=? AND s.status='active' ORDER BY s.created_at DESC LIMIT 1`).get(userId);
  }
  return { ...sub, features: JSON.parse(sub.features_json || '[]'), bot_limit: Number(sub.bot_limit), running_limit: Number(sub.running_limit), log_limit: Number(sub.log_limit), team_enabled: Boolean(sub.team_enabled), premium_templates: Boolean(sub.premium_templates) };
}

async function assertCanCreateBot(userId) {
  const [plan, count] = await Promise.all([
    getUserPlan(userId),
    db.prepare('SELECT COUNT(*) AS n FROM bots WHERE owner_id=?').get(userId)
  ]);
  const effectiveLimit = Math.min(plan.bot_limit, env.maxBotsPerUser);
  if (Number(count.n) >= effectiveLimit) throw new Error(`Your ${plan.name} plan allows ${effectiveLimit} bot(s). Upgrade your plan or remove an existing bot.`);
  return plan;
}

async function assertCanRunBot(userId, currentRunning) {
  const plan = await getUserPlan(userId);
  const limit = Math.min(plan.running_limit, env.maxRunningBots);
  if (currentRunning >= limit) throw new Error(`Your ${plan.name} plan allows ${limit} running bot(s) at a time.`);
  return plan;
}

async function assertCanUseTemplate(userId, template) {
  const plan = await getUserPlan(userId);
  const rank = { free:0, starter:1, pro:2, business:3 };
  if ((rank[plan.plan_key] ?? 0) < (rank[template.minPlan] ?? 0)) {
    throw new Error(`The ${template.name} template requires the ${template.minPlan} plan. Paid checkout is not configured on this installation.`);
  }
  return plan;
}

async function recordUsage(userId, key, quantity = 1) {
  const periodStart = new Date();
  periodStart.setUTCDate(1); periodStart.setUTCHours(0,0,0,0);
  await db.prepare('INSERT INTO usage_records (id,user_id,usage_key,quantity,period_start) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), userId, key, quantity, periodStart.toISOString());
}

module.exports = { plans, initializePlans, getUserPlan, assertCanCreateBot, assertCanRunBot, assertCanUseTemplate, recordUsage };
