'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function required(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.trim().length < minLength) {
    throw new Error(`Missing or invalid environment variable: ${name}`);
  }
  return value.trim();
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  trustProxy: process.env.TRUST_PROXY === '1',
  discordClientId: process.env.DISCORD_CLIENT_ID || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback',
  sessionSecret: process.env.SESSION_SECRET || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  adminIds: new Set((process.env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)),
  maxBotsPerUser: positiveInteger(process.env.MAX_BOTS_PER_USER, 50),
  maxRunningBots: positiveInteger(process.env.MAX_RUNNING_BOTS, 15),
  maxLogRowsPerBot: positiveInteger(process.env.MAX_LOG_ROWS_PER_BOT, 500, 100),
  autoStartBots: process.env.AUTO_START_BOTS !== 'false',
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || './data'),
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  databaseSslStrict: process.env.DATABASE_SSL_STRICT !== 'false',
  databasePoolSize: positiveInteger(process.env.DATABASE_POOL_SIZE, 5),
  isProduction: (process.env.NODE_ENV || 'development') === 'production'
};

function validateBaseConfig() {
  if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  if (env.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }
  if (!env.discordClientId || !env.discordClientSecret) {
    throw new Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.');
  }
  if (!/^https?:\/\//i.test(env.discordRedirectUri)) {
    throw new Error('DISCORD_REDIRECT_URI must be an absolute HTTP(S) URL.');
  }
  if (env.isProduction && !env.discordRedirectUri.startsWith('https://')) {
    throw new Error('DISCORD_REDIRECT_URI must use HTTPS in production.');
  }
}

module.exports = { env, required, positiveInteger, validateBaseConfig };
