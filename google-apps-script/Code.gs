/* 案款 Sheets bridge. Deploy as owner. Every request requires a server-side HMAC.
 * Script properties: SPREADSHEET_ID, RECEIPT_FOLDER_ID, BRIDGE_SECRET.
 * No public Drive permissions and no temporary IMAGE URLs.
 */
const META_SHEET = '_網站交易索引';
const PHOTO_SHEET = '收據相簿';
const TYPE_LABELS = {expense:'支出',refund:'費用退款',return:'退回公司',fund:'公司給款',direct:'公司直接付款',directRefund:'公司收到費用退款'};
function doPost(e) {
  let lock;
  try {
    const env=PropertiesService.getScriptProperties();
    const req=JSON.parse(e.postData.contents);
    verifyRequest_(req,env.getProperty('BRIDGE_SECRET'));
    const payload=JSON.parse(Utilities.newBlob(Utilities.base64Decode(req.payload)).getDataAsString('UTF-8'));
    if(!payload.actor || !payload.actor.email || !payload.actor.id) throw Error('缺少已驗證身分。');
    lock=LockService.getScriptLock();if(!lock.tryLock(25000))throw Error('帳本忙碌中，請保留表單稍後重試。');
    const book=SpreadsheetApp.openById(env.getProperty('SPREADSHEET_ID'));
    let result;
    switch(payload.action) {
      case 'bootstrap': result=bootstrap_(book);break;
      case 'addPerson':result=addPerson_(book,payload.data.name);break;
      case 'saveEntry':result=saveEntry_(book,payload.data,payload.actor,env);break;
      case 'addReceipts':result=addReceipts_(book,payload.data,payload.actor,env);break;
      case 'photo':result=photo_(book,payload.data.id);break;
      default:throw Error('未知操作。');
    }
    return json_({ok:true,data:result});
  }catch(error){return json_({ok:false,error:String(error.message||error)});}
  finally{if(lock)lock.releaseLock();}
}
function json_(value){return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}
function verifyRequest_(r,secret){
  if(!secret||secret.length<32)throw Error('尚未設定同步密鑰。');
  if(!Number.isFinite(r.ts)||Math.abs(Date.now()-r.ts)>120000||typeof r.nonce!=='string'||!/^[\w-]{20,100}$/.test(r.nonce)||typeof r.payload!=='string'||r.payload.length>19000000)throw Error('同步驗證已失效。');
  const expected=hex_(Utilities.computeHmacSha256Signature(r.ts+'.'+r.nonce+'.'+r.payload,secret));
  const actual=String(r.signature||'');let mismatch=expected.length^actual.length;
  for(let i=0;i<expected.length;i++)mismatch|=expected.charCodeAt(i)^(actual.charCodeAt(i)||0);
  if(mismatch)throw Error('同步驗證未通過。');
}
function hex_(bytes){return bytes.map(b=>('0'+(b&255).toString(16)).slice(-2)).join('');}
function hash_(v){return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(v)));}
function text_(value,max){const s=String(value||'').trim();if(!s||s.length>max||/[\u0000-\u001f\u007f]/.test(s))throw Error('欄位格式不正確。');return s;}
function safe_(value){const s=String(value||'');return /^[=+\-@]/.test(s)?"'"+s:s;}
function ensureCols_(sheet,count){if(sheet.getMaxColumns()<count)sheet.insertColumnsAfter(sheet.getMaxColumns(),count-sheet.getMaxColumns());}
function meta_(book){let sheet=book.getSheetByName(META_SHEET);if(!sheet){sheet=book.insertSheet(META_SHEET);sheet.appendRow(['交易編號','案件','登記列','款項人編號','登記者暱稱','登記者信箱','同步進度','原始請求雜湊','建立時間','照片檔案','補件請求']);sheet.hideSheet();}return sheet;}
function metaRows_(book){const s=meta_(book);return s.getLastRow()<2?[]:s.getRange(2,1,s.getLastRow()-1,11).getValues();}
function projects_(book){const s=book.getSheetByName('標案設定');if(!s)return[];return s.getRange(5,1,Math.max(1,s.getLastRow()-4),3).getDisplayValues().filter(r=>r[0]&&book.getSheetByName(r[0])).map(r=>({id:r[0],name:r[1]||r[0],status:r[2]}));}
function people_(book){const sheet=book.getSheetByName('人員設定');if(!sheet)throw Error('缺少人員設定分頁。');const range=sheet.getRange(6,1,Math.max(1,sheet.getLastRow()-5),1),rows=range.getValues(),notes=range.getNotes(),people=[];rows.forEach((r,i)=>{if(!r[0]||r[0]==='公司')return;const match=notes[i][0].match(/ankuan-person:([\w-]+)/);let id=match?match[1]:Utilities.getUuid();if(!match)sheet.getRange(i+6,1).setNote((notes[i][0]+'\nankuan-person:'+id).trim());people.push({id,name:String(r[0])})});return people;}
function addPerson_(book,name){name=text_(name,40);if(name==='公司')throw Error('公司是保留名稱，請填同事姓名。');const existing=people_(book).find(p=>p.name===name);if(existing)return existing;const sheet=book.getSheetByName('人員設定'),id=Utilities.getUuid();const values=sheet.getRange(6,1,Math.max(1,sheet.getMaxRows()-5),1).getValues();let row=values.findIndex(r=>!r[0]);row=row<0?sheet.getMaxRows()+1:row+6;if(row>sheet.getMaxRows())sheet.insertRowAfter(sheet.getMaxRows());sheet.getRange(row,1).setValue(safe_(name)).setNote('ankuan-person:'+id);return{id,name};}

