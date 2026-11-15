import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { randomBytes, createHash } from 'node:crypto';
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
async function signedPoster(p) { if (!p.storage_path || !supabase) return p; const {data,error}=await supabase.storage.from('linkserve-posters').createSignedUrl(p.storage_path,3600); if(error) throw error; return {...p,image_url:data.signedUrl}; }
app.get('/api/posters', route(async (req,res) => res.json(await Promise.all((await all('posters')).map(signedPoster)))));
app.post('/api/posters/upload', express.raw({type:'image/*',limit:'20mb'}), route(async (req,res) => {
  if (!supabase) return res.status(503).json({error:'Configure Supabase before uploading posters.'});
  const bytes=req.body, mime=req.headers['content-type']; if(!Buffer.isBuffer(bytes)||!String(mime).startsWith('image/')) return res.status(400).json({error:'Upload a valid image.'});
  const hash=createHash('sha256').update(bytes).digest('hex');
  const {data:duplicate,error:lookupError}=await supabase.from('posters').select('id,title').eq('image_hash',hash).maybeSingle(); if(lookupError) throw lookupError; if(duplicate) return res.status(409).json({error:`This image already exists as “${duplicate.title}”.`});
  const id=randomBytes(16).toString('hex'), path=`${id}.${String(mime).split('/')[1].replace(/[^a-z0-9.+-]/gi,'')||'img'}`;
  const {error:uploadError}=await supabase.storage.from('linkserve-posters').upload(path,bytes,{contentType:mime,upsert:false}); if(uploadError) throw uploadError;
  const title=String(req.headers['x-poster-title']||'Untitled poster').trim().slice(0,200), description=String(req.headers['x-poster-description']||'').slice(0,2000), tags=String(req.headers['x-poster-tags']||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,30);
  const {data,error}=await supabase.from('posters').insert({title,description,image_url:path,storage_path:path,image_hash:hash,tags,status:'available'}).select().single(); if(error){await supabase.storage.from('linkserve-posters').remove([path]); if(error.code==='23505')return res.status(409).json({error:'This image is already in your poster library.'}); throw error;} res.status(201).json(await signedPoster(data));
}));
app.delete('/api/posters/:id', route(async (req,res) => { const {data:p,error}=await supabase.from('posters').select('storage_path').eq('id',req.params.id).single(); if(error)throw error; await del('posters',req.params.id); if(p.storage_path)await supabase.storage.from('linkserve-posters').remove([p.storage_path]); res.json({ok:true}); }));
app.get('/api/schedules', route(async (req,res) => res.json((await all('scheduled_posts')).map(p=>({...p,image_url:serveableDriveImage(p.image_url)})))));
app.post('/api/schedules', route(async (req,res) => { const {poster_id,scheduled_at,channel='Viber Community'}=req.body; if (!poster_id || !scheduled_at || new Date(scheduled_at)<=new Date()) return res.status(400).json({error:'Choose a poster and future schedule time'}); const {data:p,error}=await supabase.from('posters').select('*').eq('id',poster_id).single(); if(error)throw error; if(p.status==='published')return res.status(409).json({error:'This poster is already published. Share it again from its card instead.'}); const {data:existing}=await supabase.from('scheduled_posts').select('id').eq('poster_id',poster_id).in('status',['scheduled','ready_to_share']).limit(1); if(existing?.length)return res.status(409).json({error:'This poster already has an active schedule.'}); res.status(201).json(await insert('scheduled_posts',{poster_id,poster_title:p.title,image_url:p.storage_path,channel,caption:'',scheduled_at,status:'scheduled'})); }));
app.patch('/api/schedules/:id', route(async (req,res) => { const {scheduled_at}=req.body; if(!scheduled_at||new Date(scheduled_at)<=new Date())return res.status(400).json({error:'Choose a future schedule time'}); const row=await update('scheduled_posts',req.params.id,{scheduled_at,status:'scheduled'}); res.json(row); }));
app.delete('/api/schedules/:id', route(async (req,res) => { const row=await update('scheduled_posts',req.params.id,{status:'cancelled'}); res.json(row || {ok:true}); }));
app.get('/api/history', route(async (req,res) => res.json(await all('posting_history'))));
app.post('/api/publications', route(async (req,res) => { const {poster_id}=req.body; const {data:p,error}=await supabase.from('posters').select('*').eq('id',poster_id).single(); if(error)throw error; const {data:previous}=await supabase.from('posting_history').select('id').eq('poster_id',poster_id).eq('result','published').limit(1); const item=await insert('posting_history',{poster_id,poster_title:p.title,channel:'Viber Community',publication_type:previous?.length?'Republished':'First publication',result:'published',detail:'Confirmed as shared by administrator.'}); await update('posters',poster_id,{status:'published'}); res.status(201).json(item); }));
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
// Scheduled posts remain scheduled; the app surfaces due reminders without claiming publication.
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
