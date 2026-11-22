// TB EDC Platform - API server (Express + SQLite). Serves ./public.
const express=require('express'),{DatabaseSync}=require('node:sqlite'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),cookie=require('cookie-parser'),fs=require('fs'),path=require('path');
const PORT=process.env.PORT||3000,SECRET=process.env.JWT_SECRET||'dev-only-change-me',PROD=process.env.NODE_ENV==='production';
if(PROD&&SECRET==='dev-only-change-me'){console.error('Set JWT_SECRET in production.');process.exit(1)}
const DBF=process.env.DB_FILE||path.join(__dirname,'data','edc.db');
fs.mkdirSync(path.dirname(DBF),{recursive:true});
const db=new DatabaseSync(DBF);db.exec('PRAGMA journal_mode=WAL');
const tx=fn=>{db.exec('BEGIN');try{fn();db.exec('COMMIT')}catch(e){try{db.exec('ROLLBACK')}catch(_){}throw e}};
db.exec(`create table if not exists users(username text primary key,hash text not null,name text,role text,title text,initials text,admin integer default 0);
create table if not exists subjects(id text primary key,data text not null);
create table if not exists forms(id text primary key,data text not null);
create table if not exists queries(id text primary key,data text not null);
create table if not exists audit(seq integer primary key autoincrement,id text unique,data text not null);`);
if(!db.prepare('select count(*) c from users').get().c){
 const iu=db.prepare('insert into users values(?,?,?,?,?,?,?)');
 iu.run('trainee',bcrypt.hashSync('Trainee@123',10),'Trainee Kumar','dm','Data Manager','TK',0);
 iu.run('admin',bcrypt.hashSync('Admin@123',10),'Admin Singh','dm','Data Manager Lead','AS',1);
 iu.run('site',bcrypt.hashSync('Site@123',10),'Site Rao','site','Site Coordinator','SR',0)}
