'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { catalog, getInstallableTemplates, getRequiredIntents, validateTemplate } = require('../src/templates/catalog');

function readRuntimeAllowlist() {
  const source = fs.readFileSync(require.resolve('../src/discord/commands').replace(/commands\.js$/, 'commands.js'), 'utf8');
  const commandNames = [...source.matchAll(/new SlashCommandBuilder\(\)\.setName\('([^']+)'/g)].map(match => match[1]);
  const featureBlock = source.match(/const features = \[([^\]]+)\]/);
  const featureNames = featureBlock ? [...featureBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]) : [];
  return { commandNames, featureNames };
}

test('catalog contains 25 unique template manifests', () => {
  assert.equal(catalog.length, 25);
  assert.equal(new Set(catalog.map(item => item.id)).size, 25);
  for (const item of catalog) {
    assert.ok(item.name && item.description && item.category && item.version);
    assert.ok(['free', 'starter', 'pro', 'business'].includes(item.minPlan));
    assert.ok(Array.isArray(item.commands));
    assert.ok(Array.isArray(item.features));
    assert.ok(Array.isArray(item.intents));
    assert.ok(Array.isArray(item.permissions));
  }
});

test('installable manifests only reference runtime commands and features', () => {
  const { commandNames, featureNames } = readRuntimeAllowlist();
  const source = fs.readFileSync(require.resolve('../src/discord/commands'), 'utf8');
  const mappingBlock = source.match(/const featureByCommand = \{([\s\S]*?)\};/);
  const mappings = Object.fromEntries([...mappingBlock[1].matchAll(/(?:'([^']+)'|([A-Za-z][A-Za-z0-9_-]*))\s*:\s*'([^']+)'/g)].map(match => [match[1] || match[2], match[3]]));
  for (const item of getInstallableTemplates()) {
    const result = validateTemplate({ commands:item.commands, features:item.features }, commandNames, featureNames);
    assert.equal(item.support, 'ready');
    assert.ok(item.commands.length > 0, `${item.id} has no commands`);
    assert.ok(item.features.length > 0, `${item.id} has no modules`);
    assert.equal(result.valid, true, `${item.id}: ${[...result.unknownCommands, ...result.unknownFeatures].join(', ')}`);
    for (const command of item.commands) {
      if (mappings[command]) assert.ok(item.features.includes(mappings[command]), `${item.id}: /${command} requires ${mappings[command]}`);
    }
  }
  assert.equal(getInstallableTemplates().length, 25);
});

test('all 25 published manifests are installable and backed by shipped runtime modules', () => {
  const previews = catalog.filter(item => item.support === 'preview');
  assert.equal(previews.length, 0);
  assert.ok(catalog.every(item => item.support === 'ready'), 'all published catalog templates have runtime modules in this release');
});

test('gateway intents follow the enabled modules and do not request extras', () => {
  assert.deepEqual(getRequiredIntents([]), ['Guilds']);
  assert.deepEqual(getRequiredIntents(['welcome']), ['Guilds', 'GuildMembers']);
  assert.deepEqual(getRequiredIntents(['automod']), ['Guilds', 'GuildMessages', 'MessageContent']);
  assert.deepEqual(getRequiredIntents(['welcome', 'logging', 'leveling']), ['Guilds', 'GuildMembers', 'GuildMessages', 'MessageContent']);
  assert.deepEqual(getRequiredIntents(['music', 'temp_voice']), ['Guilds', 'GuildVoiceStates']);
  assert.deepEqual(getRequiredIntents(['starboard']), ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMessageReactions']);
  assert.deepEqual(getRequiredIntents(['invite_tracker']), ['Guilds', 'GuildMembers', 'GuildInvites']);
  assert.deepEqual(getRequiredIntents(['birthday', 'verification', 'server_statistics']), ['Guilds', 'GuildMembers']);
});


test('builder command dependency map matches the backend command feature map', () => {
  const backend = fs.readFileSync(require.resolve('../src/discord/commands'), 'utf8');
  const frontend = fs.readFileSync(require.resolve('../public/js/app.js'), 'utf8');
  const extract = (source, regex) => {
    const block = source.match(regex);
    assert.ok(block, 'feature map must exist');
    return Object.fromEntries([...block[1].matchAll(/(?:'([^']+)'|([A-Za-z][A-Za-z0-9_-]*))\s*:\s*'([^']+)'/g)].map(match => [match[1] || match[2], match[3]]));
  };
  const backendMap = extract(backend, /const featureByCommand = \{([\s\S]*?)\n\};/);
  const frontendMap = extract(frontend, /const commandFeature = \{([\s\S]*?)\n  \};/);
  for (const [command, feature] of Object.entries(backendMap)) assert.equal(frontendMap[command], feature, `builder must map /${command} to ${feature}`);
});
