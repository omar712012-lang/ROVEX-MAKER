'use strict';

const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { isIP } = require('node:net');
const { lookup } = require('node:dns/promises');
const https = require('node:https');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, ChannelType
} = require('discord.js');
const db = require('../config/database');
const { decrypt } = require('../services/EncryptionService');

let voice = null;
try { voice = require('@discordjs/voice'); } catch { /* Music commands return an actionable setup message until the optional voice runtime is installed. */ }

const musicSessions = new Map();
const birthdayTimers = new Map();
const integrationRate = new Map();

function parseJson(value, fallback = {}) {
  try { const result = JSON.parse(value || '{}'); return result && typeof result === 'object' ? result : fallback; }
  catch { return fallback; }
}

async function getSettings(botId, guildId, moduleKey) {
  const row = await db.prepare('SELECT settings_json FROM bot_module_settings WHERE bot_id=? AND guild_id=? AND module_key=?').get(botId, guildId, moduleKey);
  return parseJson(row?.settings_json, {});
}

async function isFeatureEnabled(botId, featureKey) {
  const row = await db.prepare('SELECT enabled FROM bot_features WHERE bot_id=? AND feature_key=?').get(botId, featureKey);
  return Boolean(row && Number(row.enabled) === 1);
}

async function saveSettings(botId, guildId, moduleKey, settings) {
  await db.prepare(`INSERT INTO bot_module_settings (bot_id,guild_id,module_key,settings_json,updated_at)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(bot_id,guild_id,module_key) DO UPDATE SET settings_json=excluded.settings_json,updated_at=CURRENT_TIMESTAMP`)
    .run(botId, guildId, moduleKey, JSON.stringify(settings));
}

function hasManageGuild(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function requireManager(interaction, permission = PermissionFlagsBits.ManageGuild) {
  if (interaction.memberPermissions?.has(permission)) return true;
  await interaction.reply({ content: 'You do not have permission to change this server configuration.', ephemeral: true });
  return false;
}

function isPrivateIp(host) {
  const normalized = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  const version = isIP(normalized);
  if (!version) return false;
  if (version === 4) {
    const [a,b] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224;
  }
  if (normalized.startsWith('::ffff:')) return isPrivateIp(normalized.slice(7));
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
    normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
}

async function resolvePublicHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (isPrivateIp(host)) throw new Error('Private and local network hosts are not allowed as stream sources.');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
    throw new Error('The stream hostname must resolve only to public IP addresses.');
  }
  // Pin the HTTPS request to the already-validated address to avoid a second DNS lookup.
  return addresses[0];
}

async function createOggOpusStream(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Music source must be a public HTTPS URL without credentials or a custom port.');
  }
  const pinnedAddress = await resolvePublicHost(url.hostname);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
      lookup: (_hostname, _options, callback) => callback(null, pinnedAddress.address, pinnedAddress.family)
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new Error(`Audio source returned HTTP ${status}. Redirects and unsuccessful responses are not allowed.`));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (!(contentType.includes('audio/ogg') || contentType.includes('application/ogg'))) {
        response.destroy();
        reject(new Error('Only direct Ogg/Opus streams are supported. Provide a licensed HTTPS .ogg/.opus stream URL.'));
        return;
      }
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > 45 * 1024 * 1024) {
        response.destroy();
        reject(new Error('The audio stream is larger than the 45 MB safety limit.'));
        return;
      }
      let received = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > 45 * 1024 * 1024) return callback(new Error('Audio stream exceeded the 45 MB safety limit.'));
        callback(null, chunk);
      }});
      response.on('error', error => limit.destroy(error));
      response.pipe(limit);
      resolve(limit);
    });
    request.on('error', reject);
    request.end();
  });
}

function musicKey(botId, guildId) { return `${botId}:${guildId}`; }

async function startNextMusicTrack(botId, session, log) {
  if (session.loading || session.player.state.status !== voice.AudioPlayerStatus.Idle) return;
  const track = session.queue.shift();
  if (!track) {
    session.current = null;
    return;
  }
  session.loading = true;
  try {
    const stream = await createOggOpusStream(track.url);
    const resource = voice.createAudioResource(stream, { inputType: voice.StreamType.OggOpus, metadata: { submittedBy: track.userId } });
    session.current = track;
    session.player.play(resource);
    log(botId, 'info', 'music', `Started an authorized Ogg/Opus stream in guild ${session.guildId}.`);
    const channel = await session.client.channels.fetch(session.textChannelId).catch(() => null);
    if (channel?.isTextBased()) await channel.send(`Now playing a direct audio stream requested by <@${track.userId}>.`).catch(() => {});
  } catch (error) {
    session.current = null;
    log(botId, 'warn', 'music', `Stream could not be played: ${error.message}`);
    const channel = await session.client.channels.fetch(session.textChannelId).catch(() => null);
    if (channel?.isTextBased()) await channel.send(`Unable to play the queued stream: ${error.message}`).catch(() => {});
  } finally {
    session.loading = false;
    if (session.player.state.status === voice.AudioPlayerStatus.Idle && session.queue.length) {
      queueMicrotask(() => startNextMusicTrack(botId, session, log));
    }
  }
}

