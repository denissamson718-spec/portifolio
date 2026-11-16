import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';

const app = express();
app.use(cors()); app.use(express.json({ limit: '2mb' }));
const port = process.env.PORT || 3001;
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
].map(([title, description, photo, tags], i) => ({ id: `demo-${i+1}`, title, description, image_url: `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=900&q=85`, tags, status: 'available', created_at: new Date(Date.now()-i*86400000).toISOString() }));

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
app.get('/api/health', (req,res) => res.json({ ok:true, storage: supabase ? 'supabase' : 'demo', authConfigured:!!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.VITE_SUPABASE_ANON_KEY), supabaseUrl:process.env.VITE_SUPABASE_URL||process.env.SUPABASE_URL||'', anonKey:process.env.VITE_SUPABASE_ANON_KEY||'', appName: process.env.APP_NAME || 'LINKSERVE POSTER MANAGEMENT SYSTEM' }));
app.use('/api', async (req,res,next) => {
  if (req.path==='/health' || !supabase) return next();
  const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({error:'Sign in to continue'});
  const {data,error}=await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({error:'Your session has expired. Sign in again.'});
  if (data.user.app_metadata?.role !== 'admin') return res.status(403).json({error:'Administrator access is required.'});
  next();
});
async function signedPoster(p) { if (!p.storage_path || !supabase) return p; const {data,error}=await supabase.storage.from('linkserve-posters').createSignedUrl(p.storage_path,3600); if(error) throw error; return {...p,image_url:data.signedUrl}; }
let imageHashesBackfilled=false;
let imageHashBackfillInFlight=null;
async function ensureStoredImageHashes() {
  if(imageHashesBackfilled)return;
  if(imageHashBackfillInFlight)return imageHashBackfillInFlight;
  imageHashBackfillInFlight=(async()=>{
  const {data:rows,error}=await supabase.from('posters').select('id,title,storage_path').is('image_hash',null).not('storage_path','is',null).limit(1000);
  if(error)throw error;
  for(const row of rows||[]){
    const {data:file,error:downloadError}=await supabase.storage.from('linkserve-posters').download(row.storage_path);
    if(downloadError){console.warn(`Could not hash stored image for poster ${row.id}: ${downloadError.message}`);continue;}
    const hash=createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
    const {error:updateError}=await supabase.from('posters').update({image_hash:hash}).eq('id',row.id).is('image_hash',null);
    if(updateError?.code==='23505')console.warn(`Existing duplicate image found while hashing poster ${row.id}.`);
    else if(updateError)throw updateError;
  }
  imageHashesBackfilled=true;
  })().finally(()=>{imageHashBackfillInFlight=null;});
  return imageHashBackfillInFlight;
}
app.get('/api/posters', route(async (req,res) => res.json(await Promise.all((await all('posters')).map(signedPoster)))));
app.post('/api/posters/upload', express.raw({type:'image/*',limit:'20mb'}), route(async (req,res) => {
  if (!supabase) return res.status(503).json({error:'Configure Supabase before uploading posters.'});
  const bytes=req.body, mime=String(req.headers['content-type']||'').split(';')[0].toLowerCase();
  const signatures={
    'image/jpeg':b=>b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff,
    'image/png':b=>b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/webp':b=>b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP',
    'image/gif':b=>b.length>=6&&/^GIF8[79]a$/.test(b.toString('ascii',0,6)),
    'image/avif':b=>b.length>=12&&b.toString('ascii',4,8)==='ftyp'&&/avif|avis/.test(b.toString('ascii',8,12)),
  };
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>20*1024*1024||!signatures[mime]?.(bytes)) return res.status(400).json({error:'Upload a valid JPEG, PNG, WebP, GIF, or AVIF image up to 20 MB.'});
  const hash=createHash('sha256').update(bytes).digest('hex');
  await ensureStoredImageHashes();
  const {data:duplicate,error:lookupError}=await supabase.from('posters').select('id,title').eq('image_hash',hash).maybeSingle(); if(lookupError) throw lookupError; if(duplicate) return res.status(409).json({error:`This image already exists as “${duplicate.title}”.`});
  const ext={ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif' }[mime];
  const path=`${randomBytes(16).toString('hex')}.${ext}`;
  const {error:uploadError}=await supabase.storage.from('linkserve-posters').upload(path,bytes,{contentType:mime,upsert:false}); if(uploadError) throw uploadError;
  const title=String(req.headers['x-poster-title']||'Untitled poster').trim().slice(0,200), description=String(req.headers['x-poster-description']||'').slice(0,2000), tags=String(req.headers['x-poster-tags']||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,30);
  const {data,error}=await supabase.from('posters').insert({title,description,image_url:path,storage_path:path,image_hash:hash,tags,status:'available'}).select().single();
  if(error){
    const {error:cleanupError}=await supabase.storage.from('linkserve-posters').remove([path]);
    if(cleanupError)throw new Error(`Poster record failed and its uploaded image could not be removed: ${cleanupError.message}`);
    if(error.code==='23505')return res.status(409).json({error:'This image is already in your poster library.'});
    throw error;
  }
  res.status(201).json(await signedPoster(data));
}));
app.get('/api/posters/:id/image', route(async (req,res) => {
  if(!supabase)return res.status(503).json({error:'Configure Supabase before downloading stored posters.'});
  const {data:poster,error}=await supabase.from('posters').select('title,storage_path').eq('id',req.params.id).single();
  if(error)throw error;
  if(!poster.storage_path)return res.status(404).json({error:'This poster does not have a Supabase Storage image.'});
  const {data:file,error:downloadError}=await supabase.storage.from('linkserve-posters').download(poster.storage_path);
  if(downloadError)throw downloadError;
  const safeName=String(poster.title||'poster').replace(/[^\w.-]+/g,'-').slice(0,100)||'poster';
  res.set('Content-Type',file.type||'application/octet-stream');
  res.set('Content-Disposition',`attachment; filename="${safeName}"`);
  res.set('Cache-Control','private, no-store');
  res.send(Buffer.from(await file.arrayBuffer()));
}));
app.delete('/api/posters/:id', route(async (req,res) => { if(!supabase){await del('posters',req.params.id);return res.json({ok:true});} const {data:p,error}=await supabase.from('posters').select('storage_path').eq('id',req.params.id).single(); if(error)throw error; if(p.storage_path){const {error:storageError}=await supabase.storage.from('linkserve-posters').remove([p.storage_path]);if(storageError)throw storageError;} await del('posters',req.params.id); res.json({ok:true}); }));
app.get('/api/schedules', route(async (req,res) => {
  const rows=await all('scheduled_posts'), now=Date.now();
  for(const row of rows) if(row.status==='scheduled'&&new Date(row.scheduled_at).getTime()<=now) await update('scheduled_posts',row.id,{status:'ready_to_share'});
  const fresh=await all('scheduled_posts');
  res.json(await Promise.all(fresh.map(async row=>{
    if(!row.poster_id||!supabase)return row;
    const {data:p,error}=await supabase.from('posters').select('storage_path').eq('id',row.poster_id).maybeSingle();
    if(error)throw error;
    return p?.storage_path?{...row,image_url:(await signedPoster({storage_path:p.storage_path})).image_url}:row;
  })));
}));
app.post('/api/schedules', route(async (req,res) => {
  const {poster_id,scheduled_at,channel='Viber Community'}=req.body;
  if(!poster_id||!Number.isFinite(Date.parse(scheduled_at))||Date.parse(scheduled_at)<=Date.now())return res.status(400).json({error:'Choose a poster and a future schedule time.'});
  if(!supabase){
    const p=memory.posters.find(poster=>poster.id===poster_id);
    if(!p)return res.status(404).json({error:'Poster not found.'});
    if(p.status!=='available')return res.status(409).json({error:'Only available posters can be scheduled.'});
    if(memory.scheduled_posts.some(item=>item.poster_id===poster_id&&['scheduled','ready_to_share'].includes(item.status)))return res.status(409).json({error:'This poster already has an active schedule.'});
    const row=await insert('scheduled_posts',{poster_id,poster_title:p.title,image_url:p.image_url,channel,caption:'',scheduled_at,status:'scheduled'});
    await update('posters',poster_id,{status:'scheduled'});
    return res.status(201).json(row);
  }
  const {data:p,error}=await supabase.from('posters').select('*').eq('id',poster_id).single();if(error)throw error;
  if(p.status!=='available')return res.status(409).json({error:p.status==='scheduled'?'This poster already has a schedule.':'Only available posters can be scheduled.'});
  const {data:existing,error:existingError}=await supabase.from('scheduled_posts').select('id').eq('poster_id',poster_id).in('status',['scheduled','ready_to_share']).limit(1);
  if(existingError)throw existingError;if(existing?.length)return res.status(409).json({error:'This poster already has an active schedule.'});
  let row;
  try{row=await insert('scheduled_posts',{poster_id,poster_title:p.title,image_url:p.storage_path||p.image_url,storage_path:p.storage_path||null,channel,caption:'',scheduled_at,status:'scheduled'});}
  catch(error){if(error.code==='23505')return res.status(409).json({error:'This poster already has an active schedule.'});throw error;}
  await update('posters',poster_id,{status:'scheduled'});
  res.status(201).json(row);
}));
app.patch('/api/schedules/:id', route(async (req,res) => {
  const {scheduled_at}=req.body;
  if(!Number.isFinite(Date.parse(scheduled_at))||Date.parse(scheduled_at)<=Date.now())return res.status(400).json({error:'Choose a future schedule time.'});
  if(!supabase){
    const current=memory.scheduled_posts.find(item=>item.id===req.params.id);
    if(!current||!['scheduled','ready_to_share'].includes(current.status))return res.status(409).json({error:'This schedule is no longer active.'});
    return res.json(await update('scheduled_posts',req.params.id,{scheduled_at,status:'scheduled'}));
  }
  const {data:existing,error}=await supabase.from('scheduled_posts').select('id,poster_id,status').eq('id',req.params.id).single();if(error)throw error;
  if(!['scheduled','ready_to_share'].includes(existing.status))return res.status(409).json({error:'This schedule is no longer active.'});
  const row=await update('scheduled_posts',req.params.id,{scheduled_at,status:'scheduled'});res.json(row);
}));
app.delete('/api/schedules/:id', route(async (req,res) => {
  if(!supabase){
    const current=memory.scheduled_posts.find(item=>item.id===req.params.id);
    if(!current)return res.json({ok:true});
    const row=await update('scheduled_posts',req.params.id,{status:'cancelled'});
    if(current.poster_id)await update('posters',current.poster_id,{status:'available'});
    return res.json(row);
  }
  const {data:existing,error}=await supabase.from('scheduled_posts').select('poster_id,status').eq('id',req.params.id).single();if(error)throw error;
  const row=await update('scheduled_posts',req.params.id,{status:'cancelled'});
  if(existing.poster_id&&['scheduled','ready_to_share'].includes(existing.status))await update('posters',existing.poster_id,{status:'available'});
  res.json(row||{ok:true});
}));
app.get('/api/history', route(async (req,res) => res.json(await all('posting_history'))));
app.post('/api/publications', route(async (req,res) => {
  const {poster_id,confirmed}=req.body;
  if(confirmed!==true)return res.status(400).json({error:'Confirm that you shared this poster before recording publication.'});
  if(!supabase){
    const p=memory.posters.find(poster=>poster.id===poster_id);
    if(!p)return res.status(404).json({error:'Poster not found.'});
    const previous=memory.posting_history.some(item=>item.result==='published'&&(item.poster_id===poster_id||item.poster_title===p.title));
    const item=await insert('posting_history',{poster_id,poster_title:p.title,channel:'Viber Community',publication_type:previous?'Republished':'First publication',result:'published',detail:'Sharing confirmed by administrator.',posted_at:new Date().toISOString()});
    await update('posters',poster_id,{status:'published'});
    for(const schedule of memory.scheduled_posts.filter(item=>item.poster_id===poster_id&&['scheduled','ready_to_share'].includes(item.status)))await update('scheduled_posts',schedule.id,{status:'cancelled'});
    return res.status(201).json(item);
  }
  const {data:p,error}=await supabase.from('posters').select('*').eq('id',poster_id).single();if(error)throw error;
  const {data:previous,error:historyError}=await supabase.from('posting_history').select('id').eq('poster_id',poster_id).eq('result','published').limit(1);
  if(historyError)throw historyError;
  let hasPrevious=Boolean(previous?.length);
  if(!hasPrevious){
    const {data:legacyHistory,error:legacyError}=await supabase.from('posting_history').select('id').eq('poster_title',p.title).eq('result','published').limit(1);
    if(legacyError)throw legacyError;
    hasPrevious=Boolean(legacyHistory?.length);
  }
  if(!['available','published','scheduled'].includes(p.status))return res.status(409).json({error:'This poster cannot be published in its current state.'});
  const item=await insert('posting_history',{poster_id,poster_title:p.title,channel:'Viber Community',publication_type:hasPrevious?'Republished':'First publication',result:'published',detail:'Sharing confirmed by administrator.'});
  await update('posters',poster_id,{status:'published'});
  const {error:scheduleError}=await supabase.from('scheduled_posts').update({status:'cancelled'}).eq('poster_id',poster_id).in('status',['scheduled','ready_to_share']);
  if(scheduleError)throw scheduleError;
  res.status(201).json(item);
}));
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
