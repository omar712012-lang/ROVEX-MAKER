'use strict';

const express = require('express');
const crypto = require('node:crypto');
const db = require('../config/database');
const { env } = require('../config/env');

const router = express.Router();
const DISCORD_API = 'https://discord.com/api/v10';

router.get('/discord', (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: env.discordClientId,
    redirect_uri: env.discordRedirectUri,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

router.get('/discord/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) throw new Error('Discord authorization was cancelled.');
    const savedState = req.session.oauthState;
    delete req.session.oauthState;
    if (typeof state !== 'string' || typeof savedState !== 'string' || state.length !== savedState.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(savedState))) {
      return res.status(400).render('errors/error', { title: 'Sign-in expired', message: 'The Discord login state did not match. Start the sign-in process again.' });
    }
    if (typeof code !== 'string' || code.length > 3000) throw new Error('Discord did not return a valid authorization code.');

    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.discordClientId,
        client_secret: env.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.discordRedirectUri
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!tokenResponse.ok) throw new Error('Discord could not complete sign-in. Check your OAuth2 redirect URI and application credentials.');
    const oauth = await tokenResponse.json();
    const profileResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${oauth.access_token}` }, signal: AbortSignal.timeout(12000)
    });
    if (!profileResponse.ok) throw new Error('Could not retrieve your Discord profile.');
    const profile = await profileResponse.json();
    const avatar = profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128` : null;

    await db.prepare(`INSERT INTO users (discord_id, username, global_name, avatar, last_login_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(discord_id) DO UPDATE SET username=excluded.username, global_name=excluded.global_name,
      avatar=excluded.avatar, last_login_at=CURRENT_TIMESTAMP`).run(profile.id, profile.username, profile.global_name || null, avatar);
    const user = await db.prepare('SELECT id, discord_id, username, global_name, avatar, is_suspended FROM users WHERE discord_id = ?').get(profile.id);
    if (user.is_suspended) throw new Error('This account has been suspended by the platform administrator.');

    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = user;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.notice = { type: 'success', message: `Signed in as ${user.global_name || user.username}.` };
    res.redirect('/dashboard');
  } catch (error) { next(error); }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('bms.sid');
    res.redirect('/');
  });
});

module.exports = router;