async function musicCommand(botId, client, interaction, log) {
  if (!voice) return interaction.reply({ content: 'Music voice support is not installed on this host. Run npm install and restart the platform.', ephemeral: true });
  const command = interaction.commandName;
  const key = musicKey(botId, interaction.guildId);
  let session = musicSessions.get(key);

  if (command === 'play') {
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) return interaction.reply({ content: 'Join a voice channel before using /play.', ephemeral: true });
    const url = interaction.options.getString('url', true).trim();
    try { const parsed = new URL(url); if (parsed.protocol !== 'https:') throw new Error(); }
    catch { return interaction.reply({ content: 'Enter a valid HTTPS stream URL.', ephemeral: true }); }
    await interaction.deferReply({ ephemeral: true });
    if (!session) {
      const player = voice.createAudioPlayer();
      const connection = voice.joinVoiceChannel({ channelId: voiceChannel.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
      session = { botId, guildId: interaction.guildId, client, player, connection, queue: [], current: null, loading: false, textChannelId: interaction.channelId };
      connection.subscribe(player);
      player.on(voice.AudioPlayerStatus.Idle, () => startNextMusicTrack(botId, session, log).catch(error => log(botId, 'error', 'music', error.message)));
      player.on('error', error => log(botId, 'error', 'music', `Audio player error: ${error.message}`));
      connection.on('error', error => log(botId, 'error', 'music', `Voice connection error: ${error.message}`));
      musicSessions.set(key, session);
      try { await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 20000); }
      catch (error) {
        musicSessions.delete(key); connection.destroy();
        return interaction.editReply('The bot could not connect to your voice channel. Check Connect/Speak permissions and the host UDP/network policy.');
      }
    } else if (session.connection.joinConfig.channelId !== voiceChannel.id) {
      return interaction.editReply('Music is already running in another voice channel in this server. Stop playback before moving it.');
    }
    if (session.queue.length + (session.current ? 1 : 0) >= 10) return interaction.editReply('The music queue is full (10 streams maximum). Try again after a track finishes.');
    session.queue.push({ url, userId: interaction.user.id, addedAt: Date.now() });
    session.textChannelId = interaction.channelId;
    if (session.player.state.status === voice.AudioPlayerStatus.Idle && !session.loading) await startNextMusicTrack(botId, session, log);
    return interaction.editReply(`Stream added to the queue. ${session.queue.length + (session.current ? 1 : 0)} item(s) in session.`);
  }

  if (command === 'nowplaying') {
    if (!session?.current) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    return interaction.reply({ content: `A direct audio stream is playing. Queue: ${session.queue.length} item(s).`, ephemeral: true });
  }
  if (command === 'skip') {
    if (!session?.current) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
    session.player.stop(true);
    return interaction.reply({ content: 'Skipped the current stream.', ephemeral: true });
  }
  if (command === 'stop') {
    if (!session) return interaction.reply({ content: 'There is no active music session.', ephemeral: true });
    session.queue.length = 0;
    session.player.stop(true);
    session.connection.destroy();
    musicSessions.delete(key);
    return interaction.reply({ content: 'Playback stopped and the voice connection was closed.', ephemeral: true });
  }
  return false;
}

async function getIntegration(botId, provider) {
  const row = await db.prepare('SELECT encrypted_value,iv,auth_tag,config_json FROM integrations WHERE bot_id=? AND provider=?').get(botId, provider);
  if (!row) return null;
  const apiKey = row.encrypted_value ? decrypt({ encrypted: row.encrypted_value, iv: row.iv, tag: row.auth_tag }) : null;
  return { apiKey, config: parseJson(row.config_json, {}) };
}

function allowIntegrationRequest(key) {
  const now = Date.now();
  const list = (integrationRate.get(key) || []).filter(time => now - time < 60000);
  if (list.length >= 8) return false;
  list.push(now);
  integrationRate.set(key, list);
  return true;
}

