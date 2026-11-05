'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { env } = require('../config/env');
const { encrypt } = require('../services/EncryptionService');
const runtime = require('../discord/runtime');
const { definitions, features, featureByCommand } = require('../discord/commands');
const { validateTemplate, getRequiredIntents } = require('../templates/catalog');
const { assertCanCreateBot, assertCanUseTemplate, recordUsage } = require('../services/PlanService');
const { notify } = require('../services/SaasService');

const router = express.Router();
router.use(requireAuth);
const botStorage = path.resolve(process.cwd(), 'storage', 'bots');
fs.mkdirSync(botStorage, { recursive: true });

async function ownedBot(req, res, next) {
  try {
    const bot = await db.prepare(`SELECT b.id,b.owner_id,b.name,b.description,b.avatar_url,b.client_id,b.status,b.last_started_at,b.created_at,b.auto_start,
      CASE WHEN b.owner_id=? THEN 'owner' ELSE COALESCE((
        SELECT CASE wm.role WHEN 'administrator' THEN 'administrator' WHEN 'developer' THEN 'developer' ELSE 'viewer' END
        FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id
        WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'
        ORDER BY CASE wm.role WHEN 'administrator' THEN 3 WHEN 'developer' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC LIMIT 1
      ),'viewer') END AS access_role
      FROM bots b WHERE b.id=? AND (b.owner_id=? OR EXISTS(
        SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id
        WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'
      ))`).get(req.session.user.id,req.session.user.id,req.params.id,req.session.user.id,req.session.user.id);
    if (!bot) return res.status(404).render('errors/error', { title: 'Bot not found', message: 'This bot does not exist or you do not have access to it.' });
    if (req.method !== 'GET' && bot.access_role === 'viewer') return res.status(403).render('errors/error', { title: 'Read-only access', message: 'Your workspace role allows viewing this bot but not changing it.' });
    req.bot = bot;
    next();
  } catch (error) { next(error); }
}
function setNotice(req, type, message) { req.session.notice = { type, message }; }

router.get('/bots', async (req, res) => {
  const plan = await require('../services/PlanService').getUserPlan(req.session.user.id);
  const bots = await db.prepare(`SELECT DISTINCT b.id,b.name,b.description,b.avatar_url,b.status,b.created_at,b.client_id FROM bots b LEFT JOIN workspace_bots wb ON wb.bot_id=b.id LEFT JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id AND wm.user_id=? AND wm.status='active' WHERE b.owner_id=? OR wm.user_id IS NOT NULL ORDER BY b.created_at DESC`).all(req.session.user.id,req.session.user.id);
  res.render('bots/index', { title: 'My Bots', bots, maxBots: Math.min(plan.bot_limit, env.maxBotsPerUser), plan });
});

router.get('/bots/new', async (req, res) => {
  let plan;
  try { plan = await assertCanCreateBot(req.session.user.id); }
  catch (error) { setNotice(req, 'warning', error.message); return res.redirect('/bots'); }
  const templateRows=await db.prepare("SELECT version,definition_json FROM templates WHERE status='published' ORDER BY uses_count DESC,name").all();
  const availableTemplates=templateRows.map(row=>{const template=JSON.parse(row.definition_json);template.version=template.version||row.version;return template;}).filter(template=>template.support==='ready');
  const selectedTemplate = req.query.template ? availableTemplates.find(template=>template.id===String(req.query.template)) || null : null;
  res.render('bots/create', { title: 'Create Bot', selectedTemplate, templates: availableTemplates, plan, availableFeatures:features, allCommands:definitions.map(command=>({name:command.name,description:command.description})) });
});

