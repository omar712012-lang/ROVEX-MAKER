# ROVEX MAKER V3 — Discord Bot SaaS Platform

ROVEX MAKER is a multi-user Discord bot management platform built with Node.js, Express 5, EJS, discord.js v14 and a SQLite/PostgreSQL database adapter. It combines a validated template marketplace, a step-based bot builder, per-bot runtime control, SaaS plan enforcement, workspace access, notifications and administration tools.

> **Runtime and billing disclosure:** Discord clients run inside the same Node.js process as the website. A sleeping or suspended host interrupts those Gateway connections. No payment processor is connected by default, and plan upgrades made by an administrator are manual subscription changes—not payments or invoices.

## Stack and requirements

- Node.js 22.12.0 or later (required by the pinned dependency set).
- Express 5, EJS and discord.js 14.
- SQLite via `better-sqlite3` by default; PostgreSQL via `pg` when `DATABASE_URL` is set.
- `express-session` with a persistent database-backed session store.
- Discord OAuth2 (`identify` scope); Discord bot tokens are submitted only to the backend and encrypted with AES-256-GCM.
- No Docker or Redis requirement.

## Install and configure

```bash
cp .env.example .env
npm install
```

Configure `.env`:

```dotenv
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000
DISCORD_CLIENT_ID=YOUR_DISCORD_APPLICATION_ID
DISCORD_CLIENT_SECRET=YOUR_OAUTH_CLIENT_SECRET
DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback
SESSION_SECRET=YOUR_LONG_RANDOM_SECRET
ENCRYPTION_KEY=YOUR_32_BYTE_BASE64_KEY
ADMIN_IDS=YOUR_DISCORD_USER_ID
DATA_DIR=./data
DATABASE_URL=
DATABASE_SSL=false
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use the first value as `SESSION_SECRET`. The decoded `ENCRYPTION_KEY` must be exactly 32 bytes. Keep both secrets outside source control. Losing the encryption key makes previously stored bot tokens unrecoverable. Configure the Discord OAuth2 redirect URL to exactly match `DISCORD_REDIRECT_URI`.

Start the application:

```bash
npm start
```

Open `http://localhost:3000`. Sign in with Discord, select a published template, complete the builder, then provide the bot token. The backend validates the token with Discord before encrypting and saving it. The token is never returned to the browser.

## V3 capabilities

### Template Marketplace

The database is seeded with 25 versioned template manifests. Search, category filtering, free/premium filtering, popularity/newest/name sorting, featured entries, details, favorites and template installation routes are included.

**All 25 catalog templates are installable** because their commands and feature modules map to trusted code shipped in `src/discord/commands.js`, `src/discord/runtime.js` and `src/discord/advancedModules.js`:

- General Bot
- Advanced Moderation Bot
- Community Bot
- Welcome Bot
- Ticket Support Bot
- Giveaway Bot
- Leveling Bot
- Economy Bot
- Gaming Bot
- Protection Bot
- Auto Moderation Bot
- Logging Bot
- Social Bot
- Server Statistics Bot

The 25 templates share the same trusted runtime modules; they are not separate copies of bot code. External integrations are configurable per bot. Music is intentionally restricted to direct public HTTPS Ogg/Opus streams that the operator is authorized to use; AI requires an OpenAI API key; translation requires a LibreTranslate-compatible endpoint and may require its API key. These provider integrations are not bundled as paid services.

Template manifests include version, category, description, commands, features, events, permissions, Gateway intents, dependencies, default settings and minimum plan. Runtime compatibility is validated against the shipped command/module allowlists. Admin-created templates can select only trusted modules and commands; arbitrary user JavaScript and `eval` are not supported. Published custom template updates create a new version record and are placed back into preview for review; existing installed bot settings are stored separately.

### Template Builder and bot runtime

The builder provides template selection, bot information, token entry, feature selection, command selection, permission/intent review and a final create action. Creation saves the encrypted credential, bot row, per-bot settings, feature and command switches, template version metadata and storage directory, then registers the bot with the runtime manager.