async function executeAi(botId, interaction) {
  if (!allowIntegrationRequest(`${botId}:${interaction.user.id}:ai`)) return interaction.reply({ content: 'AI request limit reached. Try again in a minute.', ephemeral: true });
  const integration = await getIntegration(botId, 'openai');
  if (!integration?.apiKey) return interaction.reply({ content: 'AI is not configured yet. Add an OpenAI API key in this bot’s Integrations page.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${integration.apiKey}` },
    body: JSON.stringify({ model: integration.config.model || 'gpt-4o-mini', messages: [{ role: 'system', content: 'You are a concise assistant for a Discord community. Follow safety rules and do not claim actions you did not perform.' }, { role: 'user', content: interaction.options.getString('question', true) }], max_tokens: 500 }),
    signal: AbortSignal.timeout(25000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return interaction.editReply(`AI provider error (${response.status}). Check the API key, model and provider billing settings.`);
  const answer = String(payload.choices?.[0]?.message?.content || '').trim().slice(0, 1900);
  return interaction.editReply(answer || 'The AI provider returned an empty response.');
}

async function executeTranslation(botId, interaction) {
  if (!allowIntegrationRequest(`${botId}:${interaction.user.id}:translate`)) return interaction.reply({ content: 'Translation request limit reached. Try again in a minute.', ephemeral: true });
  const integration = await getIntegration(botId, 'libretranslate');
  if (!integration) return interaction.reply({ content: 'Translation is not configured yet. Configure the platform endpoint and optional key in this bot’s Integrations page.', ephemeral: true });
  const endpoint = String(process.env.TRANSLATE_API_URL || 'https://libretranslate.com/translate');
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:' || isPrivateIp(parsed.hostname)) return interaction.reply({ content: 'The platform translation endpoint is not a valid public HTTPS address.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const body = { q: interaction.options.getString('text', true), source: 'auto', target: interaction.options.getString('target', true).trim(), format: 'text' };
  if (integration.apiKey) body.api_key = integration.apiKey;
  const response = await fetch(parsed, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return interaction.editReply(`Translation provider error (${response.status}). Check the endpoint and API key.`);
  return interaction.editReply(String(payload.translatedText || 'The translation provider returned no text.').slice(0, 1900));
}

async function executeAdvancedCommand(botId, client, interaction, log) {
  const name = interaction.commandName;
  const guild = interaction.guild;
  if (['play','skip','stop','nowplaying'].includes(name)) return musicCommand(botId, client, interaction, log);
  if (!guild) return interaction.reply({ content: 'This command must be used inside a Discord server.', ephemeral: true });

  if (name === 'tempvoice-config') {
    if (!await requireManager(interaction, PermissionFlagsBits.ManageChannels)) return true;
    const channel = interaction.options.getChannel('channel', true);
    await saveSettings(botId, guild.id, 'temp_voice', { lobbyChannelId: channel.id });
    return interaction.reply({ content: `Temporary voice lobby set to ${channel}.`, ephemeral: true });
  }
  if (name === 'role-button') {
    if (!await requireManager(interaction, PermissionFlagsBits.ManageRoles)) return true;
    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('role', true);
    const label = (interaction.options.getString('label') || `Get ${role.name}`).slice(0, 70);
    const me = guild.members.me || await guild.members.fetchMe();
    if (role.id === guild.id || role.managed || role.position >= me.roles.highest.position || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ content: 'The selected role cannot be self-assigned because of Discord role hierarchy or permissions.', ephemeral: true });
    }
    const buttonId = crypto.randomUUID();
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rr:${buttonId}`).setLabel(label).setStyle(ButtonStyle.Primary));
    const message = await channel.send({ content: `Select the button below to add or remove the **${role.name}** role.`, components: [row] });
    await db.prepare('INSERT INTO bot_reaction_roles (button_id,bot_id,guild_id,message_id,role_id,label) VALUES (?,?,?,?,?,?)')
      .run(buttonId, botId, guild.id, message.id, role.id, label);
    return interaction.reply({ content: `Role button panel published in ${channel}.`, ephemeral: true });
  }
  if (name === 'suggestion-config') {
    if (!await requireManager(interaction)) return true;
    const channel = interaction.options.getChannel('channel', true);
    await saveSettings(botId, guild.id, 'suggestions', { channelId: channel.id });
    return interaction.reply({ content: `Suggestion channel set to ${channel}.`, ephemeral: true });
  }
  if (name === 'suggest') {
    const settings = await getSettings(botId, guild.id, 'suggestions');
    const channel = settings.channelId ? await guild.channels.fetch(settings.channelId).catch(() => null) : null;
    if (!channel?.isTextBased()) return interaction.reply({ content: 'The server has not configured a suggestion channel. Ask an administrator to run /suggestion-config.', ephemeral: true });
    const content = interaction.options.getString('text', true).trim();
    const suggestionId = crypto.randomUUID();
    const embed = new EmbedBuilder().setColor(0x397dff).setTitle('New community suggestion').setDescription(content).addFields({ name: 'Submitted by', value: `${interaction.user}`, inline: true }, { name: 'Status', value: 'Pending review', inline: true }).setTimestamp();
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sv:${suggestionId}:1`).setLabel('Support · 0').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sv:${suggestionId}:-1`).setLabel('Not for me · 0').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sv:${suggestionId}:approve`).setLabel('Approve').setStyle(ButtonStyle.Primary)
    );
    const message = await channel.send({ embeds: [embed], components: [buttons] });
    await db.prepare('INSERT INTO bot_suggestions (id,bot_id,guild_id,channel_id,message_id,author_id,content) VALUES (?,?,?,?,?,?,?)')
      .run(suggestionId, botId, guild.id, channel.id, message.id, interaction.user.id, content);
    return interaction.reply({ content: `Your suggestion was submitted in ${channel}.`, ephemeral: true });
  }
  if (name === 'birthday-config') {
    if (!await requireManager(interaction)) return true;
    const channel = interaction.options.getChannel('channel', true);
    await saveSettings(botId, guild.id, 'birthday', { channelId: channel.id });
    return interaction.reply({ content: `Birthday greetings will be posted in ${channel}.`, ephemeral: true });
  }
  if (name === 'birthday-set') {
    const raw = interaction.options.getString('date', true).trim();
    const match = /^(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])$/.exec(raw);
    if (!match) return interaction.reply({ content: 'Use MM-DD format, for example 08-24. Your birth year is not collected.', ephemeral: true });
    const month = Number(match[1]); const day = Number(match[2]);
    const date = new Date(Date.UTC(2024, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return interaction.reply({ content: 'That month and day do not form a valid date.', ephemeral: true });
    await db.prepare(`INSERT INTO bot_birthdays (bot_id,guild_id,user_id,month,day) VALUES (?,?,?,?,?)
      ON CONFLICT(bot_id,guild_id,user_id) DO UPDATE SET month=excluded.month,day=excluded.day,last_wished_year=0`).run(botId, guild.id, interaction.user.id, month, day);
    return interaction.reply({ content: `Your birthday was saved as ${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}. No birth year is stored.`, ephemeral: true });
  }
  if (name === 'birthday-remove') {
    await db.prepare('DELETE FROM bot_birthdays WHERE bot_id=? AND guild_id=? AND user_id=?').run(botId, guild.id, interaction.user.id);
    return interaction.reply({ content: 'Your saved birthday was removed.', ephemeral: true });
  }
  if (name === 'birthday-list') {
    const rows = await db.prepare('SELECT user_id,month,day FROM bot_birthdays WHERE bot_id=? AND guild_id=? ORDER BY month,day LIMIT 20').all(botId, guild.id);
    const body = rows.length ? rows.map(row => `• <@${row.user_id}> — ${String(row.month).padStart(2,'0')}-${String(row.day).padStart(2,'0')}`).join('\n') : 'No birthdays have been added yet.';
    return interaction.reply({ content: body.slice(0, 1900), ephemeral: true });
  }
  if (name === 'counting-config') {
    if (!await requireManager(interaction, PermissionFlagsBits.ManageChannels)) return true;
    const channel = interaction.options.getChannel('channel', true);
    const start = interaction.options.getInteger('start') ?? 1;
    await db.prepare(`INSERT INTO bot_counting_state (bot_id,guild_id,channel_id,next_number,last_user_id) VALUES (?,?,?,?,NULL)
      ON CONFLICT(bot_id,guild_id) DO UPDATE SET channel_id=excluded.channel_id,next_number=excluded.next_number,last_user_id=NULL`).run(botId, guild.id, channel.id, start);
    await saveSettings(botId, guild.id, 'counting', { start });
    return interaction.reply({ content: `Counting channel set to ${channel}. The next number is ${start}.`, ephemeral: true });
  }
  if (name === 'starboard-config') {
    if (!await requireManager(interaction)) return true;
    const channel = interaction.options.getChannel('channel', true);
    const threshold = interaction.options.getInteger('threshold') || 3;
    await saveSettings(botId, guild.id, 'starboard', { channelId: channel.id, threshold });
    return interaction.reply({ content: `Starboard configured in ${channel} with a threshold of ${threshold} stars.`, ephemeral: true });
  }
  if (name === 'verify-config') {
    if (!await requireManager(interaction)) return true;
    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('role', true);
    const me = guild.members.me || await guild.members.fetchMe();
    if (role.id === guild.id || role.managed || role.position >= me.roles.highest.position || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'The verification role must be below the bot role and assignable by the bot.', ephemeral: true });
    await saveSettings(botId, guild.id, 'verification', { channelId: channel.id, roleId: role.id });
    return interaction.reply({ content: `Verification configured in ${channel} with role ${role}.`, ephemeral: true });
  }
  if (name === 'verification-panel') {
    if (!await requireManager(interaction)) return true;
    const settings = await getSettings(botId, guild.id, 'verification');
    const channel = settings.channelId ? await guild.channels.fetch(settings.channelId).catch(() => null) : null;
    if (!channel?.isTextBased() || !settings.roleId) return interaction.reply({ content: 'Run /verify-config first to select a channel and role.', ephemeral: true });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`verify:${botId}`).setLabel('Verify me').setStyle(ButtonStyle.Success));
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle('Server verification').setDescription('Press the button below to receive the verified member role.')], components: [row] });
    return interaction.reply({ content: `Verification panel posted in ${channel}.`, ephemeral: true });
  }
  if (name === 'invites') {
    const target = interaction.options.getUser('user') || interaction.user;
    const totals = await db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN invite_code IS NOT NULL THEN 1 ELSE 0 END) AS tracked
      FROM bot_invite_joins WHERE bot_id=? AND guild_id=? AND inviter_id=?`).get(botId, guild.id, target.id);
    return interaction.reply({ content: `${target.username} invited ${Number(totals.total || 0)} member(s). ${Number(totals.tracked || 0)} were attributed to a tracked invite.`, ephemeral: true });
  }
  if (name === 'stats-config') {
    if (!await requireManager(interaction, PermissionFlagsBits.ManageChannels)) return true;
    const channel = interaction.options.getChannel('channel', true);
    const metric = interaction.options.getString('metric', true);
    await saveSettings(botId, guild.id, 'server_statistics', { channelId: channel.id, metric });
    await updateStatsChannel(guild, { channelId: channel.id, metric }, log, botId);
    return interaction.reply({ content: `Statistics channel configured for ${metric}.`, ephemeral: true });
  }
  if (name === 'ask') return executeAi(botId, interaction);
  if (name === 'translate') return executeTranslation(botId, interaction);
  return false;
}

async function handleAdvancedButton(botId, interaction, log) {
  if (!interaction.isButton()) return false;
  const customId = interaction.customId;
  if (customId.startsWith('rr:')) {
    if (!await isFeatureEnabled(botId, 'reaction_roles')) return interaction.reply({ content: 'This feature is currently disabled.', ephemeral: true });
    const buttonId = customId.slice(3);
    const row = await db.prepare('SELECT role_id,guild_id,message_id FROM bot_reaction_roles WHERE button_id=? AND bot_id=?').get(buttonId, botId);
    if (!row || row.guild_id !== interaction.guildId || row.message_id !== interaction.message.id) return interaction.reply({ content: 'This role panel is no longer active.', ephemeral: true });
    const role = await interaction.guild.roles.fetch(row.role_id).catch(() => null);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    if (!role || role.managed || role.position >= me.roles.highest.position || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'The role can no longer be assigned. Contact a server administrator.', ephemeral: true });
    if (member.roles.cache.has(role.id)) { await member.roles.remove(role, 'Self-service role panel'); return interaction.reply({ content: `Removed ${role.name}.`, ephemeral: true }); }
    await member.roles.add(role, 'Self-service role panel');
    return interaction.reply({ content: `Added ${role.name}.`, ephemeral: true });
  }
  if (customId.startsWith('verify:')) {
    if (!await isFeatureEnabled(botId, 'verification')) return interaction.reply({ content: 'This feature is currently disabled.', ephemeral: true });
    if (customId !== `verify:${botId}`) return interaction.reply({ content: 'This verification panel belongs to a different bot.', ephemeral: true });
    const settings = await getSettings(botId, interaction.guildId, 'verification');
    const role = settings.roleId ? await interaction.guild.roles.fetch(settings.roleId).catch(() => null) : null;
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    if (!role || role.managed || role.position >= me.roles.highest.position || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'Verification is temporarily unavailable. Contact a server administrator.', ephemeral: true });
    if (member.roles.cache.has(role.id)) return interaction.reply({ content: 'You are already verified.', ephemeral: true });
    await member.roles.add(role, 'Member verification completed');
    return interaction.reply({ content: 'Verification completed. Welcome!', ephemeral: true });
  }
  if (customId.startsWith('sv:')) {
    if (!await isFeatureEnabled(botId, 'suggestions')) return interaction.reply({ content: 'This feature is currently disabled.', ephemeral: true });
    const [, suggestionId, value] = customId.split(':');
    const suggestion = await db.prepare('SELECT * FROM bot_suggestions WHERE id=? AND bot_id=?').get(suggestionId, botId);
    if (!suggestion || suggestion.guild_id !== interaction.guildId || suggestion.message_id !== interaction.message.id) return interaction.reply({ content: 'This suggestion is no longer available.', ephemeral: true });
    if (value === 'approve') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Only server managers can approve a suggestion.', ephemeral: true });
      await db.prepare("UPDATE bot_suggestions SET status='approved' WHERE id=?").run(suggestionId);
      const votes = await db.prepare('SELECT SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) AS upvotes,SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS downvotes FROM bot_suggestion_votes WHERE suggestion_id=?').get(suggestionId);
      const embed = new EmbedBuilder().setColor(0x22c55e).setTitle('Suggestion · Approved').setDescription(suggestion.content).addFields({ name: 'Support', value: String(votes.upvotes || 0), inline: true }, { name: 'Not for me', value: String(votes.downvotes || 0), inline: true }).setFooter({ text: `Submitted by ${suggestion.author_id}` });
      await interaction.message.edit({ embeds: [embed], components: [] });
      return interaction.reply({ content: 'Suggestion approved.', ephemeral: true });
    }
    if (!['1','-1'].includes(value) || suggestion.status !== 'pending') return interaction.reply({ content: 'This suggestion is closed.', ephemeral: true });
    await db.prepare(`INSERT INTO bot_suggestion_votes (suggestion_id,user_id,vote) VALUES (?,?,?)
      ON CONFLICT(suggestion_id,user_id) DO UPDATE SET vote=excluded.vote,created_at=CURRENT_TIMESTAMP`).run(suggestionId, interaction.user.id, Number(value));
    const votes = await db.prepare('SELECT SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) AS upvotes,SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) AS downvotes FROM bot_suggestion_votes WHERE suggestion_id=?').get(suggestionId);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sv:${suggestionId}:1`).setLabel(`Support · ${Number(votes.upvotes || 0)}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sv:${suggestionId}:-1`).setLabel(`Not for me · ${Number(votes.downvotes || 0)}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sv:${suggestionId}:approve`).setLabel('Approve').setStyle(ButtonStyle.Primary)
    );
    await interaction.message.edit({ components: [row] });
    return interaction.reply({ content: 'Your vote was saved. You may change it later.', ephemeral: true });
  }
  return false;
}

