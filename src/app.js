'use strict';

const express = require('express');
const path = require('node:path');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { env } = require('./config/env');
const { translate, localizeHtml } = require('./i18n');
const SQLiteSessionStore = require('./services/SQLiteSessionStore');
const csrfProtection = require('./middleware/csrf');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const botRoutes = require('./routes/bots');
const saasRoutes = require('./routes/saas');

const app = express();
app.disable('x-powered-by');
if (env.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: env.isProduction ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.urlencoded({ extended: false, limit: '25kb' }));
app.use(express.json({ limit: '25kb' }));
app.use(express.static(path.join(process.cwd(), 'public'), { maxAge: env.isProduction ? '1h' : 0 }));
app.use(session({
  name: 'bms.sid',
  store: new SQLiteSessionStore(),
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.isAdmin = Boolean(req.session.user && env.adminIds.has(req.session.user.discord_id));
  res.locals.notice = req.session.notice || null;
  res.locals.formError = req.session.formError || null;
  delete req.session.notice;
  delete req.session.formError;
  res.locals.currentPath = req.path;
  res.locals.lang = req.session.lang === 'ar' ? 'ar' : 'en';
  res.locals.dir = res.locals.lang === 'ar' ? 'rtl' : 'ltr';
  res.locals.t = key => translate(res.locals.lang, key);
  res.locals.tr = phrase => translate(res.locals.lang, phrase);

  // Apply one consistent server-side UI translation pass to every EJS page.
  const originalRender = res.render.bind(res);
  res.render = (view, options, callback) => {
    const hasOptionsFunction = typeof options === 'function';
    const renderOptions = hasOptionsFunction ? {} : options;
    const renderCallback = hasOptionsFunction ? options : callback;
    return originalRender(view, renderOptions, (error, html) => {
      if (error) {
        if (renderCallback) return renderCallback(error);
        return next(error);
      }
      const localized = localizeHtml(html, res.locals.lang);
      if (renderCallback) return renderCallback(null, localized);
      return res.send(localized);
    });
  };
  next();
});
app.use(csrfProtection);
app.post('/language', (req, res) => {
  req.session.lang = req.body.language === 'ar' ? 'ar' : 'en';
  const referer = req.get('referer') || '/dashboard';
  let destination = '/dashboard';
  try { const url = new URL(referer); if (url.host === req.get('host')) destination = `${url.pathname}${url.search}`; } catch {}
  req.session.save(error => {
    if (error) return res.status(500).send('Unable to save language preference.');
    res.redirect(destination);
  });
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: 'Too many requests. Please try again later.' });
const botActionLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false });

app.get('/', (req, res) => req.session.user ? res.redirect('/dashboard') : res.render('landing', { title: 'ROVEX MAKER — Discord Bot Platform' }));
app.get('/login', (req, res) => req.session.user ? res.redirect('/dashboard') : res.render('auth/login', { title: 'Sign in' }));
app.use('/auth', authLimiter, authRoutes);
app.use('/api/v1', apiLimiter);
app.use('/', saasRoutes);
app.use('/', dashboardRoutes);
app.use('/', botActionLimiter, botRoutes);

app.use((req, res) => res.status(404).render('errors/error', { title: 'Page not found', message: 'The page you requested does not exist.' }));
app.use((error, req, res, next) => {
  // Do not log request bodies or credentials; error messages only.
  console.error(`[HTTP] ${req.method} ${req.path}: ${error.message}`);
  if (res.headersSent) return next(error);
  const message = env.isProduction ? 'An unexpected error occurred. Please try again.' : error.message;
  res.status(500).render('errors/error', { title: 'Something went wrong', message });
});

module.exports = app;
