'use strict';

const crypto = require('node:crypto');
const {
  Client,
  AttachmentBuilder,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');
const db = require('../config/database');
const { env } = require('../config/env');
const { decrypt } = require('../services/EncryptionService');
const { definitions, featureByCommand } = require('./commands');
const { getRequiredIntents } = require('../templates/catalog');
const { assertCanRunBot, getUserPlan, recordUsage } = require('../services/PlanService');
const { notify } = require('../services/SaasService');
const advancedModules = require('./advancedModules');

const runtimeClients = new Map();
let startAdmissionQueue = Promise.resolve();

async function withStartAdmission(task) {
  let release;
  const previous = startAdmissionQueue;
  startAdmissionQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await task(); }
  finally { release(); }
}
const spamCache = new Map();
const joinCache = new Map();
const activeQuizzes = new Map();
const quizBank = [
  { q: 'Which language runs natively in web browsers?', options: ['JavaScript', 'Python', 'C++', 'Rust'], answer: 0 },
  { q: 'What does HTML stand for?', options: ['HyperText Markup Language', 'High Transfer Machine Link', 'Home Tool Markup Language', 'Hyperlink Text Mode'], answer: 0 },
  { q: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], answer: 1 },
  { q: 'How many sides does a hexagon have?', options: ['Five', 'Six', 'Seven', 'Eight'], answer: 1 },
  { q: 'Which data format is commonly used for JSON APIs?', options: ['Structured text', 'Binary audio', 'Vector graphics', 'Video stream'], answer: 0 }
];

function log(botId, level, category, message) {
  const safeMessage = String(message).replace(/\b[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{5,}\.[A-Za-z0-9._-]{10,}\b/g, '[REDACTED_TOKEN]').slice(0, 1500);
  (async () => {
    const bot = await db.prepare('SELECT owner_id FROM bots WHERE id=?').get(botId);
    const plan = bot ? await getUserPlan(bot.owner_id) : null;
    const retention = Math.max(100, Math.min(env.maxLogRowsPerBot, plan?.log_limit || env.maxLogRowsPerBot));
    await db.prepare('INSERT INTO bot_logs (bot_id, level, category, message) VALUES (?, ?, ?, ?)').run(botId, level, category, safeMessage);
    await db.prepare(`DELETE FROM bot_logs WHERE bot_id = ? AND id NOT IN (
      SELECT id FROM bot_logs WHERE bot_id = ? ORDER BY id DESC LIMIT ?
    )`).run(botId, botId, retention);
  })().catch(error => console.error('[Bot log]', error.message));
}

async function featureEnabled(botId, key) {
  const row = await db.prepare('SELECT enabled FROM bot_features WHERE bot_id = ? AND feature_key = ?').get(botId, key);
  return row ? Number(row.enabled) === 1 : true;
}

async function getGuildSettings(botId, guildId) {
  let row = await db.prepare('SELECT * FROM guild_settings WHERE bot_id = ? AND guild_id = ?').get(botId, guildId);
  if (!row) {
    await db.prepare('INSERT INTO guild_settings (bot_id, guild_id) VALUES (?, ?) ON CONFLICT(bot_id, guild_id) DO NOTHING').run(botId, guildId);
    row = await db.prepare('SELECT * FROM guild_settings WHERE bot_id = ? AND guild_id = ?').get(botId, guildId);
  }
  return row;
}

async function sendGuildLog(botId, guild, title, description, color = 0x7c5cff) {
  if (!await featureEnabled(botId, 'logging')) return;
  const config = await getGuildSettings(botId, guild.id);
  if (!config.log_channel_id) return;
  const channel = guild.channels.cache.get(config.log_channel_id) || await guild.channels.fetch(config.log_channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(String(description).slice(0, 3900)).setTimestamp()] }).catch(() => {});
}

async function syncCommands(botId, client) {
  for (const command of definitions) await db.prepare('INSERT INTO bot_commands (bot_id, command_name, enabled) VALUES (?, ?, 1) ON CONFLICT(bot_id, command_name) DO NOTHING').run(botId, command.name);
  const enabledRows = await db.prepare('SELECT command_name FROM bot_commands WHERE bot_id = ? AND enabled = 1').all(botId);
  const enabled = new Set(enabledRows.map(row => row.command_name));
  const body = definitions.filter(item => enabled.has(item.name));
  const tokenRecord = await db.prepare('SELECT encrypted_token AS encrypted, token_iv AS iv, token_tag AS tag FROM bots WHERE id = ?').get(botId);
  const rest = new REST({ version: '10' }).setToken(decrypt(tokenRecord));
  await rest.put(Routes.applicationCommands(client.user.id), { body });
  log(botId, 'info', 'commands', `Synchronized ${body.length} application commands.`);
}