async function updateStatsChannel(guild, settings, log, botId) {
  const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice) return;
  let value = 0;
  if (settings.metric === 'channels') value = guild.channels.cache.size;
  else if (settings.metric === 'humans') {
    const members = await guild.members.fetch().catch(() => null);
    value = members ? members.filter(member => !member.user.bot).size : guild.memberCount;
  } else value = guild.memberCount;
  const label = settings.metric === 'humans' ? 'Humans' : settings.metric === 'channels' ? 'Channels' : 'Members';
  const nextName = `${label} · ${value}`.slice(0, 95);
  if (channel.name !== nextName) await channel.setName(nextName, 'ROVEX server statistics').catch(error => log(botId, 'warn', 'statistics', `Could not update statistics channel: ${error.message}`));
}

async function cacheInvites(botId, guild, log) {
  try {
    const invites = await guild.invites.fetch();
    for (const invite of invites.values()) {
      await db.prepare(`INSERT INTO bot_invite_cache (bot_id,guild_id,invite_code,uses,inviter_id) VALUES (?,?,?,?,?)
        ON CONFLICT(bot_id,guild_id,invite_code) DO UPDATE SET uses=excluded.uses,inviter_id=excluded.inviter_id`)
        .run(botId, guild.id, invite.code, Number(invite.uses || 0), invite.inviter?.id || null);
    }
  } catch (error) {
    log(botId, 'warn', 'invites', `Invite cache unavailable in ${guild.id}; grant Manage Guild to track invite use. ${error.message}`);
  }
}

