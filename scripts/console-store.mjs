// 控制台的数据边界：查询使用只读连接，修改通过已验证配置和现有业务入口。
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, statfsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { DUST_HOME, loadConf, makeCfg, expand } from './config.mjs';
import { readPreviews, previewFor } from './preview-routing.mjs';
import { chatEndpoint } from './routing.mjs';
import { sessionSummary } from './session-status.mjs';
import { readGallery } from './gallery.mjs';
import { localPath, under, atomicWrite, readPolicy, treeBytes } from './policy.mjs';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const savedVideoWhere = "COALESCE(media_type,'video')!='gallery' AND media_path IS NOT NULL AND media_path!='' AND COALESCE(media_deleted,0)=0 AND (status='saved' OR processing_mode IN ('video','both'))";
const number = (label, group, fallback, min, max, step = 1) => ({ label, group, type:'number', fallback, min, max, step });
const text = (label, group, fallback, type = 'text') => ({ label, group, type, fallback });
export const FIELDS = {
  DUST_DAILY_LIMIT:number('每日最多处理（条）','policy',50,1,50),
  DUST_MAX_DURATION_MIN:number('视频最长时长（分钟）','policy',10,0.1,10,0.1),
  DUST_SAVED_MEDIA_MAX_GB:number('视频与图集收藏上限（GiB）','policy',1,0.1,10240,0.1),
  DUST_MEDIA_MAX_GB:number('媒体缓存上限（GiB）','policy',1,0.1,1,0.1),
  DUST_MIN_FREE_GB:number('最低可用空间（GiB）','policy',10,10,10240,0.1),
  DUST_SCAN_COUNT:number('扫描起始窗口（条）','policy',100,1,100),
  DUST_KEEP_RUNS:number('运行日志保留（天）','policy',30,1,3650),
  DUST_REQUEST_TIMEOUT_S:number('单次请求超时（秒）','policy',180,10,3600),
  DUST_RUN_TIMEOUT_S:number('整轮执行时限（秒）','policy',7200,60,86400),
  DUST_NOTIFY:{...text('系统通知','policy','1'),type:'select',options:['1','0']},
  DUST_ROUTER_BASE:text('用途判断接口（Base URL）','models','http://127.0.0.1:8317/v1','url'),
  DUST_ROUTER_MODEL:text('用途判断模型','models','glm'),
  DUST_ROUTER_KEY:text('用途判断模型密钥','models','','password'),
  DUST_ASR_MODEL:text('转写模型','models','qwen-audio-3.0-asr-flash'),
  DUST_LLM_MODEL:text('笔记模型','models','glm-5.3-flash'),
  DUST_LLM_BASE:text('笔记模型接口','models','https://open.bigmodel.cn/api/paas/v4/chat/completions','url'),
  DUST_LLM_EFFORT:{...text('笔记思考档位','models','high'),type:'select',options:['low','high','max']},
  DUST_LLM_MAX_TOKENS:number('笔记输出上限（token）','models',8000,1000,64000),
  DUST_DASHSCOPE_KEY:text('阿里百炼密钥','models','','password'),
  DUST_LLM_KEY:text('笔记模型密钥','models','','password'),
  DUST_NOTES:text('笔记输出目录','paths',join(homedir(),'Documents','抖音收藏'),'path'),
  DUST_SAVED_MEDIA:text('视频与图集收藏目录','paths','','path'),
  DUST_TEXT:text('原始文字稿目录','paths','','path'),
  DUST_WARN_DAYS:number('登录到期提前提醒（天）','login',7,1,30),
  DUST_ASR_CONTEXT:text('转写热词','login','','textarea'),
};
const digest = value => createHash('sha256').update(value).digest('hex');
export function liveLock(home = DUST_HOME) {
  const path = join(home,'.lock.pipeline');
  if (!existsSync(path)) return { running:false };
  let pid;
  try { pid=Number(readFileSync(path,'utf8').trim()); } catch(e) { if(e.code==='ENOENT')return {running:false}; throw e; }
  if (!Number.isInteger(pid) || pid < 1) return { running:true, pid:null, unknown:true };
  try { process.kill(pid,0); return { running:true, pid }; }
  catch(e) { return { running:e.code !== 'ESRCH', pid, stale:e.code === 'ESRCH' }; }
}
export function createStore(home = DUST_HOME) {
  home = localPath(home);
  const confFile = join(home,'dustoff.conf');
  const conf = () => loadConf(confFile);
  const cfg = () => makeCfg({ conf:conf() });
  const databasePath = () => localPath(expand(process.env.DUST_DB || join(home,'index.sqlite')));
  function redact(value) {
    let output = typeof value === 'string' ? value : JSON.stringify(value);
    for (const [key,val] of Object.entries({...conf(),...process.env})) if (/^(DUST_).*(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && String(val).length >= 6) output=output.split(String(val)).join('[已隐藏密钥]');
    return output.replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,})\b/g,'[已隐藏密钥]').replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi,'$1[已隐藏]');
  }
  function readDb(fn, fallback) {
    const path=databasePath();
    if (!existsSync(path)) return fallback;
    const db=new DatabaseSync(path,{readOnly:true});
    try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500'); return fn(db); }
    finally { db.close(); }
  }
  const has = (db,name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  function policy() { return readPolicy(conf()); }
  function settings() {
    const current=conf(),get=cfg(),p=policy();
    const effective={DUST_DAILY_LIMIT:p.daily,DUST_SCAN_COUNT:p.scan,DUST_MAX_DURATION_MIN:p.seconds/60,DUST_MEDIA_MAX_GB:p.bytes/1024**3,DUST_MIN_FREE_GB:p.free/1024**3};
    const fields=Object.entries(FIELDS).map(([key,f])=>{
      let value=get(key,key==='DUST_TEXT'?join(home,'text'):key==='DUST_SAVED_MEDIA'?join(home,'saved-media'):f.fallback);
      if (key==='DUST_ASR_CONTEXT'&&!value) { const path=localPath(get('DUST_ASR_CONTEXT_FILE',join(home,'asr-context.txt'))); if(existsSync(path))value=readFileSync(path,'utf8').slice(0,8000); }
      const overridden=process.env[key] !== undefined && process.env[key] !== '';
      return {...f,key,value:f.type==='password'?'':effective[key]??value,configured:f.type==='password'?!!value:undefined,overridden,clamped:key in effective && Number(value)!==effective[key]};
    });
    return {revision:digest(existsSync(confFile)?readFileSync(confFile):''),fields,home,confFile,database:databasePath(),media:localPath(get('DUST_MEDIA',join(home,'media')))};
  }
  function saveSettings({revision,values}) {
    if (!values || typeof values!=='object' || Array.isArray(values)) throw new HttpError(400,'配置内容不正确');
    const old=existsSync(confFile)?readFileSync(confFile,'utf8'):'';
    if (revision!==digest(old)) throw new HttpError(409,'配置已被其他操作修改，请刷新设置后再保存');
    const changes={};
    for(const [key,raw] of Object.entries(values)) {
      const f=FIELDS[key]; if(!f)throw new HttpError(400,`不支持的配置：${key}`);
      if(typeof raw!=='string'&&typeof raw!=='number')throw new HttpError(400,`${f.label} 格式不正确`);
      let value=String(raw).trim();
      if(f.type==='password'&&!value)continue;
      if(process.env[key] !== undefined && process.env[key] !== '')throw new HttpError(409,`${f.label} 正被环境变量覆盖，请先移除覆盖再修改`);
      if(f.type==='textarea')value=value.replace(/[\r\n]+/g,'，');
      if(/[\r\n\0]/.test(value)||/\s#/.test(value)||value.length>8000)throw new HttpError(400,`${f.label} 包含不支持的内容`);
      if(f.type==='number') { const n=Number(value); if(!value||!Number.isFinite(n)||n<f.min||n>f.max||(f.step===1&&!Number.isInteger(n)))throw new HttpError(400,`${f.label} 范围为 ${f.min}–${f.max}`); value=String(n); }
      if(f.type==='select'&&!f.options.includes(value))throw new HttpError(400,`${f.label} 选项无效`);
      if(f.type==='url') {try{chatEndpoint(value);}catch{throw new HttpError(400,'模型接口必须是无内嵌凭据的 HTTPS 或本机 HTTP 地址');}}
      if(!value&&!['password','textarea'].includes(f.type))throw new HttpError(400,`${f.label} 不能为空`);
      if(f.type==='path') {value=expand(value);if(!value.startsWith('/'))throw new HttpError(400,'请填写绝对路径或 ~/ 开头的路径');value=localPath(value);if(existsSync(value)&&!statSync(value).isDirectory())throw new HttpError(400,'输出位置必须是文件夹');}
      changes[key]=value;
    }
    const merged={...conf(),...changes},get=makeCfg({conf:merged});
    const media=localPath(get('DUST_MEDIA',join(home,'media'))),temp=localPath(join(home,'tmp-media'));
    const saved=localPath(get('DUST_SAVED_MEDIA',join(home,'saved-media')));
    if([media,temp].some(p=>p===saved||under(p,saved)||under(saved,p)))throw new HttpError(400,'视频收藏目录必须与缓存和临时目录分开');
    for(const key of ['DUST_NOTES','DUST_TEXT']) {const path=localPath(get(key,key==='DUST_TEXT'?join(home,'text'):FIELDS[key].fallback));if(path===media||under(path,media)||path===temp||under(path,temp))throw new HttpError(400,'文字稿与笔记目录不能位于媒体缓存或临时目录内');}
    const remaining={...changes};
    const lines=old.split('\n').map(line=>{const match=line.match(/^\s*(DUST_[A-Z0-9_]+)\s*=/);if(match&&Object.hasOwn(changes,match[1])){delete remaining[match[1]];return `${match[1]}=${changes[match[1]]}`;}return line;});
    for(const [key,value] of Object.entries(remaining))lines.push(`${key}=${value}`);
    atomicWrite(confFile,lines.join('\n').replace(/\n*$/,'\n'));
    return settings();
  }
  function listItems(params={}) {
    const page=Math.max(1,Number(params.page)||1),size=Math.min(50,Math.max(1,Number(params.size)||20));
    if(!Number.isInteger(page)||!Number.isInteger(size)||page>1e7)throw new HttpError(400,'分页参数不正确');
    const search=String(params.q||'').slice(0,200),status=params.status||'all';
    return readDb(db=>{
      if(!has(db,'items'))return {items:[],total:0,page:1,pages:1,size};
      const where=["platform='douyin'"],values=[];
      if(params.galleries==='1')where.push("media_type='gallery' AND status='saved' AND media_path IS NOT NULL AND COALESCE(media_deleted,0)=0");
      else if(params.videos==='1')where.push(savedVideoWhere);
      else if(params.results==='1') {where.push("((note_path IS NOT NULL AND note_path!='') OR (text_path IS NOT NULL AND text_path!=''))");if(status==='notes')where.push("note_path IS NOT NULL AND note_path!=''");else if(status==='text')where.push("(note_path IS NULL OR note_path='')");}
      else if(status==='baseline')where.push("skip_reason='baseline'");
      else if(status!=='all'){if(!['pending','downloaded','transcribed','extracted','saved','review','failed','skipped','removed'].includes(status))throw new HttpError(400,'状态无效');where.push('status=?');values.push(status);}
      if(search){where.push("(title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR note_path LIKE ? ESCAPE '\\')");const q='%'+search.replace(/[\\%_]/g,'\\$&')+'%';values.push(q,q,q,q);}
      const clause=where.join(' AND '),total=db.prepare(`SELECT count(*) n FROM items WHERE ${clause}`).get(...values).n,pages=Math.max(1,Math.ceil(total/size)),actual=Math.min(page,pages);
      const order=params.videos==='1'||params.galleries==='1'?'COALESCE(updated_at,collected_at,first_seen)':'COALESCE(extracted_at,transcribed_at,collected_at,first_seen)';
      const imageCount=db.prepare('PRAGMA table_info(items)').all().some(c=>c.name==='image_count')?'image_count':'NULL AS image_count';
      const rows=db.prepare(`SELECT id,title,author,status,media_type,${imageCount},skip_reason,duration_s,category,attempts,last_error,note_path,text_path,extracted_at,transcribed_at,collected_at,first_seen,updated_at,processing_mode,routing_reason,routing_source,media_path,media_deleted,media_quality,needs_ocr FROM items WHERE ${clause} ORDER BY ${order} DESC,id DESC LIMIT ? OFFSET ?`).all(...values,size,(actual-1)*size);
      const previews=readPreviews(home);
      return {items:rows.map(r=>({...r,routing_preview:previewFor(r,previews),display_title:displayTitle(r),last_error:r.last_error?redact(r.last_error):null})),total,page:actual,pages,size};
    },{items:[],total:0,page:1,pages:1,size});
  }
  function displayTitle(row) {
    // 只读当前页笔记的开头，避免长正文和长视频文案撑满作品列表。
    if(row.note_path&&extname(row.note_path)==='.md') {
      let fd;
      try {
        fd=openSync(localPath(row.note_path),'r');
        const buffer=Buffer.alloc(8192),count=readSync(fd,buffer,0,buffer.length,0);
        const header=buffer.subarray(0,count).toString('utf8').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        const value=header?.match(/^标题:\s*(.+)$/m)?.[1]?.trim();
        if(value){const title=value.startsWith('"')?JSON.parse(value):value;if(typeof title==='string'&&title.trim())return title.trim();}
      } catch { /* 文件缺失或用户改过元信息时，仍展示账本中的标题。 */ }
      finally {if(fd!==undefined)closeSync(fd);}
    }
    return row.title||row.id;
  }
  function pendingItems() {
    // 与 daily.mjs 的队列筛选、顺序相同；metadata 含下载信息，不发送给浏览器。
    return readDb(db=>{
      if(!has(db,'items')||!has(db,'daily_queue'))return {items:[]};
      const rows=db.prepare("SELECT i.id,i.title,i.author,i.status,i.media_type,i.processing_mode,i.duration_s,i.note_path,i.attempts FROM daily_queue q JOIN items i ON i.id=q.id AND i.platform='douyin' WHERE i.status IN ('pending','downloaded','transcribed') AND i.attempts<3 ORDER BY q.enqueued ASC,q.rowid DESC LIMIT 10").all();
      return {items:rows.map(row=>({...row,display_title:displayTitle(row)}))};
    },{items:[]});
  }
  function item(id) {
    if(!/^\d{1,30}$/.test(String(id)))throw new HttpError(400,'作品 ID 不正确');
    const row=readDb(db=>has(db,'items')?db.prepare("SELECT * FROM items WHERE platform='douyin' AND id=?").get(id):null,null);
    if(!row)throw new HttpError(404,'找不到这条作品');
    const inQueue=readDb(db=>has(db,'daily_queue')&&!!db.prepare('SELECT 1 FROM daily_queue WHERE id=?').get(id),false);
    return JSON.parse(redact({...row,routing_preview:previewFor(row,readPreviews(home)),can_change_purpose:row.media_type!=='gallery'&&inQueue&&!['baseline','gallery','too_long'].includes(row.skip_reason)&&row.status!=='removed',display_title:displayTitle(row)}));
  }
  function fileFor(id,kind) {const row=item(id),path=row[kind==='note'?'note_path':kind==='video'?'media_path':'text_path'];if(!['note','text','video'].includes(kind)||!path||(kind==='video'&&row.media_deleted))throw new HttpError(404,'尚未生成这份文件或视频已清理');const p=localPath(path);if(kind==='video'?!['.mp4','.mov','.webm','.m4v'].includes(extname(p)):extname(p)!==(kind==='note'?'.md':'.txt'))throw new HttpError(400,'产物格式不正确');if(!existsSync(p)||!statSync(p).isFile())throw new HttpError(404,'文件已移动或不存在，请核对账本路径');return p;}
  function gallery(id) {
    const row=item(id);
    if(row.media_type!=='gallery'||row.status!=='saved'||!row.media_path||row.media_deleted)throw new HttpError(404,'图集尚未完整保存');
    let result;
    try { result=readGallery(row.media_path,id); } catch { throw new HttpError(404,'图集文件缺失或已修改，请核对本地文件夹'); }
    return {item:row,images:result.images.map(({path,...image})=>image)};
  }
  function galleryFile(id,index=0) {
    if(!/^\d+$/.test(String(index)))throw new HttpError(400,'图片序号不正确');
    const data=gallery(id),image=data.images[Number(index)];
    if(!image)throw new HttpError(404,'图片不存在');
    return localPath(join(dirname(data.item.media_path),image.file));
  }
  function document(id,kind){if(!['note','text'].includes(kind))throw new HttpError(400,'只支持阅读文字产物');const path=fileFor(id,kind);if(statSync(path).size>4*1024**2)throw new HttpError(413,'文件超过 4 MiB，请在本机阅读器中打开');return {item:item(id),kind,path,content:readFileSync(path,'utf8')};}
  function tail(path,limit=128*1024){path=localPath(path);if(!existsSync(path))return '';const fd=openSync(path,'r');try{const size=statSync(path).size,buffer=Buffer.alloc(Math.min(size,limit));readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));let out=buffer.toString('utf8');if(size>limit)out='（仅显示日志末尾）\n'+out.slice(out.indexOf('\n')+1);return redact(out);}finally{closeSync(fd);}}
  function readJson(path){if(!existsSync(localPath(path)))return null;try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}}
  function runs(){const dir=join(home,'runs');if(!existsSync(dir))return [];return readdirSync(dir).filter(n=>/^\d{8}T\d{6}(?:-\d+)?-(run|collect|extract|notes|console-action)$/.test(n)).sort().reverse().slice(0,150).map(id=>{const p=localPath(join(dir,id));return {id,modifiedAt:statSync(p).mtimeMs,result:readJson(join(p,'result.json'))};}).map(r=>JSON.parse(redact(r)));}
  function runDetail(id){if(!runs().some(r=>r.id===id))throw new HttpError(404,'运行记录不存在或已过保留期');return {id,log:tail(join(home,'runs',id,'run.log')),result:readJson(join(home,'runs',id,'result.json'))};}
  function overview(){
    const date=new Date(),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
    const midnight=new Date(date.getFullYear(),date.getMonth(),date.getDate()).getTime()/1000;
    const totals=readDb(db=>{
      const out={total:0,notes:0,todayNotes:0,pending:0,failed:0,usedToday:0,baseline:null,statuses:[]};
      if(has(db,'items')){out.statuses=db.prepare("SELECT status,count(*) n FROM items WHERE platform='douyin' GROUP BY status").all();out.total=out.statuses.reduce((s,r)=>s+r.n,0);out.notes=out.statuses.find(r=>r.status==='extracted')?.n||0;out.failed=out.statuses.find(r=>r.status==='failed')?.n||0;out.todayNotes=db.prepare("SELECT count(*) n FROM items WHERE platform='douyin' AND extracted_at>=?").get(midnight).n;}
      if(has(db,'daily_queue')&&has(db,'items'))out.pending=db.prepare("SELECT count(*) n FROM daily_queue q JOIN items i ON i.id=q.id AND i.platform='douyin' WHERE i.status IN ('pending','downloaded','transcribed') AND i.attempts<3").get().n;
      if(has(db,'daily_usage'))out.usedToday=db.prepare('SELECT count(*) n FROM daily_usage WHERE day=?').get(day).n;
      if(has(db,'daily_state')){const r=db.prepare("SELECT value FROM daily_state WHERE name='baseline'").get();if(r)out.baseline=JSON.parse(r.value);}
      return out;
    },{total:0,notes:0,todayNotes:0,pending:0,failed:0,usedToday:0,baseline:null,statuses:[]});
    const get=cfg(),media=localPath(get('DUST_MEDIA',join(home,'media'))),temp=join(home,'tmp-media');let storage={used:null,available:null,error:null};
    try{let p=media;while(!existsSync(p))p=dirname(p);const s=statfsSync(p);storage={used:treeBytes(media)+(under(temp,media)?0:treeBytes(temp)),available:Number(s.bavail)*Number(s.bsize),error:null};}catch(e){storage.error=e.message;}
    try{storage.savedUsed=treeBytes(localPath(get('DUST_SAVED_MEDIA',join(home,'saved-media'))));}catch(e){storage.error=e.message;}
    try{storage.previewUsed=treeBytes(localPath(join(home,'console','media-preview')));}catch(e){storage.error=e.message;}
    totals.review=totals.statuses.find(r=>r.status==='review')?.n||0;
    totals.saved=totals.statuses.find(r=>r.status==='saved')?.n||0;
    const notes=listItems({results:'1',status:'notes',size:3});
    const videos=listItems({videos:'1',size:3});
    totals.notes=notes.total;
    totals.videos=videos.total;
    totals.galleries=listItems({galleries:'1',size:1}).total;
    totals.textOnly=listItems({results:'1',status:'text',size:1}).total;
    const session=readJson(join(home,'state','session.json'));
    const login=readJson(join(home,'console','login.json'));
    const flag=existsSync(join(home,'NEEDS_LOGIN'));
    return {...totals,day,policy:policy(),lock:liveLock(home),storage,session:sessionSummary(session,Date.now()/1000,Number(get('DUST_WARN_DAYS',7))),login,needsLogin:flag,paths:{notes:get('DUST_NOTES',FIELDS.DUST_NOTES.fallback),text:get('DUST_TEXT',join(home,'text')),media,saved:localPath(get('DUST_SAVED_MEDIA',join(home,'saved-media'))),home},recent:notes.items,recentVideos:videos.items,lastRun:runs().find(r=>!r.id.endsWith('-console-action'))||null};
  }
  return {home,settings,saveSettings,overview,listItems,pendingItems,item,document,fileFor,gallery,galleryFile,runs,runDetail,tail,redact,cfg,policy};
}