async function executeCommand(botId, client, interaction) {
  const name = interaction.commandName;
  if (!interaction.guild && !['ping', 'help', 'botinfo', 'invite', 'avatar', 'userinfo'].includes(name)) {
    return interaction.reply({ content: 'This command can only be used inside a Discord server.', ephemeral: true });
  }
  const feature = featureByCommand[name];
  if (feature && !await featureEnabled(botId, feature)) {
    return interaction.reply({ content: `The **${feature}** feature is currently disabled for this bot.`, ephemeral: true });
  }
  const guild = interaction.guild;
  const user = interaction.user;
  const owner = await db.prepare('SELECT owner_id FROM bots WHERE id=?').get(botId);
  if (owner) await recordUsage(owner.owner_id, 'slash_commands', 1).catch(() => {});
  const reason = interaction.options.getString('reason') || 'No reason provided';

  try {
    switch (name) {
      case 'ping':
        return interaction.reply({ content: `Pong! Gateway: ${Math.max(0, Math.round(client.ws.ping))}ms`, ephemeral: true });
      case 'help': {
        const commandRows = await db.prepare('SELECT command_name FROM bot_commands WHERE bot_id = ? AND enabled = 1').all(botId);
        const enabledNames = new Set(commandRows.map(row => row.command_name));
        const list = definitions.filter(command => enabledNames.has(command.name)).map(command => `**/${command.name}** — ${command.description}`).join('\n');
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(`${client.user.username} commands`).setDescription(list.slice(0, 4000))], ephemeral: true });
      }
      case 'botinfo':
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(client.user.username).setThumbnail(client.user.displayAvatarURL()).addFields(
          { name: 'Servers', value: String(client.guilds.cache.size), inline: true },
          { name: 'Ping', value: `${Math.round(client.ws.ping)}ms`, inline: true },
          { name: 'Library', value: 'discord.js v14', inline: true }
        ).setTimestamp()] });
      case 'invite': {
        const url = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=1099511753814`;
        return interaction.reply({ content: `Invite this bot: ${url}`, ephemeral: true });
      }
      case 'avatar': {
        const target = interaction.options.getUser('user') || user;
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(`${target.username}'s avatar`).setImage(target.displayAvatarURL({ size: 1024 }))] });
      }
      case 'userinfo': {
        const target = interaction.options.getUser('user') || user;
        const member = guild ? await guild.members.fetch(target.id).catch(() => null) : null;
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(target.username)
          .setThumbnail(target.displayAvatarURL()).addFields(
            { name: 'User ID', value: target.id, inline: true },
            { name: 'Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
            { name: 'Joined', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'Not available', inline: true }
          )] });
      }
      case 'serverinfo':
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(guild.name).setThumbnail(guild.iconURL())
          .addFields({ name: 'Members', value: String(guild.memberCount), inline: true }, { name: 'Channels', value: String(guild.channels.cache.size), inline: true }, { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true })] });
      case 'ban': {
        const target = interaction.options.getUser('user', true);
        await guild.members.ban(target.id, { reason });
        log(botId, 'info', 'moderation', `${user.tag} banned ${target.tag}: ${reason}`);
        await sendGuildLog(botId, guild, 'Member banned', `${target.tag} was banned by ${user.tag}.\nReason: ${reason}`, 0xe05252);
        return interaction.reply({ content: `Banned **${target.tag}**.`, ephemeral: true });
      }
      case 'kick': {
        const target = interaction.options.getUser('user', true);
        const member = await guild.members.fetch(target.id);
        await member.kick(reason);
        log(botId, 'info', 'moderation', `${user.tag} kicked ${target.tag}: ${reason}`);
        await sendGuildLog(botId, guild, 'Member kicked', `${target.tag} was kicked by ${user.tag}.\nReason: ${reason}`, 0xe08a52);
        return interaction.reply({ content: `Kicked **${target.tag}**.`, ephemeral: true });
      }
      case 'timeout': {
        const target = interaction.options.getUser('user', true);
        const minutes = interaction.options.getInteger('minutes', true);
        const member = await guild.members.fetch(target.id);
        await member.timeout(minutes * 60000, reason);
        log(botId, 'info', 'moderation', `${user.tag} timed out ${target.tag} for ${minutes} minutes.`);
        return interaction.reply({ content: `Timed out **${target.tag}** for ${minutes} minutes.`, ephemeral: true });
      }
      case 'unban': {
        const targetId = interaction.options.getString('user_id', true).trim();
        if (!/^\d{15,22}$/.test(targetId)) return interaction.reply({ content: 'Enter a valid Discord user ID.', ephemeral: true });
        await guild.members.unban(targetId, interaction.options.getString('reason') || `Unban by ${user.tag}`);
        log(botId, 'info', 'moderation', `${user.tag} unbanned user ${targetId}.`);
        return interaction.reply({ content: `Unbanned user <@${targetId}>.`, ephemeral: true });
      }
      case 'untimeout': {
        const target = interaction.options.getUser('user', true);
        const member = await guild.members.fetch(target.id);
        await member.timeout(null, `Timeout removed by ${user.tag}`);
        return interaction.reply({ content: `Removed timeout for **${target.tag}**.`, ephemeral: true });
      }
      case 'warn': {
        const target = interaction.options.getUser('user', true);
        const why = interaction.options.getString('reason', true);
        const result = await db.prepare('INSERT INTO warnings (bot_id, guild_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?, ?) RETURNING id').run(botId, guild.id, target.id, user.id, why.slice(0, 500));
        log(botId, 'info', 'moderation', `${user.tag} warned ${target.tag}: ${why}`);
        await sendGuildLog(botId, guild, 'Member warned', `${target.tag} was warned by ${user.tag}.\nReason: ${why}`, 0xe0b452);
        return interaction.reply({ content: `Warning #${result.lastInsertRowid} saved for **${target.tag}**.`, ephemeral: true });
      }
      case 'warnings':
      case 'modlogs': {
        const target = interaction.options.getUser('user', true);
        const rows = await db.prepare('SELECT id, reason, moderator_id, created_at FROM warnings WHERE bot_id = ? AND guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10').all(botId, guild.id, target.id);
        const description = rows.length ? rows.map(row => `**#${row.id}** • <t:${Math.floor(new Date(`${row.created_at}Z`).getTime() / 1000)}:R>\n${row.reason}\nModerator: <@${row.moderator_id}>`).join('\n\n') : 'No warnings recorded.';
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(`${target.username} moderation history`).setDescription(description.slice(0, 4000))], ephemeral: true });
      }
      case 'clear': {
        const amount = interaction.options.getInteger('amount', true);
        const deleted = await interaction.channel.bulkDelete(amount, true);
        return interaction.reply({ content: `Deleted ${deleted.size} recent messages. Discord does not bulk-delete messages older than 14 days.`, ephemeral: true });
      }
      case 'lock':
      case 'unlock': {
        const value = name === 'lock' ? false : null;
        await interaction.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: value });
        return interaction.reply({ content: name === 'lock' ? 'Channel locked.' : 'Channel unlocked.' });
      }
      case 'slowmode': {
        const seconds = interaction.options.getInteger('seconds', true);
        await interaction.channel.setRateLimitPerUser(seconds);
        return interaction.reply({ content: `Slowmode set to ${seconds} second(s).` });
      }
      case 'set-welcome': {
        const channel = interaction.options.getChannel('channel', true);
        const message = interaction.options.getString('message') || 'Welcome {user} to **{server}**!';
        const previous = await getGuildSettings(botId, guild.id);
        const leaveMessage = interaction.options.getString('leave_message') || previous.leave_message;
        const imageUrl = interaction.options.getString('image_url');
        if (imageUrl) { let parsed; try { parsed = new URL(imageUrl); } catch { return interaction.reply({ content: 'The image URL is invalid.', ephemeral: true }); } if (parsed.protocol !== 'https:') return interaction.reply({ content: 'The welcome image must use HTTPS.', ephemeral: true }); }
        await db.prepare(`INSERT INTO guild_settings (bot_id, guild_id, welcome_channel_id, welcome_message, leave_message, welcome_image_url) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(bot_id, guild_id) DO UPDATE SET welcome_channel_id=excluded.welcome_channel_id, welcome_message=excluded.welcome_message, leave_message=excluded.leave_message, welcome_image_url=COALESCE(excluded.welcome_image_url, guild_settings.welcome_image_url)`).run(botId, guild.id, channel.id, message.slice(0, 1000), leaveMessage.slice(0, 1000), imageUrl || null);
        return interaction.reply({ content: `Welcome and leave messages configured for ${channel}.`, ephemeral: true });
      }
      case 'set-logs': {
        const channel = interaction.options.getChannel('channel', true);
        await db.prepare(`INSERT INTO guild_settings (bot_id, guild_id, log_channel_id) VALUES (?, ?, ?)
          ON CONFLICT(bot_id, guild_id) DO UPDATE SET log_channel_id=excluded.log_channel_id`).run(botId, guild.id, channel.id);
        return interaction.reply({ content: `Moderation and event logs will be sent to ${channel}.`, ephemeral: true });
      }
      case 'ticket-config': {
        const role = interaction.options.getRole('staff_role', true);
        await db.prepare(`INSERT INTO guild_settings (bot_id, guild_id, ticket_staff_role_id) VALUES (?, ?, ?)
          ON CONFLICT(bot_id, guild_id) DO UPDATE SET ticket_staff_role_id=excluded.ticket_staff_role_id`).run(botId, guild.id, role.id);
        return interaction.reply({ content: `Ticket staff role configured: ${role}.`, ephemeral: true });
      }
      case 'ticket': {
        if (!await featureEnabled(botId, 'tickets')) return interaction.reply({ content: 'Tickets are disabled.', ephemeral: true });
        const topic = interaction.options.getString('topic') || 'Support request';
        const guildConfig = await getGuildSettings(botId, guild.id);
        const safeName = `ticket-${user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12) || 'member'}`;
        const channel = await guild.channels.create({
          name: safeName,
          type: ChannelType.GuildText,
          topic: `Opened by ${user.tag} (${user.id}) • ${topic.slice(0, 500)}`,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
            ...(guildConfig.ticket_staff_role_id ? [{ id: guildConfig.ticket_staff_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : [])
          ]
        });
        const closeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger));
        await channel.send({ content: `${user} opened a ticket.\n**Topic:** ${topic}`, components: [closeRow] });
        return interaction.reply({ content: `Your private ticket is ready: ${channel}`, ephemeral: true });
      }
      case 'giveaway': {
        const prize = interaction.options.getString('prize', true).slice(0, 180);
        const minutes = interaction.options.getInteger('minutes', true);
        const winners = interaction.options.getInteger('winners') || 1;
        const giveawayId = crypto.randomUUID();
        const endsAt = Date.now() + minutes * 60000;
        const join = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`giveaway:join:${giveawayId}`).setLabel('Enter giveaway').setStyle(ButtonStyle.Success));
        const post = await interaction.channel.send({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle('🎉 Giveaway').setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R>\n\nPress the button to enter. Free entry.`)], components: [join] });
        await db.prepare('INSERT INTO giveaways (id, bot_id, guild_id, channel_id, message_id, prize, winner_count, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(giveawayId, botId, guild.id, interaction.channelId, post.id, prize, winners, endsAt);
        scheduleGiveaway(botId, client, giveawayId, Math.max(1000, endsAt - Date.now()));
        return interaction.reply({ content: 'Giveaway created.', ephemeral: true });
      }
      case 'giveaway-reroll': {
        const messageId = interaction.options.getString('message_id', true).trim();
        const giveaway = await db.prepare('SELECT * FROM giveaways WHERE bot_id = ? AND guild_id = ? AND message_id = ? AND ended = 1').get(botId, guild.id, messageId);
        if (!giveaway) return interaction.reply({ content: 'No ended giveaway was found for that message ID.', ephemeral: true });
        const entries = (await db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(giveaway.id)).map(row => row.user_id);
        if (!entries.length) return interaction.reply({ content: 'This giveaway had no entries to reroll.', ephemeral: true });
        const winner = entries[crypto.randomInt(entries.length)];
        return interaction.reply({ content: `New winner for **${giveaway.prize}**: <@${winner}>` });
      }
      case 'automod-config': {
        const config = await getGuildSettings(botId, guild.id);
        const automod = JSON.parse(config.automod_json || '{}');
        for (const [option, key] of [['anti_spam', 'antiSpam'], ['anti_links', 'antiLinks'], ['anti_mass_mention', 'antiMassMention'], ['anti_caps', 'antiCaps'], ['anti_raid', 'antiRaid']]) {
          const value = interaction.options.getBoolean(option);
          if (value !== null) automod[key] = value;
        }
        const words = interaction.options.getString('blocked_words');
        if (words !== null) automod.badWords = words.split(',').map(word => word.trim()).filter(Boolean).slice(0, 30).map(word => word.slice(0, 40));
        await db.prepare('UPDATE guild_settings SET automod_json = ? WHERE bot_id = ? AND guild_id = ?').run(JSON.stringify(automod), botId, guild.id);
        return interaction.reply({ content: `AutoMod updated: spam ${automod.antiSpam === false ? 'off' : 'on'}, links ${automod.antiLinks ? 'on' : 'off'}, mass mentions ${automod.antiMassMention === false ? 'off' : 'on'}, caps ${automod.antiCaps ? 'on' : 'off'}, raid alerts ${automod.antiRaid === false ? 'off' : 'on'}, blocked words ${automod.badWords?.length || 0}.`, ephemeral: true });
      }
      case 'set-level-reward': {
        const level = interaction.options.getInteger('level', true);
        const role = interaction.options.getRole('role', true);
        if (role.managed || role.id === guild.id) return interaction.reply({ content: 'Choose a normal server role that the bot can assign.', ephemeral: true });
        const me = guild.members.me || await guild.members.fetchMe();
        if (role.position >= me.roles.highest.position) return interaction.reply({ content: 'Move the bot role above the reward role first.', ephemeral: true });
        await db.prepare(`INSERT INTO level_rewards (bot_id, guild_id, level, role_id) VALUES (?, ?, ?, ?)
          ON CONFLICT(bot_id, guild_id, level) DO UPDATE SET role_id=excluded.role_id`).run(botId, guild.id, level, role.id);
        return interaction.reply({ content: `Level ${level} reward saved: ${role}.`, ephemeral: true });
      }
      case 'shop': {
        const items = await db.prepare('SELECT name, description, price, reward_role_id, stock FROM economy_shop_items WHERE bot_id = ? AND guild_id = ? AND enabled = 1 ORDER BY price ASC LIMIT 20').all(botId, guild.id);
        const description = items.length ? items.map(item => `**${item.name}** — ${item.price} coins${item.stock >= 0 ? ` · Stock: ${item.stock}` : ''}\n${item.description || 'No description'}${item.reward_role_id ? ` · Role reward: <@&${item.reward_role_id}>` : ''}`).join('\n\n') : 'The shop is empty. The server owner can add items from the bot dashboard.';
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle('Coin Shop').setDescription(description.slice(0, 3900)).setFooter({ text: 'Use /buy with the exact item name.' })], ephemeral: true });
      }
      case 'buy': {
        const itemName = interaction.options.getString('item', true).trim();
        const member = await guild.members.fetch(user.id);
        const item = await db.prepare('SELECT * FROM economy_shop_items WHERE bot_id = ? AND guild_id = ? AND lower(name) = lower(?) AND enabled = 1').get(botId, guild.id, itemName);
        if (!item) return interaction.reply({ content: 'That shop item does not exist or is disabled. Use /shop to see available items.', ephemeral: true });
        let rewardRole = null;
        if (item.reward_role_id) {
          rewardRole = await guild.roles.fetch(item.reward_role_id).catch(() => null);
          const me = guild.members.me || await guild.members.fetchMe();
          if (!rewardRole || rewardRole.managed || rewardRole.position >= me.roles.highest.position || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return interaction.reply({ content: 'The configured reward role is unavailable or cannot be assigned by this bot. Ask a server administrator to review role hierarchy and permissions.', ephemeral: true });
          }
          if (member.roles.cache.has(rewardRole.id)) return interaction.reply({ content: 'You already have this role reward.', ephemeral: true });
        }
        let purchaseError = null;
        let purchaseId = null;
        await db.withTransaction(async tx => {
          const currentItem = await tx.prepare('SELECT stock, enabled FROM economy_shop_items WHERE id = ? AND bot_id = ?').get(item.id, botId);
          if (!currentItem || !currentItem.enabled || (Number(currentItem.stock) === 0)) { purchaseError = 'This item is out of stock or unavailable.'; return; }
          const debit = await tx.prepare('UPDATE economy SET coins = coins - ? WHERE bot_id = ? AND guild_id = ? AND user_id = ? AND coins >= ?').run(item.price, botId, guild.id, user.id, item.price);
          if (!debit.changes) { purchaseError = 'You do not have enough coins. Claim /daily or earn coins from activities.'; return; }
          if (Number(currentItem.stock) > 0) {
            const stockResult = await tx.prepare('UPDATE economy_shop_items SET stock = stock - 1 WHERE id = ? AND stock > 0').run(item.id);
            if (!stockResult.changes) { await tx.prepare('UPDATE economy SET coins = coins + ? WHERE bot_id = ? AND guild_id = ? AND user_id = ?').run(item.price, botId, guild.id, user.id); purchaseError = 'This item just went out of stock. Your coins were not charged.'; return; }
          }
          const purchase = await tx.prepare('INSERT INTO economy_purchases (item_id, bot_id, guild_id, user_id, price) VALUES (?, ?, ?, ?, ?) RETURNING id').get(item.id, botId, guild.id, user.id, item.price);
          purchaseId = purchase?.id;
        });
        if (purchaseError) return interaction.reply({ content: purchaseError, ephemeral: true });
        if (rewardRole) {
          try { await member.roles.add(rewardRole, `Coin shop purchase: ${item.name}`); }
          catch (error) {
            await db.withTransaction(async tx => {
              await tx.prepare('UPDATE economy SET coins = coins + ? WHERE bot_id = ? AND guild_id = ? AND user_id = ?').run(item.price, botId, guild.id, user.id);
              await tx.prepare('UPDATE economy_shop_items SET stock = stock + 1 WHERE id = ? AND stock >= 0').run(item.id);
              if (purchaseId !== null) await tx.prepare('DELETE FROM economy_purchases WHERE id = ?').run(purchaseId);
            });
            return interaction.reply({ content: 'The role could not be assigned, so the purchase was refunded. Check the bot role hierarchy and permissions.', ephemeral: true });
          }
        }
        return interaction.reply({ content: `Purchase complete: **${item.name}** for **${item.price} coins**.${rewardRole ? ` Reward role granted: ${rewardRole}.` : ''}`, ephemeral: true });
      }
      case 'rank': {
        const target = interaction.options.getUser('user') || user;
        const row = await db.prepare('SELECT xp, level FROM levels WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(botId, guild.id, target.id) || { xp: 0, level: 0 };
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(`${target.username}'s rank`).addFields({ name: 'Level', value: String(row.level), inline: true }, { name: 'XP', value: String(row.xp), inline: true }, { name: 'Next level', value: String((row.level + 1) * 100 - row.xp), inline: true })] });
      }
      case 'leaderboard': {
        const rows = await db.prepare('SELECT user_id, xp, level FROM levels WHERE bot_id = ? AND guild_id = ? ORDER BY xp DESC LIMIT 10').all(botId, guild.id);
        const desc = rows.length ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — Level ${r.level} (${r.xp} XP)`).join('\n') : 'No XP records yet.';
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle('XP Leaderboard').setDescription(desc)] });
      }
      case 'daily': {
        const now = Date.now();
        const claimed = await db.prepare(`INSERT INTO economy (bot_id, guild_id, user_id, coins, last_daily_at) VALUES (?, ?, ?, 100, ?)
          ON CONFLICT(bot_id, guild_id, user_id) DO UPDATE SET coins=economy.coins+100, last_daily_at=excluded.last_daily_at
          WHERE economy.last_daily_at <= ? RETURNING coins, last_daily_at`).get(botId, guild.id, user.id, now, now - 86400000);
        if (!claimed) {
          const current = await db.prepare('SELECT last_daily_at FROM economy WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(botId, guild.id, user.id);
          const left = Math.max(1, Math.ceil((86400000 - (now - Number(current?.last_daily_at || now))) / 3600000));
          return interaction.reply({ content: `You already claimed today's reward. Try again in about ${left} hour(s).`, ephemeral: true });
        }
        return interaction.reply({ content: 'Daily reward claimed: **100 coins**.' });
      }
      case 'balance': {
        const row = await db.prepare('SELECT coins FROM economy WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(botId, guild.id, user.id);
        return interaction.reply({ content: `Your balance: **${row?.coins || 0} coins**.` , ephemeral: true });
      }
      case 'inventory': {
        const items = await db.prepare(`SELECT s.name, COUNT(p.id) AS quantity, MAX(p.id) AS latest
          FROM economy_purchases p JOIN economy_shop_items s ON s.id = p.item_id
          WHERE p.bot_id = ? AND p.guild_id = ? AND p.user_id = ?
          GROUP BY s.id, s.name ORDER BY latest DESC LIMIT 15`).all(botId, guild.id, user.id);
        const description = items.length ? items.map(item => `**${item.name}** × ${item.quantity}`).join('\n') : 'Your virtual inventory is empty. Browse items with /shop.';
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(`${user.username}'s inventory`).setDescription(description)], ephemeral: true });
      }
      case 'richest': {
        const leaders = await db.prepare('SELECT user_id, coins FROM economy WHERE bot_id = ? AND guild_id = ? ORDER BY coins DESC LIMIT 10').all(botId, guild.id);
        const description = leaders.length ? leaders.map((entry, index) => `**${index + 1}.** <@${entry.user_id}> — ${entry.coins} coins`).join('\n') : 'No virtual coin balances have been recorded yet.';
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle('Virtual coin leaderboard').setDescription(description)] });
      }
      case 'quiz': {
        const question = quizBank[Math.floor(Math.random() * quizBank.length)];
        const quizId = crypto.randomUUID();
        activeQuizzes.set(quizId, { botId, userId: user.id, guildId: guild.id, answer: question.answer, expiresAt: Date.now() + 120000 });
        if (activeQuizzes.size > 5000) {
          for (const [id, quiz] of activeQuizzes) if (quiz.expiresAt <= Date.now()) activeQuizzes.delete(id);
        }
        const row = new ActionRowBuilder().addComponents(question.options.map((label, index) => new ButtonBuilder().setCustomId(`quiz:${quizId}:${index}`).setLabel(label).setStyle(ButtonStyle.Secondary)));
        await interaction.reply({ content: `**Knowledge quiz**\n${question.q}\n\nCorrect answer rewards 25 coins.`, components: [row], ephemeral: true });
        return;
      }
      case 'poll': {
        const question = interaction.options.getString('question', true).slice(0, 900);
        const message = await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle('📊 Community poll').setDescription(question)], fetchReply: true });
        await message.react('👍').catch(() => {});
        await message.react('👎').catch(() => {});
        return;
      }
      case 'embed': {
        const title = interaction.options.getString('title', true).slice(0, 240);
        const description = interaction.options.getString('description', true).slice(0, 3500);
        await interaction.channel.send({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle(title).setDescription(description)] });
        return interaction.reply({ content: 'Embed posted.', ephemeral: true });
      }
      default: {
        const handled = await advancedModules.executeAdvancedCommand(botId, client, interaction, log);
        if (handled !== false) return handled;
        return interaction.reply({ content: 'This command is not implemented in the current runtime.', ephemeral: true });
      }
    }
  } catch (error) {
    log(botId, 'error', 'command', `/${name} failed: ${error.message}`);
    const content = 'The command failed. Check bot permissions and make sure the target role is below the bot role.';
    if (interaction.deferred || interaction.replied) return interaction.followUp({ content, ephemeral: true }).catch(() => {});
    return interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
}

