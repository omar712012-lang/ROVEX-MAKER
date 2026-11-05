'use strict';

const express = require('express');
const crypto = require('node:crypto');
const db = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { catalog } = require('../templates/catalog');
const { definitions, features, featureByCommand } = require('../discord/commands');
const { validateTemplate, getRequiredIntents } = require('../templates/catalog');
const { plans, getUserPlan, assertCanUseTemplate } = require('../services/PlanService');
const { notify, audit } = require('../services/SaasService');
const { encrypt } = require('../services/EncryptionService');
const runtime = require('../discord/runtime');

const router = express.Router();
const docs = [
  ['getting-started','Getting Started','Connect Discord OAuth, configure the encryption key and create your first bot.'],
  ['first-bot','Creating Your First Bot','Create a Discord application, enable the required intents, then add the bot token in the builder.'],
  ['templates','Installing Templates','Choose a published manifest. Preview-only templates clearly list missing runtime modules.'],
  ['commands','Managing Commands','Toggle supported Slash Commands and synchronize them while the bot is online.'],
  ['features','Managing Features','Enable or disable supported runtime modules independently for each bot.'],
  ['permissions','Discord Permissions','Grant only the permissions listed by the selected template and Discord command needs.'],
  ['intents','Gateway Intents','Enable privileged intents in the Discord Developer Portal where the template requires them.'],
  ['troubleshooting','Troubleshooting','Review bot logs, gateway state, token validity and hosting process limits.'],
  ['api','API Guide','Use authenticated JSON endpoints under /api. Session authentication and CSRF protection apply to writes.'],
  ['hosting','Hosting Guide','Use persistent storage, stable outbound connections and a long-running Node.js process.']
].map(([slug,title,body]) => ({slug,title,body}));
const publicPages = {
  '/about': ['About ROVEX MAKER','A Discord bot management workspace built around reusable, validated runtime modules.'],
  '/features': ['Platform Features','Create bots, install supported templates, manage commands, inspect logs and control runtime sessions.'],
  '/changelog': ['Changelog','V3 introduces template manifests, plan enforcement, SaaS workspace records, notifications and API routes.'],
  '/faq': ['Frequently Asked Questions','Answers about bot tokens, intents, plans, hosting and template availability.'],
  '/terms': ['Terms of Service','Use the platform lawfully, protect bot tokens and follow Discord Developer Terms and applicable platform rules.'],
  '/privacy': ['Privacy Policy','Discord profile data, encrypted bot credentials and platform activity records are stored only for platform operation.']
};

function page(res, title, description, options = {}) {
  return res.render('saas/page', { title, description, stats: options.stats || [], items: options.items || [], links: options.links || [], table: options.table || null, chart: options.chart || null, notice: options.notice || null, form: options.form || null, lang: res.locals.lang });
}

function splitList(value, max = 40) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map(item => String(item).trim()).filter(Boolean))].slice(0, max);
}
function buildDailyChart(rows, field = 'created_at') {
  const start = new Date();
  start.setUTCHours(0,0,0,0);
  start.setUTCDate(start.getUTCDate() - 6);
  const counts = new Map();
  for (const row of rows) {
    const raw = String(row[field] || '');
    const parsed = new Date(raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z'));
    if (Number.isNaN(parsed.getTime())) continue;
    const key = parsed.toISOString().slice(0,10);
    counts.set(key,(counts.get(key)||0)+1);
  }
  const points = Array.from({length:7},(_,index)=>{
    const date=new Date(start.getTime()+index*86400000);
    const key=date.toISOString().slice(0,10);
    return {date:key,label:date.toLocaleDateString('en',{weekday:'short',timeZone:'UTC'}),value:counts.get(key)||0};
  });
  const max=Math.max(1,...points.map(point=>point.value));
  points.forEach(point=>{point.height=point.value?Math.max(7,Math.round(point.value/max*100)):2;});
  return {title:'Activity · last 7 days',points};
}

function semverGreater(next, current) {
  const parse = value => /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(value||''));
  const a=parse(next),b=parse(current); if(!a||!b)return false;
  for(let i=1;i<=3;i++){const x=Number(a[i]),y=Number(b[i]);if(x!==y)return x>y;}
  return false;
}
function buildManifest(body, id, current = null) {
  const name=String(body.name||'').trim();
  const category=String(body.category||'').trim();
  const description=String(body.description||'').trim();
  const minPlan=String(body.min_plan||'free');
  const version=String(body.version||'1.0.0').trim();
  const selectedFeatures=splitList(body.features);
  const selectedCommands=splitList(body.commands);
  const permissions=splitList(body.permissions,30);
  const requestedIntents=splitList(body.intents,15);
  const requiredIntents=getRequiredIntents(selectedFeatures);
  const intents=[...new Set([...requiredIntents,...requestedIntents])];
  const events=splitList(body.events,30);
  const allowedEvents=new Set(['interactionCreate','messageCreate','guildMemberAdd','guildMemberRemove','messageDelete','messageUpdate','guildCreate','guildDelete','shardDisconnect','shardReconnecting','voiceStateUpdate','messageReactionAdd','inviteCreate','inviteDelete','channelCreate','channelDelete','ready']);
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)||id.length>48)throw new Error('Template ID must use lowercase letters, numbers and hyphens.');
  if(name.length<3||name.length>80||category.length<2||category.length>40||description.length<20||description.length>500)throw new Error('Name, category or description length is invalid.');
  if(!plans.some(plan=>plan.key===minPlan))throw new Error('Select a valid minimum plan.');
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Version must use semantic versioning, such as 1.0.0.');
  if(!selectedFeatures.length||!selectedCommands.length)throw new Error('A template must include at least one supported feature and command.');
  const compatibility=validateTemplate({features:selectedFeatures,commands:selectedCommands},definitions.map(item=>item.name),features);
  if(!compatibility.valid)throw new Error(`Unsupported runtime items: ${[...compatibility.unknownFeatures,...compatibility.unknownCommands].join(', ')}`);
  const mismatched=selectedCommands.filter(command=>featureByCommand[command]&&!selectedFeatures.includes(featureByCommand[command]));
  if(mismatched.length)throw new Error(`These commands require disabled modules: ${mismatched.join(', ')}`);
  const safeList = (values, label) => {
    if(values.some(value=>value.length>80||!/^[A-Za-z][A-Za-z0-9_. -]*$/.test(value)))throw new Error(`${label} contains an invalid entry.`);
    return values;
  };
  safeList(permissions,'Permissions'); safeList(intents,'Gateway intents'); safeList(events,'Events');
  if(events.some(event=>!allowedEvents.has(event)))throw new Error('Events must be selected from the runtime event handlers shipped by the platform.');
  return {id,name,version,description,category,commands:selectedCommands,events,features:selectedFeatures,dependencies:[],intents,requiredIntents,permissions,requiredPermissions:permissions,defaultSettings:current?.defaultSettings||{},minPlan,support:'ready',featured:Boolean(current?.featured),commandsCount:selectedCommands.length,featuresCount:selectedFeatures.length,updatedAt:new Date().toISOString().slice(0,10)};
}