async function handleMemberJoin(botId, member, log) {
  try {
    const before = await db.prepare('SELECT invite_code,uses,inviter_id FROM bot_invite_cache WHERE bot_id=? AND guild_id=?').all(botId, member.guild.id);
    const oldUses = new Map(before.map(item => [item.invite_code, Number(item.uses)]));
    const invites = await member.guild.invites.fetch();
    let used = null;
    for (const invite of invites.values()) {
      if (Number(invite.uses || 0) > (oldUses.get(invite.code) ?? 0)) { used = invite; break; }
    }
    await db.prepare(`INSERT INTO bot_invite_joins (bot_id,guild_id,user_id,invite_code,inviter_id) VALUES (?,?,?,?,?)
      ON CONFLICT(bot_id,guild_id,user_id) DO UPDATE SET invite_code=excluded.invite_code,inviter_id=excluded.inviter_id`)
      .run(botId, member.guild.id, member.id, used?.code || null, used?.inviter?.id || null);
    await cacheInvites(botId, member.guild, log);
  } catch (error) { log(botId, 'warn', 'invites', `Could not attribute a new member: ${error.message}`); }
}

async function checkBirthdays(botId, client, log) {
  if (!await isFeatureEnabled(botId, 'birthday')) return;
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const year = now.getUTCFullYear();
  const rows = await db.prepare('SELECT guild_id,user_id FROM bot_birthdays WHERE bot_id=? AND month=? AND day=? AND last_wished_year<?').all(botId, month, day, year);
  for (const birthday of rows) {
    const settings = await getSettings(botId, birthday.guild_id, 'birthday');
    const guild = client.guilds.cache.get(birthday.guild_id);
    const channel = settings.channelId ? await guild?.channels.fetch(settings.channelId).catch(() => null) : null;
    if (!channel?.isTextBased()) continue;
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x8855ff).setTitle('Happy Birthday!').setDescription(`Everyone wish <@${birthday.user_id}> a wonderful day!`).setTimestamp()] }).then(async () => {
      await db.prepare('UPDATE bot_birthdays SET last_wished_year=? WHERE bot_id=? AND guild_id=? AND user_id=?').run(year, botId, birthday.guild_id, birthday.user_id);
    }).catch(error => log(botId, 'warn', 'birthday', `Birthday greeting failed in ${birthday.guild_id}: ${error.message}`));
  }
}

