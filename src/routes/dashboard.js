'use strict';

const express = require('express');
const db = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { env } = require('../config/env');
const runtime = require('../discord/runtime');
const { getUserPlan } = require('../services/PlanService');
const fs = require('node:fs');
const path = require('node:path');

const router = express.Router();
router.use(requireAuth);

router.get('/dashboard', async (req, res) => {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 6);
  const sinceSql = since.toISOString().slice(0, 19).replace('T', ' ');
  const [total, online, bots, plan, notifications, guilds, activityRows] = await Promise.all([
    db.prepare(`SELECT COUNT(DISTINCT b.id) AS count FROM bots b WHERE b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active')`).get(req.session.user.id,req.session.user.id),
    db.prepare(`SELECT COUNT(DISTINCT b.id) AS count FROM bots b WHERE b.status='online' AND (b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'))`).get(req.session.user.id,req.session.user.id),
    db.prepare(`SELECT DISTINCT b.id,b.owner_id,b.name,b.description,b.avatar_url,b.status,b.created_at,b.client_id,CASE WHEN b.owner_id=? THEN 'owner' ELSE COALESCE((SELECT wm.role FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active' LIMIT 1),'viewer') END AS access_role FROM bots b WHERE b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active') ORDER BY b.created_at DESC LIMIT 6`).all(req.session.user.id,req.session.user.id,req.session.user.id,req.session.user.id),
    getUserPlan(req.session.user.id),
    db.prepare('SELECT id,kind,title,message,created_at FROM notifications WHERE user_id=? AND read_at IS NULL ORDER BY created_at DESC LIMIT 5').all(req.session.user.id),
    db.prepare(`SELECT COUNT(*) AS count FROM bot_guilds g JOIN bots b ON b.id=g.bot_id WHERE b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active')`).get(req.session.user.id,req.session.user.id),
    db.prepare('SELECT l.created_at FROM bot_logs l JOIN bots b ON b.id=l.bot_id WHERE b.owner_id=? AND l.created_at>=? ORDER BY l.created_at').all(req.session.user.id, sinceSql)
  ]);
  const daily = new Map();
  for (const row of activityRows) {
    const parsed = new Date(String(row.created_at).replace(' ', 'T') + (String(row.created_at).endsWith('Z') ? '' : 'Z'));
    if (!Number.isNaN(parsed.getTime())) {
      const key = parsed.toISOString().slice(0, 10);
      daily.set(key, (daily.get(key) || 0) + 1);
    }
  }
  const activity = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(since.getTime() + index * 86400000);
    const key = day.toISOString().slice(0, 10);
    return { date: key, label: day.toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }), count: daily.get(key) || 0 };
  });
  const maxActivity = Math.max(1, ...activity.map(point => point.count));
  activity.forEach(point => { point.height = point.count ? Math.max(7, Math.round(point.count / maxActivity * 100)) : 2; });
  const stats = { total: Number(total.count), online: Number(online.count), offline: Number(total.count) - Number(online.count), guilds:Number(guilds.count||0) };
  res.render('dashboard', { title: 'Dashboard', stats, bots, maxBots: Math.min(plan.bot_limit, env.maxBotsPerUser), plan, notifications, activity });
});

router.get('/profile', (req, res) => res.render('profile', { title: 'Profile' }));

router.get('/admin', requireAdmin, async (req, res) => {
  const [users, bots, totals, auditLogs] = await Promise.all([
    db.prepare('SELECT id, discord_id, username, created_at, last_login_at, is_suspended FROM users ORDER BY id DESC LIMIT 100').all(),
    db.prepare(`SELECT b.id, b.name, b.status, b.created_at, u.username, u.discord_id
      FROM bots b JOIN users u ON u.id = b.owner_id ORDER BY b.created_at DESC LIMIT 100`).all(),
    Promise.all([
      db.prepare('SELECT COUNT(*) AS n FROM users').get(),
      db.prepare('SELECT COUNT(*) AS n FROM bots').get(),
      db.prepare("SELECT COUNT(*) AS n FROM bots WHERE status = 'online'").get()
    ]),
    db.prepare('SELECT admin_discord_id, action, target, details, created_at FROM admin_audit_logs ORDER BY id DESC LIMIT 30').all()
  ]);
  res.render('admin', { title: 'Admin Panel', users, bots, totals: { users: totals[0].n, bots: totals[1].n, online: totals[2].n }, auditLogs });
});

router.post('/admin/users/:id/suspension', requireAdmin, async (req, res) => {
  const user = await db.prepare('SELECT id, discord_id, username, is_suspended FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('errors/error', { title: 'User not found', message: 'The requested user does not exist.' });
  if (user.discord_id === req.session.user.discord_id) {
    req.session.notice = { type: 'error', message: 'You cannot suspend your own administrator account.' };
    return res.redirect('/admin');
  }
  const suspended = user.is_suspended ? 0 : 1;
  await db.prepare('UPDATE users SET is_suspended = ? WHERE id = ?').run(suspended, user.id);
  await db.prepare('INSERT INTO admin_audit_logs (admin_discord_id, action, target, details) VALUES (?, ?, ?, ?)')
    .run(req.session.user.discord_id, suspended ? 'user.suspend' : 'user.restore', user.discord_id, `${user.username} (${user.id})`);
  req.session.notice = { type: 'success', message: `${user.username} ${suspended ? 'suspended' : 'restored'}.` };
  res.redirect('/admin');
});

router.post('/admin/bots/:id/:action', requireAdmin, async (req, res) => {
  const bot = await db.prepare('SELECT id, owner_id, name FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.status(404).render('errors/error', { title: 'Bot not found', message: 'The requested bot does not exist.' });
  const action = req.params.action;
  try {
    if (action === 'start') await runtime.startBot(bot.id);
    else if (action === 'stop') await runtime.stopBot(bot.id);
    else if (action === 'restart') await runtime.restartBot(bot.id);
    else if (action === 'delete') {
      await runtime.stopBot(bot.id).catch(() => {});
      await db.prepare('DELETE FROM bots WHERE id = ?').run(bot.id);
      fs.rmSync(path.resolve(process.cwd(), 'storage', 'bots', bot.id), { recursive: true, force: true });
    } else throw new Error('Unsupported administrator action.');
    await db.prepare('INSERT INTO admin_audit_logs (admin_discord_id, action, target, details) VALUES (?, ?, ?, ?)')
      .run(req.session.user.discord_id, `bot.${action}`, bot.id, bot.name);
    req.session.notice = { type: 'success', message: `Administrator action completed: ${action} ${bot.name}.` };
  } catch (error) {
    req.session.notice = { type: 'error', message: error.message };
  }
  res.redirect('/admin');
});

module.exports = router;