router.get('/about', (req,res) => page(res, ...publicPages['/about'], { links:[{label:'Explore templates',href:'/templates'}] }));
router.get('/features', (req,res) => page(res, ...publicPages['/features'], { items:['Template Marketplace with installability checks','Per-bot command and feature controls','Encrypted Discord bot token storage','SQLite and PostgreSQL adapters','Role-protected workspace administration','Runtime state and Discord gateway logs'] }));
for (const [routePath, content] of Object.entries(publicPages)) {
  if (routePath === '/about' || routePath === '/features') continue;
  router.get(routePath, (req, res) => page(res, content[0], content[1], { links: routePath === '/faq' ? [{label:'Documentation',href:'/docs'},{label:'Template Marketplace',href:'/templates'}] : [] }));
}
router.get('/pricing', async (req,res) => page(res,'Plans & Pricing','No prices or paid checkout are published until a payment provider is configured.', { items: plans.map(p => `${p.name}: ${p.botLimit} bots, ${p.runningLimit} running at once, ${p.logLimit} retained logs. ${p.teams ? 'Teams enabled.' : 'Single-user workspace.'}`), notice:'Paid subscription checkout is not configured. Plan upgrades can only be made by a platform administrator until a verified payment provider and webhook are connected.' }));
router.get('/templates', async (req,res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim();
  const sort = ['popular','newest','name'].includes(req.query.sort) ? req.query.sort : 'popular';
  const tier = ['free','premium'].includes(req.query.tier) ? req.query.tier : '';
  let templates = await db.prepare(`SELECT t.*, CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END AS favorite
    FROM templates t LEFT JOIN user_favorites f ON f.template_id=t.id AND f.user_id=?
    WHERE t.status <> 'hidden' AND (?='' OR lower(t.name) LIKE ? OR lower(t.description) LIKE ?)
      AND (?='' OR t.category=?) AND (?='' OR (?='free' AND t.min_plan='free') OR (?='premium' AND t.min_plan<>'free')) ORDER BY ${sort === 'newest' ? 't.updated_at DESC' : sort === 'name' ? 't.name ASC' : 't.uses_count DESC, t.name ASC'}`).all(req.session.user?.id || -1, q, `%${q}%`, `%${q}%`, category, category, tier, tier, tier);
  const featuredTemplates=templates.filter(t=>JSON.parse(t.definition_json).featured).slice(0,5);
  const categories = (await db.prepare('SELECT DISTINCT category FROM templates WHERE status<>? ORDER BY category').all('hidden')).map(row=>row.category);
  res.render('saas/marketplace', { title:'Template Marketplace', templates, featuredTemplates, categories, query:q, selectedCategory:category, sort, tier });
});
router.get('/template-categories', async (req,res) => {
  const rows = await db.prepare('SELECT category, COUNT(*) AS total, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS published FROM templates GROUP BY category ORDER BY category').all('published');
  page(res,'Template Categories','Browse manifests by category. Installability is checked against the runtime modules actually shipped.', { items:rows.map(r=>`${r.category}: ${r.published || 0} installable / ${r.total} catalog entries`), links:rows.map(r=>({label:r.category,href:`/templates?category=${encodeURIComponent(r.category)}`})) });
});
router.get('/templates/:id', async (req,res) => {
  const row = await db.prepare('SELECT * FROM templates WHERE id=? AND status<>?').get(req.params.id,'hidden');
  if (!row) return res.status(404).render('errors/error',{title:'Template not found',message:'This template does not exist.'});
  const manifest = JSON.parse(row.definition_json);
  const favorite = req.session.user ? await db.prepare('SELECT 1 AS yes FROM user_favorites WHERE user_id=? AND template_id=?').get(req.session.user.id,row.id) : null;
  res.render('saas/template',{title:row.name, template:row, manifest, favorite:Boolean(favorite)});
});
router.post('/templates/:id/favorite', requireAuth, async (req,res) => {
  const template = await db.prepare('SELECT id FROM templates WHERE id=?').get(req.params.id);
  if (!template) return res.status(404).json({ok:false,error:'Template not found.'});
  const existing = await db.prepare('SELECT 1 AS yes FROM user_favorites WHERE user_id=? AND template_id=?').get(req.session.user.id,template.id);
  if (existing) await db.prepare('DELETE FROM user_favorites WHERE user_id=? AND template_id=?').run(req.session.user.id,template.id);
  else await db.prepare('INSERT INTO user_favorites (user_id,template_id) VALUES (?,?)').run(req.session.user.id,template.id);
  res.redirect(req.get('referer') || `/templates/${template.id}`);
});
router.post('/templates/:id/use', requireAuth, async (req,res) => {
  const row = await db.prepare('SELECT status,definition_json FROM templates WHERE id=?').get(req.params.id);
  let manifest=null; try { manifest=row?JSON.parse(row.definition_json):null; } catch {}
  if(manifest && !manifest.version)manifest.version=row.version;
  if (!manifest || row.status !== 'published' || manifest.support !== 'ready') {
    req.session.notice = {type:'warning',message:'This catalog entry is preview-only. Its runtime module is not installed in this release.'};
    return res.redirect(`/templates/${encodeURIComponent(req.params.id)}`);
  }
  try { await assertCanUseTemplate(req.session.user.id, manifest); }
  catch (error) { req.session.notice = {type:'warning',message:error.message}; return res.redirect(`/templates/${manifest.id}`); }
  res.redirect(`/bots/new?template=${encodeURIComponent(manifest.id)}`);
});

router.get('/docs', (req,res) => {
  const q = String(req.query.q || '').toLowerCase();
  const articles = docs.filter(d => !q || `${d.title} ${d.body}`.toLowerCase().includes(q));
  page(res,'Documentation Center','Guides for creating and operating ROVEX MAKER bots.', {items:articles.map(a=>`${a.title} — ${a.body}`),links:articles.map(a=>({label:a.title,href:`/docs/${a.slug}`}))});
});
router.get('/docs/:slug', (req,res) => {
  const article = docs.find(d=>d.slug===req.params.slug);
  if (!article) return res.status(404).render('errors/error',{title:'Article not found',message:'Documentation article not found.'});
  page(res,article.title,article.body,{links:[{label:'All documentation',href:'/docs'},{label:'Template marketplace',href:'/templates'}]});
});
router.get('/api-docs',(req,res)=>page(res,'API Documentation','REST endpoints use the logged-in web session. Write requests require the CSRF token.',{items:['GET /api/v1/templates — published template catalog','GET /api/v1/bots — bots owned by the current user','GET /api/v1/usage — plan limits and usage counts','GET /api/v1/notifications — notification center','POST /api/v1/notifications/:id/read — mark a notification read','POST /api/v1/bots/bulk-control — start, stop or restart up to 20 accessible bots'],notice:'No bot token, OAuth client secret or integration secret is returned by API responses.'}));
router.get('/blog',(req,res)=>page(res,'ROVEX Journal','Product updates and operating notes.',{items:['Template manifests and runtime compatibility','Choosing Discord gateway intents','Deploying long-running Node.js bot services']}));
router.get('/blog/:slug',(req,res)=>{
  const posts = {'template-manifests':['Template manifests','Manifests describe the commands, modules, intents and permissions a bot needs. Only compatible manifests can be installed.'],'gateway-intents':['Gateway intents','Enable only the intents your bot needs in the Discord Developer Portal. Some privileged intents require explicit approval or configuration.'],'hosting-node':['Hosting Node.js bots','Bots need a persistent process and stable network access. Free hosting sleep policies can interrupt gateway connections.']};
  const post=posts[req.params.slug]; if(!post) return res.status(404).render('errors/error',{title:'Article not found',message:'Blog article not found.'});
  page(res,post[0],post[1],{links:[{label:'All articles',href:'/blog'}]});
});
router.get('/status', async (req,res)=>{
  const counts = await db.prepare('SELECT COUNT(*) AS bots, SUM(CASE WHEN status=? THEN 1 ELSE 0 END) AS online FROM bots').get('online');
  page(res,'Platform Status','Live metrics from this application process and its configured database.',{stats:[{label:'Database',value:db.dialect.toUpperCase()},{label:'Registered bots',value:Number(counts.bots||0)},{label:'Online bots',value:Number(counts.online||0)},{label:'Runtime clients',value:runtime.runtimeClients.size}],notice:'This is a process-local status view. It does not represent a multi-region status monitor.'});
});
router.get('/contact',(req,res)=>page(res,'Contact Us','Send a platform support request to the configured administrators.',{form:{action:'/contact',method:'post',fields:[{name:'subject',label:'Subject',type:'text',required:true},{name:'message',label:'Message',type:'textarea',required:true}]}}));
router.post('/contact',requireAuth,async(req,res)=>{
  const subject=String(req.body.subject||'').trim(); const message=String(req.body.message||'').trim();
  if(subject.length<3||subject.length>100||message.length<10||message.length>2000) return res.status(400).render('errors/error',{title:'Invalid support request',message:'Subject must be 3–100 characters and message 10–2000 characters.'});
  await audit(req.session.user.id,'support.contact',req.session.user.discord_id,`${subject}: ${message}`);
  await notify(req.session.user.id,'support','Support request recorded','Your request was recorded in the platform audit log. A live support ticket provider is not configured.');
  req.session.notice={type:'success',message:'Your request was recorded. Live email/ticket delivery is not configured.'}; res.redirect('/notifications');
});
router.get('/unauthorized',(req,res)=>res.status(403).render('errors/error',{title:'Unauthorized',message:'You do not have permission to access this resource.'}));
router.get('/suspended',(req,res)=>res.status(403).render('errors/error',{title:'Account suspended',message:'This account is suspended. Contact the platform administrator.'}));

