'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');

const definitions = [
  new SlashCommandBuilder().setName('ping').setDescription('Show the bot latency.'),
  new SlashCommandBuilder().setName('help').setDescription('Show available commands.'),
  new SlashCommandBuilder().setName('botinfo').setDescription('Show information about this bot.'),
  new SlashCommandBuilder().setName('invite').setDescription('Get an invite link for this bot.'),
  new SlashCommandBuilder().setName('avatar').setDescription('Display a member avatar.')
    .addUserOption(o => o.setName('user').setDescription('Member to inspect.')),
  new SlashCommandBuilder().setName('userinfo').setDescription('Display member information.')
    .addUserOption(o => o.setName('user').setDescription('Member to inspect.')),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Display server information.'),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to ban.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the ban.')),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to kick.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the kick.')),
  new SlashCommandBuilder().setName('timeout').setDescription('Temporarily timeout a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to timeout.').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes (1–40320).').setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the timeout.')),
  new SlashCommandBuilder().setName('unban').setDescription('Unban a user by Discord ID.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o => o.setName('user_id').setDescription('User ID to unban.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the unban.')),
  new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member timeout.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to restore.').setRequired(true)),
  new SlashCommandBuilder().setName('warn').setDescription('Add a moderation warning.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to warn.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the warning.').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('View a member warning history.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to inspect.').setRequired(true)),
  new SlashCommandBuilder().setName('modlogs').setDescription('View a member moderation history.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to inspect.').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Delete up to 100 recent messages.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1–100).').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('slowmode').setDescription('Set this channel slowmode.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o => o.setName('seconds').setDescription('Seconds (0 disables slowmode).').setMinValue(0).setMaxValue(21600).setRequired(true)),
  new SlashCommandBuilder().setName('set-welcome').setDescription('Configure this server welcome channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Welcome channel.').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Welcome message; use {user} and {server}.'))
    .addStringOption(o => o.setName('leave_message').setDescription('Optional leave message; use {user} and {server}.'))
    .addStringOption(o => o.setName('image_url').setDescription('Optional HTTPS welcome image URL.')),
  new SlashCommandBuilder().setName('set-logs').setDescription('Configure this server log channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Log channel.').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('ticket-config').setDescription('Set the staff role that can view tickets.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption(o => o.setName('staff_role').setDescription('Support staff role.').setRequired(true)),
  new SlashCommandBuilder().setName('ticket').setDescription('Create a private support ticket.')
    .addStringOption(o => o.setName('topic').setDescription('What do you need help with?')),
  new SlashCommandBuilder().setName('giveaway').setDescription('Start a free server giveaway.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('prize').setDescription('Giveaway prize.').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes.').setMinValue(1).setMaxValue(10080).setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners.').setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('giveaway-reroll').setDescription('Pick a new winner from an ended giveaway.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID.').setRequired(true)),
  new SlashCommandBuilder().setName('automod-config').setDescription('Configure basic server AutoMod filters.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption(o => o.setName('anti_spam').setDescription('Block rapid repeated messages.'))
    .addBooleanOption(o => o.setName('anti_links').setDescription('Delete links from non-moderators.'))
    .addBooleanOption(o => o.setName('anti_mass_mention').setDescription('Block mass mentions.'))
    .addBooleanOption(o => o.setName('anti_caps').setDescription('Block excessive capital letters.'))
    .addBooleanOption(o => o.setName('anti_raid').setDescription('Alert staff about rapid join spikes.'))
    .addStringOption(o => o.setName('blocked_words').setDescription('Comma-separated blocked words; omit to keep current.')),
  new SlashCommandBuilder().setName('set-level-reward').setDescription('Assign a role reward to a level.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption(o => o.setName('level').setDescription('Required level (1–1000).').setMinValue(1).setMaxValue(1000).setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role to grant at this level.').setRequired(true)),
  new SlashCommandBuilder().setName('shop').setDescription('Browse this server coin shop.'),
  new SlashCommandBuilder().setName('buy').setDescription('Purchase an item from the coin shop.')
    .addStringOption(o => o.setName('item').setDescription('Exact item name from /shop.').setRequired(true)),
  new SlashCommandBuilder().setName('inventory').setDescription('View the virtual items you have purchased.'),
  new SlashCommandBuilder().setName('richest').setDescription('Show the virtual coin leaderboard.'),
  new SlashCommandBuilder().setName('rank').setDescription('View a member level.')
    .addUserOption(o => o.setName('user').setDescription('Member to inspect.')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the server XP leaderboard.'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim your daily virtual coins.'),
  new SlashCommandBuilder().setName('balance').setDescription('View your virtual coin balance.'),
  new SlashCommandBuilder().setName('quiz').setDescription('Answer a short knowledge question to earn coins.'),
  new SlashCommandBuilder().setName('poll').setDescription('Create a simple reaction poll.')
    .addStringOption(o => o.setName('question').setDescription('Poll question.').setRequired(true)),
  new SlashCommandBuilder().setName('embed').setDescription('Post a simple embed in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o.setName('title').setDescription('Embed title.').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Embed description.').setRequired(true))
].map(command => command.toJSON());