function scheduleGiveaway(botId, client, giveawayId, delay) {
  const timer = setTimeout(async () => {
    try {
      const giveaway = await db.prepare('SELECT * FROM giveaways WHERE id = ? AND ended = 0').get(giveawayId);
      if (!giveaway) return;
      const entries = (await db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(giveawayId)).map(row => row.user_id);
      const selected = [];
      while (entries.length && selected.length < giveaway.winner_count) {
        const index = crypto.randomInt(entries.length);
        selected.push(entries.splice(index, 1)[0]);
      }
      await db.prepare('UPDATE giveaways SET ended = 1 WHERE id = ?').run(giveawayId);
      const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send({ embeds: [new EmbedBuilder().setColor(0x7c5cff).setTitle('Giveaway ended').setDescription(
          selected.length ? `**Prize:** ${giveaway.prize}\n**Winner(s):** ${selected.map(id => `<@${id}>`).join(', ')}` : `**Prize:** ${giveaway.prize}\nNo entries were received.`
        )] });
      }
      log(botId, 'info', 'giveaway', `Giveaway ${giveawayId} ended with ${selected.length} winner(s).`);
    } catch (error) { log(botId, 'error', 'giveaway', `Giveaway end failed: ${error.message}`); }
  }, Math.min(delay, 2147480000));
  timer.unref?.();
}

