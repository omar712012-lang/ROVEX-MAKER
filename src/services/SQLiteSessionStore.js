'use strict';

const session = require('express-session');
const db = require('../config/database');

class DatabaseSessionStore extends session.Store {
  async get(sid, callback) {
    try {
      const row = await db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid);
      if (!row || Number(row.expire) <= Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  async set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      await db.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire`).run(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (error) { callback(error); }
  }
  async touch(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      await db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expires, sid);
      callback(null);
    } catch (error) { callback(error); }
  }
  async destroy(sid, callback = () => {}) {
    try { await db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
  async prune() { await db.prepare('DELETE FROM sessions WHERE expire <= ?').run(Date.now()); }
}

module.exports = DatabaseSessionStore;