function bootstrap_(book){
  const people=people_(book),projects=projects_(book),meta=metaRows_(book),byId={};meta.forEach(m=>byId[m[0]]=m);
  const records=[];projects.forEach(p=>{
    const sheet=book.getSheetByName(p.id);ensureCols_(sheet,25);
    const rows=sheet.getRange(13,1,Math.max(1,sheet.getLastRow()-12),10).getValues();const notes=sheet.getRange(13,1,rows.length,1).getNotes();
    rows.forEach((r,i)=>{if(!r[0]||!r[1]||!r[2]||!r[5])return;const entryType=Object.keys(TYPE_LABELS).find(k=>TYPE_LABELS[k]===r[2]);if(!entryType)return;
      let audit={};try{audit=JSON.parse(notes[i][0]||'{}')}catch(ignored){}const payer=people.find(person=>person.id===audit.payerId)||people.find(person=>person.name===String(r[1]));if(!payer)return; const id=String(audit.ankuanId||'manual-'+sheet.getSheetId()+'-'+(i+13)),m=byId[id],files=m?JSON.parse(m[9]||'[]'):[];
      records.push({id,project:p.id,payerId:payer.id,date:r[0] instanceof Date?Utilities.formatDate(r[0],'Asia/Taipei','yyyy-MM-dd'):String(r[0]).replace(/\//g,'-'),type:entryType,desc:String(r[3]),category:String(r[4]),amount:Number(r[5]),payment:String(r[6]),status:String(r[8]),note:String(r[9]),recorder:String(audit.recorder||'Sheets 登記'),photos:files.map(f=>'/api/photos/'+f),syncStatus:m?m[6]:'done'});
    });
  });return{projects,people,records};
}
function saveEntry_(book,data,actor,env){
  if(!/^[\w-]{8,80}$/.test(data.id))throw Error('交易編號不正確。');
  const project=projects_(book).find(p=>p.id===data.project);if(!project)throw Error('案件不存在，請先到 Sheets 設定案件。');
  const payer=people_(book).find(p=>p.id===data.payerId);if(!payer)throw Error('款項當事人不存在。');
  if(!['expense','refund','return','fund'].includes(data.type)||data.type==='fund'&&actor.role!=='admin')throw Error('不允許這項往來。');
  if(!Number.isFinite(data.amount)||data.amount<=0)throw Error('金額不正確。');
  const digest=hash_({id:data.id,project:data.project,payerId:data.payerId,type:data.type,amount:data.amount,date:data.date,desc:data.desc,category:data.category,payment:data.payment,note:data.note,photos:data.photos,recorderEmail:actor.email});
  const meta=meta_(book),all=metaRows_(book);let mi=all.findIndex(m=>m[0]===data.id),m=mi>=0?all[mi]:null;
  if(m&&m[7]!==digest)throw Error('這個交易編號已存在，請勿改寫已送出的交易。');
  if(m&&m[5]!==actor.email)throw Error('這筆交易屬於另一位登記者。');
  const sheet=book.getSheetByName(project.id);ensureCols_(sheet,25);
  if(!m){
    const reserved=new Set(all.filter(m=>m[1]===project.id).map(m=>Number(m[2])));
    const values=sheet.getRange(13,1,Math.max(1,sheet.getMaxRows()-12),10).getValues();let row=values.findIndex((r,i)=>!r.some(v=>v!=='')&&!reserved.has(i+13));if(row<0)throw Error('案件登記列已滿，請先延伸範本。');row+=13;
    m=[data.id,project.id,row,payer.id,actor.nickname,actor.email,'pending',digest,new Date().toISOString(),'[]','{}'];meta.appendRow(m);mi=meta.getLastRow()-2;
  }
  if(m[6]==='done')return recordResult_(data,m);
  const images=savePhotos_(book,data.id,data.photos||[],data,payer,env);
  m[9]=JSON.stringify(images);meta.getRange(mi+2,10).setValue(m[9]);
  let row=Number(m[2]);const found=findLedgerRow_(sheet,data.id,true);if(found)row=found;let note={};try{note=JSON.parse(sheet.getRange(row,1).getNote()||'{}')}catch(ignored){}const existingId=String(note.ankuanId||'');
  if(existingId&&existingId!==data.id)throw Error('預留列已被其他交易占用，請聯絡管理者。');
  if(!existingId&&sheet.getRange(row,1,1,10).getValues()[0].some(v=>v!==''))throw Error('預留列已有手動資料，請聯絡管理者。');
  const status=data.type==='return'||data.type==='fund'?'免附':images.length?'待審核':'待補件';
  const date=new Date(data.date+'T12:00:00+08:00');
  
  sheet.getRange(row,1).setNumberFormat('yyyy/mm/dd').setNote(JSON.stringify({ankuanId:data.id,recorder:actor.nickname,recorderEmail:actor.email,payerId:payer.id,createdAt:m[8]}));
  sheet.getRange(row,1,1,10).setValues([[date,safe_(payer.name),TYPE_LABELS[data.type],safe_(data.desc),safe_(data.category),data.amount,safe_(data.payment),images.map(id=>'https://drive.google.com/file/d/'+id+'/view').join('\n'),status,safe_(data.note)]]);
  SpreadsheetApp.flush();
  m[6]='done';meta.getRange(mi+2,7).setValue('done');return recordResult_({...data,status},m);
}
function recordResult_(data,m){return{...data,recorder:m[4],photos:JSON.parse(m[9]||'[]').map(id=>'/api/photos/'+id),syncStatus:m[6]};}
function photoSheet_(book){let s=book.getSheetByName(PHOTO_SHEET);if(!s){s=book.insertSheet(PHOTO_SHEET);s.appendRow(['交易編號','案件','日期','款項當事人','事由','金額','收據檔','收據照片','檔案編號']);s.setFrozenRows(1);s.getRange(1,1,1,9).setBackground('#173c46').setFontColor('#ffffff').setFontWeight('bold');s.setColumnWidth(8,200);s.setColumnWidth(5,200);s.setColumnWidth(7,170);s.hideColumns(9);s.getRange('A1').setNote('相簿照片固定附在各列。請從案件頁或網站篩選交易，不要直接排序相簿。');}return s;}
function savePhotos_(book,id,photos,data,payer,env){
  if(!Array.isArray(photos)||photos.length>5)throw Error('每筆最多 5 張照片。');if(!photos.length)return[];
  const folder=DriveApp.getFolderById(env.getProperty('RECEIPT_FOLDER_ID')),gallery=photoSheet_(book),files=[];
  photos.forEach((src,index)=>{
    const match=String(src).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);if(!match)throw Error('照片格式不正確。');
    const bytes=Utilities.base64Decode(match[2]);if(bytes.length>1900000)throw Error('照片超過嵌入大小限制。');
    const filename='ankuan-'+id+'-'+index+'.'+(match[1]==='image/png'?'png':match[1]==='image/webp'?'webp':'jpg');
    const existing=folder.getFilesByName(filename),file=existing.hasNext()?existing.next():folder.createFile(Utilities.newBlob(bytes,match[1],filename));
    const fileId=file.getId();files.push(fileId);
    const all=gallery.getLastRow()>1?gallery.getRange(2,9,gallery.getLastRow()-1,1).getValues():[];let offset=all.findIndex(r=>String(r[0])===fileId),row;
    if(offset<0){gallery.appendRow([id,data.project,data.date,safe_(payer.name),safe_(data.desc),data.amount,file.getUrl(),'',fileId]);row=gallery.getLastRow();}else row=offset+2;
    const marker='ankuan:'+fileId;let image=gallery.getImages().find(img=>img.getAltTextTitle()===marker);
    if(!image){image=gallery.insertImage(file.getBlob(),8,row,6,6);image.setAltTextTitle(marker);image.setAltTextDescription('交易 '+id+' 的收據');}
    const ratio=Math.min(185/image.getInherentWidth(),150/image.getInherentHeight(),1);image.setWidth(Math.round(image.getInherentWidth()*ratio));image.setHeight(Math.round(image.getInherentHeight()*ratio));gallery.setRowHeight(row,165);
  });return files;
}
function addReceipts_(book,data,actor,env){
  const meta=meta_(book),all=metaRows_(book),mi=all.findIndex(m=>m[0]===data.id);if(mi<0)throw Error('這筆手動紀錄請先由管理者在 Sheets 補收據。');const m=all[mi],sheet=book.getSheetByName(m[1]);
  const requests=JSON.parse(m[10]||'{}'),digest=hash_(data.photos);if(requests[data.requestId]){if(requests[data.requestId]!==digest)throw Error('補件編號重複。');return{ok:true};}
  const existing=JSON.parse(m[9]||'[]');if(existing.length+data.photos.length>5)throw Error('每筆最多 5 張照片。');
  const row=findLedgerRow_(sheet,data.id),r=sheet.getRange(row,1,1,10).getValues()[0];if(r[8]==='已核准')throw Error('已核准的紀錄請由管理者處理更正。');
  const payer=people_(book).find(p=>p.id===m[3]);const date=r[0] instanceof Date?Utilities.formatDate(r[0],'Asia/Taipei','yyyy-MM-dd'):String(r[0]);
  const added=savePhotos_(book,data.id+'-'+data.requestId,data.photos,{project:m[1],date,desc:r[3],amount:r[5]},payer,env);
  const files=[...new Set(existing.concat(added))];m[9]=JSON.stringify(files);requests[data.requestId]=digest;m[10]=JSON.stringify(requests);
  sheet.getRange(row,8,1,2).setValues([[files.map(id=>'https://drive.google.com/file/d/'+id+'/view').join('\n'),'待審核']]);
  meta.getRange(mi+2,10,1,2).setValues([[m[9],m[10]]]);SpreadsheetApp.flush();return{ok:true};
}
function findLedgerRow_(sheet,id,optional){const values=sheet.getRange(13,1,Math.max(1,sheet.getLastRow()-12),1).getNotes(),index=values.findIndex(r=>{try{return JSON.parse(r[0]).ankuanId===id}catch(ignored){return false}});if(index<0){if(optional)return null;throw Error('找不到交易列。');}return index+13;}
function photo_(book,id){if(!/^[\w-]+$/.test(id))throw Error('照片編號錯誤。');const all=metaRows_(book);if(!all.some(m=>JSON.parse(m[9]||'[]').includes(id)))throw Error('照片不屬於公司帳本。');const blob=DriveApp.getFileById(id).getBlob();return{mime:blob.getContentType(),base64:Utilities.base64Encode(blob.getBytes())};}