router.post('/bots', async (req, res) => {
  let botId;
  try {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const token = String(req.body.token || '').trim();
    const avatarUrl = String(req.body.avatar_url || '').trim();
    if (name.length < 2 || name.length > 48) throw new Error('Bot name must be between 2 and 48 characters.');
    if (description.length > 240) throw new Error('Description must be 240 characters or fewer.');
    if (token.length < 40 || token.length > 300) throw new Error('Enter a valid Discord bot token. The token is never returned to the browser.');
    if (avatarUrl) {
      let url;
      try { url = new URL(avatarUrl); } catch { throw new Error('Avatar URL is not valid.'); }
      if (url.protocol !== 'https:') throw new Error('Avatar URL must use HTTPS.');
    }
    const templateId = String(req.body.template_id || '').trim();
    let template = null;
    let selectedFeatures = features;
    let selectedCommands = definitions.map(command => command.name);
    if (templateId) {
      const templateRow = await db.prepare('SELECT status,version,definition_json FROM templates WHERE id = ?').get(templateId);
      try { template = templateRow ? JSON.parse(templateRow.definition_json) : null; } catch { template = null; }
      if(template && !template.version)template.version=templateRow.version;
      if (!template || template.support !== 'ready' || templateRow?.status !== 'published') throw new Error('The selected template is not currently installable.');
      const compatibility=validateTemplate(template,definitions.map(command=>command.name),features);
      if(!compatibility.valid)throw new Error('The selected template contains commands or modules unavailable in this runtime.');
      await assertCanUseTemplate(req.session.user.id, template);
      selectedFeatures = template.features;
      selectedCommands = template.commands;
    }
    if (req.body.features_present === '1') {
      const requested = req.body.feature_keys === undefined ? [] : (Array.isArray(req.body.feature_keys) ? req.body.feature_keys : [req.body.feature_keys]);
      if (requested.some(key => !features.includes(key))) throw new Error('An unsupported feature was selected.');
      selectedFeatures = [...new Set(requested)];
    }
    if (req.body.commands_present === '1') {
      const requested = req.body.command_names === undefined ? [] : (Array.isArray(req.body.command_names) ? req.body.command_names : [req.body.command_names]);
      const supported = definitions.map(command => command.name);
      if (requested.some(key => !supported.includes(key))) throw new Error('An unsupported command was selected.');
      selectedCommands = [...new Set(requested)].filter(name => !featureByCommand[name] || selectedFeatures.includes(featureByCommand[name]));
      if (requested.length !== selectedCommands.length) throw new Error('A command requires a feature that is currently disabled.');
    }
    const plan = await assertCanCreateBot(req.session.user.id);
    const profile = await runtime.validateToken(token);
    const encrypted = encrypt(token);
    botId = crypto.randomUUID();
    await db.withTransaction(async tx => {
      const currentCount = await tx.prepare('SELECT COUNT(*) AS n FROM bots WHERE owner_id = ?').get(req.session.user.id);
      if (Number(currentCount.n) >= Math.min(plan.bot_limit, env.maxBotsPerUser)) throw new Error(`You have reached the ${plan.name} plan bot limit.`);
      const duplicate = await tx.prepare('SELECT id FROM bots WHERE client_id = ?').get(profile.id);
      if (duplicate) throw new Error('This Discord bot is already registered on the platform.');
      await tx.prepare(`INSERT INTO bots (id, owner_id, name, description, avatar_url, client_id, encrypted_token, token_iv, token_tag)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(botId, req.session.user.id, name, description, avatarUrl || null, profile.id,
        encrypted.encrypted, encrypted.iv, encrypted.tag);
      const settings = { template: template?.id || 'complete', templateName: template?.name || 'Complete Bot', templateVersion: template?.version || null, requiredIntents: getRequiredIntents(selectedFeatures), installedAt: new Date().toISOString() };
      await tx.prepare('INSERT INTO bot_settings (bot_id, settings_json) VALUES (?, ?)').run(botId, JSON.stringify(settings));
      for (const feature of features) await tx.prepare('INSERT INTO bot_features (bot_id, feature_key, enabled) VALUES (?, ?, ?)').run(botId, feature, selectedFeatures.includes(feature) ? 1 : 0);
      for (const command of definitions) await tx.prepare('INSERT INTO bot_commands (bot_id, command_name, enabled) VALUES (?, ?, ?)').run(botId, command.name, selectedCommands.includes(command.name) ? 1 : 0);
    });
    if (template) await db.prepare('UPDATE templates SET uses_count=uses_count+1 WHERE id=?').run(template.id);
    await recordUsage(req.session.user.id, 'bot_created', 1);
    await notify(req.session.user.id, 'bot-created', 'Bot created', `${name} was added to your workspace${template ? ` from ${template.name}` : ''}.`);
    const directory = path.join(botStorage, botId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ botId, createdAt: new Date().toISOString(), template: template?.id || 'complete', templateVersion: template?.version || null, requiredIntents: getRequiredIntents(selectedFeatures) }, null, 2));
    try {
      await runtime.startBot(botId);
      setNotice(req, 'success', 'Bot created. Discord is connecting; its status will update when the Gateway is ready.');
      await notify(req.session.user.id, 'bot-starting', 'Bot is starting', `${name} is connecting to the Discord Gateway.`);
    } catch (error) {
      setNotice(req, 'warning', `Bot record created, but it could not start: ${error.message}`);
      await notify(req.session.user.id, 'bot-error', 'Bot could not start', `${name}: ${error.message}`);
    }
    res.redirect(`/bots/${botId}`);
  } catch (error) {
    if (botId) await db.prepare('DELETE FROM bots WHERE id = ? AND owner_id = ?').run(botId, req.session.user.id).catch(() => {});
    req.session.formError = error.message;
    res.redirect('/bots/new');
  }
});

router.get('/bots/:id/logs', ownedBot, async (req, res) => {
  const requestedPage = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const perPage = 50;
  const totalRow = await db.prepare('SELECT COUNT(*) AS count FROM bot_logs WHERE bot_id = ?').get(req.bot.id);
  const total = Number(totalRow.count);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(requestedPage, pages);
  const logs = await db.prepare('SELECT level, category, message, created_at FROM bot_logs WHERE bot_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(req.bot.id, perPage, (page - 1) * perPage);
  res.render('bots/logs', { title: 'Bot Logs', bot: req.bot, logs, page, pages, total });
});

router.get('/bots/:id', ownedBot, async (req, res) => {
  const bot = req.bot;
  const [featuresRows, commandRows, guilds, logs, shopItems, levelRewards] = await Promise.all([
    db.prepare('SELECT feature_key, enabled FROM bot_features WHERE bot_id = ? ORDER BY feature_key').all(bot.id),
    db.prepare('SELECT command_name, enabled FROM bot_commands WHERE bot_id = ? ORDER BY command_name').all(bot.id),
    db.prepare('SELECT guild_id, guild_name, member_count, updated_at FROM bot_guilds WHERE bot_id = ? ORDER BY guild_name').all(bot.id),
    db.prepare('SELECT level, category, message, created_at FROM bot_logs WHERE bot_id = ? ORDER BY id DESC LIMIT 12').all(bot.id),
    db.prepare('SELECT id, guild_id, name, price, reward_role_id, stock, enabled FROM economy_shop_items WHERE bot_id = ? ORDER BY created_at DESC LIMIT 20').all(bot.id),
    db.prepare('SELECT guild_id, level, role_id FROM level_rewards WHERE bot_id = ? ORDER BY guild_id, level LIMIT 30').all(bot.id)
  ]);
  res.render('bots/detail', { title: bot.name, bot, featuresRows, commandRows, guilds, logs, shopItems, levelRewards });
});

router.post('/bots/:id/control/:action', ownedBot, async (req, res) => {
  try {
    const action = req.params.action;
    if (action === 'start') await runtime.startBot(req.bot.id);
    else if (action === 'stop') await runtime.stopBot(req.bot.id);
    else if (action === 'restart') await runtime.restartBot(req.bot.id);
    else throw new Error('Unknown bot action.');
    setNotice(req, 'success', `Bot ${action} request completed.`);
  } catch (error) { setNotice(req, 'error', error.message); }
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/update', ownedBot, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const avatarUrl = String(req.body.avatar_url || '').trim();
  if (name.length < 2 || name.length > 48 || description.length > 240) {
    setNotice(req, 'error', 'Check the name and description lengths.'); return res.redirect(`/bots/${req.bot.id}`);
  }
  if (avatarUrl) {
    try { if (new URL(avatarUrl).protocol !== 'https:') throw new Error(); }
    catch { setNotice(req, 'error', 'Avatar URL must be a valid HTTPS URL.'); return res.redirect(`/bots/${req.bot.id}`); }
  }
  await db.prepare('UPDATE bots SET name = ?, description = ?, avatar_url = ? WHERE id = ?').run(name, description, avatarUrl || null, req.bot.id);
  runtime.log(req.bot.id, 'info', 'settings', 'Bot profile settings updated.');
  setNotice(req, 'success', 'Bot settings updated.');
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/auto-start', ownedBot, async (req, res) => {
  const enabled = req.body.enabled === '1' ? 1 : 0;
  await db.prepare('UPDATE bots SET auto_start = ? WHERE id = ?').run(enabled, req.bot.id);
  setNotice(req, 'success', `Automatic restart ${enabled ? 'enabled' : 'disabled'}.`);
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/features/:feature', ownedBot, async (req, res) => {
  const feature = req.params.feature;
  const enabled = req.body.enabled === '1' ? 1 : 0;
  if (!features.includes(feature)) return res.status(400).send('Unknown feature.');
  await db.prepare('UPDATE bot_features SET enabled = ? WHERE bot_id = ? AND feature_key = ?').run(enabled, req.bot.id, feature);
  if (!enabled) {
    const names = definitions.filter(command => featureByCommand[command.name] === feature).map(command => command.name);
    for (const name of names) await db.prepare('UPDATE bot_commands SET enabled=0 WHERE bot_id=? AND command_name=?').run(req.bot.id, name);
  }
  runtime.log(req.bot.id, 'info', 'settings', `Feature ${feature} ${enabled ? 'enabled' : 'disabled'}.`);
  if (runtime.runtimeClients.has(req.bot.id)) {
    try {
      await runtime.restartBot(req.bot.id);
      await runtime.syncBotCommands(req.bot.id);
      setNotice(req, 'success', `${feature} ${enabled ? 'enabled' : 'disabled'}. Bot restarted and enabled slash commands synchronized.`);
    } catch (error) {
      setNotice(req, 'warning', `${feature} saved, but the bot could not restart or synchronize: ${error.message}`);
    }
  } else {
    setNotice(req, 'success', `${feature} ${enabled ? 'enabled' : 'disabled'}. Start the bot to apply Gateway intent changes.`);
  }
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/commands/:command/toggle', ownedBot, async (req, res) => {
  const command = req.params.command;
  const current = await db.prepare('SELECT enabled FROM bot_commands WHERE bot_id = ? AND command_name = ?').get(req.bot.id, command);
  if (!current) return res.status(404).send('Command not found.');
  const enabled = current.enabled ? 0 : 1;
  await db.prepare('UPDATE bot_commands SET enabled = ? WHERE bot_id = ? AND command_name = ?').run(enabled, req.bot.id, command);
  runtime.log(req.bot.id, 'info', 'commands', `Command /${command} ${enabled ? 'enabled' : 'disabled'}.`);
  try { await runtime.syncBotCommands(req.bot.id); setNotice(req, 'success', `/${command} updated and synchronized.`); }
  catch (error) { setNotice(req, 'warning', `/${command} updated in settings. Synchronization needs the bot online: ${error.message}`); }
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/sync-commands', ownedBot, async (req, res) => {
  try { await runtime.syncBotCommands(req.bot.id); setNotice(req, 'success', 'Slash commands synchronized with Discord.'); }
  catch (error) { setNotice(req, 'error', error.message); }
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/shop-items', ownedBot, async (req, res) => {
  const guildId = String(req.body.guild_id || '').trim();
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const price = Number(req.body.price);
  const roleId = String(req.body.reward_role_id || '').trim();
  const stock = req.body.stock === '' || req.body.stock === undefined ? -1 : Number(req.body.stock);
  if (!/^\d{15,22}$/.test(guildId) || name.length < 2 || name.length > 50 || description.length > 160 || !Number.isSafeInteger(price) || price < 1 || price > 100000000 || !Number.isInteger(stock) || stock < -1 || (roleId && !/^\d{15,22}$/.test(roleId))) {
    setNotice(req, 'error', 'Invalid shop item. Check the server ID, item name, price, stock and optional role ID.');
    return res.redirect(`/bots/${req.bot.id}`);
  }
  const itemId = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO economy_shop_items (id, bot_id, guild_id, name, description, price, reward_role_id, stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, req.bot.id, guildId, name, description, price, roleId || null, stock);
    setNotice(req, 'success', 'Shop item created. Members can purchase it with /shop and /buy.');
  } catch (error) { setNotice(req, 'error', error.message.includes('UNIQUE') ? 'An item with this name already exists in that server.' : error.message); }
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/shop-items/:itemId/toggle', ownedBot, async (req, res) => {
  const item = await db.prepare('SELECT enabled FROM economy_shop_items WHERE id = ? AND bot_id = ?').get(req.params.itemId, req.bot.id);
  if (!item) return res.status(404).send('Shop item not found.');
  await db.prepare('UPDATE economy_shop_items SET enabled = ? WHERE id = ? AND bot_id = ?').run(item.enabled ? 0 : 1, req.params.itemId, req.bot.id);
  setNotice(req, 'success', 'Shop item status updated.');
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/level-rewards', ownedBot, async (req, res) => {
  const guildId = String(req.body.guild_id || '').trim();
  const roleId = String(req.body.role_id || '').trim();
  const level = Number(req.body.level);
  if (!/^\d{15,22}$/.test(guildId) || !/^\d{15,22}$/.test(roleId) || !Number.isInteger(level) || level < 1 || level > 1000) {
    setNotice(req, 'error', 'Enter a valid server ID, role ID and level.');
    return res.redirect(`/bots/${req.bot.id}`);
  }
  try {
    await db.prepare(`INSERT INTO level_rewards (bot_id, guild_id, level, role_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id, guild_id, level) DO UPDATE SET role_id=excluded.role_id`).run(req.bot.id, guildId, level, roleId);
    setNotice(req, 'success', `Level ${level} role reward saved.`);
  } catch (error) { setNotice(req, 'error', error.message); }
  res.redirect(`/bots/${req.bot.id}`);
});

router.post('/bots/:id/delete', ownedBot, async (req, res) => {
  if (req.bot.access_role !== 'owner') return res.status(403).render('errors/error',{title:'Owner permission required',message:'Only the bot owner can delete this bot.'});
  await runtime.stopBot(req.bot.id).catch(() => {});
  await db.prepare('DELETE FROM bots WHERE id = ? AND owner_id = ?').run(req.bot.id, req.session.user.id);
  fs.rmSync(path.join(botStorage, req.bot.id), { recursive: true, force: true });
  setNotice(req, 'success', 'Bot and its platform data were deleted. The Discord application itself remains in your Developer Portal.');
  res.redirect('/bots');
});

module.exports = router;