const extraDefinitions = [
  new SlashCommandBuilder().setName('play').setDescription('Play an HTTPS Ogg/Opus stream you are authorized to use.')
    .addStringOption(o => o.setName('url').setDescription('Direct HTTPS .ogg or .opus audio stream URL.').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current music stream.'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music playback and clear the queue.'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current music stream.'),
  new SlashCommandBuilder().setName('tempvoice-config').setDescription('Set the lobby channel for temporary voice rooms.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName('channel').setDescription('Join-to-create voice lobby.').addChannelTypes(ChannelType.GuildVoice).setRequired(true)),
  new SlashCommandBuilder().setName('role-button').setDescription('Post a button that lets members assign one approved role.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addChannelOption(o => o.setName('channel').setDescription('Panel text channel.').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Self-assignable role.').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Button label (max 70 characters).').setMaxLength(70)),
  new SlashCommandBuilder().setName('suggestion-config').setDescription('Choose the channel for member suggestions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Suggestions channel.').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('suggest').setDescription('Submit a suggestion to the configured channel.')
    .addStringOption(o => o.setName('text').setDescription('Your suggestion.').setMinLength(5).setMaxLength(1500).setRequired(true)),
  new SlashCommandBuilder().setName('birthday-config').setDescription('Choose the channel for birthday greetings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Birthday announcement channel.').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('birthday-set').setDescription('Save your birthday as MM-DD (year is not collected).')
    .addStringOption(o => o.setName('date').setDescription('Month and day, for example 08-24.').setRequired(true)),
  new SlashCommandBuilder().setName('birthday-remove').setDescription('Remove your saved birthday.'),
  new SlashCommandBuilder().setName('birthday-list').setDescription('List upcoming birthdays in this server.'),
  new SlashCommandBuilder().setName('counting-config').setDescription('Configure a counting channel and starting number.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName('channel').setDescription('Counting text channel.').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addIntegerOption(o => o.setName('start').setDescription('First number (default 1).').setMinValue(0).setMaxValue(1000000)),
  new SlashCommandBuilder().setName('starboard-config').setDescription('Configure the starboard channel and reaction threshold.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Starboard output channel.').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addIntegerOption(o => o.setName('threshold').setDescription('Required star reactions (default 3).').setMinValue(2).setMaxValue(25)),
  new SlashCommandBuilder().setName('verify-config').setDescription('Configure the member verification channel and role.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Verification panel channel.').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role granted after verification.').setRequired(true)),
  new SlashCommandBuilder().setName('verification-panel').setDescription('Post the configured verification button.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('invites').setDescription('Show invite attribution counts for a member.')
    .addUserOption(o => o.setName('user').setDescription('Member to inspect.')),
  new SlashCommandBuilder().setName('stats-config').setDescription('Create or update a live server statistics voice channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName('channel').setDescription('Voice channel to rename.').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
    .addStringOption(o => o.setName('metric').setDescription('Value shown in the channel name.')
      .addChoices({ name: 'Members', value: 'members' }, { name: 'Humans', value: 'humans' }, { name: 'Channels', value: 'channels' } ).setRequired(true)),
  new SlashCommandBuilder().setName('ask').setDescription('Ask the configured AI assistant a question.')
    .addStringOption(o => o.setName('question').setDescription('Question (max 1000 characters).').setMaxLength(1000).setRequired(true)),
  new SlashCommandBuilder().setName('translate').setDescription('Translate text using the configured translation provider.')
    .addStringOption(o => o.setName('text').setDescription('Text to translate (max 1000 characters).').setMaxLength(1000).setRequired(true))
    .addStringOption(o => o.setName('target').setDescription('Target language code, such as ar or en.').setMaxLength(12).setRequired(true))
];

definitions.push(...extraDefinitions.map(command => command.toJSON()));

const featureByCommand = {
  avatar: 'utility', userinfo: 'utility', serverinfo: 'utility', botinfo: 'utility', invite: 'utility', poll: 'utility', embed: 'utility',
  ban: 'moderation', kick: 'moderation', timeout: 'moderation', untimeout: 'moderation', warn: 'moderation',
  warnings: 'moderation', modlogs: 'moderation', clear: 'moderation', lock: 'moderation', unlock: 'moderation', slowmode: 'moderation',
  'set-welcome': 'welcome', 'set-logs': 'logging', 'ticket-config': 'tickets', ticket: 'tickets',
  'set-level-reward': 'leveling', shop: 'economy', buy: 'economy', inventory: 'economy', richest: 'economy',
  giveaway: 'giveaways', 'giveaway-reroll': 'giveaways', 'automod-config': 'automod', unban: 'moderation', rank: 'leveling',
  leaderboard: 'leveling', daily: 'economy', balance: 'economy', quiz: 'economy',
  play: 'music', skip: 'music', stop: 'music', nowplaying: 'music',
  'tempvoice-config': 'temp_voice', 'role-button': 'reaction_roles',
  'suggestion-config': 'suggestions', suggest: 'suggestions',
  'birthday-config': 'birthday', 'birthday-set': 'birthday', 'birthday-remove': 'birthday', 'birthday-list': 'birthday',
  'counting-config': 'counting', 'starboard-config': 'starboard',
  'verify-config': 'verification', 'verification-panel': 'verification',
  invites: 'invite_tracker', 'stats-config': 'server_statistics', ask: 'ai_assistant', translate: 'translator'
};

const features = ['moderation', 'automod', 'welcome', 'tickets', 'giveaways', 'leveling', 'economy', 'logging', 'utility', 'music', 'temp_voice', 'reaction_roles', 'suggestions', 'ai_assistant', 'translator', 'birthday', 'counting', 'starboard', 'verification', 'invite_tracker', 'server_statistics'];

module.exports = { definitions, featureByCommand, features };