The Bot Manager uses one Discord.js client per bot inside the main Node.js process. Start admission is serialized so concurrent start requests cannot race the platform/per-plan limits. Runtime state is derived from the connected client and Discord Gateway lifecycle. Enabling or disabling a feature while a bot is running restarts that client to apply the minimum Gateway intents for the enabled modules.

Per-bot runtime metrics include real client uptime, Gateway ping and guild-cache count when connected. Process RSS is process-wide memory, not isolated memory per bot. Per-bot CPU usage is not currently implemented and is not reported as a real metric.

### SaaS plans and usage enforcement

Plan limits are enforced by server-side services, not only by the UI:

| Plan | Total bots | Concurrent running bots | Retained log rows per bot | Teams | Premium template eligibility |
|---|---:|---:|---:|---|---|
| Free | 2 | 1 | 200 | No | No |
| Starter | 5 | 3 | 1,000 | No | Yes |
| Pro | 15 | 8 | 5,000 | No | Yes |
| Business | 50 | 15 | 15,000 | Yes | Yes |

The global `MAX_BOTS_PER_USER` and `MAX_RUNNING_BOTS` environment settings provide additional ceilings; the lower of the plan and platform limit applies. These values are product limits, not a promise that a host can support that many connected clients. Measure RAM, CPU, outbound WebSocket capacity and database performance before increasing them.

Subscriptions, plans, usage records, invoice records and payment-event idempotency records are represented in the schema. The app does not include a payment gateway, checkout session, signed provider webhook verifier or automatic invoice issuer. Until a provider integration is configured and tested, `/subscription` records a request and an administrator can manually assign a plan. That admin action changes access limits only; it does not collect money.

### EJS interface and Arabic RTL

The public site, authentication, bot workspace, marketplace, integrations, SaaS pages and administration use the same EJS partial system and premium dark design tokens. All 24 EJS view files are syntax-checked; shared server-side localization covers the visible static interface, all 25 template names/descriptions/categories and all slash-command/option descriptions. Select Arabic from the language control on the public or signed-in navigation; the preference is stored in the session and the rendered document uses `lang="ar"` and `dir="rtl"`. URLs, bot IDs, Discord identifiers, code samples and user-provided content remain in their original form.

### Workspaces, notifications and administration

- Workspaces can be created by eligible plan owners, registered Discord users can be invited by user ID, and workspace roles are `owner`, `administrator`, `developer` and `viewer`.
- Shared bot access is checked in backend routes. Viewer roles are read-only; owner controls workspace membership and linked bots.
- Notifications support listing, unread counts, read-one, read-all and delete actions.
- Admin routes include template draft/update/publish/hide/delete controls, user and bot views, subscription plan assignment, payment-record review, audit logs, platform analytics, settings and system health.
- Manual plan changes and administrative operations are audit logged.

### Documentation and REST API

The documentation center includes Getting Started, first bot creation, template installation, commands, features, Discord permissions, Gateway intents, troubleshooting, API and hosting guidance. Authenticated REST endpoints are under `/api/v1`; they use the signed-in session and CSRF protection for writes, and include templates, bots, usage, notifications, command/feature switches, individual and bulk bot controls (up to 20 IDs per request), and workspace access.

## Template permissions and Gateway intents

Grant only the permissions displayed on each template details page. The runtime derives intents from enabled modules: `Guilds` is the base intent; `GuildMembers` is added for welcome, logging, birthdays, invite tracking, verification and server statistics; `GuildMessages` plus privileged `MessageContent` are added for leveling, AutoMod, counting and Starboard; `GuildVoiceStates` is added for music and temporary voice rooms; `GuildMessageReactions` is added for Starboard; and `GuildInvites` is added for invite tracking. Privileged intents must also be enabled in the Discord Developer Portal and may require approval for some applications. Discord permission and role hierarchy checks still apply inside the server.

## Database and migrations

