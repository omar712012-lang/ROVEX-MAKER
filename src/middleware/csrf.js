'use strict';

const crypto = require('node:crypto');

function csrfProtection(req, res, next) {
  if (!req.session) return next(new Error('Session middleware must run before CSRF protection.'));
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const submitted = req.body?._csrf || req.get('x-csrf-token');
    const expected = req.session.csrfToken;
    const valid = typeof submitted === 'string' && submitted.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
    if (!valid) return res.status(403).render('errors/error', { title: 'Request rejected', message: 'The security token is missing or expired. Refresh the page and try again.' });
  }
  next();
}

module.exports = csrfProtection;
