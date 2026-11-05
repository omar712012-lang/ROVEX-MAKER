'use strict';

const { env } = require('../config/env');
const db = require('../config/database');

async function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  try {
    const status = await db.prepare('SELECT is_suspended FROM users WHERE id = ?').get(req.session.user.id);
    if (!status || status.is_suspended) {
      return req.session.destroy(() => {
        res.clearCookie('bms.sid');
        res.status(403).render('errors/error', { title: 'Account suspended', message: 'This account is currently unavailable. Contact the platform administrator.' });
      });
    }
    next();
  } catch (error) { next(error); }
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  if (!env.adminIds.has(req.session.user.discord_id)) return res.status(403).render('errors/error', { title: 'Access denied', message: 'You do not have administrator access.' });
  next();
}

module.exports = { requireAuth, requireAdmin };