router.use(requireAuth);
router.get('/builder',async(req,res)=>{
  const available=await db.prepare("SELECT id,name,category,description,min_plan,uses_count FROM templates WHERE status='published' ORDER BY uses_count DESC,name").all();
  page(res,'Template Builder','Choose a validated manifest to start the guided eight-step creation flow.',{links:[{label:'Start with an empty supported bot',href:'/bots/new'},...available.map(t=>({label:`${t.name} · ${t.category} · ${t.min_plan}`,href:`/bots/new?template=${t.id}`}))]});
});
router.get('/search',async(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,100);if(q.length<2)return page(res,'Search','Enter at least two characters to search your workspace.');
  const pattern=`%${q.toLowerCase()}%`;
  const [bots,templates]=await Promise.all([
    db.prepare('SELECT id,name,description,status FROM bots WHERE owner_id=? AND (lower(name) LIKE ? OR lower(description) LIKE ?) ORDER BY created_at DESC LIMIT 30').all(req.session.user.id,pattern,pattern),
    db.prepare("SELECT id,name,description,status FROM templates WHERE status<>'hidden' AND (lower(name) LIKE ? OR lower(description) LIKE ?) ORDER BY uses_count DESC LIMIT 30").all(pattern,pattern)
  ]);
  page(res,`Search: ${q}`,'Results are limited to your own bots and public template catalog entries.',{items:[...bots.map(b=>`Bot · ${b.name} · ${b.status}`),...templates.map(t=>`Template · ${t.name} · ${t.status}`)],links:[...bots.map(b=>({label:`Open bot: ${b.name}`,href:`/bots/${b.id}`})),...templates.map(t=>({label:`Open template: ${t.name}`,href:`/templates/${t.id}`}))]});
});
router.get('/integrations',async(req,res)=>{
  const rows=await db.prepare(`SELECT i.provider,i.updated_at,b.name FROM integrations i JOIN bots b ON b.id=i.bot_id WHERE b.owner_id=? ORDER BY i.updated_at DESC`).all(req.session.user.id);
  page(res,'Integrations','Connected integration configurations for bots owned by your account. Secret values are never displayed.',{items:rows.map(r=>`${r.name} · ${r.provider} · updated ${r.updated_at}`),notice:'Provider execution adapters for AI, translation and payments are not connected in this release.'});
});
router.get('/profile/settings',(req,res)=>res.redirect('/profile'));
router.get('/account',(req,res)=>res.redirect('/profile'));
router.get('/account/security',(req,res)=>res.redirect('/security'));
router.get('/pricing/comparison',(req,res)=>res.redirect('/pricing-comparison'));
router.get('/template-management',(req,res)=>res.redirect('/admin/templates'));
router.get('/admin/template-management',requireAdmin,(req,res)=>res.redirect('/admin/templates'));
router.get('/analytics',async(req,res)=>{
  const counts=await db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='online' THEN 1 ELSE 0 END) AS online FROM bots WHERE owner_id=?`).get(req.session.user.id);
  const guilds=await db.prepare('SELECT COUNT(*) AS n FROM bot_guilds g JOIN bots b ON b.id=g.bot_id WHERE b.owner_id=?').get(req.session.user.id);
  const since = new Date(); since.setUTCHours(0,0,0,0); since.setUTCDate(since.getUTCDate()-6);
  const sinceSql=since.toISOString().slice(0,19).replace('T',' ');
  const activityRows=await db.prepare('SELECT l.created_at FROM bot_logs l JOIN bots b ON b.id=l.bot_id WHERE b.owner_id=? AND l.created_at>=?').all(req.session.user.id,sinceSql);
  page(res,'Analytics','Actual database snapshots for the bots owned by this account.',{stats:[{label:'Total bots',value:Number(counts.total||0)},{label:'Online now',value:Number(counts.online||0)},{label:'Known servers',value:Number(guilds.n||0)},{label:'Logs (7 days)',value:activityRows.length}],chart:buildDailyChart(activityRows)});
});
router.get('/activity',async(req,res)=>{
  const logs=await db.prepare(`SELECT l.level,l.category,l.message,l.created_at,b.name FROM bot_logs l JOIN bots b ON b.id=l.bot_id WHERE b.owner_id=? ORDER BY l.id DESC LIMIT 60`).all(req.session.user.id);
  page(res,'Activity','Latest runtime activity recorded for your bots.',{items:logs.map(l=>`${l.created_at} · ${l.level.toUpperCase()} · ${l.name} · ${l.category}: ${l.message}`)});
});
router.get('/favorites',async(req,res)=>{
  const rows=await db.prepare(`SELECT t.id,t.name,t.category,t.description,t.status FROM user_favorites f JOIN templates t ON t.id=f.template_id WHERE f.user_id=? ORDER BY f.created_at DESC`).all(req.session.user.id);
  page(res,'Favorite Templates','Templates you saved for later.',{items:rows.map(t=>`${t.name} (${t.category}) — ${t.status}: ${t.description}`),links:rows.map(t=>({label:`Open ${t.name}`,href:`/templates/${t.id}`}))});
});
router.get('/my-templates',async(req,res)=>{
  const rows=await db.prepare(`SELECT b.id,b.name,b.client_id,bs.settings_json FROM bots b LEFT JOIN bot_settings bs ON bs.bot_id=b.id WHERE b.owner_id=? ORDER BY b.created_at DESC`).all(req.session.user.id);
  const items=rows.map(r=>{let cfg={};try{cfg=JSON.parse(r.settings_json||'{}')}catch{};return `${r.name}: ${cfg.templateName||cfg.template||'Custom bot'} · ${r.client_id}`;});
  page(res,'My Templates','Installed templates are shown from each bot configuration.',{items,links:rows.map(r=>({label:`Open ${r.name}`,href:`/bots/${r.id}`}))});
});
router.get('/subscription',async(req,res)=>{
  const plan=await getUserPlan(req.session.user.id);
  const history=await db.prepare('SELECT plan_key,status,provider,started_at,renews_at FROM subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 12').all(req.session.user.id);
  page(res,'Subscription Overview','Your currently enforced plan and subscription history.',{stats:[{label:'Current plan',value:plan.name},{label:'Bot limit',value:plan.bot_limit},{label:'Running limit',value:plan.running_limit},{label:'Team workspaces',value:plan.team_enabled?'Enabled':'Not included'}],items:history.map(h=>`${h.plan_key} · ${h.status} · ${h.provider} · ${h.started_at}`),notice:'No payment processor is connected. Paid plan requests cannot be purchased from this installation.'});
});
router.post('/subscription/request',async(req,res)=>{
  await notify(req.session.user.id,'billing','Plan request received','A plan change needs administrator approval until a payment provider is configured.');
  req.session.notice={type:'info',message:'Request recorded. No payment was collected.'};res.redirect('/subscription');
});
router.get('/pricing-comparison',(req,res)=>page(res,'Plan Comparison','Limits are enforced on the server. Prices are intentionally omitted until checkout is configured.',{table:{headers:['Plan','Bots','Running','Log retention','Teams'],rows:plans.map(p=>[p.name,p.botLimit,p.runningLimit,p.logLimit,p.teams?'Yes':'No'])}}));
router.get('/billing',async(req,res)=>{
  const invoices=await db.prepare('SELECT id,status,amount_minor,currency,hosted_url,created_at FROM invoices WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.session.user.id);
  page(res,'Billing History','Verified invoices from connected payment providers, if configured.',{items:invoices.length?invoices.map(i=>`${i.created_at} · ${i.status} · ${i.amount_minor??'Amount unavailable'} ${i.currency||''}`):['No invoice records. No payment provider is connected.']});
});
router.get('/usage',async(req,res)=>{
  const plan=await getUserPlan(req.session.user.id);
  const [bots,running,usage]=await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM bots WHERE owner_id=?').get(req.session.user.id),
    db.prepare("SELECT COUNT(*) AS n FROM bots WHERE owner_id=? AND status='online'").get(req.session.user.id),
    db.prepare('SELECT usage_key,SUM(quantity) AS total,MAX(created_at) AS last_used FROM usage_records WHERE user_id=? GROUP BY usage_key ORDER BY last_used DESC').all(req.session.user.id)
  ]);
  page(res,'Usage & Limits','Usage is measured from saved bot and runtime records. CPU and memory are not estimated.',{stats:[{label:'Bots',value:`${Number(bots.n)}/${Math.min(plan.bot_limit,require('../config/env').env.maxBotsPerUser)}`},{label:'Online',value:`${Number(running.n)}/${plan.running_limit}`},{label:'Plan',value:plan.name}],items:usage.map(u=>`${u.usage_key}: ${u.total} · last ${u.last_used}`)});
});
router.get('/notifications',async(req,res)=>{
  const notifications=await db.prepare('SELECT id,kind,title,message,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.session.user.id);
  const unread=notifications.filter(n=>!n.read_at).length;
  res.render('saas/notifications',{title:'Notifications',notifications,unread});
});
router.post('/notifications/:id/read',async(req,res)=>{
  await db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(req.params.id,req.session.user.id);
  res.redirect('/notifications');
});
router.post('/notifications/:id/delete',async(req,res)=>{
  await db.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').run(req.params.id,req.session.user.id);
  res.redirect('/notifications');
});
router.post('/notifications/read-all',async(req,res)=>{
  await db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND read_at IS NULL').run(req.session.user.id);
  res.redirect('/notifications');
});
router.get('/security',async(req,res)=>page(res,'Account Security','Discord OAuth is the only account authentication method. ROVEX MAKER does not request Discord passwords.',{items:[`Discord user ID: ${req.session.user.discord_id}`,`Session cookie: HTTP-only, SameSite=Lax${require('../config/env').env.isProduction?' and Secure':''}`,'Bot tokens are encrypted at rest using AES-256-GCM.','OAuth access tokens are not retained after login.']}));
router.get('/team',async(req,res)=>{
  const plan=await getUserPlan(req.session.user.id);
  const workspaces=await db.prepare(`SELECT DISTINCT w.id,w.name,w.created_at,CASE WHEN w.owner_id=? THEN 1 ELSE 0 END AS can_manage,
    CASE WHEN w.owner_id=? THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS current_role
    FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=? AND m.status='active'
    WHERE w.owner_id=? OR m.user_id=? ORDER BY w.created_at DESC`).all(req.session.user.id,req.session.user.id,req.session.user.id,req.session.user.id,req.session.user.id);
  const memberships=await db.prepare(`SELECT w.id,w.name,m.role,m.status,u.username,u.discord_id,CASE WHEN w.owner_id=? THEN 1 ELSE 0 END AS can_manage
    FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id JOIN users u ON u.id=m.user_id
    WHERE w.owner_id=? OR EXISTS(SELECT 1 FROM workspace_members mine WHERE mine.workspace_id=w.id AND mine.user_id=? AND mine.status='active')
    ORDER BY w.created_at DESC,m.added_at`).all(req.session.user.id,req.session.user.id,req.session.user.id);
  const workspaceBots=await db.prepare(`SELECT wb.workspace_id,w.name AS workspace_name,b.id AS bot_id,b.name AS bot_name,CASE WHEN w.owner_id=? THEN 1 ELSE 0 END AS can_manage
    FROM workspace_bots wb JOIN workspaces w ON w.id=wb.workspace_id JOIN bots b ON b.id=wb.bot_id
    WHERE w.owner_id=? OR EXISTS(SELECT 1 FROM workspace_members mine WHERE mine.workspace_id=w.id AND mine.user_id=? AND mine.status='active')
    ORDER BY w.name,b.name`).all(req.session.user.id,req.session.user.id,req.session.user.id);
  const ownedBots=await db.prepare('SELECT id,name FROM bots WHERE owner_id=? ORDER BY name').all(req.session.user.id);
  res.render('saas/team',{title:'Team Management',plan,workspaces,memberships,workspaceBots,ownedBots});
});
router.post('/team/workspaces',async(req,res)=>{
  const plan=await getUserPlan(req.session.user.id);
  if(!plan.team_enabled){req.session.notice={type:'warning',message:'Team workspaces require the Business plan. Paid checkout is not configured.'};return res.redirect('/team');}
  const name=String(req.body.name||'').trim(); if(name.length<2||name.length>60){req.session.notice={type:'error',message:'Workspace name must be 2–60 characters.'};return res.redirect('/team');}
  const id=crypto.randomUUID();
  await db.prepare('INSERT INTO workspaces (id,owner_id,name) VALUES (?,?,?)').run(id,req.session.user.id,name);
  await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,status) VALUES (?,?, 'owner','active')").run(id,req.session.user.id);
  await audit(req.session.user.id,'workspace.create',id,name);req.session.notice={type:'success',message:'Workspace created.'};res.redirect('/team');
});
router.post('/team/members',async(req,res)=>{
  const plan=await getUserPlan(req.session.user.id);
  if(!plan.team_enabled){req.session.notice={type:'warning',message:'Team access requires Business plan.'};return res.redirect('/team');}
  const workspaceId=String(req.body.workspace_id||''); const discordId=String(req.body.discord_id||'').trim(); const role=String(req.body.role||'viewer');
  if(!['administrator','developer','viewer'].includes(role)||!/^[0-9]{15,22}$/.test(discordId)){req.session.notice={type:'error',message:'Enter a valid Discord user ID and role.'};return res.redirect('/team');}
  const workspace=await db.prepare('SELECT id FROM workspaces WHERE id=? AND owner_id=?').get(workspaceId,req.session.user.id);
  if(!workspace){req.session.notice={type:'error',message:'Workspace not found.'};return res.redirect('/team');}
  const member=await db.prepare('SELECT id FROM users WHERE discord_id=?').get(discordId);
  if(!member){req.session.notice={type:'error',message:'The Discord user must sign in to ROVEX MAKER before they can be added.'};return res.redirect('/team');}
  await db.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,status) VALUES (?,?,?,'active') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active'`).run(workspaceId,member.id,role);
  await notify(member.id,'team','Workspace access granted',`You were added to a workspace as ${role}.`);
  await audit(req.session.user.id,'workspace.member.add',workspaceId,`${discordId}:${role}`);req.session.notice={type:'success',message:'Workspace member added.'};res.redirect('/team');
});
router.post('/team/members/remove',async(req,res)=>{
  const workspaceId=String(req.body.workspace_id||''); const discordId=String(req.body.discord_id||'');
  const workspace=await db.prepare('SELECT id FROM workspaces WHERE id=? AND owner_id=?').get(workspaceId,req.session.user.id);
  if(!workspace)return res.status(404).render('errors/error',{title:'Workspace not found',message:'Workspace was not found.'});
  await db.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=(SELECT id FROM users WHERE discord_id=?) AND role<>'owner'").run(workspaceId,discordId);
  await audit(req.session.user.id,'workspace.member.remove',workspaceId,discordId);req.session.notice={type:'success',message:'Member access removed.'};res.redirect('/team');
});
router.post('/team/workspaces/:id/bots',async(req,res)=>{
  const workspace=await db.prepare('SELECT id FROM workspaces WHERE id=? AND owner_id=?').get(req.params.id,req.session.user.id);
  if(!workspace)return res.status(404).send('Workspace not found.');
  const bot=await db.prepare('SELECT id,name FROM bots WHERE id=? AND owner_id=?').get(String(req.body.bot_id||''),req.session.user.id);
  if(!bot){req.session.notice={type:'error',message:'Only bots you own can be linked to a workspace.'};return res.redirect('/team');}
  await db.prepare('INSERT INTO workspace_bots (workspace_id,bot_id) VALUES (?,?) ON CONFLICT(workspace_id,bot_id) DO NOTHING').run(workspace.id,bot.id);
  await audit(req.session.user.id,'workspace.bot.link',workspace.id,bot.id);req.session.notice={type:'success',message:`${bot.name} was linked to the workspace.`};res.redirect('/team');
});
router.post('/team/workspaces/:id/bots/remove',async(req,res)=>{
  const workspace=await db.prepare('SELECT id FROM workspaces WHERE id=? AND owner_id=?').get(req.params.id,req.session.user.id);
  if(!workspace)return res.status(404).send('Workspace not found.');
  await db.prepare('DELETE FROM workspace_bots WHERE workspace_id=? AND bot_id IN (SELECT id FROM bots WHERE id=? AND owner_id=?)').run(workspace.id,String(req.body.bot_id||''),req.session.user.id);
  await audit(req.session.user.id,'workspace.bot.unlink',workspace.id,String(req.body.bot_id||''));req.session.notice={type:'success',message:'Bot unlinked from workspace.'};res.redirect('/team');
});