const p2=n=>String(n).padStart(2,'0'),now=()=>{const d=new Date();return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`};
const E=(c,m)=>Object.assign(new Error(m),{code:c});
const chk=o=>{if(!o||typeof o.id!=='string'||!o.id||o.id.length>100)throw E(400,'Invalid record.')};
const get=(t,id)=>{const r=db.prepare(`select data from ${t} where id=?`).get(id);return r?JSON.parse(r.data):null};
const up=(t,o)=>db.prepare(`insert into ${t}(id,data) values(?,?) on conflict(id) do update set data=excluded.data`).run(o.id,JSON.stringify(o));

// Backups live next to the database file, so on hosting they sit on the persistent disk too.
const BK=path.join(path.dirname(DBF),'backups');fs.mkdirSync(BK,{recursive:true});
function backup(){try{const d=new Date(),f=path.join(BK,'edc-'+d.getFullYear()+p2(d.getMonth()+1)+p2(d.getDate())+'-'+p2(d.getHours())+p2(d.getMinutes())+'.db');if(!fs.existsSync(f))db.exec("VACUUM INTO '"+f.replace(/'/g,"''")+"'");fs.readdirSync(BK).filter(x=>x.endsWith('.db')).sort().slice(0,-14).forEach(x=>fs.unlinkSync(path.join(BK,x)))}catch(e){console.error('Backup failed:',e.message)}}
backup();setInterval(backup,6*3600*1000).unref();
const app=express();app.disable('x-powered-by');
if(PROD)app.set('trust proxy',1); // hosting proxy (Render etc.) - makes req.ip the real client IP for login lockout
app.use((q,r,n)=>{r.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"});n()});
app.use(express.json({limit:'2mb'}));app.use(cookie());
const auth=(req,res,next)=>{try{req.u=jwt.verify(req.cookies.t,SECRET);next()}catch(e){res.status(401).json({error:'Please sign in.'})}};
const fail=(res,c,m)=>res.status(c).json({error:m});
const pub=u=>({username:u.username,name:u.name,role:u.role,title:u.title,initials:u.initials,admin:!!u.admin});
const fails=new Map(),LIM=5,WIN=15*60*1000,limited=k=>{const f=fails.get(k);return f&&f.n>=LIM&&Date.now()-f.t<WIN};
app.post('/api/login',(req,res)=>{const un=String(req.body.username||'').trim().toLowerCase(),key=(req.ip||'')+'|'+un;
 if(limited(key))return fail(res,429,'Too many failed attempts. Try again in 15 minutes.');
 const u=db.prepare('select * from users where username=?').get(un);
 if(!u||!bcrypt.compareSync(String(req.body.password||''),u.hash)){const f=fails.get(key)||{n:0,t:0};f.n=Date.now()-f.t>WIN?1:f.n+1;f.t=Date.now();fails.set(key,f);return fail(res,401,'Invalid username or password.')}
 fails.delete(key);res.cookie('t',jwt.sign(pub(u),SECRET,{expiresIn:'8h'}),{httpOnly:true,sameSite:'lax',secure:PROD});res.json(pub(u))});
app.post('/api/logout',(q,r)=>{r.clearCookie('t');r.json({})});
app.get('/api/me',auth,(req,res)=>res.json(pub(req.u)));
app.get('/api/data',auth,(req,res)=>{const all=(t,o)=>db.prepare(`select data from ${t} order by ${o}`).all().map(r=>JSON.parse(r.data));
 res.json({subjects:all('subjects','id'),forms:all('forms','rowid'),queries:all('queries','rowid'),audit:all('audit','seq')})});
app.post('/api/batch',auth,(req,res)=>{const b=req.body||{},u=req.u,dm=u.role==='dm',ts=now(),arr=k=>Array.isArray(b[k])?b[k]:[];
 try{tx(()=>{
  arr('subjects').forEach(s=>{chk(s);up('subjects',s)});
  arr('forms').forEach(f=>{chk(f);const old=get('forms',f.id);
   if(old&&old.status==='signed'&&!dm)throw E(403,'This form is signed and locked. Only a data manager can unlock it.');
   if(f.status==='signed'&&(!old||old.status!=='signed')&&!dm)throw E(403,'Only a data manager can sign a form.');
   f.savedBy=u.username;f.savedAt=ts;up('forms',f)});
  arr('queries').forEach(q=>{chk(q);const old=get('queries',q.id),was=old&&old.status;
   if(q.status==='answered'&&was!=='answered'){if(u.role!=='site')throw E(403,'Only site coordinators can answer queries.');q.respondedBy=u.username;q.respondedAt=ts}
   if(q.status==='closed'&&was!=='closed'&&q.closedBy!=='system'){if(!dm)throw E(403,'Only data managers can close queries.');q.closedBy=u.username;q.closedAt=ts}
   if(q.status==='open'&&was==='answered'&&!dm)throw E(403,'Only data managers can re-open queries.');
   up('queries',q)});
  arr('audit').forEach(a=>{chk(a);if(db.prepare('select 1 from audit where id=?').get(a.id))return;a.user=u.username;a.ts=ts;
   db.prepare('insert into audit(id,data) values(?,?)').run(a.id,JSON.stringify(a))});
 });res.json({ok:1})}catch(e){fail(res,e.code||500,e.code?e.message:'Could not save. Try again.')}});
app.post('/api/seed',auth,(req,res)=>{const empty=!db.prepare('select 1 from subjects').get();
 if(!empty&&!(req.body.force&&req.u.admin))return fail(res,403,'Only the admin can reset practice data.');
 const d=req.body.data||{};
 try{tx(()=>{['subjects','forms','queries','audit'].forEach(t=>db.exec('delete from '+t));
  ['subjects','forms','queries'].forEach(t=>(d[t]||[]).forEach(o=>{chk(o);up(t,o)}));
  (d.audit||[]).forEach(a=>{chk(a);db.prepare('insert or ignore into audit(id,data) values(?,?)').run(a.id,JSON.stringify(a))})});res.json({ok:1})}
 catch(e){fail(res,e.code||500,e.code?e.message:'Could not seed data.')}});
const adm=(req,res,next)=>req.u.admin?next():fail(res,403,'Admin only.');
app.get('/api/users',auth,adm,(q,r)=>r.json(db.prepare('select username,name,role,title,initials,admin from users order by username').all().map(pub)));
app.post('/api/users',auth,adm,(req,res)=>{const b=req.body||{},un=String(b.username||'').trim().toLowerCase(),pw=String(b.password||''),nm=String(b.name||'').trim().slice(0,60);
 if(!/^[a-z0-9._-]{3,30}$/.test(un))return fail(res,400,'Username: 3-30 letters, numbers, dot, dash or underscore.');
 if(pw.length<8)return fail(res,400,'Password must be at least 8 characters.');if(!nm)return fail(res,400,'Name is required.');
 if(!['dm','site'].includes(b.role))return fail(res,400,'Choose a role.');if(db.prepare('select 1 from users where username=?').get(un))return fail(res,409,'Username already exists.');
 db.prepare('insert into users values(?,?,?,?,?,?,?)').run(un,bcrypt.hashSync(pw,10),nm,b.role,b.role==='dm'?'Data Manager':'Site Coordinator',nm.split(/\s+/).map(w=>w[0]).join('').slice(0,3).toUpperCase(),0);res.json({ok:1})});
app.post('/api/users/reset',auth,adm,(req,res)=>{const un=String(req.body.username||'').toLowerCase(),pw=String(req.body.password||'');
 if(pw.length<8)return fail(res,400,'Password must be at least 8 characters.');if(!db.prepare('select 1 from users where username=?').get(un))return fail(res,404,'User not found.');
 db.prepare('update users set hash=? where username=?').run(bcrypt.hashSync(pw,10),un);res.json({ok:1})});
app.post('/api/password',auth,(req,res)=>{const u=db.prepare('select * from users where username=?').get(req.u.username),n=String(req.body.new||'');
 if(!u||!bcrypt.compareSync(String(req.body.old||''),u.hash))return fail(res,401,'Current password is wrong.');if(n.length<8)return fail(res,400,'New password must be at least 8 characters.');
 db.prepare('update users set hash=? where username=?').run(bcrypt.hashSync(n,10),u.username);res.json({ok:1})});
const csv=v=>{let s=String(v==null?'':v);if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};
const send=(res,name,rows)=>{res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename='+name});res.send('\ufeff'+rows.map(r=>r.map(csv).join(',')).join('\r\n'))};
const all=t=>db.prepare('select data from '+t+' order by rowid').all().map(r=>JSON.parse(r.data));
app.get('/api/export.csv',auth,(req,res)=>{if(req.u.role!=='dm')return fail(res,403,'Only data managers can export.');
 const rows=[['subject','visit','form','row','field','value','status','saved_by','saved_at']];
 all('forms').forEach(f=>{const fl=f.fields||{},b=[f.subjectId,f.visitId,f.formName],e=[f.status,f.savedBy,f.savedAt];
  if(Array.isArray(fl.rows)){if(!fl.rows.length)rows.push([...b,'','(no entries)','',...e]);fl.rows.forEach((r,i)=>Object.keys(r).forEach(k=>rows.push([...b,i+1,k,r[k],...e])))}else Object.keys(fl).forEach(k=>rows.push([...b,'',k,fl[k],...e]))});
 send(res,'tb-edc-data.csv',rows)});
app.get('/api/audit.csv',auth,(req,res)=>{if(req.u.role!=='dm')return fail(res,403,'Only data managers can export.');
 send(res,'tb-edc-audit.csv',[['when','user','subject','visit','form','field','old_value','new_value','reason']].concat(all('audit').map(a=>[a.ts,a.user,a.subjectId,a.visitId,a.formName,a.fieldName,a.oldValue,a.newValue,a.reason])))});
app.use(express.static(path.join(__dirname,'public')));
app.listen(PORT,()=>console.log(`TB EDC Platform running at http://localhost:${PORT}`));