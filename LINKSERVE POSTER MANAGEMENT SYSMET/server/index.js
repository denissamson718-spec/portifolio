import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = express();
app.use(cors()); app.use(express.json({ limit: '2mb' }));
const port = process.env.PORT || 3001;
const driveTokenPath = resolve(process.env.GOOGLE_DRIVE_TOKEN_FILE || '.google-drive-token.json');
let pendingDriveOAuthState = '';
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = await import('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}
const memory = { posters: [], scheduled_posts: [], posting_history: [] };
const demoPosters = [
  ['Summer Sale Collection', 'Limited time offers across our summer range.', 'photo-1516321318423-f06f85e504b3', ['summer','sale']],
  ['New Arrivals — Everyday Essentials', 'Fresh picks for the new season.', 'photo-1490481651871-ab68de25d43d', ['new','collection']],
  ['Weekend Special', 'A little something for your weekend plans.', 'photo-1523275335684-37898b6baf30', ['weekend','special']],
  ['Member Appreciation', 'Thank you for being part of our community.', 'photo-1529139574466-a303027c1d8b', ['members','thank-you']],
  ['Flash Deal: 24 Hours', 'Your favorites, for less. Today only.', 'photo-1542291026-7eec264c27ff', ['flash','deal']],
  ['The Gift Edit', 'Thoughtful finds for every occasion.', 'photo-1515886657613-9f3515b0c78f', ['gifts','edit']]
].map(([title, description, photo, tags], i) => ({ id: `demo-${i+1}`, title, description, image_url: `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=900&q=85`, tags, status: 'ready', created_at: new Date(Date.now()-i*86400000).toISOString() }));

async function all(table) {
  if (!supabase) return memory[table];
  const { data, error } = await supabase.from(table).select('*').order(table === 'scheduled_posts' ? 'scheduled_at' : table === 'posting_history' ? 'posted_at' : 'created_at', { ascending: table !== 'posters' });
  if (error) throw error; return data || [];
}
async function insert(table, item) {
  if (!supabase) { const row = { id: `local-${Date.now()}`, created_at: new Date().toISOString(), ...item }; memory[table].unshift(row); return row; }
  const { data, error } = await supabase.from(table).insert(item).select().single(); if (error) throw error; return data;
}
async function update(table, id, values) {
  if (!supabase) { const row = memory[table].find(x => x.id === id); if (row) Object.assign(row, values); return row; }
  const { data, error } = await supabase.from(table).update(values).eq('id', id).select().single(); if (error) throw error; return data;
}
async function del(table, id) {
  if (!supabase) { memory[table] = memory[table].filter(x => x.id !== id); return; }
  const { error } = await supabase.from(table).delete().eq('id', id); if (error) throw error;
}
if (!supabase) memory.posters.push(...demoPosters);
const route = fn => (req,res) => Promise.resolve(fn(req,res)).catch(e => { console.error(e); res.status(500).json({ error: e.message || 'Server error' }); });
function driveOAuthConfigured() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URI && process.env.GOOGLE_DRIVE_ACCOUNT && process.env.GOOGLE_DRIVE_FOLDER_ID);
}
function readDriveToken() {
  try { return JSON.parse(readFileSync(driveTokenPath, 'utf8')); } catch { return null; }
}
function driveConnected() {
  const record = readDriveToken();
  return Boolean(driveOAuthConfigured() && record?.email?.toLowerCase() === process.env.GOOGLE_DRIVE_ACCOUNT.toLowerCase() && record?.tokens);
}
function googleOAuthClient(google) {
  return new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, process.env.GOOGLE_OAUTH_REDIRECT_URI);
}
app.get('/api/health', (req,res) => res.json({ ok:true, storage: supabase ? 'supabase' : 'demo', authConfigured:!!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.VITE_SUPABASE_ANON_KEY), supabaseUrl:process.env.VITE_SUPABASE_URL||process.env.SUPABASE_URL||'', anonKey:process.env.VITE_SUPABASE_ANON_KEY||'', appName: process.env.APP_NAME || 'LINKSERVE POSTER MANAGEMENT SYSTEM', viberConfigured: !!process.env.VIBER_AUTH_TOKEN, driveOAuthConfigured:driveOAuthConfigured(), driveConnected:driveConnected(), driveAccount:process.env.GOOGLE_DRIVE_ACCOUNT||'', driveConfigured:driveConnected() }));
app.use('/api', async (req,res,next) => {
  if (req.path==='/health' || req.path==='/drive/connect' || req.path.startsWith('/drive/oauth/') || req.path.startsWith('/drive/image/') || !supabase) return next();
  const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({error:'Sign in to continue'});
  const {data,error}=await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({error:'Your session has expired. Sign in again.'});
  next();
});
function serveableDriveImage(url, driveFileId) {
  const id = driveFileId || String(url || '').match(/[?&]id=([^&]+)/)?.[1];
  return id ? `/api/drive/image/${encodeURIComponent(id)}` : url;
}
app.get('/api/posters', route(async (req,res) => res.json((await all('posters')).map(p=>({...p,image_url:serveableDriveImage(p.image_url,p.drive_file_id)})))));
app.post('/api/posters', route(async (req,res) => { const title=String(req.body.title||'').trim()||'Untitled poster'; const description=String(req.body.description||'').trim(); const image_url=String(req.body.image_url||'').trim()||'/poster-placeholder.svg'; const tags=Array.isArray(req.body.tags)?req.body.tags:[]; res.status(201).json(await insert('posters',{title,description,image_url,tags,status:'ready'})); }));
app.delete('/api/posters/:id', route(async (req,res) => { await del('posters',req.params.id); res.json({ok:true}); }));
app.get('/api/schedules', route(async (req,res) => res.json((await all('scheduled_posts')).map(p=>({...p,image_url:serveableDriveImage(p.image_url)})))));
app.post('/api/schedules', route(async (req,res) => { const {poster_id,poster_title,image_url,channel='Manual sharing',caption='',scheduled_at} = req.body; if (!poster_title || !image_url || !scheduled_at) return res.status(400).json({error:'Choose a poster and schedule time'}); res.status(201).json(await insert('scheduled_posts',{poster_id,poster_title,image_url,channel,caption,scheduled_at,status:'scheduled'})); }));
app.delete('/api/schedules/:id', route(async (req,res) => { const row=await update('scheduled_posts',req.params.id,{status:'cancelled'}); res.json(row || {ok:true}); }));
app.get('/api/history', route(async (req,res) => res.json(await all('posting_history'))));
app.get('/api/drive/connect', route(async (req,res) => {
  if (!driveOAuthConfigured()) return res.status(503).send('Google Drive OAuth is not configured. Add the OAuth client ID and secret to .env.');
  const { google } = await import('googleapis');
  const oauth = googleOAuthClient(google);
  pendingDriveOAuthState = randomBytes(24).toString('hex');
  res.redirect(oauth.generateAuthUrl({
    access_type:'offline',
    prompt:'consent',
    include_granted_scopes:true,
    login_hint:process.env.GOOGLE_DRIVE_ACCOUNT,
    scope:['openid','email','https://www.googleapis.com/auth/drive.readonly'],
    state:pendingDriveOAuthState,
  }));
}));
app.get('/api/drive/oauth/callback', route(async (req,res) => {
  if (req.query.error) return res.status(400).send('Google Drive connection was cancelled. Return to LINKSERVE and try again.');
  if (!pendingDriveOAuthState || String(req.query.state||'')!==pendingDriveOAuthState) return res.status(400).send('The Google sign-in could not be verified. Return to LINKSERVE and connect again.');
  pendingDriveOAuthState = '';
  const { google } = await import('googleapis');
  const oauth = googleOAuthClient(google);
  const { tokens } = await oauth.getToken(String(req.query.code||''));
  oauth.setCredentials(tokens);
  const { data:user } = await google.oauth2({version:'v2',auth:oauth}).userinfo.get();
  const expectedEmail=String(process.env.GOOGLE_DRIVE_ACCOUNT||'').toLowerCase();
  const signedInEmail=String(user.email||'').toLowerCase();
  if (!user.verified_email || signedInEmail!==expectedEmail) return res.status(403).send('Use the approved Google account '+process.env.GOOGLE_DRIVE_ACCOUNT+' to connect LINKSERVE.');
  const previous=readDriveToken();
  const savedTokens={...(previous?.email?.toLowerCase()===expectedEmail?previous.tokens:{}),...tokens};
  if (!savedTokens.refresh_token) return res.status(400).send('Google did not provide offline access. Try connecting again and approve the requested access.');
  writeFileSync(driveTokenPath,JSON.stringify({email:user.email,tokens:savedTokens},null,2),{mode:0o600});
  const appOrigin=(process.env.APP_ORIGIN||'http://localhost:5173').replace(/\/+$/,'');
  res.redirect(appOrigin+'/?drive_connected=1');
}));
app.get('/api/drive', route(async (req,res) => {
  if (!driveOAuthConfigured()) return res.status(503).json({error:'Configure Google OAuth client credentials in .env first.'});
  const record=readDriveToken();
  if (!record?.tokens || record.email?.toLowerCase()!==process.env.GOOGLE_DRIVE_ACCOUNT.toLowerCase()) return res.status(401).json({error:'Connect Google Drive as '+process.env.GOOGLE_DRIVE_ACCOUNT+' first.'});
  const { google } = await import('googleapis');
  const oauth=googleOAuthClient(google);
  oauth.setCredentials(record.tokens);
  const drive=google.drive({version:'v3',auth:oauth});
  try {
    const {data:folder}=await drive.files.get({fileId:process.env.GOOGLE_DRIVE_FOLDER_ID,fields:'id,mimeType',supportsAllDrives:true});
    if(folder.mimeType!=='application/vnd.google-apps.folder') return res.status(400).json({error:'The configured Google Drive ID is not a folder.'});
  } catch (error) {
    if([403,404].includes(Number(error.code||error.response?.status))) return res.status(403).json({error:'The Google account '+record.email+' cannot access the configured folder.'});
    throw error;
  }
  const {data}=await drive.files.list({q:"'"+process.env.GOOGLE_DRIVE_FOLDER_ID+"' in parents and trashed = false and mimeType contains 'image/'",fields:'files(id,name,mimeType,thumbnailLink,webViewLink,createdTime)',pageSize:50,orderBy:'createdTime desc',supportsAllDrives:true,includeItemsFromAllDrives:true});
  res.json((data.files||[]).map(f=>({id:f.id,title:f.name,description:'Imported from Google Drive',image_url:'/api/drive/image/'+encodeURIComponent(f.id),drive_file_id:f.id,status:'ready',tags:['drive'],created_at:f.createdTime})));
}));
app.get('/api/drive/image/:fileId', route(async (req,res) => {
  if (!driveConnected()) return res.status(401).end('Connect Google Drive to view this poster.');
  const fileId=String(req.params.fileId||'');
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(fileId)) return res.status(400).end('Invalid Drive file ID.');
  const record=readDriveToken();
  const { google } = await import('googleapis');
  const oauth=googleOAuthClient(google);
  oauth.setCredentials(record.tokens);
  const drive=google.drive({version:'v3',auth:oauth});
  const {data:metadata}=await drive.files.get({fileId,fields:'mimeType',supportsAllDrives:true});
  if (!String(metadata.mimeType||'').startsWith('image/')) return res.status(415).end('This Drive file is not an image.');
  const response=await drive.files.get({fileId,alt:'media',supportsAllDrives:true},{responseType:'stream'});
  res.set('Content-Type',metadata.mimeType);
  res.set('Cache-Control','private, max-age=3600');
  response.data.on('error',error=>{console.error('Drive image stream:',error.message);if(!res.headersSent)res.status(502);res.end();});
  response.data.pipe(res);
}));
app.post('/api/viber/send', route(async (req,res) => {
  const { poster_title, image_url, caption, receiver_ids=[] } = req.body;
  if (!process.env.VIBER_AUTH_TOKEN) return res.status(503).json({error:'Viber bot is not configured. Add a commercially provisioned Viber bot token.'});
  if (!Array.isArray(receiver_ids) || !receiver_ids.length) return res.status(400).json({error:'Add at least one opted-in Viber subscriber ID. Viber API cannot send to arbitrary groups.'});
  const outcomes=[];
  for (const receiver of receiver_ids) {
    const payload={receiver,type:'picture',media:image_url,thumbnail:image_url,text:caption || poster_title,sender:{name:(process.env.VIBER_SENDER_NAME||'LINKSERVE').slice(0,28)}};
    const response=await fetch('https://chatapi.viber.com/pa/send_message',{method:'POST',headers:{'Content-Type':'application/json','X-Viber-Auth-Token':process.env.VIBER_AUTH_TOKEN},body:JSON.stringify(payload)}); const result=await response.json();
    const ok=response.ok && result.status===0; outcomes.push({receiver,ok,status:result.status_message||result.status});
    await insert('posting_history',{poster_title,channel:'Viber subscriber',result:ok?'published':'failed',detail:String(result.status_message||result.status||'')});
  }
  res.json({outcomes});
}));
// Due items are surfaced in the dashboard for manual sharing. No unapproved group automation is attempted.
cron.schedule('* * * * *', async () => { try { const due=(await all('scheduled_posts')).filter(x=>x.status==='scheduled' && new Date(x.scheduled_at)<=new Date()); for(const item of due){ await update('scheduled_posts',item.id,{status:'ready_to_share'}); await insert('posting_history',{poster_title:item.poster_title,channel:item.channel,result:'ready to share',detail:'Scheduled item is ready for assisted sharing.'}); } } catch(e){console.error('Scheduler:',e.message);} }, {timezone:process.env.APP_TIMEZONE||'UTC'});
// Serve the Vite build from the same Render web service as the API.
const distPath = resolve('dist');
app.use(express.static(distPath));
app.use((req,res,next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(resolve(distPath, 'index.html'), error => error && next(error));
  }
  next();
});
app.listen(port,()=>console.log(`LINKSERVE API listening on http://localhost:${port}`));