// Bot-specific sub-pages reuse the existing ownership model and expose real data from the bot tables.
async function getOwnedBot(req,res){
  const bot=await db.prepare(`SELECT b.id,b.owner_id,b.name,b.description,b.client_id,b.status,b.last_started_at,b.created_at,
    CASE WHEN b.owner_id=? THEN 'owner' ELSE COALESCE((SELECT wm.role FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id
      WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'
      ORDER BY CASE wm.role WHEN 'administrator' THEN 3 WHEN 'developer' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC LIMIT 1),'viewer') END AS access_role
    FROM bots b WHERE b.id=? AND (b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id
      WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'))`).get(req.session.user.id,req.session.user.id,req.params.id,req.session.user.id,req.session.user.id);
  if(!bot){res.status(404).render('errors/error',{title:'Bot not found',message:'This bot does not exist or you do not have access to it.'});return null;}
  if(req.method!=='GET' && bot.access_role==='viewer'){res.status(403).render('errors/error',{title:'Read-only access',message:'Your workspace role allows viewing this bot but not changing it.'});return null;}
  return bot;
}
router.get('/bots/:id/analytics',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const metrics=runtime.getBotMetrics(bot.id);
  const since=new Date();since.setUTCHours(0,0,0,0);since.setUTCDate(since.getUTCDate()-6);
  const sinceSql=since.toISOString().slice(0,19).replace('T',' ');
  const [guilds,logs,commands,activityRows]=await Promise.all([
    db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(member_count),0) AS members FROM bot_guilds WHERE bot_id=?').get(bot.id),
    db.prepare('SELECT COUNT(*) AS n FROM bot_logs WHERE bot_id=?').get(bot.id),
    db.prepare('SELECT COUNT(*) AS n FROM bot_commands WHERE bot_id=? AND enabled=1').get(bot.id),
    db.prepare('SELECT created_at FROM bot_logs WHERE bot_id=? AND created_at>=?').all(bot.id,sinceSql)
  ]);
  page(res,`${bot.name} Analytics`,'Metrics are based on known Discord guild snapshots, saved logs and the live Gateway client.',{stats:[{label:'Known servers',value:Number(guilds.n||0)},{label:'Known members',value:Number(guilds.members||0)},{label:'Enabled commands',value:Number(commands.n||0)},{label:'Retained logs',value:Number(logs.n||0)},{label:'Gateway ping',value:metrics.pingMs===null?'Offline':`${metrics.pingMs} ms`},{label:'Client uptime',value:metrics.uptimeMs===null?'Offline':`${Math.floor(metrics.uptimeMs/1000)} s`},{label:'Shared process RSS',value:`${Math.round(metrics.processMemoryBytes/1024/1024)} MB`}],chart:buildDailyChart(activityRows)});
});
router.get('/bots/:id/commands',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const rows=await db.prepare('SELECT command_name,enabled FROM bot_commands WHERE bot_id=? ORDER BY command_name').all(bot.id);
  page(res,`${bot.name} Commands`,'Command availability is saved per bot. Use the bot dashboard to toggle and synchronize each command.',{items:rows.map(r=>`/${r.command_name} — ${r.enabled?'enabled':'disabled'}`),links:[{label:'Open bot controls',href:`/bots/${bot.id}`} ]});
});
router.get('/bots/:id/features',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const rows=await db.prepare('SELECT feature_key,enabled FROM bot_features WHERE bot_id=? ORDER BY feature_key').all(bot.id);
  page(res,`${bot.name} Features`,'Feature modules are stored per bot. Toggle them from the main bot dashboard.',{items:rows.map(r=>`${r.feature_key}: ${r.enabled?'enabled':'disabled'}`),links:[{label:'Manage features',href:`/bots/${bot.id}`} ]});
});
router.get('/bots/:id/servers',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const rows=await db.prepare('SELECT guild_id,guild_name,member_count,updated_at FROM bot_guilds WHERE bot_id=? ORDER BY guild_name').all(bot.id);
  page(res,`${bot.name} Servers`,'Guilds currently visible to the Discord client. Results refresh when the bot connects and receives guild events.',{items:rows.map(g=>`${g.guild_name} · ${g.guild_id} · ${g.member_count} members · updated ${g.updated_at}`)});
});
router.get('/bots/:id/integrations',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const rows=await db.prepare('SELECT provider,updated_at,CASE WHEN encrypted_value IS NULL THEN 0 ELSE 1 END AS has_secret FROM integrations WHERE bot_id=? ORDER BY provider').all(bot.id);
  const byProvider=Object.fromEntries(rows.map(row=>[row.provider,row]));
  res.render('bots/integrations',{title:`${bot.name} Integrations`,bot,openaiConfigured:Boolean(byProvider.openai?.has_secret),translatorConfigured:Boolean(byProvider.libretranslate),translatorHasKey:Boolean(byProvider.libretranslate?.has_secret),translatorEndpoint:process.env.TRANSLATE_API_URL||'https://libretranslate.com/translate',updated:rows.map(row=>({provider:row.provider,updatedAt:row.updated_at}))});
});