function registerEvents(botId, client) {
  advancedModules.registerAdvancedEvents(botId, client, log).catch(error => log(botId, 'error', 'modules', `Advanced module registration failed: ${error.message}`));
  client.once('ready', async () => {
    await db.prepare("UPDATE bots SET status = 'online', client_id = ?, last_started_at = CURRENT_TIMESTAMP WHERE id = ?").run(client.user.id, botId);
    const owner = await db.prepare('SELECT owner_id,name FROM bots WHERE id=?').get(botId);
    if (owner) await notify(owner.owner_id,'bot-started','Bot is online',`${owner.name} connected to Discord.`).catch(()=>{});
    log(botId, 'info', 'system', `Connected to Discord as ${client.user.tag}.`);
    for (const guild of client.guilds.cache.values()) {
      await db.prepare(`INSERT INTO bot_guilds (bot_id, guild_id, guild_name, member_count, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(bot_id, guild_id) DO UPDATE SET guild_name=excluded.guild_name, member_count=excluded.member_count, updated_at=CURRENT_TIMESTAMP`)
        .run(botId, guild.id, guild.name, guild.memberCount || 0);
    }
    await syncCommands(botId, client).catch(error => log(botId, 'error', 'commands', `Command sync failed: ${error.message}`));
    const activeGiveaways = await db.prepare('SELECT id, ends_at FROM giveaways WHERE bot_id = ? AND ended = 0').all(botId);
    for (const g of activeGiveaways) scheduleGiveaway(botId, client, g.id, Math.max(1000, g.ends_at - Date.now()));
  });

  client.on('guildCreate', async guild => {
    await db.prepare(`INSERT INTO bot_guilds (bot_id, guild_id, guild_name, member_count) VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id, guild_id) DO UPDATE SET guild_name=excluded.guild_name, member_count=excluded.member_count, updated_at=CURRENT_TIMESTAMP`)
      .run(botId, guild.id, guild.name, guild.memberCount || 0);
    log(botId, 'info', 'guild', `Joined server ${guild.name} (${guild.id}).`);
  });
  client.on('guildDelete', async guild => {
    await db.prepare('DELETE FROM bot_guilds WHERE bot_id = ? AND guild_id = ?').run(botId, guild.id);
    log(botId, 'info', 'guild', `Left server ${guild.name} (${guild.id}).`);
  });

  client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) return executeCommand(botId, client, interaction);
    if (!interaction.isButton()) return;
    try {
      const advancedHandled = await advancedModules.handleAdvancedButton(botId, interaction, log);
      if (advancedHandled !== false) return;
      if (interaction.customId === 'ticket:close') {
        const opener = interaction.channel.topic?.match(/\((\d{15,22})\)/)?.[1];
        const canClose = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) || opener === interaction.user.id;
        if (!canClose) return interaction.reply({ content: 'Only the ticket opener or a channel manager can close this ticket.', ephemeral: true });
        await interaction.reply({ content: 'Ticket transcript is being prepared. This channel will be deleted in 5 seconds.' });
        const messages = await interaction.channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (messages?.size) {
          const transcriptText = [...messages.values()].reverse().map(message => {
            const when = new Date(message.createdTimestamp).toISOString();
            const text = (message.content || '[no text content]').replace(/\r?\n/g, ' ').slice(0, 1800);
            return `[${when}] ${message.author?.tag || 'Unknown'}: ${text}`;
          }).join('\n');
          const config = await getGuildSettings(botId, interaction.guildId);
          const logChannel = config.log_channel_id ? await interaction.guild.channels.fetch(config.log_channel_id).catch(() => null) : null;
          if (await featureEnabled(botId, 'logging') && logChannel?.isTextBased()) {
            const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf8'), { name: `ticket-${interaction.channelId}-transcript.txt` });
            await logChannel.send({ content: `Ticket transcript for #${interaction.channel.name}`, files: [attachment] }).catch(() => {});
          }
        }
        setTimeout(() => interaction.channel.delete('Ticket closed by user').catch(() => {}), 5000).unref?.();
        return;
      }
      if (interaction.customId.startsWith('giveaway:join:')) {
        const giveawayId = interaction.customId.split(':')[2];
        const giveaway = await db.prepare('SELECT id, ended, ends_at FROM giveaways WHERE id = ? AND bot_id = ?').get(giveawayId, botId);
        if (!giveaway || giveaway.ended || giveaway.ends_at <= Date.now()) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
        const result = await db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?) ON CONFLICT(giveaway_id, user_id) DO NOTHING').run(giveawayId, interaction.user.id);
        return interaction.reply({ content: result.changes ? 'You are entered in the giveaway.' : 'You have already entered.', ephemeral: true });
      }
      if (interaction.customId.startsWith('quiz:')) {
        const [, quizId, selected] = interaction.customId.split(':');
        const quiz = activeQuizzes.get(quizId);
        if (!quiz || quiz.botId !== botId || quiz.expiresAt <= Date.now()) {
          activeQuizzes.delete(quizId);
          return interaction.reply({ content: 'This quiz has expired. Start a new one with /quiz.', ephemeral: true });
        }
        if (quiz.userId !== interaction.user.id || quiz.guildId !== interaction.guildId) {
          return interaction.reply({ content: 'This quiz belongs to another user.', ephemeral: true });
        }
        activeQuizzes.delete(quizId);
        const correct = Number(selected) === Number(quiz.answer);
        if (correct) {
          await db.prepare(`INSERT INTO economy (bot_id, guild_id, user_id, coins) VALUES (?, ?, ?, 25)
            ON CONFLICT(bot_id, guild_id, user_id) DO UPDATE SET coins=economy.coins+25`).run(botId, interaction.guildId, interaction.user.id);
        }
        await interaction.update({ content: correct ? 'Correct answer. You earned 25 coins.' : 'Not quite. Try another quiz later.', components: [] });
      }
    } catch (error) { log(botId, 'error', 'interaction', `Button interaction failed: ${error.message}`); }
  });

  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const config = await getGuildSettings(botId, message.guild.id);
    const automod = JSON.parse(config.automod_json || '{}');
    if (await featureEnabled(botId, 'automod') && message.member && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      const content = message.content || '';
      const recent = spamCache.get(`${botId}:${message.guild.id}:${message.author.id}`) || [];
      const now = Date.now();
      const recentMessages = recent.filter(t => now - t < 6000);
      recentMessages.push(now);
      if (spamCache.size > 10000) spamCache.clear();
      spamCache.set(`${botId}:${message.guild.id}:${message.author.id}`, recentMessages);
      let violation = '';
      if (automod.antiSpam !== false && recentMessages.length >= 6) violation = 'message spam';
      else if (automod.antiLinks && /https?:\/\/|discord\.gg\//i.test(content)) violation = 'links are not allowed';
      else if (automod.antiMassMention !== false && (message.mentions.everyone || message.mentions.users.size + message.mentions.roles.size >= 5)) violation = 'mass mentions';
      else if (automod.antiCaps && content.length > 12 && (content.replace(/[^A-Z]/g, '').length / content.replace(/[^A-Za-z]/g, '').length) > 0.75) violation = 'excessive caps';
      else if (Array.isArray(automod.badWords) && automod.badWords.some(word => word && content.toLowerCase().includes(String(word).toLowerCase()))) violation = 'blocked word';
      if (violation) {
        await message.delete().catch(() => {});
        log(botId, 'warn', 'automod', `AutoMod removed a message from ${message.author.tag}: ${violation}.`);
        await sendGuildLog(botId, message.guild, 'AutoMod action', `${message.author.tag}: ${violation}`, 0xe0a552);
        return;
      }
    }
    if (await featureEnabled(botId, 'leveling') && message.content) {
      const row = await db.prepare('SELECT xp, level, last_xp_at FROM levels WHERE bot_id = ? AND guild_id = ? AND user_id = ?').get(botId, message.guild.id, message.author.id);
      if (!row || nowSafe() - row.last_xp_at > 60000) {
        const gain = crypto.randomInt(8, 16);
        const xp = (row?.xp || 0) + gain;
        const level = Math.floor(xp / 100);
        await db.prepare(`INSERT INTO levels (bot_id, guild_id, user_id, xp, level, last_xp_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(bot_id, guild_id, user_id) DO UPDATE SET xp=excluded.xp, level=excluded.level, last_xp_at=excluded.last_xp_at`)
          .run(botId, message.guild.id, message.author.id, xp, level, nowSafe());
        if (level > (row?.level || 0)) {
          message.channel.send(`🎉 ${message.author}, you reached level **${level}**!`).catch(() => {});
          const reward = await db.prepare('SELECT role_id FROM level_rewards WHERE bot_id = ? AND guild_id = ? AND level = ?').get(botId, message.guild.id, level);
          if (reward?.role_id) {
            const role = await message.guild.roles.fetch(reward.role_id).catch(() => null);
            const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
            if (role && me?.permissions.has(PermissionFlagsBits.ManageRoles) && role.position < me.roles.highest.position) {
              await message.member.roles.add(role, `Reached level ${level}`).catch(error => log(botId, 'warn', 'leveling', `Could not apply level reward: ${error.message}`));
            }
          }
        }
      }
    }
  });

  client.on('guildMemberAdd', async member => {
    const config = await getGuildSettings(botId, member.guild.id);
    const automod = JSON.parse(config.automod_json || '{}');
    if (await featureEnabled(botId, 'automod') && automod.antiRaid !== false) {
      const key = `${botId}:${member.guild.id}`;
      const recent = (joinCache.get(key) || []).filter(time => Date.now() - time < 15000);
      recent.push(Date.now());
      joinCache.set(key, recent);
      if (recent.length >= 8) {
        log(botId, 'warn', 'automod', `Possible join raid alert in ${member.guild.name}: ${recent.length} members joined within 15 seconds.`);
        await sendGuildLog(botId, member.guild, 'Possible raid activity', `${recent.length} members joined within 15 seconds. Review the member list and moderation settings.`, 0xe0a552);
      }
    }
    if (await featureEnabled(botId, 'welcome') && config.welcome_channel_id) {
      const channel = member.guild.channels.cache.get(config.welcome_channel_id);
      if (channel?.isTextBased()) {
        const welcome = new EmbedBuilder().setColor(0x7c5cff).setDescription(config.welcome_message.replaceAll('{user}', `${member}`).replaceAll('{server}', member.guild.name)).setThumbnail(member.user.displayAvatarURL()).setTimestamp();
        if (config.welcome_image_url) welcome.setImage(config.welcome_image_url);
        await channel.send({ embeds: [welcome] }).catch(() => {});
      }
    }
    await sendGuildLog(botId, member.guild, 'Member joined', `${member.user.tag} joined the server.`);
  });
  client.on('guildMemberRemove', async member => {
    const config = await getGuildSettings(botId, member.guild.id);
    if (await featureEnabled(botId, 'welcome') && config.welcome_channel_id) {
      const channel = member.guild.channels.cache.get(config.welcome_channel_id);
      if (channel?.isTextBased()) await channel.send(config.leave_message.replaceAll('{user}', member.user.tag).replaceAll('{server}', member.guild.name)).catch(() => {});
    }
    await sendGuildLog(botId, member.guild, 'Member left', `${member.user.tag} left the server.`);
  });
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.roles.cache?.map(role => role.id).sort().join(',') !== newMember.roles.cache.map(role => role.id).sort().join(',')) {
      await sendGuildLog(botId, newMember.guild, 'Member roles updated', `${newMember.user.tag} role membership changed.`);
    }
  });
  client.on('channelCreate', async channel => { if (channel.guild) await sendGuildLog(botId, channel.guild, 'Channel created', `${channel.name} (${channel.id})`); });
  client.on('channelDelete', async channel => { if (channel.guild) await sendGuildLog(botId, channel.guild, 'Channel deleted', `${channel.name} (${channel.id})`); });
  client.on('channelUpdate', async (oldChannel, newChannel) => { if (newChannel.guild && oldChannel.name !== newChannel.name) await sendGuildLog(botId, newChannel.guild, 'Channel updated', `${oldChannel.name} → ${newChannel.name}`); });
  client.on('messageDelete', async message => {
    if (message.guild && !message.author?.bot) await sendGuildLog(botId, message.guild, 'Message deleted', `Channel: <#${message.channelId}>\nAuthor: ${message.author?.tag || 'Unknown'}\nContent: ${(message.content || '[content unavailable]').slice(0, 1500)}`);
  });
  client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.guild && !newMessage.author?.bot && oldMessage.content !== newMessage.content) await sendGuildLog(botId, newMessage.guild, 'Message edited', `Channel: <#${newMessage.channelId}>\nAuthor: ${newMessage.author?.tag || 'Unknown'}\nBefore: ${(oldMessage.content || '[unavailable]').slice(0, 700)}\nAfter: ${(newMessage.content || '[unavailable]').slice(0, 700)}`);
  });
  client.on('error', error => log(botId, 'error', 'gateway', error.message));
  client.on('shardDisconnect', async () => {
    await db.prepare("UPDATE bots SET status = 'offline' WHERE id = ?").run(botId);
    const owner = await db.prepare('SELECT owner_id,name FROM bots WHERE id=?').get(botId);
    if (owner) await notify(owner.owner_id,'bot-stopped','Bot disconnected',`${owner.name} disconnected from the Discord Gateway.`).catch(()=>{});
    log(botId, 'warn', 'gateway', 'Discord Gateway disconnected. discord.js will attempt to reconnect when possible.');
  });
  client.on('shardReconnecting', async () => {
    await db.prepare("UPDATE bots SET status = 'starting' WHERE id = ?").run(botId);
    log(botId, 'warn', 'gateway', 'Reconnecting to Discord Gateway.');
  });
}

