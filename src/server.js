'use strict';

const fs = require('node:fs');
const path = require('node:path');
const app = require('./app');
const db = require('./config/database');
const { env, validateBaseConfig } = require('./config/env');
const { startBot, stopBot, log } = require('./discord/runtime');
const { encrypt } = require('./services/EncryptionService');
const { initializePlans } = require('./services/PlanService');
const { initializeSaas } = require('./services/SaasService');

async function main() {
  validateBaseConfig();
  await db.init();
  await initializePlans();
  await initializeSaas();
  // Validate that the encryption key is configured before accepting users.
  encrypt('startup-key-check');
  await db.prepare("UPDATE bots SET status = 'offline' WHERE status IN ('online', 'starting')").run();
  const storageDir = path.resolve(process.cwd(), 'storage', 'bots');
  fs.mkdirSync(storageDir, { recursive: true });
  const server = app.listen(env.port, () => console.log(`[HTTP] ROVEX MAKER listening on port ${env.port}`));

  if (env.autoStartBots) {
    const bots = await db.prepare('SELECT id FROM bots WHERE auto_start = 1').all();
    for (const bot of bots) {
      try { await startBot(bot.id); }
      catch (error) { log(bot.id, 'error', 'restore', `Auto-start failed: ${error.message}`); }
    }
  }

  const sessionPruner = setInterval(async () => {
    try { await db.prepare('DELETE FROM sessions WHERE expire <= ?').run(Date.now()); } catch (error) { console.error('[Session cleanup]', error.message); }
  }, 15 * 60 * 1000);
  sessionPruner.unref?.();

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    console.log(`[System] ${signal} received. Stopping bot clients...`);
    clearInterval(sessionPruner);
    for (const botId of [...require('./discord/runtime').runtimeClients.keys()]) {
      await stopBot(botId).catch(() => {});
    }
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', error => console.error('[Unhandled rejection]', error?.message || error));
}

main().catch(error => {
  console.error(`[Startup] ${error.message}`);
  process.exit(1);
});
