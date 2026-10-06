import http from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {OAuth2Client} from 'google-auth-library';
import {randomToken,validName,validEmail,validateEntry,validatePhotos,signBridge} from './core.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT||5188),origin=process.env.PUBLIC_ORIGIN||`http://localhost:${port}`;
const live=process.env.APP_MODE==='live',secure=new URL(origin).protocol==='https:';
if(!secure&&!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('PUBLIC_ORIGIN must use HTTPS outside localhost.');
const owner=validEmail(process.env.OWNER_EMAIL||'jack82342005@gmail.com');
const dir=path.resolve(root,process.env.DATA_DIRECTORY||'data');mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'app.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`CREATE TABLE IF NOT EXISTS members(email TEXT PRIMARY KEY,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS users(sub TEXT PRIMARY KEY,email TEXT NOT NULL,nickname TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,sub TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY,browser_token TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL);`);
db.prepare('INSERT INTO members(email,role) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role,active=1').run(owner,'admin');
const authConfigured=!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET);
const bridgeConfigured=!!(process.env.APPS_SCRIPT_URL&&process.env.BRIDGE_SECRET);
const oauth=new OAuth2Client(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,origin+'/auth/google/callback');
const hash=t=>createHash('sha256').update(t).digest('hex');
const cookie=(name,value,age)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(s=>s.trim().split('=')));
const response=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const redirect=(res,to)=>{res.writeHead(302,{Location:to,'Cache-Control':'no-store'});res.end();};
function actor(req){const token=cookies(req).ankuan_session;if(!token)return null;const p=db.prepare('SELECT u.sub AS id,u.email,u.nickname,m.role FROM sessions s JOIN users u ON u.sub=s.sub JOIN members m ON m.email=u.email WHERE s.token=? AND s.expires>? AND m.active=1').get(hash(token),Date.now());return p||null;}
function requiredActor(req){const p=actor(req);if(!p)throw Object.assign(Error('請先登入。'),{status:401});return p;}
async function body(req){let count=0;const parts=[];for await(const piece of req){count+=piece.length;if(count>14_000_000)throw Object.assign(Error('資料過大，請減少照片。'),{status:413});parts.push(piece)}try{return JSON.parse(Buffer.concat(parts).toString())}catch{throw Error('資料格式不正確。')}}
async function bridge(action,data,person){if(!bridgeConfigured)throw Object.assign(Error('尚未連線公司 Sheets，請先完成管理者設定。'),{status:503});const endpoint=new URL(process.env.APPS_SCRIPT_URL);if(endpoint.hostname!=='script.google.com'||!endpoint.pathname.endsWith('/exec'))throw Error('Apps Script 網址設定不正確。');const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(signBridge(process.env.BRIDGE_SECRET,action,data,person)),redirect:'follow',signal:AbortSignal.timeout(90000)});let result;try{result=await r.json()}catch{throw Error('Sheets 服務未回覆，請保留表單後重試。')}if(!r.ok||!result.ok)throw Error(result.error||'Sheets 寫入失敗，請重試。');return result.data;}
const apiLimiter=new Map();
function limit(key,max){const now=Date.now();let x=apiLimiter.get(key);if(!x||x.until<now)x={count:0,until:now+60000};x.count++;apiLimiter.set(key,x);if(apiLimiter.size>5000)for(const [k,v] of apiLimiter)if(v.until<now)apiLimiter.delete(k);if(x.count>max)throw Object.assign(Error('操作太頻繁，請稍後再試。'),{status:429});}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
 const url=new URL(req.url,origin),route=url.pathname;
 try{
  if(route==='/api/config')return response(res,200,{mode:live?'live':'demo',authConfigured,bridgeConfigured});
  if(route==='/health')return response(res,200,{ok:true});
  if(route==='/auth/google'){
   if(!authConfigured)throw Object.assign(Error('尚未設定 Google 登入。'),{status:503});limit(req.socket.remoteAddress,15);
   const state=randomToken(),browserToken=randomToken(),nonce=randomToken();const {codeVerifier,codeChallenge}=await oauth.generateCodeVerifierAsync();
   db.prepare('DELETE FROM oauth WHERE expires<?').run(Date.now());db.prepare('INSERT INTO oauth VALUES(?,?,?,?,?)').run(state,hash(browserToken),codeVerifier,nonce,Date.now()+600000);
   res.setHeader('Set-Cookie',cookie('ankuan_oauth',browserToken,600));
   return redirect(res,oauth.generateAuthUrl({scope:['openid','email','profile'],state,nonce,prompt:'select_account',code_challenge:codeChallenge,code_challenge_method:'S256'}));
  }
  if(route==='/auth/google/callback'){
   const state=url.searchParams.get('state'),token=cookies(req).ankuan_oauth;
   const pending=db.prepare('DELETE FROM oauth WHERE state=? RETURNING *').get(state||'');
   if(!pending||pending.expires<Date.now()||!token||pending.browser_token!==hash(token))throw Error('登入驗證已過期，請重新登入。');
   if(url.searchParams.get('error'))throw Error('Google 登入已取消。');
   const {tokens}=await oauth.getToken({code:url.searchParams.get('code')||'',codeVerifier:pending.verifier});
   const ticket=await oauth.verifyIdToken({idToken:tokens.id_token,audience:process.env.GOOGLE_CLIENT_ID});const claims=ticket.getPayload();
   if(!claims?.email_verified||claims.nonce!==pending.nonce)throw Error('Google 身分驗證未通過。');
   const email=validEmail(claims.email),member=db.prepare('SELECT role FROM members WHERE email=? AND active=1').get(email);
   if(!member)throw Object.assign(Error('此 Google 帳號尚未加入公司名單，請聯絡管理者。'),{status:403});
   db.prepare('INSERT INTO users(sub,email,nickname) VALUES(?,?,?) ON CONFLICT(sub) DO UPDATE SET email=excluded.email').run(claims.sub,email,String(claims.name||email.split('@')[0]).slice(0,30));
   const session=randomToken();db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session),claims.sub,Date.now()+7*86400000);
   res.setHeader('Set-Cookie',[cookie('ankuan_session',session,7*86400),cookie('ankuan_oauth','',0)]);return redirect(res,'/');
  }
  if(route.startsWith('/api/')){
   const person=requiredActor(req);limit(person.id,120);
   if(req.method==='POST'){
    if(req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json'))throw Object.assign(Error('來源驗證未通過。'),{status:403});
    const data=await body(req);
    if(route==='/api/logout'){db.prepare('DELETE FROM sessions WHERE token=?').run(hash(cookies(req).ankuan_session||''));res.setHeader('Set-Cookie',cookie('ankuan_session','',0));return response(res,200,{ok:true});}
    if(route==='/api/profile'){const nickname=validName(data.nickname,30);db.prepare('UPDATE users SET nickname=? WHERE sub=?').run(nickname,person.id);return response(res,200,{...person,nickname});}
    if(route==='/api/members'){if(person.role!=='admin')throw Object.assign(Error('限管理者操作。'),{status:403});const email=validEmail(data.email);db.prepare('INSERT INTO members(email,role) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET active=1').run(email,'member');return response(res,200,{ok:true});}
    if(route==='/api/people')return response(res,200,await bridge('addPerson',{name:validName(data.name)},person));
    if(route==='/api/entries')return response(res,200,await bridge('saveEntry',validateEntry(data,person),person));
    if(route==='/api/receipts'){if(!/^[a-zA-Z0-9-]{8,80}$/.test(data.id)||!/^[a-zA-Z0-9-]{8,80}$/.test(data.requestId))throw Error('交易編號不正確。');return response(res,200,await bridge('addReceipts',{id:data.id,requestId:data.requestId,photos:validatePhotos(data.photos)},person));}
    if(route==='/api/delete'){if(!/^[a-zA-Z0-9-]{8,80}$/.test(data.id))throw Error('交易編號不正確。');return response(res,200,await bridge('deleteEntry',{id:data.id},person));}
   }
   if(route==='/api/me'&&req.method==='GET')return response(res,200,person);
   if(route==='/api/bootstrap'&&req.method==='GET'){const data=bridgeConfigured?await bridge('bootstrap',{},person):{projects:[],people:[],records:[]};return response(res,200,{...data,profile:person,bridgeConfigured});}
   if(route.startsWith('/api/photos/')&&req.method==='GET'){const id=route.slice('/api/photos/'.length);if(!/^[\w-]+$/.test(id))throw Error('照片編號不正確。');const image=await bridge('photo',{id},person);res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'private, max-age=60'});return res.end(Buffer.from(image.base64,'base64'));}
   return response(res,404,{error:'找不到這項操作。'});
  }
  const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
  if(!files[route]||req.method!=='GET')return response(res,404,{error:'找不到頁面。'});
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const name=files[route];res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(readFileSync(path.join(root,'dist',name)));
 }catch(error){const status=error.status||400;response(res,status,{error:status===401||status===403||status===413||status===429||status===503?error.message:error.message?.includes('invalid_grant')?'Google 登入逾時，請重試。':error.message||'操作未完成，請重試。'});}
});
server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`案款 ${live?'正式連線模式':'示範模式'} http://${process.env.HOST||'127.0.0.1'}:${port}/`));