function nowSafe() { return Date.now(); }

async function startBot(botId) {
  return withStartAdmission(async () => {
    const existing = runtimeClients.get(botId);
    if (existing) return { ok: true, status: existing.isReady() ? 'online' : 'starting' };

    const row = await db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
    if (!row) throw new Error('Bot not found.');

    if (runtimeClients.size >= env.maxRunningBots) {
      throw new Error(`The platform running-bot limit (${env.maxRunningBots}) has been reached.`);
    }

    const runningRows = await db.prepare("SELECT COUNT(*) AS n FROM bots WHERE owner_id=? AND status IN ('online','starting')").get(row.owner_id);
    const currentlyRunning = Math.max(0, Number(runningRows.n || 0) - (row.status === 'online' || row.status === 'starting' ? 1 : 0));
    await assertCanRunBot(row.owner_id, currentlyRunning);

    let client;
    try {
      const token = decrypt({ encrypted: row.encrypted_token, iv: row.token_iv, tag: row.token_tag });
      const enabledFeatureRows = await db.prepare('SELECT feature_key FROM bot_features WHERE bot_id=? AND enabled=1').all(botId);
      const intentNames = getRequiredIntents(enabledFeatureRows.map(item => item.feature_key));
      const intentBits = {
        Guilds: GatewayIntentBits.Guilds,
        GuildMembers: GatewayIntentBits.GuildMembers,
        GuildMessages: GatewayIntentBits.GuildMessages,
        MessageContent: GatewayIntentBits.MessageContent,
        GuildVoiceStates: GatewayIntentBits.GuildVoiceStates,
        GuildMessageReactions: GatewayIntentBits.GuildMessageReactions,
        GuildInvites: GatewayIntentBits.GuildInvites
      };
      client = new Client({
        intents: intentNames.map(name => intentBits[name]).filter(Boolean),
        partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction, Partials.User]
      });
      runtimeClients.set(botId, client);
      await db.prepare("UPDATE bots SET status='starting' WHERE id=?").run(botId);
      registerEvents(botId, client);
      await client.login(token);
      return { ok: true, status: client.isReady() ? 'online' : 'starting' };
    } catch (error) {
      if (client && runtimeClients.get(botId) === client) runtimeClients.delete(botId);
      client?.destroy();
      await db.prepare("UPDATE bots SET status='error' WHERE id=?").run(botId).catch(() => {});
      const owner = await db.prepare('SELECT owner_id,name FROM bots WHERE id=?').get(botId).catch(() => null);
      if (owner) await notify(owner.owner_id, 'bot-error', 'Bot failed to start', `${owner.name}: Discord login failed.`).catch(() => {});
      log(botId, 'error', 'system', `Bot login failed: ${error.message}`);
      if (/plan|limit/i.test(error.message)) throw error;
      throw new Error('Discord login failed. Verify the bot token and Developer Portal intent settings.');
    }
  });
}

