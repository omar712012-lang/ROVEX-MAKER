'use strict';

const crypto = require('node:crypto');
const db = require('../config/database');
const { catalog, validateTemplate } = require('../templates/catalog');
const { definitions, features } = require('../discord/commands');

async function initializeSaas() {
  const supportedCommands = definitions.map(command => command.name);
  for (const manifest of catalog) {
    const check = validateTemplate(manifest, supportedCommands, features);
    if (!check.valid && manifest.support === 'ready') {
      throw new Error(`Invalid template manifest ${manifest.id}: ${[...check.unknownCommands, ...check.unknownFeatures].join(', ')}`);
    }
    const definition = JSON.stringify(manifest);
    const existing = await db.prepare('SELECT status,uses_count,definition_json FROM templates WHERE id=?').get(manifest.id);
    if (!existing) {
      await db.prepare(`INSERT INTO templates (id,name,category,description,version,status,min_plan,definition_json)
        VALUES (?,?,?,?,?,?,?,?)`).run(manifest.id, manifest.name, manifest.category, manifest.description, manifest.version, manifest.support === 'ready' ? 'published' : 'preview', manifest.minPlan, definition);
    } else if (existing.status === 'preview' && Number(existing.uses_count || 0) === 0) {
      let previous = null;
      try { previous = JSON.parse(existing.definition_json || '{}'); } catch {}
      // Upgrade only untouched built-in preview manifests; never publish drafts or hidden templates implicitly.
      if (previous?.id === manifest.id && previous?.name === manifest.name && previous?.support === 'preview' && manifest.support === 'ready') {
        await db.prepare(`UPDATE templates SET category=?,description=?,version=?,status='published',min_plan=?,definition_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='preview'`)
          .run(manifest.category, manifest.description, manifest.version, manifest.minPlan, definition, manifest.id);
      }
    }
    await db.prepare(`INSERT INTO template_versions (id,template_id,version,definition_json,changelog)
      VALUES (?,?,?,?,?) ON CONFLICT(template_id,version) DO NOTHING`)
      .run(crypto.randomUUID(), manifest.id, manifest.version, definition, manifest.version === '1.1.0' ? 'Added complete runtime module support and updated Discord integration requirements.' : 'Initial catalog manifest.');
  }
}

async function notify(userId, kind, title, message) {
  return db.prepare('INSERT INTO notifications (id,user_id,kind,title,message) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), userId, String(kind).slice(0,60), String(title).slice(0,120), String(message).slice(0,1000));
}

async function audit(actorUserId, action, target, details = '') {
  return db.prepare('INSERT INTO platform_audit_logs (id,actor_user_id,action,target,details) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), actorUserId || null, String(action).slice(0,100), String(target).slice(0,200), String(details).slice(0,1000));
}

module.exports = { initializeSaas, notify, audit };