async function registerAdvancedEvents(botId, client, log) {
  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      if (await isFeatureEnabled(botId, 'invite_tracker')) await cacheInvites(botId, guild, log);
      const stats = await getSettings(botId, guild.id, 'server_statistics');
      if (stats.channelId && await isFeatureEnabled(botId, 'server_statistics')) await updateStatsChannel(guild, stats, log, botId);
    }
    const timer = setInterval(() => checkBirthdays(botId, client, log).catch(error => log(botId, 'error', 'birthday', error.message)), 60000);
    timer.unref?.();
    birthdayTimers.set(botId, timer);
    checkBirthdays(botId, client, log).catch(error => log(botId, 'error', 'birthday', error.message));
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    const guild = newState.guild;
    if (!guild) return;
    if (!await isFeatureEnabled(botId, 'temp_voice')) return;
    const settings = await getSettings(botId, guild.id, 'temp_voice');
    if (newState.channelId && settings.lobbyChannelId && newState.channelId === settings.lobbyChannelId && newState.member && !newState.member.user.bot) {
      try {
        const lobby = newState.channel;
        const channel = await guild.channels.create({
          name: `${newState.member.displayName}'s room`.slice(0, 90), type: ChannelType.GuildVoice,
          parent: lobby?.parentId || undefined,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: newState.member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] }
          ], reason: 'ROVEX temporary voice room'
        });
        await db.prepare('INSERT INTO bot_temp_voice_rooms (bot_id,guild_id,channel_id,owner_id) VALUES (?,?,?,?)').run(botId, guild.id, channel.id, newState.member.id);
        try { await newState.member.voice.setChannel(channel, 'Join-to-create room'); }
        catch (error) { await channel.delete('Could not move member into temporary room').catch(() => {}); await db.prepare('DELETE FROM bot_temp_voice_rooms WHERE bot_id=? AND guild_id=? AND channel_id=?').run(botId,guild.id,channel.id); throw error; }
      } catch (error) { log(botId, 'warn', 'temp-voice', `Temporary voice room creation failed: ${error.message}`); }
    }
    if (oldState.channelId) {
      const room = await db.prepare('SELECT channel_id FROM bot_temp_voice_rooms WHERE bot_id=? AND guild_id=? AND channel_id=?').get(botId, guild.id, oldState.channelId);
      if (room) {
        const channel = await guild.channels.fetch(room.channel_id).catch(() => null);
        if (!channel || channel.members.size === 0) {
          await db.prepare('DELETE FROM bot_temp_voice_rooms WHERE bot_id=? AND guild_id=? AND channel_id=?').run(botId, guild.id, room.channel_id);
          await channel?.delete('Temporary voice room is empty').catch(() => {});
        }
      }
    }
  });

  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    if (!await isFeatureEnabled(botId, 'counting')) return;
    const state = await db.prepare('SELECT channel_id,next_number,last_user_id FROM bot_counting_state WHERE bot_id=? AND guild_id=?').get(botId, message.guild.id);
    if (!state || message.channelId !== state.channel_id) return;
    const countingSettings = await getSettings(botId, message.guild.id, 'counting');
    const startNumber = Number.isSafeInteger(Number(countingSettings.start)) ? Number(countingSettings.start) : 1;
    const text = message.content.trim();
    const value = /^\d{1,9}$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value !== Number(state.next_number) || state.last_user_id === message.author.id) {
      await db.prepare('UPDATE bot_counting_state SET next_number=?,last_user_id=NULL WHERE bot_id=? AND guild_id=?').run(startNumber, botId, message.guild.id);
      await message.reply(`Counting reset. Start again from **${startNumber}**.`).catch(() => {});
      return;
    }
    const result = await db.prepare('UPDATE bot_counting_state SET next_number=next_number+1,last_user_id=? WHERE bot_id=? AND guild_id=? AND next_number=? AND (last_user_id IS NULL OR last_user_id<>?)')
      .run(message.author.id, botId, message.guild.id, state.next_number, message.author.id);
    if (!result.changes) await message.reply('Another message updated the count first. Please try the next number.').catch(() => {});
    else if (value > 0 && value % 100 === 0) await message.react('🎉').catch(() => {});
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (!await isFeatureEnabled(botId, 'starboard')) return;
      if (!message.guild || !['⭐','🌟'].includes(reaction.emoji.name)) return;
      const settings = await getSettings(botId, message.guild.id, 'starboard');
      if (!settings.channelId || reaction.count < Number(settings.threshold || 3) || message.author?.bot) return;
      const channel = await message.guild.channels.fetch(settings.channelId).catch(() => null);
      if (!channel?.isTextBased()) return;
      const attachment = message.attachments.find(item => item.contentType?.startsWith('image/'));
      const embed = new EmbedBuilder().setColor(0xffd166).setAuthor({ name: message.author?.tag || 'Discord member', iconURL: message.author?.displayAvatarURL?.() })
        .setDescription((message.content || '*No text content*').slice(0, 3500)).addFields({ name: 'Source', value: `[Jump to message](${message.url}) · ${reaction.count} stars` }).setTimestamp(message.createdAt);
      if (attachment) embed.setImage(attachment.url);
      const claim = await db.prepare(`INSERT INTO bot_starboard_posts (bot_id,guild_id,source_message_id,starboard_message_id,channel_id,reaction_count)
        VALUES (?,?,?,NULL,?,?) ON CONFLICT(bot_id,guild_id,source_message_id) DO NOTHING`).run(botId, message.guild.id, message.id, channel.id, reaction.count);
      if (claim.changes) {
        try {
          const sent = await channel.send({ embeds: [embed] });
          await db.prepare('UPDATE bot_starboard_posts SET starboard_message_id=?,reaction_count=?,updated_at=CURRENT_TIMESTAMP WHERE bot_id=? AND guild_id=? AND source_message_id=?')
            .run(sent.id, reaction.count, botId, message.guild.id, message.id);
        } catch (error) {
          await db.prepare('DELETE FROM bot_starboard_posts WHERE bot_id=? AND guild_id=? AND source_message_id=? AND starboard_message_id IS NULL')
            .run(botId, message.guild.id, message.id);
          throw error;
        }
      } else {
        const existing = await db.prepare('SELECT starboard_message_id FROM bot_starboard_posts WHERE bot_id=? AND guild_id=? AND source_message_id=?').get(botId, message.guild.id, message.id);
        if (!existing?.starboard_message_id) return;
        const posted = await channel.messages.fetch(existing.starboard_message_id).catch(() => null);
        if (posted) await posted.edit({ embeds: [embed] });
        else {
          const sent = await channel.send({ embeds: [embed] });
          await db.prepare('UPDATE bot_starboard_posts SET starboard_message_id=?,reaction_count=?,updated_at=CURRENT_TIMESTAMP WHERE bot_id=? AND guild_id=? AND source_message_id=?').run(sent.id, reaction.count, botId, message.guild.id, message.id);
        }
      }
    } catch (error) { log(botId, 'warn', 'starboard', `Reaction processing failed: ${error.message}`); }
  });

  client.on('guildMemberAdd', async member => {
    if (await isFeatureEnabled(botId, 'invite_tracker')) await handleMemberJoin(botId, member, log);
    const stats = await getSettings(botId, member.guild.id, 'server_statistics');
    if (stats.channelId && await isFeatureEnabled(botId, 'server_statistics')) await updateStatsChannel(member.guild, stats, log, botId);
  });
  client.on('guildMemberRemove', async member => {
    const stats = await getSettings(botId, member.guild.id, 'server_statistics');
    if (stats.channelId && await isFeatureEnabled(botId, 'server_statistics')) await updateStatsChannel(member.guild, stats, log, botId);
  });
  client.on('channelCreate', async channel => {
    if (!channel.guild || !await isFeatureEnabled(botId, 'server_statistics')) return;
    const stats = await getSettings(botId, channel.guild.id, 'server_statistics');
    if (stats.channelId) await updateStatsChannel(channel.guild, stats, log, botId);
  });
  client.on('channelDelete', async channel => {
    if (!channel.guild || !await isFeatureEnabled(botId, 'server_statistics')) return;
    const stats = await getSettings(botId, channel.guild.id, 'server_statistics');
    if (stats.channelId) await updateStatsChannel(channel.guild, stats, log, botId);
  });
  client.on('guildCreate', async guild => { if (await isFeatureEnabled(botId, 'invite_tracker')) await cacheInvites(botId, guild, log); });
  client.on('inviteCreate', async invite => { if (invite.guild) await cacheInvites(botId, invite.guild, log); });
  client.on('inviteDelete', async invite => { if (invite.guild) await db.prepare('DELETE FROM bot_invite_cache WHERE bot_id=? AND guild_id=? AND invite_code=?').run(botId, invite.guild.id, invite.code); });
}

function stopAdvancedBot(botId) {
  const timer = birthdayTimers.get(botId);
  if (timer) clearInterval(timer);
  birthdayTimers.delete(botId);
  for (const [key, session] of musicSessions) {
    if (session.botId !== botId) continue;
    session.queue.length = 0;
    session.player.stop(true);
    session.connection.destroy();
    musicSessions.delete(key);
  }
}

module.exports = { executeAdvancedCommand, handleAdvancedButton, registerAdvancedEvents, stopAdvancedBot, getSettings, saveSettings };