router.post('/bots/:id/integrations/openai',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const apiKey=String(req.body.api_key||'').trim();
  const model=String(req.body.model||'gpt-4o-mini').trim();
  if(apiKey.length<20||apiKey.length>500||!/^gpt-[a-zA-Z0-9._-]{2,40}$/.test(model)){
    req.session.notice={type:'error',message:'Enter a valid OpenAI API key and a supported model identifier.'};
    return res.redirect(`/bots/${bot.id}/integrations`);
  }
  const encrypted=encrypt(apiKey);
  await db.prepare(`INSERT INTO integrations (id,bot_id,provider,encrypted_value,iv,auth_tag,config_json) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(bot_id,provider) DO UPDATE SET encrypted_value=excluded.encrypted_value,iv=excluded.iv,auth_tag=excluded.auth_tag,config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP`)
    .run(crypto.randomUUID(),bot.id,'openai',encrypted.encrypted,encrypted.iv,encrypted.tag,JSON.stringify({model}));
  await audit(req.session.user.id,'integration.openai.updated',bot.id,`OpenAI model set to ${model}.`);
  req.session.notice={type:'success',message:'OpenAI integration saved. The API key is encrypted and will not be shown again.'};
  res.redirect(`/bots/${bot.id}/integrations`);
});

router.post('/bots/:id/integrations/libretranslate',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const apiKey=String(req.body.api_key||'').trim();
  if(apiKey.length>500){req.session.notice={type:'error',message:'The translation API key is too long.'};return res.redirect(`/bots/${bot.id}/integrations`);}
  const encrypted=apiKey?encrypt(apiKey):null;
  await db.prepare(`INSERT INTO integrations (id,bot_id,provider,encrypted_value,iv,auth_tag,config_json) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(bot_id,provider) DO UPDATE SET encrypted_value=excluded.encrypted_value,iv=excluded.iv,auth_tag=excluded.auth_tag,config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP`)
    .run(crypto.randomUUID(),bot.id,'libretranslate',encrypted?.encrypted||null,encrypted?.iv||null,encrypted?.tag||null,JSON.stringify({endpoint:process.env.TRANSLATE_API_URL||'https://libretranslate.com/translate'}));
  await audit(req.session.user.id,'integration.translator.updated',bot.id,'LibreTranslate configuration updated.');
  req.session.notice={type:'success',message:'Translator integration saved. An API key is optional for endpoints that do not require one.'};
  res.redirect(`/bots/${bot.id}/integrations`);
});
router.get('/bots/:id/export',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const [settings,features,commands]=await Promise.all([
    db.prepare('SELECT settings_json FROM bot_settings WHERE bot_id=?').get(bot.id),
    db.prepare('SELECT feature_key,enabled FROM bot_features WHERE bot_id=?').all(bot.id),
    db.prepare('SELECT command_name,enabled FROM bot_commands WHERE bot_id=?').all(bot.id)
  ]);
  res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition',`attachment; filename="rovex-${bot.id}-config.json"`);
  res.send(JSON.stringify({format:'rovex-bot-config',version:1,bot:{name:bot.name,description:bot.description,clientId:bot.client_id},settings:JSON.parse(settings?.settings_json||'{}'),features,commands},null,2));
});
router.post('/bots/:id/import',async(req,res)=>{
  const bot=await getOwnedBot(req,res);if(!bot)return;
  const payload=req.body;
  if(!payload||payload.format!=='rovex-bot-config'||payload.version!==1||!Array.isArray(payload.features)||!Array.isArray(payload.commands))return res.status(400).json({ok:false,error:'Invalid ROVEX configuration file.'});
  const supportedFeatures=require('../discord/commands').features;
  const supportedCommands=require('../discord/commands').definitions.map(x=>x.name);
  for(const row of payload.features){if(!supportedFeatures.includes(row.feature_key)||![0,1,true,false].includes(row.enabled))return res.status(400).json({ok:false,error:'Unsupported feature configuration.'});}
  for(const row of payload.commands){if(!supportedCommands.includes(row.command_name)||![0,1,true,false].includes(row.enabled))return res.status(400).json({ok:false,error:'Unsupported command configuration.'});}
  await db.withTransaction(async tx=>{
    for(const row of payload.features)await tx.prepare('UPDATE bot_features SET enabled=? WHERE bot_id=? AND feature_key=?').run(row.enabled?1:0,bot.id,row.feature_key);
    for(const row of payload.commands)await tx.prepare('UPDATE bot_commands SET enabled=? WHERE bot_id=? AND command_name=?').run(row.enabled?1:0,bot.id,row.command_name);
  });
  runtime.log(bot.id,'info','configuration','Configuration imported.');
  let restarted = false;
  if (runtime.runtimeClients.has(bot.id)) {
    await runtime.restartBot(bot.id);
    restarted = true;
  }
  res.json({ok:true,message:restarted?'Configuration imported and bot restarted.':'Configuration imported. Start the bot to apply Gateway intent changes.',restarted});
});