Leave `DATABASE_URL` blank for SQLite. Set a PostgreSQL connection string to use `pg`; `DATABASE_SSL` and `DATABASE_SSL_STRICT` control TLS settings. Existing core tables are preserved; the V3 schema adds templates, template versions, favorites, plans, subscriptions, usage, invoices, payment events, workspaces, workspace members/bots, notifications, integrations, announcements and platform audit logs. A partial unique index enforces at most one active subscription per user after cleanup of historical duplicates.

Back up the database before upgrades. SQLite storage in `DATA_DIR` must be persistent. PostgreSQL adapter SQL and schema are included, but a live external PostgreSQL service is required to verify network, credentials, TLS and provider-specific deployment behavior.

## Security

- AES-256-GCM bot token encryption. Raw tokens are not rendered, put in local storage or returned by API endpoints.
- Discord OAuth2; no Discord account passwords are collected.
- Express session storage, CSRF checks, Helmet security headers, rate limiting and parameterized database access.
- Bot ownership and workspace role authorization are checked server-side.
- Admin access is restricted to Discord IDs in `ADMIN_IDS`.
- Template builders and admin template forms accept only built-in module/command identifiers and allowed Discord event names; no custom script execution.
- API responses omit encrypted token columns.

Use HTTPS and `NODE_ENV=production` in production. Set `TRUST_PROXY=1` only behind a trusted reverse proxy. Protect `.env`, database backups and the encryption key.

## Hosting constraints

- A host that sleeps, suspends long-running processes or blocks persistent outbound WebSockets disconnects managed bots.
- Use a persistent process with stable outbound WebSocket access and persistent disk (SQLite) or managed PostgreSQL.
- This release is a single-process runtime design. Do not run multiple replicas with the same database and claim safe multi-instance bot ownership; there is no distributed worker lease/ownership system.
- Multiple bots share one Node process. Memory pressure or a process restart affects every managed bot. Start with low runtime limits and increase only after load testing.
- Music requires `@discordjs/voice`, outbound UDP support and a direct HTTPS Ogg/Opus stream. The runtime does not scrape or bypass commercial streaming services.
- AI requires an OpenAI API key configured in the per-bot Integrations page. Translation requires a LibreTranslate-compatible endpoint; configure `TRANSLATE_API_URL` and, when required, the per-bot API key. External provider charges are billed by those providers, not by ROVEX MAKER.
- No free hosting provider is guaranteed to keep the site or bots online 24/7.

## Tests and validation

```bash
npm run check
npm test
```

`npm run check` syntax-checks JavaScript source, browser scripts, tests and build scripts, and parses the EJS blocks in every view file. Tests cover encryption, Arabic/English server-side localization, catalog manifests and runtime compatibility, builder command-feature parity, SQLite SaaS tables, relationships and active-subscription uniqueness. The catalog compatibility test checks each installable manifest against the shipped slash-command and feature allowlists, without needing to log in to Discord. The local SQLite schema tests use `better-sqlite3` when installed and Node’s built-in SQLite fallback on newer Node versions. Live OAuth, Gateway connection, PostgreSQL connectivity, Discord permission hierarchy and deployment load tests require credentials and services external to this repository.

## Project structure

```text
src/
  app.js, server.js
  config/          database adapter, schema and migrations
  controllers/     (reserved for future controller extraction)
  middleware/      authentication and CSRF
  routes/          OAuth, dashboard, bots and SaaS/API routes
  services/        encryption, session store, plans and SaaS services
  templates/       trusted manifest catalog
  discord/         slash-command definitions and bot runtime
views/             EJS pages and reusable partials
public/             CSS, browser JavaScript and ROVEX MAKER artwork
storage/bots/       per-bot metadata directories
 database/          database-related project assets
 tests/              automated tests
```

## ROVEX MAKER brand

The landing page uses `public/images/rovex-maker-hero.webp`, coordinated midnight-blue/electric-blue/violet/cyan styling and the `discord.gg/rovex` brand identity. Arabic is selectable from both the public navigation and authenticated application navigation. The server-side EJS localization layer translates the shipped interface copy and sets `lang="ar"` with `dir="rtl"`; dynamic user content and identifiers remain unchanged. Copyright attribution in the artwork: `© 2026 ROVEX MAKER. All rights reserved.`