async function stopBot(botId) {
  advancedModules.stopAdvancedBot(botId);
  const client = runtimeClients.get(botId);
  if (client) {
    runtimeClients.delete(botId);
    client.destroy();
  }
  await db.prepare("UPDATE bots SET status = 'offline' WHERE id = ?").run(botId);
  log(botId, 'info', 'system', 'Bot stopped by platform control.');
  return { ok: true, status: 'offline' };
}

async function restartBot(botId) {
  await stopBot(botId);
  return startBot(botId);
}

async function validateToken(token) {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'The bot token was rejected by Discord.' : `Discord token validation failed (HTTP ${response.status}).`);
  const profile = await response.json();
  if (!profile.bot) throw new Error('The supplied token does not belong to a bot account.');
  return profile;
}

async function syncBotCommands(botId) {
  const client = runtimeClients.get(botId);
  if (!client?.isReady()) throw new Error('Start this bot before synchronizing commands.');
  await syncCommands(botId, client);
}

function getBotMetrics(botId) {
  const client = runtimeClients.get(botId);
  const ready = Boolean(client?.isReady?.());
  return { ready, uptimeMs: ready ? Number(client.uptime || 0) : null, pingMs: ready ? Math.max(0, Math.round(client.ws.ping)) : null, guildCount: ready ? client.guilds.cache.size : null, processMemoryBytes: process.memoryUsage().rss };
}

module.exports = { startBot, stopBot, restartBot, validateToken, syncBotCommands, log, runtimeClients, getBotMetrics };