// Admin pages and actions are kept behind explicit platform-admin checks.
router.get('/admin/templates',requireAdmin,async(req,res)=>{
  const rows=await db.prepare('SELECT id,name,category,description,status,min_plan,version,uses_count,definition_json FROM templates ORDER BY category,name').all();
  const builtins=new Set(catalog.map(item=>item.id));
  const templates=rows.map(row=>({...row,manifest:JSON.parse(row.definition_json),builtin:builtins.has(row.id)}));
  res.render('admin/templates',{title:'Template Management',templates,plans});
});
router.post('/admin/templates',requireAdmin,async(req,res)=>{
  const id=String(req.body.id||'').trim();
  try{
    if(await db.prepare('SELECT id FROM templates WHERE id=?').get(id))throw new Error('This template ID already exists.');
    const manifest=buildManifest(req.body,id);
    const json=JSON.stringify(manifest);
    await db.withTransaction(async tx=>{
      await tx.prepare(`INSERT INTO templates (id,name,category,description,version,status,min_plan,definition_json) VALUES (?,?,?,?,?,'preview',?,?)`)
        .run(manifest.id,manifest.name,manifest.category,manifest.description,manifest.version,manifest.minPlan,json);
      await tx.prepare('INSERT INTO template_versions (id,template_id,version,definition_json,changelog) VALUES (?,?,?,?,?)')
        .run(crypto.randomUUID(),id,manifest.version,json,'Created as a draft for administrator review.');
    });
    await audit(req.session.user.id,'template.create',id,manifest.name);
    req.session.notice={type:'success',message:'Template created as a preview draft. Review it before publishing.'};
  }catch(error){req.session.notice={type:'error',message:error.message};}
  res.redirect('/admin/templates');
});
router.post('/admin/templates/:id/update',requireAdmin,async(req,res)=>{
  const row=await db.prepare('SELECT * FROM templates WHERE id=?').get(req.params.id);
  if(!row)return res.status(404).render('errors/error',{title:'Template not found',message:'Template does not exist.'});
  try{
    const current=JSON.parse(row.definition_json);
    if(current.support!=='ready')throw new Error('This built-in preview template cannot be converted into a working module by metadata editing. Implement its runtime module first.');
    const manifest=buildManifest(req.body,row.id,current);
    if(!semverGreater(manifest.version,row.version))throw new Error('A template edit must increment its semantic version.');
    const json=JSON.stringify(manifest);
    await db.withTransaction(async tx=>{
      await tx.prepare('INSERT INTO template_versions (id,template_id,version,definition_json,changelog) VALUES (?,?,?,?,?)')
        .run(crypto.randomUUID(),row.id,manifest.version,json,String(req.body.changelog||'Template updated.').slice(0,500));
      await tx.prepare("UPDATE templates SET name=?,category=?,description=?,version=?,min_plan=?,definition_json=?,status='preview',updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(manifest.name,manifest.category,manifest.description,manifest.version,manifest.minPlan,json,row.id);
    });
    await audit(req.session.user.id,'template.update',row.id,manifest.version);
    req.session.notice={type:'success',message:'New template version saved as preview. Review and republish it to make it installable.'};
  }catch(error){req.session.notice={type:'error',message:error.message};}
  res.redirect('/admin/templates');
});
router.post('/admin/templates/:id/delete',requireAdmin,async(req,res)=>{
  const row=await db.prepare('SELECT id,uses_count FROM templates WHERE id=?').get(req.params.id);
  if(!row)return res.status(404).render('errors/error',{title:'Template not found',message:'Template does not exist.'});
  if(catalog.some(item=>item.id===row.id)){req.session.notice={type:'warning',message:'Built-in templates cannot be deleted; hide them instead.'};return res.redirect('/admin/templates');}
  if(Number(row.uses_count)>0){req.session.notice={type:'warning',message:'A template already installed by users cannot be deleted. Hide it instead.'};return res.redirect('/admin/templates');}
  await db.prepare('DELETE FROM templates WHERE id=?').run(row.id);
  await audit(req.session.user.id,'template.delete',row.id,'Unused custom template removed.');
  req.session.notice={type:'success',message:'Template deleted.'};res.redirect('/admin/templates');
});
router.post('/admin/templates/:id/status',requireAdmin,async(req,res)=>{
  const row=await db.prepare('SELECT id,name,definition_json FROM templates WHERE id=?').get(req.params.id);const status=String(req.body.status||'');
  if(!row||!['published','hidden','preview'].includes(status))return res.status(400).render('errors/error',{title:'Invalid template action',message:'Unknown template or status.'});
  const manifest=JSON.parse(row.definition_json);
  if(status==='published'&&manifest.support!=='ready')return res.status(409).render('errors/error',{title:'Template not compatible',message:'This template is preview-only because its runtime module is not implemented.'});
  await db.prepare('UPDATE templates SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,row.id);
  await audit(req.session.user.id,'template.status',row.id,status);req.session.notice={type:'success',message:`${row.name} status updated to ${status}.`};res.redirect('/admin/templates');
});
router.get('/admin/users',requireAdmin,async(req,res)=>{
  const rows=await db.prepare('SELECT id,discord_id,username,is_suspended,created_at,last_login_at FROM users ORDER BY id DESC LIMIT 200').all();
  page(res,'User Management','Platform accounts and suspension status.',{table:{headers:['Platform ID','Username','Discord ID','Status','Last login'],rows:rows.map(u=>[u.id,u.username,u.discord_id,u.is_suspended?'Suspended':'Active',u.last_login_at])}});
});
router.get('/admin/bots',requireAdmin,async(req,res)=>{
  const rows=await db.prepare('SELECT b.id,b.name,b.status,b.client_id,u.username,u.discord_id FROM bots b JOIN users u ON u.id=b.owner_id ORDER BY b.created_at DESC LIMIT 200').all();
  page(res,'Bot Management','Bot records and owner context. Start/stop/restart/delete controls remain available on the main admin overview.',{items:rows.map(b=>`${b.name} · ${b.status} · ${b.username} (${b.discord_id}) · ${b.client_id}`)});
});
router.get('/admin/subscriptions',requireAdmin,async(req,res)=>{
  const subscriptions=await db.prepare(`SELECT s.id,s.user_id,s.plan_key,s.status,s.provider,s.started_at,u.username,u.discord_id FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 100`).all();
  res.render('admin/subscriptions',{title:'Subscription Management',subscriptions,plans});
});
router.post('/admin/subscriptions/:id/plan',requireAdmin,async(req,res)=>{
  const planKey=String(req.body.plan_key||'');if(!plans.some(p=>p.key===planKey))return res.status(400).send('Invalid plan.');
  const sub=await db.prepare('SELECT user_id FROM subscriptions WHERE id=?').get(req.params.id);if(!sub)return res.status(404).send('Subscription not found.');
  await db.withTransaction(async tx=>{
    await tx.prepare("UPDATE subscriptions SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE user_id=? AND status='active'").run(sub.user_id);
    await tx.prepare("INSERT INTO subscriptions (id,user_id,plan_key,status,provider) VALUES (?,?,?,'active','admin_override')").run(crypto.randomUUID(),sub.user_id,planKey);
  });
  await audit(req.session.user.id,'subscription.admin_override',req.params.id,planKey);
  await notify(sub.user_id,'subscription','Plan updated',`Your platform plan is now ${planKey}.`);
  res.redirect('/admin/subscriptions');
});
router.get('/admin/payments',requireAdmin,async(req,res)=>{
  const [invoices,events]=await Promise.all([db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 100').all(),db.prepare('SELECT event_id,provider,payload_hash,processed_at FROM payment_events ORDER BY processed_at DESC LIMIT 100').all()]);
  page(res,'Payment Records','Verified provider records only. No provider is connected by default.',{items:[...invoices.map(i=>`Invoice ${i.id}: ${i.status} · ${i.amount_minor??'N/A'} ${i.currency||''}`),...events.map(e=>`Webhook ${e.provider}: ${e.event_id} · ${e.processed_at}`)]});
});
router.get('/admin/analytics',requireAdmin,async(req,res)=>{
  const since=new Date();since.setUTCHours(0,0,0,0);since.setUTCDate(since.getUTCDate()-6);
  const sinceSql=since.toISOString().slice(0,19).replace('T',' ');
  const [users,bots,online,templates,activityRows]=await Promise.all([db.prepare('SELECT COUNT(*) AS n FROM users').get(),db.prepare('SELECT COUNT(*) AS n FROM bots').get(),db.prepare("SELECT COUNT(*) AS n FROM bots WHERE status='online'").get(),db.prepare("SELECT COUNT(*) AS n FROM templates WHERE status='published'").get(),db.prepare('SELECT created_at FROM bot_logs WHERE created_at>=?').all(sinceSql)]);
  page(res,'Platform Analytics','Live database totals and recorded activity.',{stats:[{label:'Users',value:Number(users.n)},{label:'Bots',value:Number(bots.n)},{label:'Online bots',value:Number(online.n)},{label:'Published templates',value:Number(templates.n)}],chart:buildDailyChart(activityRows)});
});
router.get('/admin/audit',requireAdmin,async(req,res)=>{
  const rows=await db.prepare('SELECT a.action,a.target,a.details,a.created_at,u.username FROM platform_audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 150').all();
  page(res,'Audit Logs','Administrative and workspace actions recorded by the platform.',{items:rows.map(r=>`${r.created_at} · ${r.username||'system'} · ${r.action} · ${r.target} · ${r.details}`)});
});
router.get('/admin/settings',requireAdmin,async(req,res)=>page(res,'System Settings','Environment-managed settings are intentionally not editable from the web dashboard.',{items:['PORT and BASE_URL: process environment','DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET: process environment','ENCRYPTION_KEY and SESSION_SECRET: secret environment variables','MAX_BOTS_PER_USER and MAX_RUNNING_BOTS: operational environment limits']}));
router.get('/admin/health',requireAdmin,async(req,res)=>{
  const [users,bots]=await Promise.all([db.prepare('SELECT COUNT(*) AS n FROM users').get(),db.prepare('SELECT COUNT(*) AS n FROM bots').get()]);
  page(res,'System Health','Health information from the current Node.js process.',{stats:[{label:'Database adapter',value:db.dialect},{label:'Process uptime',value:`${Math.floor(process.uptime())}s`},{label:'Runtime clients',value:runtime.runtimeClients.size},{label:'Users / Bots',value:`${users.n} / ${bots.n}`}],notice:'Memory can be sampled from process.memoryUsage(); CPU percentage and multi-process ownership are not claimed by this single-process build.'});
});

// REST API: all records are scoped to the authenticated owner.
function pagination(query){const limit=Math.min(100,Math.max(1,Number.parseInt(query.limit||'25',10)||25));const offset=Math.max(0,Number.parseInt(query.offset||'0',10)||0);return {limit,offset};}
router.get('/api/v1/templates',async(req,res)=>{
  const {limit,offset}=pagination(req.query);
  const rows=await db.prepare('SELECT id,name,category,description,version,status,min_plan,uses_count FROM templates WHERE status=? ORDER BY category,name LIMIT ? OFFSET ?').all('published',limit,offset);
  res.json({ok:true,data:rows,pagination:{limit,offset}});
});
router.get('/api/v1/bots',async(req,res)=>{
  const {limit,offset}=pagination(req.query);
  const rows=await db.prepare(`SELECT DISTINCT b.id,b.name,b.description,b.client_id,b.status,b.created_at,b.last_started_at FROM bots b LEFT JOIN workspace_bots wb ON wb.bot_id=b.id LEFT JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id AND wm.user_id=? AND wm.status='active' WHERE b.owner_id=? OR wm.user_id IS NOT NULL ORDER BY b.created_at DESC LIMIT ? OFFSET ?`).all(req.session.user.id,req.session.user.id,limit,offset);
  res.json({ok:true,data:rows,pagination:{limit,offset}});
});
router.get('/api/v1/usage',async(req,res)=>{
  const plan=await getUserPlan(req.session.user.id);const bots=await db.prepare('SELECT COUNT(*) AS total,SUM(CASE WHEN status=? THEN 1 ELSE 0 END) AS online FROM bots WHERE owner_id=?').get('online',req.session.user.id);
  res.json({ok:true,data:{plan:plan.plan_key,limits:{bots:plan.bot_limit,running:plan.running_limit,logs:plan.log_limit},usage:{bots:Number(bots.total||0),running:Number(bots.online||0)}}});
});
router.get('/api/v1/notifications',async(req,res)=>{
  const {limit,offset}=pagination(req.query);
  const rows=await db.prepare('SELECT id,kind,title,message,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.session.user.id,limit,offset);
  res.json({ok:true,data:rows,pagination:{limit,offset}});
});
router.post('/api/v1/notifications/:id/read',async(req,res)=>{
  const result=await db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(req.params.id,req.session.user.id);
  res.json({ok:true,updated:result.changes>0});
});
router.get('/api/v1/subscription',async(req,res)=>{
  const plan=await getUserPlan(req.session.user.id);
  res.json({ok:true,data:{plan:plan.plan_key,name:plan.name,limits:{bots:plan.bot_limit,running:plan.running_limit,logs:plan.log_limit},status:plan.status,renewsAt:plan.renews_at}});
});
router.get('/api/v1/bots/:id/commands',async(req,res)=>{
  const bot=await db.prepare(`SELECT b.id FROM bots b WHERE b.id=? AND (b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'))`).get(req.params.id,req.session.user.id,req.session.user.id);
  if(!bot)return res.status(404).json({ok:false,error:'Bot not found.'});
  const rows=await db.prepare('SELECT command_name,enabled FROM bot_commands WHERE bot_id=? ORDER BY command_name').all(bot.id);res.json({ok:true,data:rows});
});
router.get('/api/v1/bots/:id/features',async(req,res)=>{
  const bot=await db.prepare(`SELECT b.id FROM bots b WHERE b.id=? AND (b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'))`).get(req.params.id,req.session.user.id,req.session.user.id);
  if(!bot)return res.status(404).json({ok:false,error:'Bot not found.'});
  const rows=await db.prepare('SELECT feature_key,enabled FROM bot_features WHERE bot_id=? ORDER BY feature_key').all(bot.id);res.json({ok:true,data:rows});
});
async function getApiBotAccess(req){
  return db.prepare(`SELECT b.id,CASE WHEN b.owner_id=? THEN 'owner' ELSE COALESCE((SELECT wm.role FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id
    WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active' ORDER BY CASE wm.role WHEN 'administrator' THEN 3 WHEN 'developer' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC LIMIT 1),'viewer') END AS access_role
    FROM bots b WHERE b.id=? AND (b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'))`)
    .get(req.session.user.id,req.session.user.id,req.params.id,req.session.user.id,req.session.user.id);
}
router.post('/api/v1/bots/:id/commands/:command/toggle',async(req,res)=>{
  const access=await getApiBotAccess(req);
  if(!access)return res.status(404).json({ok:false,error:'Bot not found.'});
  if(access.access_role==='viewer')return res.status(403).json({ok:false,error:'Read-only workspace role.'});
  const command=String(req.params.command||'');
  const supported=require('../discord/commands').definitions.some(item=>item.name===command);
  const enabled=req.body?.enabled;
  if(!supported || typeof enabled!=='boolean')return res.status(400).json({ok:false,error:'Unknown command or invalid enabled value.'});
  if(enabled){
    const mapping=require('../discord/commands').featureByCommand[command];
    if(mapping){const feature=await db.prepare('SELECT enabled FROM bot_features WHERE bot_id=? AND feature_key=?').get(access.id,mapping);if(feature && !Number(feature.enabled))return res.status(409).json({ok:false,error:'Enable the required feature before enabling this command.'});}
  }
  const result=await db.prepare('UPDATE bot_commands SET enabled=? WHERE bot_id=? AND command_name=?').run(enabled?1:0,access.id,command);
  if(!result.changes)return res.status(404).json({ok:false,error:'Command is not installed for this bot.'});
  await audit(req.session.user.id,'api.command.toggle',access.id,`${command}:${enabled}`);
  res.json({ok:true,data:{command,enabled,syncRequired:true}});
});
router.post('/api/v1/bots/:id/features/:feature/toggle',async(req,res)=>{
  const access=await getApiBotAccess(req);
  if(!access)return res.status(404).json({ok:false,error:'Bot not found.'});
  if(access.access_role==='viewer')return res.status(403).json({ok:false,error:'Read-only workspace role.'});
  const feature=String(req.params.feature||'');
  if(!require('../discord/commands').features.includes(feature) || typeof req.body?.enabled!=='boolean')return res.status(400).json({ok:false,error:'Unknown feature or invalid enabled value.'});
  await db.prepare('UPDATE bot_features SET enabled=? WHERE bot_id=? AND feature_key=?').run(req.body.enabled?1:0,access.id,feature);
  if(!req.body.enabled){
    const commandModule=require('../discord/commands');
    const names=commandModule.definitions.filter(command=>commandModule.featureByCommand[command.name]===feature).map(command=>command.name);
    for(const name of names)await db.prepare('UPDATE bot_commands SET enabled=0 WHERE bot_id=? AND command_name=?').run(access.id,name);
  }
  let restarted = false;
  if (runtime.runtimeClients.has(access.id)) {
    await runtime.restartBot(access.id);
    await runtime.syncBotCommands(access.id);
    restarted = true;
  }
  await audit(req.session.user.id,'api.feature.toggle',access.id,`${feature}:${req.body.enabled}`);
  res.json({ok:true,data:{feature,enabled:req.body.enabled,restarted,restartRequired:!restarted,commandsSynced:restarted}});
});
router.post('/api/v1/bots/:id/sync-commands',async(req,res)=>{
  const access=await getApiBotAccess(req);
  if(!access)return res.status(404).json({ok:false,error:'Bot not found.'});
  if(access.access_role==='viewer')return res.status(403).json({ok:false,error:'Read-only workspace role.'});
  try{await runtime.syncBotCommands(access.id);res.json({ok:true,message:'Discord commands synchronized.'});}
  catch(error){res.status(409).json({ok:false,error:error.message});}
});
router.post('/api/v1/bots/bulk-control',async(req,res)=>{
  const action=String(req.body?.action||'');
  const ids=Array.isArray(req.body?.ids)?[...new Set(req.body.ids.map(value=>String(value)))]:[];
  if(!['start','stop','restart'].includes(action)||!ids.length||ids.length>20||ids.some(id=>id.length>80))return res.status(400).json({ok:false,error:'Provide 1–20 bot IDs and a supported action.'});
  const accessRows=[];
  for(const id of ids){
    req.params.id=id;
    const access=await getApiBotAccess(req);
    if(!access)return res.status(404).json({ok:false,error:'One or more bots were not found or are not accessible.'});
    if(access.access_role==='viewer')return res.status(403).json({ok:false,error:'Bulk control includes a read-only workspace bot.'});
    accessRows.push(access);
  }
  const results=[];
  for(const bot of accessRows){
    try{
      if(action==='start')await runtime.startBot(bot.id);
      else if(action==='stop')await runtime.stopBot(bot.id);
      else await runtime.restartBot(bot.id);
      results.push({id:bot.id,ok:true,status:action==='stop'?'offline':'starting'});
    }catch(error){results.push({id:bot.id,ok:false,error:error.message});}
  }
  await audit(req.session.user.id,'api.bots.bulk-control','multiple',`${action}:${ids.length}`);
  res.json({ok:results.every(item=>item.ok),data:results});
});

router.post('/api/v1/bots/:id/control/:action',async(req,res)=>{
  const bot=await db.prepare(`SELECT b.id,b.owner_id,CASE WHEN b.owner_id=? THEN 'owner' ELSE COALESCE((SELECT wm.role FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active' ORDER BY CASE wm.role WHEN 'administrator' THEN 3 WHEN 'developer' THEN 2 ELSE 1 END DESC LIMIT 1),'viewer') END AS access_role FROM bots b WHERE b.id=? AND (b.owner_id=? OR EXISTS(SELECT 1 FROM workspace_bots wb JOIN workspace_members wm ON wm.workspace_id=wb.workspace_id WHERE wb.bot_id=b.id AND wm.user_id=? AND wm.status='active'))`).get(req.session.user.id,req.session.user.id,req.params.id,req.session.user.id,req.session.user.id);
  if(!bot)return res.status(404).json({ok:false,error:'Bot not found.'});
  if(bot.access_role==='viewer')return res.status(403).json({ok:false,error:'Read-only workspace role.'});
  try{if(req.params.action==='start')await runtime.startBot(bot.id);else if(req.params.action==='stop')await runtime.stopBot(bot.id);else if(req.params.action==='restart')await runtime.restartBot(bot.id);else return res.status(400).json({ok:false,error:'Unsupported action.'});res.json({ok:true,status:req.params.action==='stop'?'offline':'starting'});}catch(error){res.status(409).json({ok:false,error:error.message});}
});
router.get('/api/v1/workspaces',async(req,res)=>{
  const rows=await db.prepare('SELECT w.id,w.name,m.role,m.status FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.status=?').all(req.session.user.id,'active');
  res.json({ok:true,data:rows});
});

router.get('/admin/platform-analytics',requireAdmin,(req,res)=>res.redirect('/admin/analytics'));
router.get('/admin/audit-logs',requireAdmin,(req,res)=>res.redirect('/admin/audit'));
router.get('/admin/system-settings',requireAdmin,(req,res)=>res.redirect('/admin/settings'));
router.get('/admin/system-health',requireAdmin,(req,res)=>res.redirect('/admin/health'));
router.get('/admin/users/:id',requireAdmin,async(req,res)=>{
  const user=await db.prepare('SELECT id,discord_id,username,global_name,is_suspended,created_at,last_login_at FROM users WHERE id=?').get(req.params.id);
  if(!user)return res.status(404).render('errors/error',{title:'User not found',message:'User does not exist.'});
  page(res,`User: ${user.username}`,'User account details.',{items:[`Discord ID: ${user.discord_id}`,`Global name: ${user.global_name||'Not set'}`,`Suspended: ${user.is_suspended?'Yes':'No'}`,`Created: ${user.created_at}`,`Last login: ${user.last_login_at}`]});
});

module.exports = router;
