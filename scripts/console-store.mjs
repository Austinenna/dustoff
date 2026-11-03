// 控制台的数据边界：查询使用只读连接，修改通过已验证配置和现有业务入口。
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, statfsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { DUST_HOME, loadConf, makeCfg, expand } from './config.mjs';
import { readPreviews, previewFor } from './preview-routing.mjs';
import { chatEndpoint } from './routing.mjs';
import { DASHSCOPE_ENDPOINT, readAsrConfig } from './asr-client.mjs';
import { sessionSummary } from './session-status.mjs';
import { readGallery } from './gallery.mjs';
import { processingActions } from './item-actions.mjs';
import { localPath, under, atomicWrite, readPolicy, treeBytes } from './policy.mjs';
import { PLATFORMS, platformOfId, validItemId } from './platforms.mjs';
import { intentsById } from './intent-store.mjs';
import { readHistory, codeVersion } from './run-history.mjs';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const savedVideoWhere = conversion => `COALESCE(media_type,'video')!='gallery' AND media_path IS NOT NULL AND media_path!='' AND COALESCE(media_deleted,0)=0 AND (processing_mode='video' OR (processing_mode IS NULL AND status='saved') OR (${conversion}=1 AND processing_mode='note'))`;
const number = (label, group, fallback, min, max, step = 1) => ({ label, group, type:'number', fallback, min, max, step });
const text = (label, group, fallback, type = 'text') => ({ label, group, type, fallback });
export const FIELDS = {
  DUST_DAILY_LIMIT:number('抖音每日最多处理（条）','policy',50,1,50),
  DUST_MAX_DURATION_MIN:number('抖音视频最长时长（分钟）','policy',10,0.1,10,0.1),
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
  DUST_ASR_BASE:text('转写模型接口','models',DASHSCOPE_ENDPOINT,'url'),
  DUST_ASR_KEY:text('转写模型密钥','models','','password'),
  DUST_ASR_MODEL:text('转写模型','models','qwen-audio-3.0-asr-flash'),
  DUST_LLM_MODEL:text('笔记模型','models','glm-5.3-flash'),
  DUST_LLM_BASE:text('笔记模型接口','models','https://open.bigmodel.cn/api/paas/v4/chat/completions','url'),
  DUST_LLM_EFFORT:{...text('笔记思考档位','models','high'),type:'select',options:['low','high','max']},
  DUST_LLM_MAX_TOKENS:number('笔记输出上限（token）','models',8000,1000,64000),
  DUST_DASHSCOPE_KEY:text('百炼直连旧密钥','models','','password'),
  DUST_LLM_KEY:text('笔记模型密钥','models','','password'),
  DUST_NOTES:text('笔记输出目录','paths',join(homedir(),'Documents','抖音收藏'),'path'),
  DUST_SAVED_MEDIA:text('视频与图集收藏目录','paths','','path'),
  DUST_TEXT:text('原始文字稿目录','paths','','path'),
  DUST_WARN_DAYS:number('登录到期提前提醒（天）','login',7,1,30),
  DUST_TOTAL_DAILY_LIMIT:number('全部平台每日合计（条）','policy',60,1,100),
  DUST_BILI_ENABLED:{...text('处理 B站收藏','bilibili','0'),type:'select',options:['0','1']},
  DUST_BILI_START_DATE:text('起始日期（YYYY-MM-DD，只处理此后的收藏）','bilibili',''),
  DUST_BILI_FOLDERS:text('只跟踪这些收藏夹（ID 或标题，逗号分隔；留空为全部）','bilibili',''),
  DUST_BILI_EXCLUDE_FOLDERS:text('不跟踪的收藏夹（ID 或标题，逗号分隔）','bilibili',''),
  DUST_BILI_FOLDER_PURPOSES:text('收藏夹指定用途（如：课程=note，舞蹈=video）','bilibili','','textarea'),
  DUST_BILI_DAILY_LIMIT:number('B站每日最多处理（条）','bilibili',20,1,50),
  DUST_BILI_MAX_DURATION_MIN:number('B站视频最长时长（分钟）','bilibili',240,1,600),
  DUST_BILI_MAX_ASR_MIN:number('无字幕时可转写的最长时长（分钟）','bilibili',30,1,180),
  DUST_BILI_DAILY_ASR_MIN:number('B站每日转写总时长（分钟）','bilibili',120,1,1440),
  DUST_BILI_SUBTITLE_AI:{...text('使用 B站 AI 字幕','bilibili','1'),type:'select',options:['1','0']},
  DUST_BILI_AUTO_ROUTE:{...text('B站新收藏自动判断用途（关闭时全部进入待确认）','bilibili','0'),type:'select',options:['0','1']},
  DUST_BILI_MAX_QUALITY:{...text('B站保存视频的默认最高画质','bilibili','80'),type:'select',options:['80','64','116','120','0']},
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
    const effective={DUST_DAILY_LIMIT:p.daily,DUST_SCAN_COUNT:p.scan,DUST_MAX_DURATION_MIN:p.seconds/60,DUST_MEDIA_MAX_GB:p.bytes/1024**3,DUST_MIN_FREE_GB:p.free/1024**3,
      DUST_TOTAL_DAILY_LIMIT:p.totalDaily,DUST_BILI_DAILY_LIMIT:p.bilibili.daily,DUST_BILI_MAX_DURATION_MIN:p.bilibili.seconds/60,DUST_BILI_MAX_ASR_MIN:p.bilibili.asrSeconds/60,DUST_BILI_DAILY_ASR_MIN:p.bilibili.dailyAsrSeconds/60};
    const fields=Object.entries(FIELDS).map(([key,f])=>{
      let value=get(key,key==='DUST_TEXT'?join(home,'text'):key==='DUST_SAVED_MEDIA'?join(home,'saved-media'):f.fallback);
      if (key==='DUST_ASR_KEY') {
        try { value=readAsrConfig(get).key; }
        catch { value=get('DUST_ASR_KEY',''); } // 手工配错接口时仍允许打开设置修正。
      }
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
      if(key==='DUST_BILI_START_DATE'&&value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(new Date(value).getTime())))throw new HttpError(400,'起始日期须为 YYYY-MM-DD');
      if(f.type==='url') {try{chatEndpoint(value);}catch{throw new HttpError(400,'模型接口必须是无内嵌凭据的 HTTPS 或本机 HTTP 地址');}}
      if(!value&&!['password','textarea'].includes(f.type)&&f.group!=='bilibili')throw new HttpError(400,`${f.label} 不能为空`);
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
      // 旧账本在首次写操作时迁移；只读控制台也能先展示转换按钮。
      const columns=new Set(db.prepare('PRAGMA table_info(items)').all().map(c=>c.name));
      const conversion=columns.has('delete_after_note')?'COALESCE(delete_after_note,0)':'0';
      const where=["COALESCE(skip_reason,'')!='user_deleted'"],values=[];
      if(params.platform&&params.platform!=='all'){if(!PLATFORMS[params.platform])throw new HttpError(400,'平台无效');where.push('platform=?');values.push(params.platform);}
      if(params.galleries==='1')where.push("media_type='gallery' AND status='saved' AND media_path IS NOT NULL AND COALESCE(media_deleted,0)=0");
      else if(params.videos==='1')where.push(savedVideoWhere(conversion));
      else if(params.posts==='1')where.push("media_type='post'");
      else if(params.results==='1') {where.push("COALESCE(media_type,'video')!='gallery' AND COALESCE(processing_mode,'note') IN ('note','speech') AND ((note_path IS NOT NULL AND note_path!='') OR (text_path IS NOT NULL AND text_path!=''))");if(status==='notes')where.push("note_path IS NOT NULL AND note_path!=''");else if(status==='text')where.push("(note_path IS NULL OR note_path='')");}
      else if(status==='baseline')where.push("skip_reason='baseline'");
      else if(status!=='all'){if(!['pending','downloaded','transcribed','extracted','saved','review','failed','skipped','removed'].includes(status))throw new HttpError(400,'状态无效');where.push('status=?');values.push(status);}
      if(search){where.push("(title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR note_path LIKE ? ESCAPE '\\')");const q='%'+search.replace(/[\\%_]/g,'\\$&')+'%';values.push(q,q,q,q);}
      const clause=where.join(' AND '),total=db.prepare(`SELECT count(*) n FROM items WHERE ${clause}`).get(...values).n,pages=Math.max(1,Math.ceil(total/size)),actual=Math.min(page,pages);
      const order=params.videos==='1'||params.galleries==='1'?'COALESCE(updated_at,collected_at,first_seen)':'COALESCE(extracted_at,transcribed_at,collected_at,first_seen)';
      const imageCount=columns.has('image_count')?'image_count':'NULL AS image_count',videoQuality=columns.has('video_quality')?'video_quality':'NULL AS video_quality';
      const rows=db.prepare(`SELECT id,platform,title,author,status,media_type,${imageCount},${videoQuality},${conversion} AS delete_after_note,skip_reason,duration_s,category,attempts,last_error,note_path,text_path,extracted_at,transcribed_at,collected_at,first_seen,updated_at,processing_mode,routing_reason,routing_source,media_path,media_deleted,media_quality,needs_ocr,retain_media,decay,prompt_hash,routed_at,downloaded_at,saved_at FROM items WHERE ${clause} ORDER BY ${order} DESC,id DESC LIMIT ? OFFSET ?`).all(...values,size,(actual-1)*size);
      const previews=readPreviews(home);
      const inScope=has(db,'daily_queue')?db.prepare('SELECT 1 FROM daily_queue WHERE id=?'):null;
      const intents=intentsById(home);
      return {items:rows.map(r=>({...r,...processingActions(r,!!inScope?.get(r.id)),pending_intents:intents.get(r.id)||null,routing_preview:previewFor(r,previews),display_title:displayTitle(r),...(params.posts==='1'?{gist:noteMeta(r).gist}:{}),last_error:r.last_error?redact(r.last_error):null})),total,page:actual,pages,size};
    },{items:[],total:0,page:1,pages:1,size});
  }
  // 笔记开头的元信息与摘要按路径和修改时间缓存；只读文件前 8 KiB，避免长正文撑大列表。
  const metaCache=new Map();
  function noteMeta(row) {
    const empty={title:row.title||row.id,tags:[],gist:''};
    if(!row.note_path||extname(row.note_path)!=='.md')return empty;
    let fd;
    try {
      const path=localPath(row.note_path),mtime=statSync(path).mtimeMs,key=path,hit=metaCache.get(key);
      if(hit&&hit.mtime===mtime)return {...hit.meta,title:hit.meta.title||empty.title};
      fd=openSync(path,'r');
      const buffer=Buffer.alloc(8192),count=readSync(fd,buffer,0,buffer.length,0);
      const text=buffer.subarray(0,count).toString('utf8').replace(/\uFFFD+$/,'');
      const match=text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/),header=match?.[1]||'';
      const field=name=>{const value=header.match(new RegExp('^'+name+':\\s*(.+)$','m'))?.[1]?.trim();if(!value)return null;try{return value.startsWith('"')||value.startsWith('[')?JSON.parse(value):value;}catch{return value;}};
      const title=typeof field('标题')==='string'?field('标题').trim():'';
      const tags=Array.isArray(field('标签'))?field('标签').filter(t=>typeof t==='string').map(t=>t.trim()).filter(Boolean).slice(0,12):[];
      const body=(match?text.slice(match[0].length):text).split(/\r?\n/);
      // 摘要取正文第一段文字：跳过标题、引用标记和列表符号，去掉加粗等标记。
      const gist=(body.find(line=>line.trim()&&!/^\s*(#|---|\||!\[|```)/.test(line)&&!line.includes('⚠️'))||'').replace(/^\s*(?:>|[-*+]|\d+[.)])\s*/,'').replace(/\*\*|__|`/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').trim().slice(0,180);
      const meta={title,tags,gist};
      if(metaCache.size>5000)metaCache.clear();
      metaCache.set(key,{mtime,meta});
      return {...meta,title:title||empty.title};
    } catch { return empty; } // 文件缺失或用户改过元信息时，仍展示账本中的标题。
    finally {if(fd!==undefined)closeSync(fd);}
  }
  function displayTitle(row) { return noteMeta(row).title; }
  // 知识库索引：全部笔记与文字稿的轻量信息，供浏览器按主题、标签、状态筛选。
  function notesIndex() {
    return readDb(db=>{
      if(!has(db,'items'))return {items:[]};
      const rows=db.prepare("SELECT id,platform,title,author,media_type,duration_s,category,decay,note_path,text_path,extracted_at,transcribed_at,collected_at,first_seen,prompt_hash FROM items WHERE COALESCE(skip_reason,'')!='user_deleted' AND COALESCE(media_type,'video')!='gallery' AND COALESCE(processing_mode,'note') IN ('note','speech') AND ((note_path IS NOT NULL AND note_path!='') OR (text_path IS NOT NULL AND text_path!='')) ORDER BY COALESCE(extracted_at,transcribed_at,collected_at,first_seen) DESC,id DESC LIMIT 5000").all();
      return {items:rows.map(r=>{const m=noteMeta(r);return {id:r.id,platform:r.platform,title:m.title,author:r.author,media_type:r.media_type,duration_s:r.duration_s,category:r.category,decay:r.decay,tags:m.tags,gist:m.gist,has_note:!!r.note_path,has_text:!!r.text_path,archive_only:r.media_type==='post'&&!r.prompt_hash,at:r.extracted_at||r.transcribed_at||r.collected_at||r.first_seen,collected_at:r.collected_at||r.first_seen};})};
    },{items:[]});
  }
  // 一批作品的摘要（素材箱、对外接口用），只读必要字段。
  function summaries(ids) {
    const list=[...new Set(ids.filter(validItemId))];if(!list.length)return new Map();
    return readDb(db=>{
      if(!has(db,'items'))return new Map();
      const out=new Map();
      for(let n=0;n<list.length;n+=200){
        const part=list.slice(n,n+200);
        for(const r of db.prepare(`SELECT id,platform,title,author,media_type,duration_s,category,decay,status,note_path,text_path,media_path,media_deleted,image_count,collected_at,first_seen,prompt_hash FROM items WHERE id IN (${part.map(()=>'?').join(',')})`).all(...part)){
          const m=noteMeta(r);
          out.set(r.id,{id:r.id,platform:r.platform,title:m.title,author:r.author,media_type:r.media_type||'video',duration_s:r.duration_s,category:r.category,decay:r.decay,status:r.status,tags:m.tags,gist:m.gist,has_note:!!r.note_path,has_media:!!r.media_path&&!r.media_deleted,image_count:r.image_count,collected_at:r.collected_at||r.first_seen,archive_only:r.media_type==='post'&&!r.prompt_hash});
        }
      }
      return out;
    },new Map());
  }
  // 选题建议用到的作品特征：分类来自账本，标签来自笔记开头。
  function itemMeta(id) {
    if(!validItemId(id))return null;
    return readDb(db=>{if(!has(db,'items'))return null;const r=db.prepare('SELECT id,title,category,note_path FROM items WHERE platform=? AND id=?').get(platformOfId(id),String(id));return r?{category:r.category,tags:noteMeta(r).tags}:null;},null);
  }
  // 健康页：运行历史（runs/history.jsonl）与账本产出的汇总；不改变任何数据。
  function insights({id}={}) {
    const history=readHistory(home),recent=history.slice(-30);
    const codes={0:0,1:0,2:0,5:0};for(const r of recent)codes[r.exit]=(codes[r.exit]||0)+1;
    const seconds=recent.map(r=>r.seconds).filter(Number.isFinite);
    const longest=recent.reduce((a,r)=>!a||r.seconds>a.seconds?r:a,null);
    const weekAgo=Date.now()-7*86400_000,groups=new Map();
    for(const r of history)if(Date.parse(r.started)>=weekAgo)for(const f of r.failures||[]){
      // 同类错误归为一组：去掉作品 ID、数字和引号内的具体内容。
      const key=String(f.error||'处理失败').replace(/\d{6,}/g,'').replace(/[“"'][^“"']*[”"']/g,'').replace(/\d+/g,'N').slice(0,60).trim()||'处理失败';
      const g=groups.get(key)||{reason:redact(String(f.error||'处理失败').slice(0,160)),ids:new Set(),platforms:new Set(),count:0};
      g.count++;if(f.id)g.ids.add(f.id);if(f.platform)g.platforms.add(f.platform);groups.set(key,g);
    }
    const failures=[...groups.values()].map(g=>({reason:g.reason,items:g.ids.size,count:g.count,platforms:[...g.platforms],sample:[...g.ids].slice(0,3)})).sort((a,b)=>b.items-a.items||b.count-a.count).slice(0,8);
    const days=[];const today=new Date();today.setHours(0,0,0,0);
    for(let n=13;n>=0;n--){const d=new Date(today);d.setDate(d.getDate()-n);days.push({day:d.toLocaleDateString('sv-SE'),start:d.getTime()/1000});}
    const output=readDb(db=>{
      if(!has(db,'items'))return days.map(d=>({day:d.day,notes:0,saved:0}));
      const notes=db.prepare("SELECT count(*) n FROM items WHERE extracted_at>=? AND extracted_at<? AND note_path IS NOT NULL"),saved=db.prepare("SELECT count(*) n FROM items WHERE saved_at>=? AND saved_at<?");
      return days.map(d=>({day:d.day,notes:notes.get(d.start,d.start+86400).n,saved:saved.get(d.start,d.start+86400).n}));
    },days.map(d=>({day:d.day,notes:0,saved:0})));
    let lookup=null;
    if(id){
      if(!validItemId(id))throw new HttpError(400,'作品 ID 不正确');
      let current=null;try{current=item(id);}catch{}
      lookup={id,item:current&&{title:current.display_title,status:current.status,last_error:current.last_error,platform:current.platform},runs:history.filter(r=>r.failures?.some(f=>f.id===id)).slice(-20).reverse().map(r=>({run:r.run,started:r.started,version:r.version,exit:r.exit,errors:r.failures.filter(f=>f.id===id).map(f=>redact(String(f.error||'')))}))};
    }
    return {version:codeVersion(),total:history.length,recent:recent.map(r=>({run:r.run,started:r.started,exit:r.exit,seconds:r.seconds})),codes,avgSeconds:seconds.length?Math.round(seconds.reduce((a,b)=>a+b,0)/seconds.length):null,longest:longest&&{started:longest.started,seconds:longest.seconds},failures,output,lookup};
  }
  function pendingItems() {
    // 与 daily.mjs 的队列筛选、顺序相同；metadata 含下载信息，不发送给浏览器。
    return readDb(db=>{
      if(!has(db,'items')||!has(db,'daily_queue'))return {items:[]};
      const queuePlatform=db.prepare('PRAGMA table_info(daily_queue)').all().some(c=>c.name==='platform')?'q.platform':"'douyin'";
      const rows=db.prepare("SELECT i.id,i.platform,i.title,i.author,i.status,i.media_type,i.processing_mode,i.duration_s,i.note_path,i.attempts FROM daily_queue q JOIN items i ON i.id=q.id AND i.platform="+queuePlatform+" WHERE i.status IN ('pending','downloaded','transcribed') AND i.attempts<3 ORDER BY q.enqueued ASC,q.rowid DESC LIMIT 10").all();
      const intents=intentsById(home);
      return {items:rows.map(row=>({...row,pending_intents:intents.get(row.id)||null,display_title:displayTitle(row)}))};
    },{items:[]});
  }
  function item(id) {
    if(!validItemId(id))throw new HttpError(400,'作品 ID 不正确');
    const row=readDb(db=>has(db,'items')?db.prepare("SELECT * FROM items WHERE platform=? AND id=?").get(platformOfId(id),String(id)):null,null);
    if(!row)throw new HttpError(404,'找不到这条作品');
    const inQueue=readDb(db=>has(db,'daily_queue')&&!!db.prepare('SELECT 1 FROM daily_queue WHERE id=?').get(id),false);
    const canChange=row.media_type!=='gallery'&&row.media_type!=='post'&&inQueue&&!['baseline','gallery','too_long','user_deleted'].includes(row.skip_reason)&&row.status!=='removed';
    const canConvert=canChange&&!!row.media_path&&!row.media_deleted&&row.has_audio!==0&&Number(row.duration_s)>0&&Number(row.duration_s)<=(row.platform==='bilibili'?policy().bilibili.asrSeconds:policy().seconds)
      &&(row.processing_mode==='video'||(row.processing_mode==null&&row.status==='saved'));
    return JSON.parse(redact({...row,...processingActions(row,inQueue),pending_intents:intentsById(home).get(String(id))||null,routing_preview:previewFor(row,readPreviews(home)),can_change_purpose:canChange,can_convert_to_note:canConvert,display_title:displayTitle(row)}));
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
      if(has(db,'items')){out.statuses=db.prepare("SELECT status,count(*) n FROM items WHERE COALESCE(skip_reason,'')!='user_deleted' GROUP BY status").all();out.total=out.statuses.reduce((s,r)=>s+r.n,0);out.notes=out.statuses.find(r=>r.status==='extracted')?.n||0;out.failed=out.statuses.find(r=>r.status==='failed')?.n||0;out.todayNotes=db.prepare("SELECT count(*) n FROM items WHERE COALESCE(media_type,'video')!='gallery' AND COALESCE(processing_mode,'note') IN ('note','speech') AND extracted_at>=?").get(midnight).n;
        out.platforms=Object.fromEntries(db.prepare("SELECT platform,count(*) n FROM items WHERE COALESCE(skip_reason,'')!='user_deleted' GROUP BY platform").all().map(r=>[r.platform,r.n]));}
      const queuePlatform=has(db,'daily_queue')&&db.prepare('PRAGMA table_info(daily_queue)').all().some(c=>c.name==='platform')?'q.platform':"'douyin'";
      if(has(db,'daily_queue')&&has(db,'items'))out.pending=db.prepare(`SELECT count(*) n FROM daily_queue q JOIN items i ON i.id=q.id AND i.platform=${queuePlatform} WHERE i.status IN ('pending','downloaded','transcribed') AND i.attempts<3`).get().n;
      if(has(db,'items'))out.todayNew=Object.fromEntries(db.prepare("SELECT platform,count(*) n FROM items WHERE first_seen>=? AND COALESCE(skip_reason,'') NOT IN ('baseline','user_deleted') GROUP BY platform").all(midnight).map(r=>[r.platform,r.n]));
      if(has(db,'daily_usage')){out.usedToday=db.prepare('SELECT count(*) n FROM daily_usage WHERE day=?').get(day).n;
        if(db.prepare('PRAGMA table_info(daily_usage)').all().some(c=>c.name==='platform'))out.usedByPlatform=Object.fromEntries(db.prepare('SELECT platform,count(*) n FROM daily_usage WHERE day=? GROUP BY platform').all(day).map(r=>[r.platform,r.n]));}
      if(has(db,'daily_state')){const r=db.prepare("SELECT value FROM daily_state WHERE name='baseline:bilibili'").get();if(r)out.biliState=JSON.parse(r.value);}
      if(has(db,'daily_state')){const r=db.prepare("SELECT value FROM daily_state WHERE name='baseline:x'").get();if(r)out.xState=JSON.parse(r.value);}
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
    const p=policy(),biliFolders=readJson(join(home,'bilibili','folders.json'));
    const bilibili={enabled:p.bilibili.enabled,session:sessionSummary(readJson(join(home,'state','bilibili-session.json')),Date.now()/1000,Number(get('DUST_WARN_DAYS',7))),
      startAt:totals.biliState?.start_at??null,scannedAt:totals.biliState?.scanned_at??null,folders:biliFolders?.folders||[],usedToday:totals.usedByPlatform?.bilibili||0,daily:p.bilibili.daily};
    // X 只回传连接状态，不回传令牌。
    const xSession=readJson(join(home,'state','x-session.json'))||{};
    const x={enabled:p.x.enabled,configured:!!get('DUST_X_CLIENT_ID',''),connected:existsSync(join(home,'x','token.json')),username:xSession.username||totals.xState?.username||null,
      online:xSession.online||null,onlineCheckedAt:xSession.online_checked_at||null,lastCheckAt:xSession.last_check_at||null,scannedAt:totals.xState?.scanned_at??null,complete:!!totals.xState?.complete,usedToday:totals.usedByPlatform?.x||0,daily:p.x.daily};
    delete totals.biliState;delete totals.xState;
    return {...totals,bilibili,x,day,policy:p,lock:liveLock(home),storage,session:sessionSummary(session,Date.now()/1000,Number(get('DUST_WARN_DAYS',7))),login,needsLogin:flag,paths:{notes:get('DUST_NOTES',FIELDS.DUST_NOTES.fallback),text:get('DUST_TEXT',join(home,'text')),media,saved:localPath(get('DUST_SAVED_MEDIA',join(home,'saved-media'))),home},recent:notes.items,recentVideos:videos.items,lastRun:runs().find(r=>!r.id.endsWith('-console-action'))||null};
  }
  return {home,settings,saveSettings,overview,listItems,pendingItems,notesIndex,itemMeta,summaries,insights,item,document,fileFor,gallery,galleryFile,runs,runDetail,tail,redact,cfg,policy};
}
