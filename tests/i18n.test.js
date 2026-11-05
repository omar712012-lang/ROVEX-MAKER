'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { translate, localizeHtml } = require('../src/i18n');

test('Arabic language dictionary returns Arabic labels', () => {
  assert.equal(translate('ar', 'my_bots'), 'بوتاتي');
  assert.equal(translate('ar', 'admin_panel'), 'لوحة الإدارة');
});

test('unknown locale falls back to English', () => {
  assert.equal(translate('fr', 'my_bots'), 'My Bots');
});

test('unknown translation keys remain visible for diagnostics', () => {
  assert.equal(translate('ar', 'missing_key'), 'missing_key');
});


test('server-rendered Arabic localization translates public and application copy', () => {
  const html = '<html lang="ar" dir="rtl"><body><h1>Template Marketplace</h1><button>Use template</button><input placeholder="Search templates"></body></html>';
  const localized = localizeHtml(html, 'ar');
  assert.match(localized, /متجر القوالب/);
  assert.match(localized, /استخدم القالب/);
  assert.match(localized, /placeholder="ابحث عن القوالب"/);
});

test('English rendering remains unchanged when Arabic is not selected', () => {
  const html = '<h1>Template Marketplace</h1>';
  assert.equal(localizeHtml(html, 'en'), html);
});

test('Arabic translation supports the newly shipped command descriptions', () => {
  assert.equal(translate('ar', 'Post a button that lets members assign one approved role.'), 'نشر زر يتيح للأعضاء منح أنفسهم رتبة معتمدة.');
  assert.equal(translate('ar', 'Ask the configured AI assistant a question.'), 'طرح سؤال على مساعد الذكاء الاصطناعي المضبوط.');
});


test('Arabic localization covers the new template catalog and provider setup copy', () => {
  assert.equal(translate('ar', 'Voice playback for direct HTTPS Ogg/Opus streams that you are authorized to use. Includes queue, skip, stop and now-playing controls.'), 'تشغيل صوتي لروابط HTTPS مباشرة بصيغة Ogg/Opus تملك تصريح استخدامها، مع قائمة انتظار والتخطي والإيقاف وعرض المقطع الحالي.');
  assert.equal(translate('ar', 'All 25 catalog templates have platform runtime modules. Music requires direct HTTPS Ogg/Opus streams; AI and translation require provider configuration in the bot Integrations page.'), 'تتضمن القوالب الـ25 وحدات تشغيل في المنصة. يتطلب قالب الموسيقى روابط HTTPS مباشرة بصيغة Ogg/Opus، بينما يتطلب الذكاء الاصطناعي والترجمة إعداد مزودي الخدمة في صفحة تكاملات البوت.');
  const html = '<p>Connect external services to this bot. Credentials are encrypted at rest and never returned to the browser.</p><span>Community</span>';
  assert.match(localizeHtml(html, 'ar'), /اربط الخدمات الخارجية بهذا البوت/);
  assert.match(localizeHtml(html, 'ar'), /المجتمع/);
});


test('all template names, descriptions and categories have Arabic equivalents', () => {
  const { catalog } = require('../src/templates/catalog');
  for (const template of catalog) {
    assert.notEqual(translate('ar', template.name), template.name, `${template.id} name is untranslated`);
    assert.notEqual(translate('ar', template.description), template.description, `${template.id} description is untranslated`);
    assert.notEqual(translate('ar', template.category), template.category, `${template.id} category is untranslated`);
  }
});

test('all Discord slash command descriptions and option descriptions are translated', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/discord/commands'), 'utf8');
  const descriptions = [...source.matchAll(/\.setDescription\('([^']*)'\)/g)].map(match => match[1]);
  assert.ok(descriptions.length > 100, 'expected command and option descriptions to be covered');
  for (const description of descriptions) {
    assert.notEqual(translate('ar', description), description, `missing Arabic translation: ${description}`);
  }
});
