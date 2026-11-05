import {renderMarkdown} from './markdown.mjs';
import {remainingLabel,loginFlow} from './login-ui.mjs';
import {makePlan,nextOccurrence} from './schedule-plan.mjs';
import {esc,PURPOSES,STATUSES,REASONS,SETTINGS,PLATFORM_LABELS,QUALITY_LABELS,intentLabel,fmt,bytes,duration,titleOf,mediaLabel,resultLabel,runSummary,splitNoteContent,sourceLink,evergreen,decayLabel,postState} from './studio-view.mjs';

const root=document.querySelector('#dustoff-studio'),main=document.querySelector('#main'),dialog=document.querySelector('#dialog');
const token=document.querySelector('meta[name="dustoff-token"]').content;
const serverMode=document.querySelector('meta[name="dustoff-server"]')?.content==='1';
if(serverMode){const env=document.querySelector('#env-label');env.textContent='prod';env.className='env prod';env.title='生产服务器';}
if(document.querySelector('meta[name="dustoff-access"]')?.content==='1'){const form=document.createElement('form');form.method='post';form.action='auth/logout';form.innerHTML='<button class="button quiet" title="退出登录">退出</button>';document.querySelector('#side-tools').append(form);}

// ── 路由：沿用旧地址，旧书签和 X 授权回调（#account）仍能打开对应页面 ──
const PAGES={overview:'今日',pending:'收件箱',notes:'知识库',videos:'媒体库',materials:'素材箱',collection:'收藏记录',pipeline:'流水线',health:'健康',settings:'设置'};
const ALIASES={results:['notes'],run:['pending'],galleries:['videos','gallery'],posts:['videos','post'],schedule:['pipeline','schedule'],history:['pipeline','history'],account:['pipeline','sources'],models:['settings','models'],rules:['settings','rules'],storage:['settings','storage'],api:['settings','api']};
const state={route:'overview',overview:null,settings:null,index:null,library:null,insights:null,
  kb:{id:null,cat:'all',read:'all',tag:null,platform:'all',type:'all',q:'',view:'read',kind:'note',list:true},
  media:{tab:'video',platform:'all',q:'',page:1},inbox:{id:null,page:1},
  collection:{q:'',status:'all',page:1,platform:'all'},materials:{topic:'all'},settingsTab:'models',
  runs:[],runId:null,logKind:'business',runPage:1,selection:'',lookup:''};
// keptUnread：刚手动标为未读、仍停留在这一篇时不再自动标已读；切到别的笔记后失效
let keptUnread=null,pageEpoch=0,listEpoch=0,docEpoch=0,logEpoch=0,dialogEpoch=0,searchTimer,polling=false,drawerId=null,videoTimer;
const $=s=>root.querySelector(s);
const query=v=>new URLSearchParams(Object.entries(v).filter(([,x])=>x!==undefined&&x!==null)).toString();
const busy=()=>!!state.overview?.execution.running;

// ── 图标 ──
const ICONS={today:'<path d="M3 10h18M8 3v4M16 3v4"/><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 14h3v3H8z"/>',inbox:'<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z"/>',book:'<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H11v17H5.5A1.5 1.5 0 0 1 4 18.5zM20 4.5A1.5 1.5 0 0 0 18.5 3H13v17h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',media:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/>',bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>',list:'<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',flow:'<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',pulse:'<path d="M3 12h4l2-6 4 12 2-6h6"/>',settings:'<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',play:'<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',spark:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',alert:'<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',check:'<path d="m5 12 5 5L20 7"/>',shield:'<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',arrow:'<path d="M9 6l6 6-6 6"/>',note:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',video:'<rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="m16 10 5-3v10l-5-3z"/>',skip:'<path d="M5 12h14M13 6l6 6-6 6"/>',x:'<path d="M6 6l12 12M18 6 6 18"/>',ext:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',collapse:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M15 10l-2 2 2 2"/>',expand:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M13 10l2 2-2 2"/>',up:'<path d="m6 15 6-6 6 6"/>',down:'<path d="m6 9 6 6 6-6"/>',gallery:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 16l5-5 4 4 3-3 6 6M15 8h.01"/>',post:'<path d="M4 4h16v12H8l-4 4z"/>',excerpt:'<path d="M7 7h4v4H7zM13 7h4v4h-4zM7 11c0 3-1 5-3 6M13 11c0 3-1 5-3 6"/>'};
const ic=(name,size=17)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]||''}</svg>`;
const paintIcons=(scope=root)=>scope.querySelectorAll('[data-icon]:empty').forEach(el=>{el.innerHTML=ic(el.dataset.icon);});
paintIcons();

// ── 小部件 ──
const PF={douyin:['抖音','抖'],bilibili:['B站','B'],x:['X','𝕏']};
const pf=(p,label=true)=>{const v=PF[p]||PF.douyin;return `<span class="pf ${PF[p]?p:'douyin'}"><i>${v[1]}</i>${label?v[0]:''}</span>`;};
const tag=(value,tone='')=>`<span class="tag ${tone}">${esc(value)}</span>`;
const chip=(html,tone='')=>`<span class="chip ${tone}">${html}</span>`;
const button=(label,action,attrs='',style='')=>serverMode&&action==='open'?'':`<button type="button" class="btn ${style}" data-action="${action}" ${attrs}>${label}</button>`;
const empty=(text='暂无内容')=>`<div class="empty">${esc(text)}</div>`;
const sourceA=(item,label='原作品')=>`<a class="btn quiet sm" href="${esc(sourceLink(item))}" target="_blank" rel="noopener noreferrer">${ic('ext',14)}${label}</a>`;
const kindOf=i=>i.media_type==='gallery'?'图集':i.media_type==='post'?'帖子':duration(i.duration_s);
const hasMedia=i=>!!i.media_path&&!i.media_deleted;
// 没有视频文件时不放占位图，只显示平台图标。
const thumbOf=i=>hasMedia(i)?cover(i,{cls:'thumb'}):`<span class="thumb-icon">${pf(i.platform,false)}</span>`;
function hue(id){let h=0;for(const c of String(id))h=(h*31+c.charCodeAt(0))%360;return h;}
const gradient=id=>{const h=hue(id);return `background:radial-gradient(120% 80% at 20% 10%,hsl(${(h+300)%360} 60% 70% / .7),transparent 60%),radial-gradient(90% 90% at 90% 100%,hsl(${(h+40)%360} 48% 32%),transparent 70%),linear-gradient(160deg,hsl(${h} 42% 52%),hsl(${(h+40)%360} 48% 32%))`;};
// 封面：视频用控制台生成的封面，图集用第一张图；读不到时露出按作品 ID 生成的渐变底色。
function cover(item,{cls='',badge='',pfb=false,ratio=''}={}){
  const src=item.media_type==='gallery'?`api/gallery-image?id=${encodeURIComponent(item.id)}&index=0`:item.media_type==='post'?'':`api/video-poster?id=${encodeURIComponent(item.id)}`;
  return `<span class="cover ${cls}" style="${gradient(item.id)}${ratio?`;aspect-ratio:${ratio}`:''}">${src&&(item.media_path||item.has_media)?`<img src="${src}" alt="" loading="lazy">`:''}${pfb?`<span class="pfb">${pf(item.platform,false)}</span>`:''}${badge?`<span class="badge">${esc(badge)}</span>`:''}</span>`;
}
root.addEventListener('error',e=>{if(e.target.matches?.('.cover img'))e.target.remove();},true);
function spark(values){const max=Math.max(1,...values),w=100,h=28;const pts=values.map((v,i)=>`${(i/Math.max(1,values.length-1))*w},${h-(v/max)*h*.9-1}`).join(' ');return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:28px;margin-top:4px"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;}
const hm=ts=>{const d=new Date(ts);return Number.isNaN(d.getTime())?'—':d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});};
function until(ts){const ms=new Date(ts)-Date.now();if(!Number.isFinite(ms))return '';if(ms<=60000)return '即将开始';const m=Math.round(ms/60000),h=Math.floor(m/60);return h?`还有 ${h} 小时 ${m%60} 分`:`还有 ${m} 分钟`;}

// ── 接口 ──
async function api(path,data){
  const response=await fetch('api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Dustoff-Token':token},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
  if(response.status===401){location.href='./';throw new Error('请重新登录控制台');}
  const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败');return value;
}
let noticeTimer;
function notice(message,error=false){
  const el=$('#notice');clearTimeout(noticeTimer);el.hidden=!message;el.className=error?'error':'';
  el.innerHTML=message?`<span>${esc(message)}</span><button type="button" data-action="dismiss">关闭</button>`:'';
  dialog.querySelector('.dialog-notice')?.remove();
  if(dialog.open&&message){const p=document.createElement('p');p.className='dialog-notice'+(error?' error':'');p.setAttribute('role','status');p.textContent=message;dialog.querySelector('.dialog-head')?.after(p);}
  if(message&&!error)noticeTimer=setTimeout(()=>{el.hidden=true;},5000);
}
const head=(title,meta='',actions='')=>`<header class="pagehead"><div><h1>${title}</h1>${meta?`<p>${meta}</p>`:''}</div><div class="actions">${actions}</div></header>`;
const pagination=(data,kind)=>data.pages>1||data.total>data.size?`<div class="pagination"><span>共 ${data.total} 条</span><div>${button('上一页','paginate',`data-kind="${kind}" data-step="-1" ${data.page<=1?'disabled':''}`,'sm')}<span>${data.page} / ${data.pages}</span>${button('下一页','paginate',`data-kind="${kind}" data-step="1" ${data.page>=data.pages?'disabled':''}`,'sm')}</div></div>`:'';
const searchField=(value,label,id)=>`<label class="search">${ic('search',15)}<input id="${id}" type="search" maxlength="200" aria-label="${label}" placeholder="${label}" value="${esc(value)}"></label>`;

// ── 外壳：侧栏计数、自动安排卡片、今日顶栏 ──
function syncChrome(){
  const o=state.overview;if(!o)return;
  root.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===state.route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  const set=(id,value,hot=false)=>{const el=$(id);el.textContent=value||value===0?value:'';el.classList.toggle('hot',hot&&value>0);};
  set('#count-pending',o.review,true);set('#count-notes',o.notes);set('#count-media',o.videos+(o.galleries||0));set('#count-collection',o.total);
  if(state.library)set('#count-materials',state.library.materials.length);
  $('#running-dot').hidden=!o.execution.running;
  const r=o.lastRun?.result;$('#health-dot').hidden=!(r&&(r.error||r.failures?.length||r.paused||Object.keys(r.pausedPlatforms||{}).length))&&!o.failed;
  const s=o.scheduler,card=$('#schedule-card');
  card.innerHTML=s.error?`<span class="row1"><span class="pulse off"></span>自动安排暂不可用</span><small>${esc(s.error).slice(0,60)}</small>`:s.loaded?`<span class="row1"><span class="pulse"></span>自动整理已开启</span><strong>${esc(hm(s.nextRun))}</strong><small>下一轮 · ${esc(until(s.nextRun))}</small>`:`<span class="row1"><span class="pulse off"></span>自动整理已关闭</span><small>可在流水线中开启</small>`;
  const now=new Date(),hour=now.getHours();
  $('#greet-word').textContent=hour<5?'夜深了':hour<11?'早上好':hour<13?'中午好':hour<18?'下午好':'晚上好';
  $('#greet-date').textContent=now.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'});
  const top=$('#top-run');top.dataset.action=busy()?'go-pipeline':'manual-run';top.innerHTML=`${ic('play',15)}${busy()?'查看本轮进度':'运行一轮'}`;
  root.querySelectorAll('[data-idle]').forEach(b=>{b.disabled=busy();});
  if($('#run-status'))$('#run-status').innerHTML=executionPanel();
}
const overviewKey=o=>o&&JSON.stringify([o.notes,o.todayNotes,o.videos,o.galleries,o.pending,o.usedToday,o.review,o.failed,o.scheduler,o.execution,o.lastRun?.id,o.recentVideos?.map(v=>v.id),o.session.online,o.todayNew]);
async function refreshOverview(){const before=overviewKey(state.overview);state.overview=await api('overview');syncChrome();if(state.route==='overview'&&!dialog.open&&before!==overviewKey(state.overview)){state.today=null;await loadToday();}}
async function ensureIndex(force=false){if(!state.index||force)state.index=(await api('notes-index')).items;return state.index;}
async function ensureLibrary(force=false){if(!state.library||force){state.library=await api('library');syncChrome();}return state.library;}

// ── 今日 ──
function overviewPage(){return `<div class="page" id="today">${empty('正在读取…')}</div>`;}
async function loadToday(){
  const epoch=pageEpoch;
  const [index,insights,review,galleries]=await Promise.all([ensureIndex(true),api('insights'),api('items?'+query({status:'review',size:4})),api('items?'+query({galleries:1,size:3}))]);
  if(epoch!==pageEpoch)return;state.insights=insights;
  const o=state.overview,s=o.scheduler,p=o.policy,last=runSummary(o.lastRun),r=o.lastRun?.result||{};
  const weekAgo=Date.now()/1000-7*86400,notes=index.filter(n=>n.has_note&&!n.archive_only),weekNotes=notes.filter(n=>n.at>=weekAgo).length,unread=notes.filter(n=>!n.read_at);
  const paused=Object.entries(r.pausedPlatforms||{});
  const lede=[o.review?`还有 <b>${o.review}</b> 条等你决定用途`:'',o.pending?`<b>${o.pending}</b> 条在排队整理`:''].filter(Boolean).join('，')+(paused.length?`。${paused.map(([k,v])=>`${esc(PLATFORM_LABELS[k]||k)}暂停：${esc(v)}`).join('；')}`:'')||'收件箱是空的，排队也已清空。';
  const todayNew=o.todayNew||{},newTotal=Object.values(todayNew).reduce((a,b)=>a+b,0);
  const used=o.usedToday,total=p.totalDaily||p.daily,ratio=Math.min(1,used/Math.max(1,total)),C=2*Math.PI*22;
  const outputs=insights.output.map(d=>d.notes);
  const resurface=pickResurface(notes);
  const warn=alerts();
  const recent=[...o.recentVideos,...galleries.items].sort((a,b)=>(b.updated_at||0)-(a.updated_at||0)).slice(0,6);
  $('#today').innerHTML=`
  <section class="hero">
    <div class="card hero-main">
      <h1>${weekNotes?`吃灰的收藏，这周变成了 <em>${weekNotes}</em> 篇笔记。`:'这周还没有新笔记，收藏还在吃灰。'}</h1>
      <p class="lede">${lede}${lede.endsWith('。')?'':'。'}</p>
      <div class="hero-cta"><a class="btn primary lg" href="#pending">${ic('inbox',16)}处理收件箱${o.review?` · ${o.review}`:''}</a><a class="btn lg" href="#notes" data-action="kb-unread">${ic('book',16)}读新笔记${unread.length?` · ${unread.length} 篇未读`:''}</a></div>
    </div>
    <div class="card runcard">
      <div class="row">${s.loaded?'<span class="pulse"></span>':'<span class="pulse off"></span>'}<b style="font-size:12.5px;font-weight:500">${s.error?'自动安排暂不可用':s.loaded?'自动整理已开启':'自动整理已关闭'}</b>${s.loaded?`<span class="chip" style="margin-left:auto">每 ${s.intervalHours} 小时</span>`:''}</div>
      <div><div class="eyebrow">${busy()?'正在运行':'下一轮'}</div><div class="big">${busy()?'进行中':s.loaded?esc(hm(s.nextRun)):'—'}</div><small>${busy()?`开始于 ${esc(fmt(o.execution.startedAt))}`:s.loaded?`${esc(until(s.nextRun))} · 上一轮${o.lastRun?esc(last.label):'暂无'}`:'在流水线中开启自动整理'}</small></div>
      <div class="ring-row">
        <svg class="ring" viewBox="0 0 54 54"><circle cx="27" cy="27" r="22" stroke="var(--sunken)"/><circle cx="27" cy="27" r="22" stroke="var(--accent)" stroke-dasharray="${C}" stroke-dashoffset="${C*(1-ratio)}" transform="rotate(-90 27 27)" stroke-linecap="round"/><text x="27" y="31" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">${Math.round(ratio*100)}%</text></svg>
        <dl class="kv"><dt>今日额度</dt><dd>${used} / ${total} 条</dd>${['douyin','bilibili','x'].filter(k=>k==='douyin'||o[k==='x'?'x':'bilibili']?.enabled).map(k=>`<dt>${PLATFORM_LABELS[k]}</dt><dd>${o.usedByPlatform?.[k]||0} / ${k==='douyin'?p.daily:k==='x'?o.x.daily:o.bilibili.daily}</dd>`).join('')}<dt>本月成本</dt><dd class="muted" data-cost="month">读取中…</dd></dl>
      </div>
    </div>
  </section>
  <section class="card pipeline-band">
    <a class="stage" href="#collection"><span class="eyebrow"><b>1</b>收进来</span><strong>${newTotal}</strong><small>今天新收藏</small><span class="lanes">${Object.entries(todayNew).map(([k,v])=>`${pf(k)} ${v}`).join(' ')||'暂无'}</span></a>
    <a class="stage ${o.review?'attn':''}" href="#pending"><span class="eyebrow"><b>2</b>等你决定</span><strong>${o.review}</strong><small>需要你选用途</small><span class="lanes">${o.review?'点开逐条处理':'都处理完了'}</span></a>
    <a class="stage" href="#pipeline"><span class="eyebrow"><b>3</b>排队整理</span><strong>${o.pending}</strong><small>保存视频 · 转写 · 整理</small><span class="lanes">${paused.map(([k])=>chip(`<span class="dot"></span>${esc(PLATFORM_LABELS[k]||k)}暂停中`,'amber')).join('')||(busy()?chip('<span class="dot"></span>正在运行','green'):'')}</span></a>
    <a class="stage" href="#notes"><span class="eyebrow"><b>4</b>变成知识</span><strong>${o.notes}</strong><small>笔记 · 本周 +${weekNotes}</small>${spark(outputs)}</a>
  </section>
  ${warn.length?`<section class="card alert-strip">${warn.join('')}</section>`:''}
  <div class="cols">
    <div class="stack">
      <section><div class="sec-head"><h2>新到的知识</h2><span class="sub">最近整理完成</span><a class="more" href="#notes">全部 ${notes.length} 篇 ›</a></div>
        <div class="fresh">${notes.slice(0,4).map(n=>`<button type="button" class="card fresh-card" data-action="read" data-id="${esc(n.id)}"><span class="meta">${pf(n.platform,false)}${n.category?`<span style="color:${catColor(n.category)}">● ${esc(n.category)}</span>`:''}<span>· ${esc(fmt(n.at))}</span>${n.read_at?'':'<span class="unread" style="margin-left:auto" title="未读"></span>'}</span><h3>${esc(n.title)}</h3>${n.gist?`<p>${esc(n.gist)}</p>`:''}<span class="foot">${n.tags.slice(0,3).map(t=>chip('#'+esc(t),'outline')).join('')}</span></button>`).join('')||empty('整理完成的知识笔记会显示在这里')}</div></section>
    </div>
    <section class="card card-pad decide-card"><div class="sec-head"><h2>等你决定</h2><span class="sub">${o.review} 条</span><a class="more" href="#pending">逐条处理 ›</a></div>${review.items.map(i=>`<div class="decide-row">${thumbOf(i)}<div class="t"><b>${esc(titleOf(i))}</b><small>${esc(PLATFORM_LABELS[i.platform]||'')} · ${esc(kindOf(i))}</small></div>${i.pending_intents?`<small>${esc(intentLabel(i.pending_intents)).slice(0,8)}</small>`:`<div class="mini-choice"><button type="button" data-action="quick-purpose" data-id="${esc(i.id)}" data-purpose="note">笔记</button><button type="button" data-action="quick-purpose" data-id="${esc(i.id)}" data-purpose="video">视频</button></div>`}</div>`).join('')||'<p class="muted" style="font-size:13px">暂时没有需要你决定的收藏。</p>'}</section>
  </div>
  <div class="stack today-rest">
      ${resurface?`<section class="card resurface"><div class="l"><span class="eyebrow" style="color:var(--accent)">重温 · ${esc(fmt(resurface.collected_at))} 收藏${resurface.read_at?'':' · 还没读过'}</span><h3>${esc(resurface.title)}</h3>${resurface.gist?`<blockquote>${esc(resurface.gist)}</blockquote>`:''}<div class="row">${button('继续读','read',`data-id="${esc(resurface.id)}"`,'sm')}${button('加入素材箱','add-material',`data-id="${esc(resurface.id)}" data-kind="note"`,'quiet sm')}${button('换一篇','resurface-next','','quiet sm')}</div></div>
        <div class="r"><div class="sec-head" style="margin-bottom:4px"><h2 style="font-size:13.5px">还没读过的</h2><span class="sub">${unread.length} 篇</span></div>${unread.slice(0,5).map(n=>`<button type="button" class="list-item" data-action="read" data-id="${esc(n.id)}"><span class="unread"></span><span>${esc(n.title)}</span><small>${esc(fmt(n.at))}</small></button>`).join('')||'<p class="muted" style="font-size:13px">都读过了。</p>'}</div></section>`:''}
      <section><div class="sec-head"><h2>最近保存的视频与图集</h2><a class="more" href="#videos">媒体库 ›</a></div><div class="media-grid media-strip">${recent.map(i=>mediaCard(i,{uniform:true})).join('')||empty('选择「保存视频」后，保留的视频会显示在这里')}</div></section>
  </div>`;
  void fillMonthCost(epoch);
}
// ── 成本（AI 网关按单价估算，不是厂商账单）──
const COST_LABELS={router:'用途判断',asr:'转写',note:'笔记'};
function money(v){return !v?'¥0':v<0.01?'不到 ¥0.01':`¥${v.toFixed(2)}`;}
// 未定价、用量未知的调用按 0 计，必须让人看到，不能和真的 0 元混在一起。
function costCaveat(t){return [t.unpriced&&`未定价 ${t.unpriced} 次`,t.usage_unknown&&`用量未知 ${t.usage_unknown} 次`,t.usage_partial&&`用量不完整 ${t.usage_partial} 次`].filter(Boolean).join(' · ');}
function budgetLine(b){return b?.monthly_budget==null?'未设月预算':b.exceeded?`月预算 ${money(b.monthly_budget)} 已用完`:`月预算 ${money(b.monthly_budget)}，剩 ${money(b.remaining)}`;}
async function fillMonthCost(epoch){
  const el=$('[data-cost="month"]');if(!el)return;
  try{const c=await api('costs');if(epoch!==pageEpoch)return;const w=costCaveat(c.month);el.classList.toggle('muted',false);el.innerHTML=`${esc(money(c.month.cost))}${w?` <small class="muted">另有${esc(w)}</small>`:''}`;el.title=budgetLine(c.budget);}
  catch(e){if(epoch===pageEpoch){el.textContent='暂时读不到';el.title=e.message;}}
}
async function fillCostCard(epoch){
  const el=$('#cost-card');if(!el)return;
  try{
    const c=await api('costs');if(epoch!==pageEpoch)return;const w=costCaveat(c.month),b=c.budget;
    const groups=c.month.groups.filter(g=>g.requests).map(g=>`${esc(COST_LABELS[g.key]||g.label||'未标记')} ${esc(money(g.cost))}`).join(' · ');
    el.innerHTML=`<span class="eyebrow">本月成本 ${chip('由 AI 网关估算')}</span><strong>${esc(money(c.month.cost))}<small>${c.month.requests} 次调用</small></strong><span class="delta">今天 ${esc(money(c.today.cost))} · ${esc(budgetLine(b))}${groups?`<br>${groups}`:''}${w?`<br><span style="color:var(--amber)">${esc(w)}，按 0 计入</span>`:''}</span>`;
    if(b?.exceeded)el.querySelector('strong').style.color='var(--red)';
  }catch(e){if(epoch===pageEpoch)el.querySelector('.delta').textContent=`暂时读不到网关用量：${e.message}`;}
}
async function fillItemCost(id,epoch){
  const el=dialog.querySelector('[data-cost="item"]');if(!el)return;
  try{const c=await api('item-cost?'+query({id}));if(epoch!==dialogEpoch)return;const w=costCaveat(c);el.textContent=c.requests?`${money(c.cost)}（${c.groups.filter(g=>g.requests).map(g=>`${COST_LABELS[g.key]||g.label||'未标记'} ${money(g.cost)}`).join('，')}）${w?`；另有${w}`:''}`:'没有记录到模型调用';}
  catch(e){if(epoch===dialogEpoch)el.textContent='暂时读不到';}
}
let resurfaceShift=0;
function pickResurface(notes){
  // 重温：一周前收藏的笔记，未读优先；同一天内固定，点“换一篇”轮换。
  const old=notes.filter(n=>n.collected_at<Date.now()/1000-7*86400);const pool=old.length?old:notes;if(!pool.length)return null;
  const sorted=[...pool].sort((a,b)=>(!!a.read_at-!!b.read_at)||(a.collected_at-b.collected_at));
  const day=Math.floor(Date.now()/86400000);return sorted[(day+resurfaceShift)%Math.min(sorted.length,12)];
}
const CAT_COLORS=['#C2703D','#5B7FC7','#2C8A6A','#8A5BC7','#C79A3D','#C75B6E','#4E9AA8','#7A8C3D'];
const catColor=c=>c?CAT_COLORS[hue(c)%CAT_COLORS.length]:'var(--faint)';
function alerts(){
  const o=state.overview,r=o.lastRun?.result||{},out=[];
  const item=(tone,icon,title,text,href,action='')=>`<a class="alert ${tone}" href="${href}" ${action}><span class="ic">${ic(icon,15)}</span><span><b>${esc(title)}</b>${text?`<small>${esc(text)}</small>`:''}</span><span class="go">${ic('arrow',14)}</span></a>`;
  if(o.needsLogin||o.session.level==='expired'||o.session.online==='login_required')out.push(item('red','shield','抖音需要重新登录','新收藏扫描会受阻，登录后恢复','#account'));
  else if(o.session.level==='warn')out.push(item('amber','clock','抖音登录即将到期',remainingLabel(o.session),'#account'));
  if(o.bilibili.enabled&&(o.bilibili.session.level==='expired'||o.bilibili.session.online==='login_required'))out.push(item('red','shield','B站需要重新登录','','#account'));
  if(o.x.enabled&&o.x.configured&&!o.x.connected)out.push(item('blue','link','X 还没有连接','在流水线的来源卡片里点「连接 X」','#account'));
  else if(o.x.enabled&&o.x.online==='login_required')out.push(item('red','link','X 授权已失效','需要重新连接','#account'));
  for(const [k,v] of Object.entries(r.pausedPlatforms||{}))out.push(item('amber','shield',`${PLATFORM_LABELS[k]||k}已暂停`,v,'#history'));
  if(r.paused)out.push(item('amber','alert','上一轮已暂停',r.paused,'#history'));
  if(r.scanWarning)out.push(item('amber','alert','扫描受阻，已继续待办',r.scanWarning,'#history'));
  if(o.failed)out.push(item('red','alert',`${o.failed} 条处理失败`,'查看原因，可以恢复为待办','#collection','data-action="failed-items"'));
  if(o.scheduler.error||o.scheduler.warning)out.push(item('amber','clock','自动安排需要处理',o.scheduler.error||o.scheduler.warning,'#schedule'));
  if(o.storage.available!=null&&o.storage.available<o.policy.free*1.5)out.push(item('amber','alert','磁盘空间偏低',`可用 ${bytes(o.storage.available)}`,'#storage'));
  return out;
}
function mediaCard(i,{big=false,uniform=false}={}){
  const badge=i.media_type==='gallery'?`${i.image_count||'多'} 张`:duration(i.duration_s);
  // 图集墙按第一张图的真实比例显示（今日页整行卡片统一 3:4，uniform）；过长、过扁的图收在 9:16 到 4:3 之间，大卡最高 4:5。
  const ratio=!uniform&&i.cover_ratio>0?String(Math.min(4/3,Math.max(big?0.8:9/16,i.cover_ratio))):'';
  return `<button type="button" class="media-card${big?' big':''}" data-action="${i.media_type==='gallery'?'view-gallery':'play-video'}" data-id="${esc(i.id)}">${cover(i,{badge,pfb:true,ratio})}<b>${esc(titleOf(i))}</b><small>${esc(i.author||'未知作者')}${i.delete_after_note?' · 待转为笔记':i.note_path&&i.media_type!=='gallery'?' · 也有笔记':''}</small></button>`;
}

// ── 收件箱：只放需要你决定的条目 ──
function pendingPage(){return `<div class="page">${head('收件箱','模型拿不准的收藏在这里由你决定。键盘 <span class="kbd">N</span> 笔记 · <span class="kbd">V</span> 视频 · <span class="kbd">D</span> 放弃 · <span class="kbd">J</span>/<span class="kbd">K</span> 上下切换',`<span class="chip">${ic('clock',13)}${state.overview.scheduler.loaded?`决定后在下一轮 ${esc(hm(state.overview.scheduler.nextRun))} 处理`:'决定后在下一轮运行时处理'}</span>`)}<div id="inbox">${empty('正在读取…')}</div></div>`;}
async function loadPending(){
  const epoch=++listEpoch,page=pageEpoch;
  const data=await api('items?'+query({status:'review',page:state.inbox.page,size:20}));
  if(epoch!==listEpoch||page!==pageEpoch||state.route!=='pending')return;
  state.inbox.data=data;state.inbox.page=data.page;
  if(!data.items.some(i=>i.id===state.inbox.id))state.inbox.id=data.items[0]?.id||null;
  renderInbox();
}
function renderInbox(){
  const data=state.inbox.data,o=state.overview,i=data.items.find(x=>x.id===state.inbox.id);
  const queueLink=`<a class="card queue-link" href="#pipeline">${ic('flow',16)}<span><b>另有 ${o.pending} 条在排队自动处理</b><small>不需要你动手 · ${o.scheduler.loaded?`下一轮 ${esc(hm(o.scheduler.nextRun))} 开始`:'自动整理已关闭，可手动运行'}</small></span><span class="go">在流水线查看 ›</span></a>`;
  if(!i){$('#inbox').innerHTML=`<section class="card" style="padding:48px 24px;text-align:center;margin-bottom:20px"><h2 style="font-size:18px;font-weight:600">收件箱清空了</h2><p class="muted" style="margin-top:6px">需要你判断用途的收藏会出现在这里。</p></section>${queueLink}`;return;}
  const bili=i.platform==='bilibili';
  $('#inbox').innerHTML=`<div class="inbox">
    <div class="card queue-list"><div class="nav-label" style="padding:6px 10px">待确认 · ${data.total}</div>${data.items.map(x=>`<button type="button" class="q-item" data-action="inbox-select" data-id="${esc(x.id)}" aria-pressed="${x.id===i.id}">${thumbOf(x)}<span class="t"><b>${esc(titleOf(x))}</b><small>${esc(PLATFORM_LABELS[x.platform]||'')} · ${esc(x.author||'未知作者')} · ${esc(kindOf(x))}</small></span></button>`).join('')}${pagination(data,'inbox')}</div>
    <div class="stack">
      <section class="card focus"><div class="body">
        <div class="row">${pf(i.platform)}<small>· ${esc(i.author||'未知作者')}</small><span style="margin-left:auto">${sourceA(i)}</span></div>
        <h2>${esc(titleOf(i))}</h2>
        <div class="reason">${ic('spark',16)}<span><b style="font-weight:600">为什么需要你：</b>${esc(i.routing_reason||(bili?'B站新收藏默认由你确认用途和画质。':'需要你确认这条收藏的用途。'))}</span></div>
        ${i.pending_intents?`<p class="intent-note">${esc(intentLabel(i.pending_intents))}</p>`:''}
        ${previewHint(i)}
        ${hasMedia(i)?inlinePlayer(i):''}
        <div class="choices">
          <button type="button" class="choice" data-action="quick-purpose" data-id="${esc(i.id)}" data-purpose="note"><span class="kbd">N</span><b>${ic('note')}知识笔记</b><small>${bili?'字幕优先，没有字幕再转写':'转写后整理成笔记'}</small></button>
          <button type="button" class="choice" data-action="quick-purpose" data-id="${esc(i.id)}" data-purpose="video"><span class="kbd">V</span><b>${ic('video')}保存视频</b><small>${bili?'画质见下方':'保存高清原声'}</small></button>
          ${i.can_discard?`<button type="button" class="choice" data-action="discard-item" data-id="${esc(i.id)}"><span class="kbd">D</span><b style="color:var(--ink-2)">${ic('skip')}放弃处理</b><small>保留记录，可随时恢复</small></button>`:''}
        </div>
        ${bili?qualityPicker(i):''}
        <div class="row" style="margin-top:auto">${i.routing_preview?`<small>${ic('spark',13)} 模型建议：${esc(PURPOSES[i.routing_preview.purpose]||i.routing_preview.purpose)}${i.routing_preview.reason?' · '+esc(i.routing_preview.reason):''}</small>`:''}${button('收藏详情','detail',`data-id="${esc(i.id)}"`,'quiet sm')}${i.can_delete?button('删除记录','delete-item',`data-id="${esc(i.id)}" data-idle ${busy()?'disabled':''}`,'quiet sm danger'):''}</div>
      </div></section>
      ${queueLink}
    </div></div>`;
}
// 预下载的视频直接嵌在决定区里，点封面就地播放，不再弹窗。
function inlinePlayer(i){return `<div class="inline-player"><button type="button" class="inline-poster" data-action="inline-play" data-id="${esc(i.id)}" aria-label="播放视频"><img src="api/video-poster?id=${encodeURIComponent(i.id)}" alt=""><span class="play-badge">${ic('play',22)}</span>${i.duration_s?`<span class="badge">${esc(duration(i.duration_s))}</span>`:''}</button></div>`;}
function playInline(box,id){
  const v=document.createElement('video');v.controls=true;v.playsInline=true;v.preload='metadata';v.setAttribute('aria-label','视频');
  restoreVideoAudio(v);
  // 原片浏览器放不了时转到弹窗播放器，那里会生成兼容副本。
  v.addEventListener('error',()=>{box.innerHTML=`<div class="inline-error"><span>这个视频浏览器无法直接播放</span>${button('兼容播放','play-video',`data-id="${esc(id)}"`,'sm')}</div>`;});
  box.replaceChildren(v);v.src='api/video?'+query({id});void v.play().catch(()=>{});
}
// 收件箱条目的视频状态：已预下载可直接看；太长的决定后再下载；其余在下一轮预下载。
function previewHint(i){
  if(hasMedia(i)||i.media_type==='post')return hasMedia(i)?'<p class="muted" style="font-size:12.5px">视频已预下载，可以先看再决定；选「保存视频」直接移进收藏，选「知识笔记」不用重新下载。</p>':'';
  const s=Number(i.duration_s);
  if(s>30*60)return '<p class="muted" style="font-size:12.5px">超过 30 分钟，没有预下载；决定后再下载。</p>';
  return '<p class="muted" style="font-size:12.5px">视频会在下一轮运行时预下载，届时可以先看再决定。</p>';
}
function qualityPicker(i){
  const fallback=String(state.overview?.policy?.bilibili?.maxQuality??80),current=i.video_quality==null?'':String(i.video_quality);
  return `<label class="row" style="font-size:13px;color:var(--ink-2)">保存为视频时的画质<select data-quality-for="${esc(i.id)}" aria-label="视频画质">${[['',`默认（${QUALITY_LABELS[fallback]||'1080p'}）`],...['64','80','116','120','0'].filter(v=>v!==fallback).map(v=>[v,QUALITY_LABELS[v]])].map(([v,l])=>`<option value="${v}" ${v===current?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
}
function inboxStep(dir){const list=state.inbox.data?.items||[];if(!list.length)return;const n=list.findIndex(x=>x.id===state.inbox.id);state.inbox.id=list[(n+dir+list.length)%list.length].id;renderInbox();}

// ── 知识库 ──
const filtered=()=>{const k=state.kb,q=k.q.trim().toLowerCase();return (state.index||[]).filter(n=>(k.cat==='all'||(n.category||'未分类')===k.cat)&&(k.platform==='all'||n.platform===k.platform)&&(k.tag===null||n.tags.includes(k.tag))&&(k.type==='all'||(k.type==='note'?n.has_note:!n.has_note))&&(k.read==='all'||(k.read==='unread'?!n.read_at:k.read==='read'?!!n.read_at:k.read==='evergreen'?evergreen(n.decay):n.decay&&!evergreen(n.decay)))&&(!q||[n.title,n.author,n.id,...n.tags].join(' ').toLowerCase().includes(q)));};
function notesPage(){return `<div class="page" id="kb">${empty('正在读取…')}</div>`;}
async function loadNotes(){const epoch=pageEpoch;await ensureIndex(true);if(epoch!==pageEpoch)return;renderNotes();}
function renderNotes(){
  const k=state.kb,all=state.index,list=filtered(),notes=all.filter(n=>n.has_note);
  const count=(fn)=>all.filter(fn).length,cats=Object.entries(all.reduce((a,n)=>{const c=n.category||'未分类';a[c]=(a[c]||0)+1;return a;},{})).sort((a,b)=>b[1]-a[1]);
  const tags=Object.entries(all.reduce((a,n)=>{for(const t of n.tags)a[t]=(a[t]||0)+1;return a;},{})).sort((a,b)=>b[1]-a[1]).slice(0,12);
  document.body.classList.toggle('fit',k.view==='read');
  const headHtml=head('知识库',`${notes.length} 篇笔记 · ${count(n=>n.has_note&&!n.read_at)} 篇未读 · ${cats.length} 个主题${count(n=>!n.has_note)?` · 另有 ${count(n=>!n.has_note)} 份独立文字稿`:''}`,`<div class="seg">${[['read','阅读'],['topics','主题地图']].map(([v,l])=>`<button type="button" data-action="kb-view" data-value="${v}" aria-pressed="${k.view===v}">${l}</button>`).join('')}</div>${button(`${ic('ext',14)}Obsidian 打开目录`,'open','data-kind="notes-folder"')}`);
  if(k.view==='topics'){
    $('#kb').innerHTML=headHtml+`<div class="topics">${cats.map(([c,n])=>{const ns=all.filter(x=>(x.category||'未分类')===c);return `<button type="button" class="card topic-card" data-action="kb-facet" data-facet="cat" data-value="${esc(c)}"><h3><span class="sw" style="width:10px;height:10px;background:${catColor(c==='未分类'?null:c)}"></span>${esc(c)}<small style="margin-left:auto;font-weight:400">${n} 篇</small></h3><span class="bar"><i style="width:${Math.min(100,n/Math.max(1,cats[0][1])*100)}%;background:${catColor(c==='未分类'?null:c)}"></i></span><ul>${ns.slice(0,3).map(x=>`<li>${esc(x.title)}</li>`).join('')}</ul><span class="row">${[...new Set(ns.flatMap(x=>x.tags))].slice(0,4).map(t=>chip('#'+esc(t),'outline')).join('')}</span></button>`;}).join('')||empty('还没有笔记')}</div>`;return;
  }
  if(!list.some(n=>n.id===k.id))k.id=list[0]?.id||null;
  const n=all.find(x=>x.id===k.id);
  const facet=(f,v,label,c,dot='')=>`<button type="button" data-action="kb-facet" data-facet="${f}" data-value="${esc(v)}" aria-pressed="${String(k[f==='tag'?'tag':f])===String(v)}">${dot}<span>${label}</span><span>${c}</span></button>`;
  $('#kb').innerHTML=headHtml+`<section class="card kb ${k.list?'':'nolist'} ${n&&!k.list?'reading':''}">
    <aside class="kb-facets">
      <div class="facet"><div class="nav-label">阅读状态</div>${facet('read','all','全部',all.length)}${facet('read','unread','未读',count(x=>!x.read_at))}${facet('read','read','已读',count(x=>!!x.read_at))}${facet('read','evergreen','常青内容',count(x=>evergreen(x.decay)))}${facet('read','timely','有时效',count(x=>x.decay&&!evergreen(x.decay)))}</div>
      <div class="facet"><div class="nav-label">主题</div>${facet('cat','all','全部主题',all.length,'<span class="sw" style="background:var(--ink)"></span>')}${cats.map(([c,num])=>facet('cat',c,esc(c),num,`<span class="sw" style="background:${catColor(c==='未分类'?null:c)}"></span>`)).join('')}</div>
      ${tags.length?`<div class="facet"><div class="nav-label">热门标签</div><div class="tagcloud">${tags.map(([t])=>`<button type="button" data-action="kb-facet" data-facet="tag" data-value="${esc(t)}" aria-pressed="${k.tag===t}">#${esc(t)}</button>`).join('')}</div></div>`:''}
      <div class="facet"><div class="nav-label">来源</div>${['douyin','bilibili','x'].map(p=>facet('platform',p,pf(p),count(x=>x.platform===p))).join('')}</div>
      ${count(x=>!x.has_note)?`<div class="facet"><div class="nav-label">类型</div>${facet('type','note','知识笔记',count(x=>x.has_note))}${facet('type','text','仅文字稿',count(x=>!x.has_note))}</div>`:''}
    </aside>
    <div class="kb-list"><div class="tools">${searchField(k.q,`在 ${list.length} 篇中搜索标题、作者、标签`,'kb-search')}</div>
      <div class="kb-items" id="kb-items">${list.map(x=>`<button type="button" class="kb-item" data-action="kb-select" data-id="${esc(x.id)}" aria-pressed="${x.id===k.id}"><b>${esc(x.title)}</b><span class="m">${pf(x.platform,false)}${x.category?`<span style="color:${catColor(x.category)}">●</span>`:''}<span>${esc(x.author||'未知作者')}</span><span>· ${esc(fmt(x.at))}</span>${x.has_note?'':tag('文字稿')}${x.read_at?'':'<span class="unread"></span>'}</span></button>`).join('')||empty(k.q?'没有找到匹配的笔记':'这个筛选下没有笔记')}</div>
    </div>
    <article class="reader" id="reader">${n?'':empty('还没有可阅读的内容')}</article>
  </section>`;
  if(n)void loadDocument();
}
async function loadDocument(){
  const epoch=++docEpoch,k=state.kb,list=filtered(),n=state.index.find(x=>x.id===k.id);if(!n)return;
  if(keptUnread!==n.id)keptUnread=null;
  const pos=list.findIndex(x=>x.id===n.id);
  const bar=formatted=>`<div class="reader-bar">${button(`${ic(k.list?'collapse':'expand',15)}${k.list?'收起列表':'展开列表'}`,'kb-list','title="收起或展开列表（[）"','quiet sm')}${k.list?'':`<span class="pager">${button(ic('up',14),'kb-step','data-step="-1" title="上一篇（K）" aria-label="上一篇"','quiet sm')}<small class="num">${pos+1} / ${list.length}</small>${button(ic('down',14),'kb-step','data-step="1" title="下一篇（J）" aria-label="下一篇"','quiet sm')}</span>`}
    ${n.has_note?`<div class="seg">${[['note','知识笔记'],...(formatted?[['formatted','格式化转写']]:[])].map(([v,l])=>`<button type="button" data-action="kb-kind" data-value="${v}" aria-pressed="${k.kind===v||(!formatted&&v==='note')}">${l}</button>`).join('')}</div>`:'<span style="margin-right:auto"></span>'}
    ${button(`${ic('check',14)}${n.read_at?'标为未读':'标为已读'}`,'toggle-read',`data-id="${esc(n.id)}"`,'quiet sm')}${button(`${ic('bookmark',14)}加入素材箱`,'add-material',`data-id="${esc(n.id)}" data-kind="${n.media_type==='post'?'post':'note'}" data-from-reader="1"`,'quiet sm')}${n.has_note?button(`${ic('ext',14)}Obsidian`,'open',`data-kind="note" data-id="${esc(n.id)}"`,'quiet sm'):''}${sourceA(n,n.platform==='x'?'原帖':'原视频')}</div>`;
  $('#reader').innerHTML=bar(false)+empty('正在读取正文…');$('#reader').scrollTop=0;
  try{
    const doc=await api('document?'+query({id:n.id,kind:n.has_note?'note':'text'}));if(epoch!==docEpoch||state.route!=='notes')return;
    const parts=n.has_note?splitNoteContent(doc.content):{note:null,formatted:null};
    const kind=parts.formatted&&k.kind==='formatted'?'formatted':'note';
    const body=n.has_note?renderMarkdown(parts[kind],{headingOffset:1}):`<div class="raw">${esc(doc.content)}</div>`;
    $('#reader').innerHTML=bar(!!parts.formatted)+`<div class="article"><div class="kicker">${n.category?chip(`<span class="sw" style="width:7px;height:7px;background:${catColor(n.category)}"></span>${esc(n.category)}`):''}${n.decay?chip(decayLabel(n.decay),evergreen(n.decay)?'green':'amber'):''}${n.has_note?'':chip('原始文字稿')}${n.archive_only?chip('只存原帖'):''}</div><h1>${esc(n.title)}</h1><div class="byline">${pf(n.platform)}<span>${esc(n.author||'未知作者')}</span>${n.duration_s?`<span>${esc(duration(n.duration_s))}</span>`:''}<span>收藏 ${esc(fmt(n.collected_at))}</span><span>整理 ${esc(fmt(n.at))}</span>${n.has_note?button('在文件夹中显示','open',`data-kind="folder" data-file-kind="note" data-id="${esc(n.id)}"`,'quiet sm'):''}</div><div class="prose">${body}</div>${n.tags.length?`<div class="tags">${n.tags.map(t=>chip('#'+esc(t),'outline')).join('')}</div>`:''}</div>`;
    if(!n.read_at&&keptUnread!==n.id){api('read',{id:n.id,read:true}).then(()=>{n.read_at=Date.now()/1000;if(epoch!==docEpoch)return;document.querySelector(`.kb-item[data-id="${CSS.escape(n.id)}"] .unread`)?.remove();const t=$('#reader [data-action="toggle-read"]');if(t)t.innerHTML=`${ic('check',14)}标为未读`;}).catch(()=>{});}
  }catch(e){if(epoch===docEpoch)$('#reader').innerHTML=bar(false)+empty(e.message);}
}
function kbStep(dir){const list=filtered();if(!list.length)return;const n=Math.max(0,list.findIndex(x=>x.id===state.kb.id));state.kb.id=list[(n+dir+list.length)%list.length].id;root.querySelectorAll('.kb-item').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.id===state.kb.id)));void loadDocument();}

// ── 媒体库：视频、图集、X 原帖 ──
function videosPage(){const m=state.media;return `<div class="page">${head('媒体库',`按原样保留的内容：视频保存高清原声，图集按原顺序${state.overview.x.enabled?'，X 每条书签都存原帖':''}`,`<span class="chip">${ic('clock',13)}保留占用 ${esc(bytes(state.overview.storage.savedUsed))}</span>`)}
  <div class="toolbar"><div class="seg">${[['video','视频',state.overview.videos],['gallery','图集',state.overview.galleries||0],['post','X 原帖',state.overview.platforms?.x||0]].map(([v,l,c])=>`<button type="button" data-action="media-tab" data-value="${v}" aria-pressed="${m.tab===v}">${l} <small class="num">${c}</small></button>`).join('')}</div>
  ${m.tab==='post'?'':`<div class="seg">${[['all','全部平台'],['douyin','抖音'],['bilibili','B站'],['x','X']].map(([v,l])=>`<button type="button" data-action="media-platform" data-value="${v}" aria-pressed="${m.platform===v}">${l}</button>`).join('')}</div>`}
  ${searchField(m.q,'搜索标题、作者','media-search')}</div><div id="media-list">${empty('正在读取…')}</div></div>`;}
// 媒体库滚动加载：先读第一批，滚到列表底部附近时接着读下一批并追加，不翻页。
// 刷新（删除、转为笔记后）按已读到的批数重新读取，保持当前位置。
const mediaQuery=(m,page)=>'items?'+query({[m.tab==='video'?'videos':m.tab==='gallery'?'galleries':'posts']:1,size:m.tab==='post'?20:24,q:m.q,page,platform:m.tab==='post'?'all':m.platform});
let mediaObserver=null,mediaLoading=false;
async function loadMedia(){
  const epoch=++listEpoch,page=pageEpoch,m=state.media,pages=Math.max(1,m.page||1);
  mediaObserver?.disconnect();mediaLoading=false;
  let data,items=[];
  for(let n=1;n<=pages;n++){data=await api(mediaQuery(m,n));if(epoch!==listEpoch||page!==pageEpoch)return;items=items.concat(data.items);if(n>=data.pages)break;}
  m.items=items;m.data=data;m.page=Math.min(pages,data.pages);
  const none=m.q?'没有找到匹配的内容':m.tab==='video'?'还没有保留的视频，可在收藏记录中选择视频用途':m.tab==='gallery'?'还没有保存的图集':'还没有 X 书签';
  if(!items.length){$('#media-list').innerHTML=empty(none);return;}
  const box=m.tab==='post'?'posts':m.tab==='gallery'?'wall':'media-grid';
  $('#media-list').innerHTML=`<div class="${box}">${mediaItems(0)}</div><div class="load-more" id="media-more"></div>`;
  if(m.tab==='gallery')layoutWall();
  watchMediaEnd();
}
function mediaItems(from){
  const m=state.media,items=m.items;
  if(m.tab==='post')return items.slice(from).map(postCard).join('');
  if(m.tab==='gallery'){const big=wallBig(items);return items.slice(from).map((i,n)=>mediaCard(i,{big:big[from+n]})).join('');}
  return items.slice(from).map(i=>mediaCard(i)).join('');
}
function postCard(i){const s=postState(i);return `<article class="card post-card"><div class="who"><span class="avatar" style="background:hsl(${hue(i.author||i.id)} 40% 45%)">${esc((i.author||'X').slice(0,1))}</span><span><b>${esc(i.author||'未知作者')}</b><small>${esc(fmt(i.collected_at||i.first_seen))}</small></span><span style="margin-left:auto">${pf('x',false)}</span></div><h3>${esc(titleOf(i))}</h3>${i.gist&&i.gist!==titleOf(i)?`<p>${esc(i.gist)}</p>`:''}<div class="foot">${tag(s.label,s.tone)}${i.last_error?`<small class="cell-error">${esc(i.last_error).slice(0,80)}</small>`:''}<span style="margin-left:auto" class="row">${i.note_path?button('阅读','read',`data-id="${esc(i.id)}"`,'quiet sm'):''}${i.note_path?button('加入素材箱','add-material',`data-id="${esc(i.id)}" data-kind="post"`,'quiet sm'):''}${sourceA(i,'原帖')}</span></div></article>`;}
function watchMediaEnd(){
  const m=state.media,more=$('#media-more');if(!more)return;
  const done=m.page>=m.data.pages;
  more.innerHTML=done?`<small>共 ${m.data.total} 条，已经到底了</small>`:'<small>正在加载更多…</small>';
  if(done)return;
  // 提前一屏开始读，滚动时基本看不到等待。
  mediaObserver=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))void loadMoreMedia();},{rootMargin:'0px 0px 1200px 0px'});
  mediaObserver.observe(more);
}
async function loadMoreMedia(){
  const m=state.media;if(mediaLoading||m.page>=m.data.pages)return;
  const epoch=listEpoch,page=pageEpoch;mediaLoading=true;mediaObserver?.disconnect();
  try{
    const data=await api(mediaQuery(m,m.page+1));if(epoch!==listEpoch||page!==pageEpoch)return;
    // 读取期间有新收藏进来会让分页错位，按 ID 去重。
    const seen=new Set(m.items.map(i=>i.id)),fresh=data.items.filter(i=>!seen.has(i.id)),from=m.items.length;
    m.items=m.items.concat(fresh);m.data=data;m.page=data.page;
    $('#media-list > :first-child').insertAdjacentHTML('beforeend',mediaItems(from));
    if(m.tab==='gallery')layoutWall();
    watchMediaEnd();
  }catch(e){if(epoch===listEpoch){const more=$('#media-more');if(more)more.innerHTML=`<small>${esc(e.message)}</small>${button('重试','media-more','','quiet sm')}`;}}
  finally{if(epoch===listEpoch)mediaLoading=false;}
}
// 图集墙：图多（9 张及以上）或横图的图集做成两列宽的大卡，相邻 4 张内只出一张，避免大卡扎堆。
function wallBig(items){let last=-9;return items.map((i,n)=>{const big=(i.image_count>=9||i.cover_ratio>=1.2)&&n-last>4;if(big)last=n;return big;});}
// 网格每行 4px，按卡片实际高度算出占几行，形成高矮错落的瀑布流；空位由后面的卡片补上。
const WALL_ROW=4,WALL_GAP=20;let wallObserver=null,wallWidth=0;
function layoutWall(){
  const wall=$('#media-list .wall');wallObserver?.disconnect();if(!wall)return;
  const place=()=>{
    const cards=[...wall.children],cols=getComputedStyle(wall).gridTemplateColumns.split(' ').length;
    for(const c of cards)c.style.gridColumn=c.classList.contains('big')&&cols>1?'span 2':'';
    const heights=cards.map(c=>c.getBoundingClientRect().height);
    cards.forEach((c,n)=>{c.style.gridRowEnd=`span ${Math.ceil((heights[n]+WALL_GAP)/WALL_ROW)}`;});
    wallWidth=wall.clientWidth;
  };
  place();
  wallObserver=new ResizeObserver(()=>{if(wall.isConnected&&wall.clientWidth!==wallWidth)place();});wallObserver.observe(wall);
  void document.fonts?.ready.then(()=>{if(wall.isConnected)place();});
}
let galleryData=null,galleryIndex=0;
async function viewGallery(id){
  const epoch=++dialogEpoch;galleryData=null;galleryIndex=0;drawerId=null;
  openDialog(dialogHead('图集')+empty('正在读取图片…'),'modal wide');
  try{const data=await api('gallery?'+query({id}));if(epoch!==dialogEpoch||!dialog.open)return;galleryData=data;renderGallery();}
  catch(e){if(epoch===dialogEpoch&&dialog.open)dialog.innerHTML=dialogHead('图集')+empty(e.message);}
}
function renderGallery(){
  if(!galleryData)return;const {item,images}=galleryData,id=item.id;
  galleryIndex=Math.max(0,Math.min(images.length-1,galleryIndex));const src='api/gallery-image?'+query({id,index:galleryIndex});
  dialog.innerHTML=dialogHead(esc(titleOf(item)))+`<div class="gallery-stage"><a href="${src}" target="_blank" rel="noopener" aria-label="打开第 ${galleryIndex+1} 张原图"><img src="${src}" alt="第 ${galleryIndex+1} 张图片"></a></div><div class="gallery-controls">${button('← 上一张','gallery-step',`data-step="-1" ${galleryIndex===0?'disabled':''}`,'quiet')}<span class="num" aria-live="polite">${galleryIndex+1} / ${images.length}</span>${button('下一张 →','gallery-step',`data-step="1" ${galleryIndex===images.length-1?'disabled':''}`,'quiet')}</div><div class="gallery-thumbnails">${images.map((_,n)=>`<button type="button" data-action="gallery-select" data-index="${n}" aria-label="第 ${n+1} 张" aria-pressed="${n===galleryIndex}"><img loading="lazy" src="api/gallery-image?id=${encodeURIComponent(id)}&index=${n}" alt=""></button>`).join('')}</div><div class="gallery-foot"><small>${esc(item.author||'未知作者')} · ${images.length} 张 · ${bytes(item.media_bytes)}</small><div class="row">${button('加入素材箱','add-material',`data-id="${esc(id)}" data-kind="gallery"`,'sm')}<a class="btn quiet sm" href="${src}" target="_blank" rel="noopener">查看原图 ↗</a>${button('打开本地文件夹','open',`data-kind="gallery-folder" data-id="${esc(id)}"`,'quiet sm')}${sourceA(item,'原图集')}</div></div>`;
  dialog.querySelector('.gallery-thumbnails [aria-pressed=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
dialog.addEventListener('keydown',e=>{if(!galleryData||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();galleryIndex+=e.key==='ArrowRight'?1:-1;renderGallery();});

// ── 视频播放 ──
function stopVideo(){clearTimeout(videoTimer);const v=dialog.querySelector('video');if(v){v.pause();v.removeAttribute('src');v.load();}}
const videoMessage=m=>{const p=dialog.querySelector('#video-message');if(p)p.textContent=m;};
const videoAudioKey='dustoff.video-audio';let videoAudio={volume:0.2,muted:false};
try{const saved=JSON.parse(localStorage.getItem(videoAudioKey));if(typeof saved?.volume==='number'&&saved.volume>=0&&saved.volume<=1)videoAudio.volume=saved.volume;if(typeof saved?.muted==='boolean')videoAudio.muted=saved.muted;}catch{} // 存储不可用时仍以低音量播放
function restoreVideoAudio(v){v.volume=videoAudio.volume;v.muted=videoAudio.muted;v.addEventListener('volumechange',()=>{videoAudio={volume:v.volume,muted:v.muted};try{localStorage.setItem(videoAudioKey,JSON.stringify(videoAudio));}catch{}});}
async function preparePlayback(id,epoch){
  if(epoch!==dialogEpoch||!dialog.open)return;const v=dialog.querySelector('video');if(!v||v.dataset.preparing==='true')return;
  v.dataset.preparing='true';v.pause();videoMessage('正在准备兼容播放，首次需要稍等；原视频会保留。');
  try{let status=await api('video-prepare',{id});
    const check=async()=>{if(epoch!==dialogEpoch||!dialog.open)return;
      if(status.state==='ready'){v.dataset.compatible='true';v.dataset.preparing='false';v.src='api/video?'+query({id,compatible:1});v.load();void v.play().catch(()=>{});videoMessage('播放兼容副本 · 原视频保留');return;}
      if(status.state==='failed')throw new Error(status.error);
      videoTimer=setTimeout(async()=>{try{status=await api('video-status?'+query({id}));await check();}catch(e){if(epoch===dialogEpoch){v.dataset.preparing='false';videoMessage(e.message);}}},1200);};
    await check();
  }catch(e){if(epoch===dialogEpoch){v.dataset.preparing='false';videoMessage(e.message);}}
}
function videoNoteLabel(i){return i.status==='extracted'?(i.retain_media?'内容不足，视频保留':'笔记已生成，待清理视频'):['failed','skipped'].includes(i.status)?'转换未完成，视频保留':'待转为笔记';}
function videoNoteButton(i){if(i.media_deleted||i.media_type==='gallery')return '';if(i.delete_after_note&&i.processing_mode==='note')return `<span data-video-note-button>${button(esc(videoNoteLabel(i)),'','disabled','sm')}</span>`;return i.can_convert_to_note?`<span data-video-note-button>${button(`转为笔记`,'video-to-note',`data-id="${esc(i.id)}" data-idle ${busy()?'disabled':''}`,'sm')}</span>`:'';}
function videoNoteHint(i){
  if(i.media_deleted||(!i.can_convert_to_note&&!i.delete_after_note))return '';
  let text=`使用${serverMode?'服务器上的':'本地'}视频整理笔记，成功后原视频自动移入${TRASH}。`;
  if(i.delete_after_note){if(['failed','skipped'].includes(i.status)||i.retain_media)text='转换未完整完成，原视频已保留。可在收藏详情查看原因。';else if(i.status==='extracted')text=`笔记已保存，原视频将在运行收尾时移入${TRASH}；清理失败会在下次运行重试。`;else text=state.overview?.scheduler.loaded?`已加入待办，下次定时运行时整理笔记，成功后原视频自动移入${TRASH}。`:`已加入待办。自动整理已关闭，请开启自动安排或手动运行；成功后原视频自动移入${TRASH}。`;}
  return `<p class="muted" style="font-size:12.5px" data-video-note-hint>${esc(text)}</p>`;
}
// 已有笔记时下载视频只是多留一份，笔记不变。
const noteVideoQueued=i=>!!i.note_path&&i.processing_mode==='video'&&!['extracted','saved'].includes(i.status);
function videoKeepButton(i){return i.can_download_video?button(i.media_quality==='high'&&!i.media_deleted?'保留高清视频':'下载高清视频','quick-purpose',`data-id="${esc(i.id)}" data-purpose="video" ${i.pending_intents?'disabled':''}`,'sm'):'';}
function videoKeepHint(i){
  const line=text=>`<p class="muted" style="font-size:12.5px;margin-top:6px">${esc(text)}</p>`;
  if(noteVideoQueued(i))return line(i.status==='failed'?'高清视频下载未完成，笔记不受影响。':'已加入待办，下一轮下载高清视频，笔记继续留在知识库。');
  if(!i.can_download_video)return '';
  return `${i.platform==='bilibili'?`<div style="margin-top:8px">${qualityPicker(i)}</div>`:''}${i.pending_intents?`<p class="intent-note" style="margin-top:8px">${esc(intentLabel(i.pending_intents))}</p>`:line('下一轮运行时处理，笔记继续留在知识库。')}`;
}
const TRASH=serverMode?'回收站（7 天后自动清除）':'废纸篓';
const videoDeleteButton=i=>i.media_type!=='gallery'&&i.media_path&&!i.media_deleted?button('删除视频','delete-video',`data-id="${esc(i.id)}" data-idle ${busy()?'disabled':''}`,'quiet sm danger'):'';
async function playVideo(id){
  const epoch=++dialogEpoch;drawerId=null;
  openDialog(`<div class="player-loading">${empty('正在读取视频…')}</div>`,'player-dialog');
  try{
    const i=await api('item?'+query({id}));if(epoch!==dialogEpoch||!dialog.open)return;
    // 先按未知方向渲染，读到视频尺寸后切换横屏或竖屏布局；优先尝试原片，避免默认降画质。
    dialog.innerHTML=`<button type="button" class="player-close" data-action="close-dialog" aria-label="关闭">${ic('x',18)}</button><div class="player">
      <div class="screen"><img class="screen-poster" src="api/video-poster?id=${encodeURIComponent(id)}" alt=""><video class="local-video" controls playsinline preload="metadata" aria-label="${esc(titleOf(i))}" data-compatible="false"></video></div>
      <aside class="info">
        <div class="info-main"><div class="meta-line">${pf(i.platform)}<span>${esc(i.author||'未知作者')}</span><span>${esc(kindOf(i))}</span><span>${esc(mediaLabel(i))}</span></div>
          <h2 title="${esc(titleOf(i))}">${esc(titleOf(i))}</h2><p id="video-message" role="status" aria-live="polite">正在载入视频…</p></div>
        <div class="info-acts"><div class="row">${i.status==='review'?`${button(`${ic('video',14)}保存视频`,'quick-purpose',`data-id="${esc(id)}" data-purpose="video"`,'primary sm')}${button(`${ic('note',14)}知识笔记`,'quick-purpose',`data-id="${esc(id)}" data-purpose="note"`,'sm')}`:`${button(`${ic('bookmark',14)}加入素材箱`,'add-material',`data-id="${esc(id)}" data-kind="video"`,'primary sm')}${i.note_path||i.text_path?button(`${ic('note',14)}阅读笔记`,'read',`data-id="${esc(id)}"`,'sm'):''}${videoNoteButton(i)}`}</div>
          <div class="row secondary">${sourceA(i)}${button('收藏详情','detail',`data-id="${esc(id)}"`,'quiet sm')}${button('兼容播放','prepare-video',`data-id="${esc(id)}"`,'quiet sm')}${button('外部播放器','open',`data-id="${esc(id)}" data-kind="video"`,'quiet sm')}${i.status==='review'?'':videoDeleteButton(i)}</div>${i.status==='review'?'<p class="muted">收件箱预下载，还没有存进视频收藏。</p>':videoNoteHint(i)}</div>
      </aside></div>`;
    const v=dialog.querySelector('video');
    // 视频画面出来之前用按比例完整显示的封面占位，避免封面被拉伸裁切。
    v.addEventListener('loadeddata',()=>{dialog.querySelector('.screen-poster')?.remove();});
    v.addEventListener('loadeddata',()=>{if(epoch===dialogEpoch)videoMessage(v.dataset.compatible==='true'?'播放兼容副本 · 原视频保留':serverMode?'服务器保存的原视频':'本地原视频 · 无需上传');});
    v.addEventListener('error',()=>{if(epoch!==dialogEpoch||!dialog.open)return;if(v.dataset.compatible==='true')videoMessage('播放失败，可尝试外部播放器，或重新打开此视频。');else void preparePlayback(id,epoch);});
    restoreVideoAudio(v);v.src='api/video?'+query({id});void v.play().catch(()=>{});
  }catch(e){if(epoch===dialogEpoch&&dialog.open){dialog.className='modal';dialog.innerHTML=dialogHead('视频暂不可播放')+empty(e.message);}}
}
async function deleteVideo(id){
  if(!window.confirm(`把这个视频移入${TRASH}？笔记、文字稿和收藏记录会保留。`))return;
  const epoch=dialogEpoch;stopVideo();
  try{await api('video-delete',{id,confirm:true});}catch(error){if(epoch===dialogEpoch&&dialog.open)await playVideo(id);throw error;}
  if(epoch===dialogEpoch&&dialog.open)dialog.close();
  await refreshOverview();await reloadList();notice(`视频已移入${TRASH}，笔记、文字稿和收藏记录已保留。`);
}
async function queueVideoNote(id){
  const epoch=dialogEpoch;await api('video-to-note',{id});await refreshOverview();
  const i=await api('item?'+query({id}));
  if(dialog.open&&dialogEpoch===epoch){if(drawerId===id)await detail(id);else{const c=dialog.querySelector('[data-video-note-button]'),h=dialog.querySelector('[data-video-note-hint]');if(c)c.outerHTML=videoNoteButton(i);if(h)h.outerHTML=videoNoteHint(i);}}
  await reloadList();notice(state.overview.scheduler.loaded?'已加入待办，下次定时运行时转为笔记。':'已加入待办。自动整理已关闭，请开启自动安排或手动运行。');
}

// ── 素材箱 ──
const KIND_LABELS={note:['笔记','note'],excerpt:['摘录','excerpt'],video:['视频','video'],gallery:['图集','gallery'],post:['X 原帖','post']};
const MAT_STATUS=[['todo','待用','var(--blue)'],['using','在用','var(--amber)'],['used','已用','var(--accent)']];
function materialsPage(){return `<div class="page" id="mat-page">${empty('正在读取…')}</div>`;}
async function loadMaterials(){const epoch=pageEpoch;await ensureLibrary(true);if(epoch!==pageEpoch)return;renderMaterials();}
function renderMaterials(){
  const lib=state.library,sel=state.materials.topic,topics=lib.topics,t=topics.find(x=>String(x.id)===String(sel));
  if(sel!=='all'&&sel!=='none'&&!t)state.materials.topic='all';
  const mine=lib.materials.filter(m=>state.materials.topic==='all'||(state.materials.topic==='none'?m.topic_id===null:String(m.topic_id)===String(state.materials.topic)));
  const topicName=id=>topics.find(x=>x.id===id);
  const card=m=>{const s=m.source,tp=topicName(m.topic_id);return `<article class="mcard" data-action="material-open" data-id="${m.id}" tabindex="0">
    <span class="k">${ic(KIND_LABELS[m.kind][1],13)}${KIND_LABELS[m.kind][0]}<span>·</span>${s.missing?'':pf(s.platform,false)}${state.materials.topic==='all'&&tp?`<span style="margin-left:auto;color:${tp.color}">● ${esc(tp.name)}</span>`:''}</span>
    <b>${esc(s.title)}</b>
    ${m.excerpt?`<blockquote>${esc(m.excerpt)}</blockquote>`:m.kind==='note'&&s.gist?`<blockquote>${esc(s.gist)}</blockquote>`:''}
    ${(m.kind==='video'||m.kind==='gallery')&&s.has_media?`<span class="thumbrow">${cover(s)}${m.kind==='gallery'&&s.image_count?`<small style="align-self:center">共 ${s.image_count} 张</small>`:''}</span>`:''}
    ${m.memo?`<span class="memo">${esc(m.memo)}</span>`:''}
    ${m.usage.length?`<span class="used">${ic('check',13)} ${esc(m.usage.at(-1).channel)}${m.usage.at(-1).title?' · '+esc(m.usage.at(-1).title):''}</span>`:''}
    ${m.topic_id===null?`<span class="suggest" data-suggest="${m.id}" data-item="${esc(m.item)}"><small>正在找合适的选题…</small></span>`:''}
  </article>`;};
  const brief=state.materials.topic==='all'?'':state.materials.topic==='none'?`<section class="card topic-brief"><div style="flex:1"><h2><span class="sw" style="width:10px;height:10px;background:var(--faint)"></span>未归类</h2><p>收进来时没有选题的素材。卡片上有按标签和分类匹配的建议，点「放入」即可。</p></div></section>`:`<section class="card topic-brief"><div style="flex:1;min-width:0"><h2><span class="sw" style="width:10px;height:10px;background:${t.color}"></span>${esc(t.name)}</h2>${t.description?`<p>${esc(t.description)}</p>`:''}<div class="dest">${t.channels.map(c=>chip(esc(c),'blue')).join('')}${chip(`${mine.length} 条素材`)}${chip(`已用 ${mine.filter(m=>m.status==='used').length}`,'green')}</div></div><div class="row">${button('导出 Markdown','export-topic',`data-id="${t.id}"`,'sm')}${button('编辑','topic-edit',`data-id="${t.id}"`,'quiet sm')}</div></section>`;
  $('#mat-page').innerHTML=head('素材箱','从笔记、视频、图集、X 原帖里挑出来要用的东西，按选题归拢；写公众号、做视频时从这里取，外部服务也能通过接口读取',`<a class="btn" href="#api">${ic('link',14)}外部访问</a>${button(`${ic('spark',14)}新建选题`,'topic-edit','','primary')}`)+`<div class="mat">
    <nav class="card topic-nav" aria-label="选题"><div class="nav-label" style="padding:4px 10px 6px">选题</div>
      <button type="button" data-action="topic-select" data-value="all" aria-pressed="${state.materials.topic==='all'}"><span class="sw" style="background:var(--ink)"></span><span>全部素材</span><span>${lib.materials.length}</span></button>
      ${topics.map(x=>`<button type="button" data-action="topic-select" data-value="${x.id}" aria-pressed="${String(state.materials.topic)===String(x.id)}"><span class="sw" style="background:${x.color}"></span><span>${esc(x.name)}</span><span>${x.count}</span></button>`).join('')}
      <button type="button" data-action="topic-select" data-value="none" aria-pressed="${state.materials.topic==='none'}"><span class="sw" style="background:var(--faint)"></span><span>未归类</span><span>${lib.unsorted}</span></button>
      <button type="button" class="new" data-action="topic-edit">+ 新建选题</button>
      <div class="nav-label" style="padding:16px 10px 6px">类型</div>${Object.entries(KIND_LABELS).map(([k,[l,i]])=>`<button type="button" disabled style="opacity:1;cursor:default"><span style="color:var(--muted)">${ic(i,14)}</span><span>${l}</span><span>${lib.materials.filter(m=>m.kind===k).length}</span></button>`).join('')}
    </nav>
    <div>${brief}${lib.materials.length?`<div class="board">${MAT_STATUS.map(([st,l,c])=>{const list=mine.filter(m=>m.status===st);return `<section class="col"><div class="col-head"><span class="dot" style="color:${c}"></span>${l}<small>${list.length}</small></div>${list.map(card).join('')||'<p class="muted" style="font-size:12.5px;padding:8px">暂无</p>'}</section>`;}).join('')}</div>`:`<section class="card" style="padding:40px 24px;text-align:center"><h2 style="font-size:17px;font-weight:600">素材箱还是空的</h2><p class="muted" style="margin-top:6px;font-size:13px">在知识库阅读时点「加入素材箱」，或在视频、图集、X 原帖上收藏要用的内容。<br>选中正文里的一段文字再点，会收成一条摘录。</p></section>`}</div></div>`;
  void fillSuggestions();
}
async function fillSuggestions(){
  const epoch=pageEpoch;
  for(const el of root.querySelectorAll('[data-suggest]')){
    try{const {suggestions}=await api('suggest?'+query({id:el.dataset.item}));if(epoch!==pageEpoch||!el.isConnected)return;
      const best=suggestions[0],t=best&&state.library.topics.find(x=>x.id===best.topic_id);
      el.innerHTML=t?`<span>建议放入 <b style="font-size:12.5px">${esc(t.name)}</b><small>${esc(best.reason)}</small></span><span class="row">${button('放入','material-move',`data-id="${el.dataset.suggest}" data-topic="${t.id}"`,'accent sm')}</span>`:`<small>没有匹配的选题，点开卡片手动选择。</small>`;if(!t)el.className='';
    }catch{el.remove();}
  }
}
function materialDialog(id){
  const m=state.library.materials.find(x=>x.id===Number(id));if(!m)return;const s=m.source;
  openDialog(dialogHead('素材')+`<form class="dialog-body" id="material-form" data-id="${m.id}">
    <div><div class="row" style="margin-bottom:8px">${chip(KIND_LABELS[m.kind][0])}${s.missing?'':pf(s.platform)}<small>${esc(s.author||'')}</small></div><h2 class="title">${esc(s.title)}</h2></div>
    ${m.kind==='excerpt'?`<label class="field">摘录<textarea name="excerpt" rows="4" maxlength="4000">${esc(m.excerpt)}</textarea></label>`:''}
    <label class="field">选题<select name="topic_id"><option value="">未归类</option>${state.library.topics.map(t=>`<option value="${t.id}" ${t.id===m.topic_id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label>
    <div class="field">状态<div class="seg" role="radiogroup">${MAT_STATUS.map(([v,l])=>`<label style="display:contents"><input type="radio" name="status" value="${v}" ${m.status===v?'checked':''} hidden><span class="seg-opt" data-action="seg-radio" style="height:28px;padding:0 12px;border-radius:8px;display:inline-flex;align-items:center;font-size:12.5px;cursor:pointer;${m.status===v?'background:var(--surface);color:var(--ink);box-shadow:var(--shadow)':'color:var(--muted)'}">${l}</span></label>`).join('')}</div></div>
    <label class="field">备注<textarea name="memo" rows="3" maxlength="1000" placeholder="打算怎么用">${esc(m.memo)}</textarea></label>
    ${m.usage.length?`<div><h3>使用记录</h3>${m.usage.map(u=>`<p style="font-size:13px;margin-top:6px">${esc(fmt(u.at))} · ${esc(u.channel)}${u.title?' · '+esc(u.title):''}${u.url?` · <a class="link" href="${esc(u.url)}" target="_blank" rel="noopener noreferrer">链接</a>`:''}</p>`).join('')}</div>`:''}
    <div class="row">${s.missing?'':s.has_note&&['note','excerpt','post'].includes(m.kind)?button('阅读原笔记','read',`data-id="${esc(m.item)}"`,'sm'):''}${!s.missing&&m.kind==='video'&&s.has_media?button('播放视频','play-video',`data-id="${esc(m.item)}"`,'sm'):''}${!s.missing&&m.kind==='gallery'&&s.has_media?button('查看图集','view-gallery',`data-id="${esc(m.item)}"`,'sm'):''}${s.missing?'':sourceA(s)}</div>
    <div class="row" style="justify-content:space-between">${button('移出素材箱','material-delete',`data-id="${m.id}"`,'quiet danger')}<button class="btn primary">保存</button></div>
  </form>`,'modal');
}
async function addMaterialDialog(id,kind){
  const epoch=++dialogEpoch;drawerId=null;const selection=state.selection;
  await ensureLibrary();
  const {suggestions}=await api('suggest?'+query({id})).catch(()=>({suggestions:[]}));
  if(epoch!==dialogEpoch)return;
  const best=suggestions[0]?.topic_id??null,topics=state.library.topics;
  const kinds=[[kind,KIND_LABELS[kind][0]==='笔记'?'整篇笔记':KIND_LABELS[kind][0]==='X 原帖'?'整条原帖':KIND_LABELS[kind][0]==='视频'?'原视频':'整组图集'],...(selection&&['note','post'].includes(kind)?[['excerpt','选中的段落']]:[])];
  openDialog(dialogHead('加入素材箱')+`<form class="dialog-body" id="add-material-form" data-id="${esc(id)}">
    <div class="field">放进哪个选题<div class="opts" id="topic-opts">${topics.map(t=>`<button type="button" data-action="pick" data-value="${t.id}" aria-pressed="${t.id===best}">${esc(t.name)}${t.id===best?'<span class="sug">建议</span>':''}</button>`).join('')}<button type="button" data-action="pick" data-value="" aria-pressed="${best===null}">先不归类</button></div>${suggestions[0]?`<small>${esc(suggestions[0].reason)}</small>`:''}<input name="new_topic" maxlength="40" placeholder="+ 新选题：输入名称，加入时一并创建" style="margin-top:4px"></div>
    <div class="field">收什么<div class="opts" id="kind-opts">${kinds.map(([v,l],n)=>`<button type="button" data-action="pick" data-value="${v}" aria-pressed="${selection&&v==='excerpt'?true:n===0&&!(selection&&kinds.length>1)}">${l}</button>`).join('')}</div>${selection&&kinds.length>1?`<small>已选中：${esc(selection.slice(0,80))}${selection.length>80?'…':''}</small>`:''}</div>
    <label class="field">备注<textarea name="memo" rows="2" maxlength="1000" placeholder="打算怎么用（可选）"></textarea></label>
    <div class="row" style="justify-content:flex-end">${button('取消','close-dialog','','quiet')}<button class="btn primary">加入</button></div>
  </form>`,'modal');
  dialog.querySelector('#add-material-form').dataset.selection=selection;
}
function exportTopic(id){
  const t=state.library.topics.find(x=>x.id===Number(id)),list=state.library.materials.filter(m=>m.topic_id===t.id);
  const md=[`# ${t.name}`,t.description?`\n${t.description}`:'',t.channels.length?`\n发布渠道：${t.channels.join('、')}`:'',...MAT_STATUS.map(([st,l])=>{const part=list.filter(m=>m.status===st);return part.length?`\n## ${l}\n\n`+part.map(m=>[`### ${m.source.title}`,`- 类型：${KIND_LABELS[m.kind][0]} · 来源：${PLATFORM_LABELS[m.source.platform]||''} ${m.source.missing?'':sourceLink(m.source)}`,m.excerpt?`\n> ${m.excerpt.replace(/\n/g,'\n> ')}`:'',m.memo?`\n备注：${m.memo}`:'',...m.usage.map(u=>`- 已用：${u.channel} ${u.title} ${u.url}`.trim())].filter(Boolean).join('\n')).join('\n\n'):'';})].filter(Boolean).join('\n')+'\n';
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([md],{type:'text/markdown'}));a.download=`${t.name}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
function topicDialog(id){
  const t=id?state.library.topics.find(x=>x.id===Number(id)):null;
  openDialog(dialogHead(t?'编辑选题':'新建选题')+`<form class="dialog-body" id="topic-form" data-id="${t?.id||''}"><label class="field">名称<input name="name" maxlength="40" required value="${esc(t?.name||'')}" placeholder="例如：AI 做视频的几条路"></label><label class="field">说明<textarea name="description" rows="3" maxlength="500" placeholder="打算写什么、怎么用">${esc(t?.description||'')}</textarea></label><label class="field">发布渠道（逗号分隔）<input name="channels" maxlength="120" value="${esc(t?.channels.join('，')||'')}" placeholder="公众号，视频"></label><div class="row" style="justify-content:space-between">${t?button('删除选题','topic-delete',`data-id="${t.id}"`,'quiet danger'):'<span></span>'}<button class="btn primary">保存</button></div></form>`,'modal');
}

// ── 收藏记录与详情 ──
function collectionPage(){
  const s=state.collection,o=state.overview;
  return `<div class="page">${head('收藏记录',`全部 ${o.total} 条收藏的处理账本 · 最近同步 ${esc(fmt(o.baseline?.scanned_at))}`,button('刷新','refresh'))}
  <div class="toolbar"><div class="seg">${[['all',`全部 ${o.total}`],['review',`待确认 ${o.review}`],['failed',`失败 ${o.failed}`],['saved',`已保存 ${o.saved||0}`],['pending','排队']].map(([v,l])=>`<button type="button" data-action="collection-filter" data-value="${v}" aria-pressed="${s.status===v}">${l}</button>`).join('')}</div>
  <select id="collection-platform" aria-label="收藏平台"><option value="all">全部平台</option>${Object.entries(PLATFORM_LABELS).map(([k,l])=>`<option value="${k}" ${s.platform===k?'selected':''}>${l}</option>`).join('')}</select>
  <select id="collection-status" aria-label="更多状态"><option value="all">更多状态</option>${Object.entries(STATUSES).map(([k,l])=>`<option value="${k}" ${s.status===k?'selected':''}>${l}</option>`).join('')}<option value="baseline" ${s.status==='baseline'?'selected':''}>历史基线</option></select>
  ${searchField(s.q,'搜索标题、作者或作品 ID','collection-search')}</div><div id="collection-list">${empty('正在读取…')}</div></div>`;
}
async function loadCollection(){
  const epoch=++listEpoch,page=pageEpoch,s=state.collection;
  const data=await api('items?'+query({size:15,q:s.q,status:s.status,page:s.page,platform:s.platform}));if(epoch!==listEpoch||page!==pageEpoch)return;
  s.data=data;s.page=data.page;
  $('#collection-list').innerHTML=data.items.length?`<div class="card table-wrap"><table class="table"><thead><tr><th>收藏内容</th><th>用途</th><th>媒体现状</th><th>来源</th><th>结果</th><th aria-label="操作"></th></tr></thead><tbody>${data.items.map(i=>`<tr><td><button type="button" class="item-title" data-action="detail" data-id="${esc(i.id)}">${esc(titleOf(i))}</button><small>${esc(i.author||'未知作者')} · ${esc(kindOf(i))}</small>${i.last_error?`<span class="cell-error">${esc(i.last_error)}</span>`:''}</td><td>${esc(i.media_type==='gallery'?'图集':i.media_type==='post'?'X 原帖':PURPOSES[i.processing_mode]||'尚未分流')}${i.routing_preview?`<span class="suggestion">建议：${esc(PURPOSES[i.routing_preview.purpose]||i.routing_preview.purpose)} · 未应用</span>`:''}</td><td class="muted">${esc(mediaLabel(i))}</td><td>${pf(i.platform)}</td><td>${['failed','review'].includes(i.status)&&(i.note_path||i.text_path)?tag(STATUSES[i.status],i.status==='failed'?'danger':'warn')+' ':''}${tag(resultLabel(i),i.status==='failed'?'danger':i.status==='review'?'warn':i.note_path||i.status==='saved'?'green':'')}${i.skip_reason?`<small>${esc(REASONS[i.skip_reason]||i.skip_reason)}</small>`:''}</td><td>${i.media_type==='gallery'&&i.status==='saved'?button('查看','view-gallery',`data-id="${esc(i.id)}"`,'quiet sm'):i.note_path||i.text_path?button('阅读','read',`data-id="${esc(i.id)}"`,'quiet sm'):button('详情','detail',`data-id="${esc(i.id)}"`,'quiet sm')}</td></tr>`).join('')}</tbody></table></div>${pagination(data,'collection')}`:empty(s.q?'没有找到匹配的收藏':'这个筛选下还没有收藏');
}
function journey(i){
  const step=(done,title,at,cls='')=>`<div class="j ${done?cls:'todo'}"><span class="b">${done?ic(cls==='err'?'x':cls==='warn'?'alert':'check',12):''}</span><span><b>${title}</b><small>${at||''}</small></span></div>`;
  const both=i.processing_mode==='video'&&!!i.note_path,saving=i.processing_mode==='video'||i.media_type==='gallery';
  const purpose=i.media_type==='gallery'?'图集':i.media_type==='post'?'X 原帖':both?'知识笔记和视频':PURPOSES[i.processing_mode];
  return `<div class="journey">${step(true,'收藏进来',fmt(i.collected_at||i.first_seen))}${step(!!i.processing_mode||i.media_type==='gallery'||i.media_type==='post',i.status==='review'?'等你决定用途':`用途：${purpose||'尚未判断'}`,i.routing_source==='manual'?'你手动选择':i.routing_source==='model'?'模型判断':'',i.status==='review'?'warn':'')}${!saving||both?step(!!i.transcribed_at,'转写成文字',fmt(i.transcribed_at))+step(!!i.extracted_at,'整理成笔记',fmt(i.extracted_at)):''}${saving?step(i.status==='saved','保存媒体',fmt(i.saved_at)):''}${i.status==='failed'?step(true,'处理失败',i.last_error||'','err'):''}</div>`;
}
async function detail(id){
  drawerId=id;const epoch=++dialogEpoch;
  openDialog(dialogHead('收藏详情')+empty('正在读取…'),'drawer');
  try{
    const i=await api('item?'+query({id}));if(epoch!==dialogEpoch||!dialog.open)return;
    const attrs=`data-id="${esc(id)}" data-idle ${busy()?'disabled':''}`;
    const materialKind=i.media_type==='gallery'?'gallery':i.media_type==='post'?'post':i.note_path?'note':i.media_path&&!i.media_deleted?'video':null;
    dialog.innerHTML=dialogHead('收藏详情')+`<div class="dialog-body">
      ${i.media_type==='post'?'':cover(i,{badge:kindOf(i),pfb:true,ratio:'16/9'})}
      <div><h2 class="title">${esc(titleOf(i))}</h2><p class="muted" style="font-size:12.5px;margin-top:4px">${esc(i.author||'未知作者')} · ${esc(PLATFORM_LABELS[i.platform]||'')} · ${esc(kindOf(i))}</p><div class="row" style="margin-top:10px">${tag(STATUSES[i.status]||i.status,i.status==='failed'?'danger':i.status==='review'?'warn':'')}${tag(mediaLabel(i))}</div></div>
      <section><h3 style="margin-bottom:10px">处理经过</h3>${journey(i)}</section>
      <section><h3 style="margin-bottom:8px">留下的内容</h3><div class="row">${i.note_path||i.text_path?button('阅读','read',`data-id="${esc(id)}"`,'sm'):''}${i.media_path&&!i.media_deleted?button(i.media_type==='gallery'?'查看图集':'播放视频',i.media_type==='gallery'?'view-gallery':'play-video',`data-id="${esc(id)}"`,'sm'):''}${materialKind?button('加入素材箱','add-material',`data-id="${esc(id)}" data-kind="${materialKind}"`,'sm'):''}${sourceA(i)}${videoNoteButton(i)}${videoKeepButton(i)}${videoDeleteButton(i)}</div>${videoNoteHint(i)}${videoKeepHint(i)}${!i.note_path&&!i.text_path&&i.media_type!=='gallery'?'<p class="muted" style="font-size:12.5px;margin-top:6px">暂未生成文字内容。</p>':''}</section>
      ${i.media_type==='gallery'||i.media_type==='post'||['extracted','saved'].includes(i.status)||noteVideoQueued(i)?'':`<section><h3 style="margin-bottom:6px">这条收藏用来做什么</h3><p class="muted" style="font-size:12.5px">${esc(i.routing_reason||'用途决定接下来保留视频还是提取知识。')}</p>${i.routing_preview?`<div class="callout">建议：${esc(PURPOSES[i.routing_preview.purpose]||i.routing_preview.purpose)}，尚未应用。${esc(i.routing_preview.reason||'')}</div>`:''}<form id="purpose-form" style="margin-top:10px"><input type="hidden" name="id" value="${esc(id)}"><div class="purpose-options">${['note','video','review'].map(k=>`<label><input type="radio" name="purpose" value="${k}" ${i.processing_mode===k?'checked':''} ${i.can_change_purpose?'':'disabled'} required><span>${PURPOSES[k]}<small>${({note:'转写并整理笔记',video:'只保存高清原声视频',review:'暂不处理，等你确认'})[k]}</small></span></label>`).join('')}</div>${i.platform==='bilibili'&&i.can_change_purpose?`<div style="margin-top:10px">${qualityPicker(i)}</div>`:''}${i.can_change_purpose?`<div class="row" style="margin-top:10px"><button class="btn primary sm">保存用途</button><small>下一轮运行时处理；已有文件保留。</small></div>${i.pending_intents?`<p class="intent-note" style="margin-top:8px">${esc(intentLabel(i.pending_intents))}</p>`:''}`:'<p class="muted" style="font-size:12.5px;margin-top:8px">这条收藏不在可修改用途的处理范围内。</p>'}</form></section>`}
      ${i.last_error?`<section class="callout danger"><b>上次未完成</b><p style="margin-top:4px">${esc(i.last_error)}</p>${i.status==='failed'?`<div style="margin-top:8px">${button('恢复为待办','retry',attrs,'sm')}</div>`:''}</section>`:''}
      ${i.can_discard||i.can_delete||i.skip_reason==='user_discarded'?`<section><h3 style="margin-bottom:6px">处理操作</h3><p class="muted" style="font-size:12.5px">${noteVideoQueued(i)?'取消后这条回到知识笔记，已有文件不动。':i.skip_reason==='user_discarded'?'已放弃处理。重新选择用途并保存即可恢复。':'放弃处理会停止自动处理，保留收藏记录和本地文件。'}${i.can_delete?' 删除记录会从列表移除，不取消原平台收藏。':''}</p><div class="row" style="margin-top:8px">${i.can_discard?button(noteVideoQueued(i)?'取消下载':'放弃处理',noteVideoQueued(i)?'cancel-video':'discard-item',`data-id="${esc(id)}"`,'quiet sm danger'):''}${i.can_delete?button('删除记录','delete-item',attrs,'quiet sm danger'):''}</div></section>`:''}
      <details><summary>作品信息</summary><dl class="kv" style="font-size:12.5px"><dt>来源</dt><dd>${esc(PLATFORM_LABELS[i.platform]||'抖音')}${i.folders?` · ${esc(JSON.parse(i.folders).join('、'))}`:''}</dd><dt>作品 ID</dt><dd class="mono">${esc(id)}</dd><dt>处理状态</dt><dd>${esc(STATUSES[i.status]||i.status)}</dd><dt>跳过原因</dt><dd>${esc(REASONS[i.skip_reason]||i.skip_reason||'无')}</dd><dt>更新时间</dt><dd>${esc(fmt(i.updated_at))}</dd><dt>AI 费用</dt><dd data-cost="item">读取中…</dd></dl></details>
    </div>`;
    void fillItemCost(id,epoch);
  }catch(e){if(epoch===dialogEpoch&&dialog.open)dialog.innerHTML=dialogHead('收藏详情')+empty(e.message);}
}
async function stopProcessing(action,id,keepNote=false){
  if(action==='delete-item'&&!window.confirm('删除这条收藏记录？只会从列表移除，不会取消原平台收藏；此操作不可恢复。'))return;
  if(action==='discard'&&!window.confirm(keepNote?'取消下载高清视频？笔记不受影响。':'放弃处理这条收藏？记录和已有文件会保留，之后仍可重新选择用途。'))return;
  const epoch=dialogEpoch,r=await api(action,{id});
  if(r.deferred){await refreshOverview();await reloadList();notice(`当前正在运行，已记下“${keepNote?'取消下载':'放弃处理'}”，本轮结束后生效。`);return;}
  if(dialog.open&&epoch===dialogEpoch&&drawerId===id){if(action==='delete-item')dialog.close();else await detail(id);}
  await refreshOverview();await reloadList();
  notice(keepNote?'已取消下载，笔记不受影响。':action==='discard'?'已放弃处理，记录和文件保留；可在收藏详情重新选择用途恢复。':'记录已从列表移除，再次扫描不会重新处理；原平台收藏保持不变。');
}
async function queueMutation(path,data){
  const r=await api(path,data);
  if(r.deferred){await refreshOverview();await reloadList();notice('当前正在运行，已记下这个选择，本轮结束后生效。');return;}
  notice(path==='purpose'?'正在保存用途…':'正在恢复待办…');
  const expected=r.startedAt,originalDrawer=dialogEpoch;
  for(let n=0;n<20;n++){
    await new Promise(resolve=>setTimeout(resolve,200));await refreshOverview();
    const current=state.overview.execution;
    if(current.lastAction?.startedAt===expected){
      if(current.lastAction.exitCode!==0)throw new Error('操作未完成，请在「流水线 → 运行记录 → 控制台操作」查看原因。');
      let message=path==='purpose'?'用途已保存，下一轮运行时处理。':'已恢复为待办，下一轮运行时处理。';
      // 收件箱预下载过的视频选“保存视频”会直接存好，选“知识笔记”下一轮不用重新下载。
      if(path==='purpose'){try{const i=await api('item?'+query({id:data.id}));if(i.status==='saved')message='已存进视频收藏。';else if(i.status==='pending'&&i.note_path)message='已加入待办，下一轮下载高清视频，笔记保留。';else if(i.status==='downloaded')message='用途已保存，下一轮直接用已下载的视频整理笔记。';}catch{}}
      notice(message);
      await reloadList();if(dialog.open&&originalDrawer===dialogEpoch&&drawerId===data.id)await detail(data.id);return;
    }
  }
  notice('操作仍在执行，可在运行记录中查看结果。');
}

// ── 流水线：运行、队列、来源、自动安排、运行记录 ──
function executionPanel(){
  const o=state.overview,e=o.execution,last=runSummary(o.lastRun),r=o.lastRun?.result;
  const kinds={run:'本轮整理',retry:'恢复待办',purpose:'保存用途',discard:'放弃处理','delete-item':'删除记录',login:'扫码登录','session-check':'登录检查','bili-login':'B站扫码登录','bili-session-check':'B站登录检查',quality:'保存画质','apply-intents':'执行记下的操作','video-to-note':'转为笔记','video-delete':'删除视频'};
  if(e.running)return `<section class="card live active"><div class="row"><span class="pulse"></span><b style="font-weight:600">正在执行${esc(kinds[e.kind]||'任务')}</b><small>开始于 ${esc(fmt(e.startedAt))}${e.owned?'':' · 由其他入口启动'}</small><span style="margin-left:auto" class="row">${e.owned?button('停止本轮','stop','','sm'):''}<a class="btn quiet sm" href="#history">查看记录 ›</a></span></div><p class="muted" style="font-size:12.5px">可以离开这个页面，运行会在后台继续；结束后笔记、视频和图集会出现在对应栏目。</p></section>`;
  return `<section class="card live"><div class="row">${chip('<span class="dot"></span>空闲')}<b style="font-weight:600">${o.lastRun?`上一轮 ${esc(fmt(o.lastRun.modifiedAt))} · ${esc(last.label)}`:'还没有运行过'}</b>${last.detail&&o.lastRun?`<small>${esc(last.detail).slice(0,120)}</small>`:''}<span style="margin-left:auto" class="row">${button('只继续已有待办','manual-run','data-noscan="1" data-idle','sm')}${button(`${ic('play',14)}运行一轮`,'manual-run','data-idle','primary sm')}</span></div>
    ${r?`<div class="steps">${[['新收藏',r.added??'—','扫描到的新增'],['待确认',r.review??0,'交给你决定'],['保存媒体',(r.saved||0)+(r.galleries||0),`视频 ${r.saved||0} · 图集 ${r.galleries||0}`],['整理笔记',r.notes??0,`剩余待办 ${r.pending??'—'}`]].map(([l,v,s])=>`<div class="step"><small>${l}</small><strong>${esc(v)}</strong><small>${esc(s)}</small></div>`).join('')}</div>`:''}</section>`;
}
function pipelinePage(){return `<div class="page">${head('流水线','三个来源同一个定时、同一轮运行；扫描、登录、每日额度和风控暂停各自独立')}<div id="run-status">${executionPanel()}</div><section class="card" style="margin-bottom:20px" id="queue">${empty('正在读取队列…')}</section><div id="sources-anchor"></div><div class="sources" id="sources"></div><div id="login-flow"></div><form id="settings-form" class="card card-pad" style="margin-bottom:20px"><details><summary>来源设置：登录提醒、B站收藏夹与用途</summary><div id="account-fields"></div><div class="row" style="margin-top:12px"><button class="btn primary sm">保存来源设置</button><small>新配置从下一轮处理开始生效。</small></div></details></form><div class="split2"><div id="schedule-anchor">${scheduleCard()}</div><section class="card history" id="history-anchor"><div class="list" id="run-list"></div><div class="h-detail" id="log-detail">${empty('正在读取…')}</div></section></div></div>`;}
async function loadPipeline(section){
  const epoch=pageEpoch;
  const [queue,runs,settings]=await Promise.all([api('queue'),api('runs'),api('settings')]);if(epoch!==pageEpoch)return;
  const o=state.overview;state.settings=settings;state.runs=runs.runs;state.runId=state.runs.some(r=>r.id===state.runId)?state.runId:state.runs[0]?.id;
  $('#queue').innerHTML=`<div class="sec-head" style="padding:16px 18px 6px;margin:0"><h2>下一轮会处理</h2><span class="sub">排队 ${o.pending} 条 · 按实际处理顺序${o.pending>10?' · 显示前 10 条':''} · 今日剩余额度 ${Math.max(0,(o.policy.totalDaily||o.policy.daily)-o.usedToday)} 条</span></div>${queue.items.length?queue.items.map((i,n)=>`<div class="decide-row" style="padding:11px 18px;border-top:1px solid var(--line)"><small class="num" style="width:22px">${String(n+1).padStart(2,'0')}</small><span class="t"><button type="button" class="item-title" data-action="detail" data-id="${esc(i.id)}">${esc(titleOf(i))}</button><small>${esc(i.author||'未知作者')} · ${esc(kindOf(i))}</small></span>${pf(i.platform)}<small>${esc(i.media_type==='gallery'?'图集':PURPOSES[i.processing_mode]||'等待判断')}</small>${tag(STATUSES[i.status]||i.status)}</div>`).join(''):`<p class="muted" style="padding:6px 18px 18px;font-size:13px">当前没有等待自动处理的收藏。</p>`}${!o.baseline?'<div class="callout" style="margin:0 18px 18px">第一次运行只建立历史收藏参照，不下载历史视频。之后处理新收藏。</div>':''}`;
  $('#account-fields').innerHTML=sectionFields('登录提醒',SETTINGS.account.slice(0,1))+sectionFields('B站收藏',SETTINGS.account.slice(1),'只处理起始日期之后收藏的视频，存量不处理。默认跟踪自己创建的全部收藏夹；收藏夹可以用 ID 或完整标题指定。')+biliFolders(o.bilibili);
  schedulePreview();runRows();await loadSession();await loadLog();
  const anchor={schedule:'#schedule-anchor',history:'#history-anchor',sources:'#sources-anchor'}[section];if(anchor)$(anchor)?.scrollIntoView({block:'start'});
}
function sourceCard(platform,s){
  const bili=platform==='bilibili',o=state.overview,attr=bili?' data-platform="bilibili"':'';
  const status=bili&&!o.bilibili.enabled?tag('未启用'):tag(s.online==='verified'?'上次验证可用':s.online==='login_required'||s.level==='expired'?'需要重新登录':'尚未在线确认',s.online==='verified'?'green':'warn');
  return `<section class="card source"><div class="h"><span class="logo" style="background:var(--${bili?'bili':'dy'})">${bili?'B':'抖'}</span><span><b>${bili?'B站收藏夹':'抖音收藏'}</b><small>${bili?'登录 Cookie 直连接口 · 字幕优先':'无界面 Chrome 读取收藏列表'}</small></span>${status}</div>
    <div class="stats"><div><small>登录有效期</small><strong title="${esc(remainingLabel(s))}">${esc(remainingLabel(s).replace('剩余约 ',''))}</strong></div><div><small>最近检查</small><strong>${esc(fmt(s.last_check_at))}</strong></div><div><small>今日额度</small><strong>${bili?`${o.bilibili.usedToday}/${o.bilibili.daily}`:`${o.usedByPlatform?.douyin||0}/${o.policy.daily}`}</strong></div></div>
    ${!bili&&o.lastRun?.result?.pausedPlatforms?.douyin?`<div class="note-box amber">${esc(o.lastRun.result.pausedPlatforms.douyin)}</div>`:''}
    ${bili&&!o.bilibili.enabled?'<p class="note-box">只处理启用之后的新收藏，存量不登记。新收藏默认进收件箱，由你选用途和画质；有 CC 字幕时不调用转写。在下方「来源设置」里开启。</p>':'<p class="muted" style="font-size:12px">有效期按凭据估算；是否可用以在线验证为准。</p>'}
    <div class="row" style="margin-top:auto">${button('立即检查','check-session',`data-idle${attr} ${busy()?'disabled':''}`,'sm')}${button('扫码登录','login',`data-idle${attr} ${busy()?'disabled':''}`,'primary sm')}</div></section>`;
}
function xCard(x){
  if(!x)return '';
  const status=!x.configured?tag('尚未配置应用','warn'):!x.connected?tag('尚未连接','warn'):x.online==='login_required'?tag('需要重新连接','warn'):tag('已连接','green');
  const tip=!x.configured?'先在 dustoff.conf 中填写 X 应用的 DUST_X_CLIENT_ID 和 DUST_X_CLIENT_SECRET。':x.enabled?'与抖音、B站同一轮运行。首次读入全部书签，之后只读新增的。':'已关闭处理；在配置中设置 DUST_X_ENABLED=1 后开始处理书签。';
  return `<section class="card source"><div class="h"><span class="logo" style="background:var(--x);color:var(--bg)">𝕏</span><span><b>X 书签</b><small>官方接口 · 只读授权${x.username?' · @'+esc(x.username):''}</small></span>${status}</div><div class="stats"><div><small>最近验证</small><strong>${esc(fmt(x.onlineCheckedAt))}</strong></div><div><small>最近扫描</small><strong>${esc(fmt(x.scannedAt))}</strong></div><div><small>今日额度</small><strong>${x.usedToday}/${x.daily}</strong></div></div><p class="note-box ${x.connected?'':'blue'}">${esc(tip)}${x.scannedAt?(x.complete?' 已读入全部书签。':' 下轮完整读取。'):''}</p><div class="row" style="margin-top:auto">${button(x.connected?'重新连接':'连接 X','x-connect',`data-idle ${busy()||!x.configured?'disabled':''}`,'primary sm')}</div></section>`;
}
async function loadSession(){
  const epoch=pageEpoch,data=await api('session');if(epoch!==pageEpoch||state.route!=='pipeline')return;
  // 不重建来源设置表单，避免轮询覆盖未保存的输入。
  const cards=sourceCard('douyin',data.session)+xCard(data.x)+sourceCard('bilibili',data.bilibili.session),flow=loginFlow(data);
  if($('#sources').innerHTML!==cards)$('#sources').innerHTML=cards;
  if($('#login-flow').innerHTML!==flow)$('#login-flow').innerHTML=flow;
}
function biliFolders(b){
  if(!b.folders.length)return `<p class="muted" style="font-size:12.5px">${b.enabled?'登录并运行一次后，这里会列出你的收藏夹。':'开启“处理 B站收藏”并登录后，这里会列出你的收藏夹。'}</p>`;
  return `<section class="settings-section"><h2>B站收藏夹</h2><p class="muted">起始时间 ${esc(fmt(b.startAt))} · 最近扫描 ${esc(fmt(b.scannedAt))} · 今日已处理 ${b.usedToday}/${b.daily} 条</p><div class="table-wrap"><table class="table"><thead><tr><th>收藏夹</th><th>ID</th><th>条数</th><th>跟踪</th></tr></thead><tbody>${b.folders.map(f=>`<tr><td>${esc(f.title)}</td><td class="mono">${esc(f.id)}</td><td>${f.count}</td><td>${f.tracked?tag('跟踪中','green'):tag('未跟踪')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function scheduleCard(){
  const s=state.overview.scheduler;
  if(s.error)return `<section class="card card-pad"><div class="sec-head"><h2>自动安排</h2></div><div class="callout">${esc(s.error)}</div>${button('重试','refresh','','sm')}</section>`;
  return `<form class="card card-pad" id="schedule-form"><div class="sec-head"><h2>自动安排</h2>${tag(s.loaded?'已开启':'已关闭',s.loaded?'green':'')}<span style="margin-left:auto">${button(s.loaded?'关闭':'开启','schedule-toggle',`data-value="${s.loaded?'stop':'start'}" ${s.running?'disabled':''}`,s.loaded?'sm':'primary sm')}</span></div>${s.warning?`<div class="callout">${esc(s.warning)}</div>`:''}
    <label class="form-row"><span>起始时间<small>按${serverMode?'服务器':'本机'}时区 ${esc(s.timezone||'')}</small></span><input name="time" type="time" value="${esc(s.time)}" required></label>
    <label class="form-row"><span>重复间隔<small>从起始时间起，每隔这些小时运行</small></span><span class="row"><input name="intervalHours" aria-label="重复间隔小时" type="number" min="1" max="720" value="${s.intervalHours}" required>小时</span></label>
    <label class="form-row"><span>${serverMode?'服务器重启后自动启用':'登录电脑后自动启用'}<small>${serverMode?'无需保持浏览器开着':'关机或注销后，在下次登录时加载安排'}</small></span><input class="toggle" name="autoStartAfterReboot" type="checkbox" ${s.autoStartAfterReboot?'checked':''}></label>
    <div class="nav-label" style="padding:14px 0 4px">接下来三次</div><div id="schedule-preview"></div>
    <div class="row" style="margin-top:12px"><button class="btn primary sm">保存安排</button><small>${s.loaded?'保存后立即更新':'关闭时只保存配置'}</small></div></form>`;
}
function schedulePreview(){
  const form=$('#schedule-form');if(!form)return;
  try{const data=new FormData(form),saved=state.overview.scheduler,time=data.get('time'),intervalHours=Number(data.get('intervalHours'));
    const unchanged=time===saved.time&&intervalHours===saved.intervalHours,plan=makePlan({time,intervalHours,startAt:unchanged?saved.startAt||null:null}),start=Date.parse(nextOccurrence(plan));
    $('#schedule-preview').innerHTML=Array.from({length:3},(_,n)=>`<div class="upcoming"><span class="muted">${n===0?'下一次':'然后'}</span><b class="num" style="font-weight:500">${esc(fmt(start+n*intervalHours*3600000))}</b></div>`).join('');
  }catch(e){$('#schedule-preview').textContent=e.message;}
}
const codeOf=r=>{const s=runSummary(r);return s.tone==='green'?['green','0']:s.tone==='danger'?['danger','!']:s.tone==='warn'?['warn','‖']:['muted','?'];};
function runRows(){
  const list=state.logKind==='business'?state.runs:[];const pages=Math.max(1,Math.ceil(list.length/8));state.runPage=Math.min(state.runPage,pages);
  $('#run-list').innerHTML=`<div class="seg" style="margin:2px 2px 8px">${[['business','整理批次'],['scheduler','定时输出'],['console','控制台操作']].map(([v,l])=>`<button type="button" data-action="log-kind" data-value="${v}" aria-pressed="${state.logKind===v}">${l}</button>`).join('')}</div>`+(state.logKind!=='business'?'<p class="muted" style="font-size:12.5px;padding:8px">显示最近一次的完整输出。</p>':list.slice((state.runPage-1)*8,state.runPage*8).map(r=>{const [tone,mark]=codeOf(r);return `<button type="button" class="h-item" data-action="select-run" data-id="${esc(r.id)}" aria-pressed="${r.id===state.runId}"><span class="code ${tone}">${mark}</span><span><b class="num" style="font-weight:500">${esc(fmt(r.modifiedAt))}</b><small>${esc(runSummary(r).label)} · ${r.id.endsWith('-console-action')?'收藏操作':r.id.endsWith('-run')?'日常整理':esc(r.id.split('-').at(-1))}</small></span></button>`;}).join('')+(list.length?pagination({page:state.runPage,pages,total:list.length,size:8},'runs'):empty('还没有运行记录')));
}
async function loadLog(){
  const epoch=++logEpoch,page=pageEpoch;
  if(state.logKind==='business'&&!state.runId){$('#log-detail').innerHTML=empty('开始运行后，可在这里查看结果。');return;}
  $('#log-detail').innerHTML=empty('正在读取记录…');
  try{const data=await api('log?'+query({kind:state.logKind,id:state.runId||''}));if(epoch!==logEpoch||page!==pageEpoch)return;
    const summary=runSummary(data),r=data.result;
    $('#log-detail').innerHTML=state.logKind!=='business'?`<h2 style="font-size:15px;font-weight:600">${state.logKind==='console'?'控制台最近操作':'定时最近输出'}</h2><pre class="log">${esc(data.log||'暂无日志')}</pre>`:`<div class="row"><span class="code ${codeOf(data)[0]}">${codeOf(data)[1]}</span><h2 style="font-size:16px;font-weight:600">${esc(summary.label)}</h2>${tag(({daily:'日常整理',baseline:'历史基线'})[r?.mode]||'批次记录')}<small class="mono" style="margin-left:auto">${esc(data.id)}</small></div>${summary.detail?`<div class="callout ${summary.tone==='green'?'green':summary.tone==='danger'?'danger':''}">${esc(summary.detail)}</div>`:''}${r?`<div class="nums">${[['processed','处理'],['notes','笔记'],['saved','视频'],['galleries','图集'],['pending','剩余待办']].map(([k,l])=>`<div><strong>${typeof r[k]==='number'?r[k]:'—'}</strong><small>${l}</small></div>`).join('')}</div>`:''}${r?.scanWarning&&summary.detail!==r.scanWarning?`<div class="callout">${esc(r.scanWarning)}</div>`:''}${r?.failures?.length?`<ul class="failure-list">${r.failures.map(f=>`<li>${esc(f.id?f.id+'：':'')}${esc(f.error||'处理失败')}</li>`).join('')}</ul>`:''}${runEvents(data.log)}<details ${!r?'open':''}><summary>查看执行日志</summary><pre class="log">${esc(data.log||'暂无日志')}</pre></details>${r?`<details><summary>查看完整运行数据</summary><pre class="log">${esc(JSON.stringify(r,null,2))}</pre></details>`:''}`;
  }catch(e){if(epoch===logEpoch&&page===pageEpoch)$('#log-detail').innerHTML=empty(e.message);}
}
function runEvents(log=''){
  const events=log.split('\n').map(line=>line.match(/^\[([^\]]+)\]\s*(.+)$/)).filter(m=>m&&/扫描|新增|完成|失败|结束|暂停|保存|基线|恢复|用途|放弃|删除/.test(m[2])).slice(-8);
  return events.length?`<div class="timeline">${events.map(([,time,message])=>`<div class="tl ${/失败|异常/.test(message)?'err':/暂停|受阻/.test(message)?'warn':''}"><time>${esc(time.match(/\d{2}:\d{2}(?::\d{2})?/)?.[0]||time)}</time><span class="d"></span><span>${esc(message.slice(0,300))}</span></div>`).join('')}</div>`:'';
}
function manualRun(noScan=false){
  const o=state.overview;drawerId=null;++dialogEpoch;
  openDialog(dialogHead('运行一轮')+`<form id="run-form" class="dialog-body"><p class="muted" style="font-size:13px">${o.baseline?`排队 ${o.pending} 条，今日剩余额度 ${Math.max(0,o.policy.daily-o.usedToday)} 条。`:'第一次运行只建立历史参照，不下载视频。'}</p><label class="form-row"><span>本轮最多处理<small>同时受每日额度限制</small></span><input name="limit" aria-label="本轮最多处理" type="number" min="1" max="${o.policy.daily}" value="${Math.max(1,Math.min(10,o.policy.daily-o.usedToday))}" required></label><label class="form-row"><span>只继续已有待办<small>跳过本次新收藏扫描</small></span><input class="toggle" name="noScan" type="checkbox" ${noScan?'checked':''} ${!o.baseline?'disabled':''}></label><p class="muted" style="font-size:12.5px">可在流水线停止；已经完成的阶段会保留。</p><div class="row" style="justify-content:flex-end">${button('取消','close-dialog','','quiet')}<button class="btn primary" data-idle ${busy()?'disabled':''}>开始运行</button></div></form>`,'modal');
}

// ── 健康 ──
function healthPage(){return `<div class="page" id="health">${empty('正在读取…')}</div>`;}
async function loadHealth(){
  const epoch=pageEpoch,data=await api('insights?'+query({id:state.lookup||undefined}));if(epoch!==pageEpoch)return;state.insights=data;
  const o=state.overview,c=data.codes,n=data.recent.length,okRate=n?Math.round((c[0]||0)/n*100):null,colors={0:'var(--accent)',1:'var(--red)',2:'var(--amber)',5:'var(--blue)'};
  const maxOut=Math.max(1,...data.output.map(d=>d.notes+d.saved));
  $('#health').innerHTML=head('健康',`运行历史来自 runs/history.jsonl（共 ${data.total} 轮），产出来自收藏账本`,button(`${ic('ext',14)}打开运行日志目录`,'open','data-kind="runs-folder"'))+`
  <div class="grid3">
    <section class="card stat"><span class="eyebrow">最近 ${n||30} 轮</span><strong>${okRate===null?'—':okRate+'%'}<small>${okRate===null?'暂无记录':'完全完成'}</small></strong><span class="delta">${n?`完成 ${c[0]||0} · 有失败 ${c[2]||0} · 暂停 ${c[5]||0} · 异常 ${c[1]||0}`:'运行一次后开始累积'}</span></section>
    <section class="card stat"><span class="eyebrow">平均每轮</span><strong>${data.avgSeconds===null?'—':(data.avgSeconds/60).toFixed(1)}<small>分钟</small></strong><span class="delta">${data.longest?`最长 ${Math.round(data.longest.seconds/60)} 分钟（${esc(fmt(data.longest.started))}）`:'暂无记录'}</span></section>
    <section class="card stat" id="cost-card"><span class="eyebrow">本月成本 ${chip('由 AI 网关估算')}</span><strong style="color:var(--faint)">—</strong><span class="delta">正在读取网关用量…</span></section>
  </div>
  <div class="grid2">
    <section class="card card-pad"><div class="sec-head"><h2>退出码</h2><span class="sub">定时服务把 2、5 视为正常结束</span></div>${n?`<div class="strip">${data.recent.map(r=>`<i style="height:${r.exit===0?60:r.exit===2?85:100}%;background:${colors[r.exit]||'var(--faint)'}" title="${esc(fmt(r.started))} · 退出码 ${r.exit}"></i>`).join('')}</div>`:empty('暂无运行历史')}<div class="legend"><span><i style="background:var(--accent)"></i>0 完成</span><span><i style="background:var(--amber)"></i>2 有条目失败或扫描受阻</span><span><i style="background:var(--blue)"></i>5 暂停（额度、空间、风控）</span><span><i style="background:var(--red)"></i>1 整轮异常</span></div></section>
    <section class="card card-pad"><div class="sec-head"><h2>版本</h2></div><div class="ver"><small style="width:64px">${serverMode?'生产':'本机'}</small><span class="sha">${esc(data.version.split(' ')[0])}</span><span class="muted">${esc(data.version.split(' ').slice(1).join(' '))}</span></div><div class="ver"><small style="width:64px">最近一轮</small><span class="muted">${data.recent.at(-1)?`${esc(fmt(data.recent.at(-1).started))} · 退出码 ${data.recent.at(-1).exit}`:'暂无记录'}</span></div><p class="muted" style="font-size:12.5px;margin-top:8px">每轮日志开头记有当时的代码版本；发版后可对照确认生效。</p></section>
  </div>
  <div class="grid2">
    <section class="card card-pad"><div class="sec-head"><h2>失败原因</h2><span class="sub">最近 7 天 · 按作品去重</span></div>${data.failures.length?data.failures.map(f=>`<div class="reason-row"><span><b style="font-weight:500">${esc(f.reason)}</b><small>${esc(f.platforms.map(p=>PLATFORM_LABELS[p]||p).join('、'))}${f.sample.length?` · 例如 <button type="button" class="link" data-action="lookup" data-id="${esc(f.sample[0])}">${esc(f.sample[0])}</button>`:''}</small></span><span class="meter"><i style="width:${Math.min(100,f.items/Math.max(1,data.failures[0].items)*100)}%;background:var(--amber)"></i></span><span class="num" style="text-align:right">${f.items||f.count}</span></div>`).join(''):'<p class="muted" style="font-size:13px">最近 7 天没有失败。</p>'}</section>
    <section class="card card-pad"><div class="sec-head"><h2>查一条作品</h2><span class="sub">在哪几轮失败、原因是什么</span></div><form id="lookup-form" class="row"><input name="id" class="mono" style="flex:1" placeholder="作品 ID" value="${esc(state.lookup)}" maxlength="40"><button class="btn sm">查询</button></form>${data.lookup?`<div style="margin-top:14px">${data.lookup.item?`<p style="font-size:13px"><b style="font-weight:500">${esc(data.lookup.item.title)}</b> · ${tag(STATUSES[data.lookup.item.status]||data.lookup.item.status)} ${button('详情','detail',`data-id="${esc(data.lookup.id)}"`,'quiet sm')}</p>`:'<p class="muted" style="font-size:13px">账本里没有这条作品。</p>'}<div class="timeline" style="margin-top:8px">${data.lookup.runs.map(r=>`<div class="tl err"><time>${esc(fmt(r.started))}</time><span class="d"></span><span>${esc(r.errors.join('；'))} <small>· ${esc(r.version||'')}</small></span></div>`).join('')||'<p class="muted" style="font-size:13px">运行历史中没有这条作品的失败记录。</p>'}</div></div>`:''}</section>
  </div>
  <div class="grid2">
    <section class="card card-pad"><div class="sec-head"><h2>今日额度</h2><span class="sub">各平台独立计数，同时受合计上限约束</span></div>${[['抖音',o.usedByPlatform?.douyin||0,o.policy.daily,'var(--dy)'],...(o.x.enabled?[['X',o.x.usedToday,o.x.daily,'var(--x)']]:[]),...(o.bilibili.enabled?[['B站',o.bilibili.usedToday,o.bilibili.daily,'var(--bili)']]:[]),['合计',o.usedToday,o.policy.totalDaily||o.policy.daily,'var(--accent)']].map(([l,u,m,c])=>`<div class="quota-row"><span>${l}</span><span class="meter"><i style="width:${Math.min(100,u/Math.max(1,m)*100)}%;background:${c}"></i></span><span class="num">${u} / ${m}</span></div>`).join('')}</section>
    <section class="card card-pad"><div class="sec-head"><h2>每日产出</h2><span class="sub">最近 14 天 · 绿色笔记，橙色视频和图集</span></div><div class="bars">${data.output.map((d,n)=>`<div title="${esc(d.day)} · 笔记 ${d.notes} · 保存 ${d.saved}"><i class="saved" style="height:${d.saved/maxOut*100}%"></i><i style="height:${d.notes/maxOut*100}%"></i><small>${n===data.output.length-1?'今':esc(d.day.slice(8))}</small></div>`).join('')}</div></section>
  </div>`;
  void fillCostCard(epoch);
}

// ── 设置 ──
function field(key){
  const f=state.settings.fields.find(f=>f.key===key);if(!f)return '';
  const attrs=`name="${key}" ${f.overridden?'disabled':''}`;
  const input=f.type==='select'?`<select ${attrs}>${f.options.map(v=>`<option value="${v}" ${String(f.value)===v?'selected':''}>${['DUST_NOTIFY','DUST_BILI_ENABLED','DUST_BILI_SUBTITLE_AI','DUST_BILI_AUTO_ROUTE'].includes(key)?(v==='1'?'开启':'关闭'):key==='DUST_BILI_MAX_QUALITY'?esc(QUALITY_LABELS[v]+(v==='80'?'（推荐）':'')):esc(v)}</option>`).join('')}</select>`:f.type==='textarea'?`<textarea ${attrs} rows="3">${esc(f.value)}</textarea>`:`<input ${attrs} type="${f.type==='path'?'text':f.type}" value="${esc(f.value)}" ${f.type==='number'?`min="${f.min}" max="${f.max}" step="${f.step}"`:''} ${f.type==='password'?`autocomplete="new-password" placeholder="${f.configured?'已配置 · 留空保留':'尚未配置'}"`:'required'}>`;
  return `<label class="field ${f.type==='path'||f.type==='textarea'?'wide':''}"><span>${esc(f.label)}</span>${input}${f.overridden?'<small>由环境变量覆盖，此处只读</small>':f.type==='password'?'<small>留空保留已有密钥</small>':f.clamped?'<small>已显示当前规则下的实际生效值</small>':''}</label>`;
}
const sectionFields=(title,keys,note='')=>`<section class="settings-section"><h2>${title}</h2>${note?`<p class="muted">${note}</p>`:''}<div class="fields">${keys.map(field).join('')}</div></section>`;
function settingsPage(){
  const t=state.settingsTab,o=state.overview,s=state.settings;
  const tabs=`<nav class="tabs" aria-label="设置">${[['models','模型服务'],['rules','处理规则'],['storage','文件与空间'],['api','外部访问']].map(([v,l])=>`<a href="#${v}" ${t===v?'aria-current="page"':''}>${l}</a>`).join('')}</nav>`;
  if(t==='api')return `<div class="page">${head('设置','新配置从下一轮处理开始生效；账号连接在「流水线」的来源卡片里')}${tabs}<div id="api-tab">${empty('正在读取…')}</div></div>`;
  let content='';
  if(t==='models')content=`<div class="model-grid">${[['用途判断','决定一条收藏保存视频还是整理笔记',SETTINGS.models.slice(0,3)],['语音转写','把口播转成文字；B站有字幕时不调用',SETTINGS.models.slice(3,6)],['笔记整理','从文字稿整理成知识笔记',SETTINGS.models.slice(6,11)]].map(([title,desc,keys])=>`<section class="card model-card"><span class="model-mark">${title.slice(0,1)}</span><div><h3 style="font-size:15px;font-weight:600">${title}</h3><p class="muted" style="font-size:12.5px">${desc}</p></div>${keys.map(field).join('')}</section>`).join('')}</div><section class="card card-pad"><details><summary>转写热词、请求超时与直连配置</summary><div class="fields">${SETTINGS.models.slice(11).map(field).join('')}</div></details></section>`;
  if(t==='storage')content=`<div class="storage-summary">${[['保留的视频与图集',o.storage.savedUsed],['临时媒体缓存',o.storage.used],['磁盘可用',o.storage.available]].map(([l,v])=>`<div class="card"><small>${l}</small><strong>${esc(bytes(v))}</strong></div>`).join('')}</div><p class="muted" style="font-size:12.5px;margin-bottom:16px">封面与播放副本缓存：${bytes(o.storage.previewUsed)} · 最多 512 MiB，自动回收，可重新生成；原视频不受影响。</p>${o.storage.error?`<div class="callout">部分空间信息未能读取：${esc(o.storage.error)}</div>`:''}<section class="card card-pad" style="margin-bottom:16px">${sectionFields('保存位置',SETTINGS.storage.slice(0,3),'修改目录只影响新产物，已有文件不会搬迁。')}<div class="row">${button('打开笔记目录 ↗','open','data-kind="notes-folder"','sm')}${button('打开运行日志目录 ↗','open','data-kind="runs-folder"','sm')}</div></section><section class="card card-pad">${sectionFields('空间与保留',SETTINGS.storage.slice(3),'视频与图集收藏独立保存，不自动清理；缓存按现有清理规则回收。')}<details><summary>数据与缓存路径</summary><dl class="kv" style="font-size:12.5px">${[['运行数据',s.home],['账本数据库',s.database],['媒体缓存',s.media]].map(([name,path])=>`<dt>${name}</dt><dd class="mono">${esc(path)}</dd>`).join('')}</dl></details></section>`;
  if(t==='rules')content=`<section class="card card-pad" style="margin-bottom:16px">${sectionFields('日常处理',SETTINGS.rules.slice(0,3),'发现新收藏后，视频按用途保存或提取知识，图集直接保存图片。已有历史基线不会自动进入待办。')}</section><section class="card card-pad" style="margin-bottom:16px">${sectionFields('B站与合计额度',SETTINGS.rules.slice(5),'各平台单独计每日额度，同时受合计额度约束。B站有字幕时不调用转写；没有字幕时按转写时长上限和每日转写总量控制成本。')}</section><section class="card card-pad"><details><summary>扫描与整轮时限</summary><div class="fields">${SETTINGS.rules.slice(3,5).map(field).join('')}</div><p class="muted" style="font-size:12.5px;margin-top:10px">起始窗口只是首次扫描的数量；未确认到历史边界时会继续翻页。已有基线时，可恢复的扫描错误不会阻断原有待办。</p></details></section>`;
  return `<div class="page">${head('设置','新配置从下一轮处理开始生效；账号连接在「流水线」的来源卡片里')}${tabs}<form id="settings-form">${content}<div class="savebar">${ic('clock',14)}新配置从下一轮处理开始生效<button class="btn primary sm">保存设置</button></div></form></div>`;
}
async function loadApiTab(){
  const epoch=pageEpoch,{tokens}=await api('tokens');if(epoch!==pageEpoch)return;
  const base=new URL('api/v1/',location.href).href.replace(/\/$/,'');
  $('#api-tab').innerHTML=`<div class="grid2"><section class="card card-pad"><div class="sec-head"><h2>访问令牌</h2><span class="sub">明文只在创建时显示一次</span><span style="margin-left:auto">${button('新建令牌','token-new','','primary sm')}</span></div>${tokens.length?tokens.map(t=>`<div class="token-row ${t.revoked_at?'revoked':''}"><span><b>${esc(t.name)}</b><small class="mono">dsk_••••${esc(t.hint)}</small></span>${tag(t.scope==='write'?'读素材 + 标记已用':'只读素材',t.scope==='write'?'warn':'blue')}<small>${t.revoked_at?`已吊销 ${esc(fmt(t.revoked_at))}`:t.last_used_at?`最近使用 ${esc(fmt(t.last_used_at))}`:'尚未使用'}</small>${t.revoked_at?'<span></span>':button('吊销','token-revoke',`data-id="${t.id}"`,'quiet sm danger')}</div>`).join(''):'<p class="muted" style="font-size:13px">还没有令牌。给每个外部服务单独建一个，不用时吊销即可。</p>'}<p class="muted" style="font-size:12.5px;margin-top:14px">令牌只能访问 <span class="mono">/api/v1/</span> 下的素材接口，不能操作收藏、运行或设置；每个令牌每分钟最多 120 次请求，调用记录写在 console/api-access.jsonl。</p></section>
    <section class="card card-pad"><div class="sec-head"><h2>接口</h2><span class="sub">请求头 Authorization: Bearer &lt;令牌&gt;</span></div>${[['GET','/topics','选题列表'],['GET','/materials?topic=&status=&kind=&limit=','素材列表；topic=none 为未归类'],['GET','/materials?since=<秒>&after=<id>','增量拉取：返回此后新增或修改的素材，带 next 用于翻页'],['GET','/materials/{id}','单条素材：摘录、备注、来源链接、笔记全文、媒体清单'],['GET','/materials/{id}/media/{n}','下载视频（n=0）或图集第 n 张，同样用令牌认证'],['POST','/materials/{id}/usage','标记已用：{channel, title, url}，需要写权限']].map(([m,u,d])=>`<div class="endpoint"><span class="m ${m==='POST'?'write':''}">${m}</span><span><code>${esc(u)}</code><small>${d}</small></span></div>`).join('')}<pre class="log" style="margin-top:14px">curl -H "Authorization: Bearer dsk_…" \\\n  "${esc(base)}/materials?status=todo"</pre></section></div>`;
}

// ── 弹窗与路由 ──
const dialogHead=title=>`<header class="dialog-head"><h2 id="dialog-title">${title}</h2>${button(ic('x',15),'close-dialog','aria-label="关闭"','quiet sm')}</header>`;
function openDialog(html,cls='modal'){stopVideo();galleryData=null;dialog.className=cls;dialog.innerHTML=html;if(!dialog.open)dialog.showModal();}
dialog.addEventListener('close',()=>{++dialogEpoch;drawerId=null;galleryData=null;stopVideo();});
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
async function reloadList(){const r=state.route;if(r==='pending')await loadPending();else if(r==='collection')await loadCollection();else if(r==='videos')await loadMedia();else if(r==='overview')await loadToday();else if(r==='notes'){await ensureIndex(true);renderNotes();}else if(r==='pipeline')await loadPipeline();}
function resolve(hash){
  if(PAGES[hash])return [hash,null];
  if(ALIASES[hash])return ALIASES[hash];
  return ['overview',null];
}
async function go(hash){
  clearTimeout(searchTimer);const [route,sub]=resolve(hash);
  if(route!==state.route){window.scrollTo({top:0,behavior:'instant'});}
  const epoch=++pageEpoch;++listEpoch;++docEpoch;++logEpoch;
  if(dialog.open)dialog.close();closePalette();
  // 从别的页面回到媒体库时从第一批开始读，不把上次滚动加载过的批次全部重读。
  if(route==='videos'&&route!==state.route)state.media.page=1;
  state.route=route;
  if(route==='videos'&&sub)state.media={...state.media,tab:sub,page:1};
  if(route==='settings'&&sub)state.settingsTab=sub;
  root.dataset.page=route;document.title=`${PAGES[route]} · dustoff`;
  document.body.classList.toggle('fit',route==='notes'&&state.kb.view==='read');
  $('#topbar').hidden=route!=='overview';
  main.innerHTML=empty('正在读取…');syncChrome();
  try{
    const [o,settings]=await Promise.all([api('overview'),route==='settings'&&state.settingsTab!=='api'?api('settings'):null]);
    if(epoch!==pageEpoch)return;state.overview=o;if(settings)state.settings=settings;syncChrome();
    main.innerHTML=({overview:overviewPage,pending:pendingPage,notes:notesPage,videos:videosPage,materials:materialsPage,collection:collectionPage,pipeline:pipelinePage,health:healthPage,settings:settingsPage})[route]();
    paintIcons(main);
    if(route==='overview')await loadToday();else if(route==='pending')await loadPending();else if(route==='notes')await loadNotes();else if(route==='videos')await loadMedia();else if(route==='materials')await loadMaterials();else if(route==='collection')await loadCollection();else if(route==='pipeline')await loadPipeline(sub);else if(route==='health')await loadHealth();else if(route==='settings'&&state.settingsTab==='api')await loadApiTab();
    if(!state.library)ensureLibrary().catch(()=>{});
  }catch(e){if(epoch===pageEpoch)main.innerHTML=`<div class="page">${head(PAGES[route])}${empty(e.message)}<div class="row" style="justify-content:center">${button('重新读取','refresh')}</div></div>`;}
}
function navigate(hash){if(location.hash==='#'+hash)void go(hash);else location.hash=hash;}

// ── ⌘K 搜索 ──
let paletteItems=[],paletteIndex=0;
function openPalette(){$('#palette').hidden=false;$('#scrim').hidden=false;$('#palette-input').value='';paletteIndex=0;renderPalette('');setTimeout(()=>$('#palette-input').focus(),20);ensureIndex().then(()=>{if(!$('#palette').hidden)renderPalette($('#palette-input').value);}).catch(()=>{});}
function closePalette(){$('#palette').hidden=true;$('#scrim').hidden=true;}
function renderPalette(raw){
  const q=raw.trim().toLowerCase();
  const pages=Object.entries(PAGES).filter(([,l])=>!q||l.includes(q)).map(([id,l])=>({g:'页面',label:l,icon:'arrow',run:()=>navigate(id)}));
  const notes=(state.index||[]).filter(n=>q&&[n.title,n.author,...n.tags].join(' ').toLowerCase().includes(q)).slice(0,8).map(n=>({g:'笔记',label:n.title,icon:'note',sub:n.category||'',run:()=>openNote(n.id)}));
  const id=/^(x?\d{6,}|BV[0-9A-Za-z]{10})$/.test(raw.trim())?[{g:'作品 ID',label:`查看作品 ${raw.trim()}`,icon:'list',run:()=>detail(raw.trim())}]:[];
  const acts=[{g:'操作',label:busy()?'查看本轮进度':'运行一轮',icon:'play',run:()=>busy()?navigate('pipeline'):manualRun()},{g:'操作',label:'切换明暗',icon:'moon',run:toggleTheme}].filter(a=>!q||a.label.includes(q));
  paletteItems=[...id,...pages,...notes,...acts];paletteIndex=Math.min(paletteIndex,Math.max(0,paletteItems.length-1));
  let g='';$('#palette-results').innerHTML=paletteItems.map((it,n)=>{const h=it.g!==g?`<div class="grp">${it.g}</div>`:'';g=it.g;return h+`<button type="button" class="opt" data-action="palette-run" data-index="${n}" aria-selected="${n===paletteIndex}">${ic(it.icon,16)}<span>${esc(it.label)}</span>${it.sub?`<small>${esc(it.sub)}</small>`:''}</button>`;}).join('')||empty('没有结果');
}
function openNote(id){Object.assign(state.kb,{id,cat:'all',read:'all',tag:null,platform:'all',type:'all',q:'',view:'read',list:false});navigate('notes');if(state.route==='notes'&&state.index&&!state.index.some(n=>n.id===id))void loadNotes();}
function toggleTheme(){const r=document.documentElement,dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme:dark)').matches;r.dataset.theme=dark?'light':'dark';try{localStorage.setItem('dustoff.theme',r.dataset.theme);}catch{}}
try{const t=localStorage.getItem('dustoff.theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;}catch{} // 外观只是本机偏好

// ── 事件 ──
// 摘录：在按下“加入素材箱”的瞬间读取正文里的选区，避免点击按钮时选区已被清空。
const proseSelection=()=>{const s=document.getSelection(),node=s?.anchorNode;return s&&!s.isCollapsed&&node?.parentElement?.closest?.('.prose')?s.toString().trim().slice(0,4000):'';};
let pointerSelection=null;
root.addEventListener('pointerdown',e=>{pointerSelection=e.target.closest?.('[data-action="add-material"]')?proseSelection():null;},true);
root.addEventListener('click',async event=>{
  const b=event.target.closest('[data-action]');if(!b||b.disabled)return;
  const a=b.dataset.action,id=b.dataset.id;
  if(b.tagName==='A'&&!['kb-unread','failed-items'].includes(a))return;
  if(['pick','seg-radio'].includes(a)){
    if(a==='pick'){b.parentElement.querySelectorAll('[data-action=pick]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));}
    else{const label=b.closest('label');label.querySelector('input').checked=true;b.closest('.seg').querySelectorAll('.seg-opt').forEach(x=>{const on=x===b;x.style.background=on?'var(--surface)':'';x.style.color=on?'var(--ink)':'var(--muted)';x.style.boxShadow=on?'var(--shadow)':'';});}
    return;
  }
  if(a==='kb-unread'){Object.assign(state.kb,{read:'unread',cat:'all',tag:null,list:true,view:'read'});return;}
  if(a==='failed-items'){Object.assign(state.collection,{status:'failed',q:'',page:1});return;}
  if(b.tagName==='BUTTON')b.disabled=true;
  try{
    if(a==='dismiss')notice('');
    else if(a==='theme')toggleTheme();
    else if(a==='palette')openPalette();
    else if(a==='palette-run'){const it=paletteItems[Number(b.dataset.index)];closePalette();await it?.run();}
    else if(a==='refresh')await go(location.hash.slice(1)||'overview');
    else if(a==='close-dialog')dialog.close();
    else if(a==='go-pipeline')navigate('pipeline');
    else if(a==='detail')await detail(id);
    else if(a==='read'){dialog.open&&dialog.close();openNote(id);}
    else if(a==='view-gallery')await viewGallery(id);
    else if(a==='gallery-step'){galleryIndex+=Number(b.dataset.step);renderGallery();}
    else if(a==='gallery-select'){galleryIndex=Number(b.dataset.index);renderGallery();}
    else if(a==='play-video')await playVideo(id);
    else if(a==='delete-video')await deleteVideo(id);
    else if(a==='prepare-video')await preparePlayback(id,dialogEpoch);
    else if(a==='video-to-note')await queueVideoNote(id);
    else if(a==='cancel-video')await stopProcessing('discard',id,true);
    else if(a==='discard-item'||a==='delete-item')await stopProcessing(a==='discard-item'?'discard':'delete-item',id);
    else if(a==='manual-run')manualRun(b.dataset.noscan==='1');
    else if(a==='stop')await mutate('stop',{},'已发送停止请求，正在完成收尾。');
    else if(a==='retry')await queueMutation('retry',{id});
    else if(a==='quick-purpose'){const q=root.querySelector(`[data-quality-for="${CSS.escape(id)}"]`);if(dialog.open&&dialog.classList.contains('player-dialog'))dialog.close();await queueMutation('purpose',{id,purpose:b.dataset.purpose,...(q&&b.dataset.purpose==='video'?{quality:q.value}:{})});}
    else if(a==='inline-play')playInline(b.closest('.inline-player'),id);
    else if(a==='inbox-select'){state.inbox.id=id;renderInbox();}
    else if(a==='open')await mutate('open',{kind:b.dataset.kind,id,fileKind:b.dataset.fileKind},'已在本机打开。');
    else if(a==='resurface-next'){resurfaceShift++;await loadToday();}
    else if(a==='kb-view'){state.kb.view=b.dataset.value;document.body.classList.toggle('fit',state.kb.view==='read');renderNotes();}
    else if(a==='kb-facet'){const f=b.dataset.facet,v=b.dataset.value;if(f==='tag')state.kb.tag=state.kb.tag===v?null:v;else state.kb[f]=state.kb[f]===v&&f!=='read'&&f!=='cat'?'all':v;state.kb.view='read';state.kb.list=true;state.kb.id=null;renderNotes();}
    else if(a==='kb-select'){state.kb.id=id;state.kb.kind='note';root.querySelectorAll('.kb-item').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.id===id)));if(matchMedia('(max-width:820px)').matches){state.kb.list=false;renderNotes();}else await loadDocument();}
    else if(a==='kb-list'){state.kb.list=!state.kb.list;renderNotes();}
    else if(a==='kb-step')kbStep(Number(b.dataset.step));
    else if(a==='kb-kind'){state.kb.kind=b.dataset.value;await loadDocument();}
    else if(a==='toggle-read'){const n=state.index.find(x=>x.id===id),read=!n.read_at;await api('read',{id,read});n.read_at=read?Date.now()/1000:null;keptUnread=read?null:id;renderNotes();notice(read?'已标为已读':'已标为未读');}
    else if(a==='media-more')await loadMoreMedia();
    else if(a==='media-tab'){Object.assign(state.media,{tab:b.dataset.value,page:1});main.innerHTML=videosPage();await loadMedia();}
    else if(a==='media-platform'){Object.assign(state.media,{platform:b.dataset.value,page:1});main.innerHTML=videosPage();await loadMedia();}
    else if(a==='collection-filter'){Object.assign(state.collection,{status:b.dataset.value,page:1});main.innerHTML=collectionPage();await loadCollection();}
    else if(a==='paginate'){const kind=b.dataset.kind,step=Number(b.dataset.step);if(kind==='runs'){state.runPage+=step;runRows();}else if(kind==='inbox'){state.inbox.page+=step;await loadPending();}else{state.collection.page+=step;await loadCollection();}}
    else if(a==='schedule-toggle'){await mutate('schedule',{action:b.dataset.value},b.dataset.value==='start'?'自动整理已开启。':'自动整理及登录自动启用已关闭。');$('#schedule-anchor').innerHTML=scheduleCard();schedulePreview();}
    else if(a==='log-kind'){state.logKind=b.dataset.value;runRows();await loadLog();}
    else if(a==='select-run'){state.runId=id;runRows();await loadLog();}
    else if(a==='login'||a==='check-session'){await mutate(a==='login'?'login':'session-check',b.dataset.platform?{platform:b.dataset.platform}:{},a==='login'?'正在打开官方登录页。':'正在检查登录状态。');await loadSession();}
    else if(a==='x-connect'){const r=await api('x-authorize',{});location.href=r.url;}
    else if(a==='cancel-login'){await mutate('login-control',{action:'cancel'},'已请求取消登录操作。');await loadSession();}
    else if(a==='lookup'){state.lookup=id;await loadHealth();}
    else if(a==='add-material'){state.selection=b.dataset.fromReader?(pointerSelection??proseSelection()):'';pointerSelection=null;await addMaterialDialog(id,b.dataset.kind);}
    else if(a==='topic-select'){state.materials.topic=b.dataset.value;renderMaterials();}
    else if(a==='topic-edit')topicDialog(id);
    else if(a==='topic-delete'){if(!window.confirm('删除这个选题？里面的素材会回到“未归类”，不会被删除。'))return;await api('topic-delete',{id:Number(id)});dialog.close();state.materials.topic='all';await ensureLibrary(true);renderMaterials();notice('选题已删除，素材移到了未归类。');}
    else if(a==='material-open')materialDialog(id);
    else if(a==='material-move'){await api('material-update',{id:Number(id),topic_id:Number(b.dataset.topic)});await ensureLibrary(true);renderMaterials();notice('已放入选题');}
    else if(a==='material-delete'){if(!window.confirm('把这条移出素材箱？原笔记和媒体不受影响。'))return;await api('material-delete',{id:Number(id)});dialog.close();await ensureLibrary(true);if(state.route==='materials')renderMaterials();notice('已移出素材箱');}
    else if(a==='export-topic')exportTopic(id);
    else if(a==='token-new')openDialog(dialogHead('新建访问令牌')+`<form class="dialog-body" id="token-form"><label class="field">名称<input name="name" maxlength="40" required placeholder="例如：写作助手"></label><div class="field">权限<div class="opts"><button type="button" data-action="pick" data-value="read" aria-pressed="true">只读素材</button><button type="button" data-action="pick" data-value="write" aria-pressed="false">读素材 + 标记已用</button></div></div><div class="row" style="justify-content:flex-end">${button('取消','close-dialog','','quiet')}<button class="btn primary">创建</button></div></form>`,'modal');
    else if(a==='token-revoke'){if(!window.confirm('吊销这个令牌？使用它的服务会立即无法访问。'))return;await api('token-revoke',{id:Number(id)});await loadApiTab();notice('令牌已吊销');}
    else if(a==='copy-secret'){await navigator.clipboard.writeText(b.dataset.value);notice('已复制');}
  }catch(e){notice(e.message,true);}finally{if(b.isConnected&&b.tagName==='BUTTON')b.disabled=b.hasAttribute('data-idle')&&busy();}
});
root.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches?.('.mcard')){e.preventDefault();e.target.click();}});
async function mutate(path,data,message){const r=await api(path,data);await refreshOverview();notice(message);return r;}
root.addEventListener('input',event=>{
  const input=event.target;
  if(input.id==='kb-search'){state.kb.q=input.value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{const pos=input.selectionStart;renderNotes();const next=$('#kb-search');next?.focus();next?.setSelectionRange(pos,pos);},200);}
  if(['collection-search','media-search'].includes(input.id)){const kind=input.id==='media-search'?'media':'collection';state[kind].q=input.value;state[kind].page=1;++listEpoch;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{(kind==='media'?loadMedia():loadCollection()).catch(e=>notice(e.message,true));},250);}
  if(input.id==='palette-input'){paletteIndex=0;renderPalette(input.value);}
  if(input.closest('#schedule-form'))schedulePreview();
});
root.addEventListener('change',event=>{if(['collection-status','collection-platform'].includes(event.target.id)){state.collection[event.target.id==='collection-status'?'status':'platform']=event.target.value;state.collection.page=1;main.innerHTML=collectionPage();loadCollection().catch(e=>notice(e.message,true));}});
root.addEventListener('submit',async event=>{
  // 表单里有 name="id" 的输入框时，表单的 id 属性会被这个输入框盖掉，只能用 getAttribute 取。
  const form=event.target,formId=form.getAttribute('id');event.preventDefault();
  const submit=event.submitter||form.querySelector('button:not([type=button])');if(submit)submit.disabled=true;
  const data=new FormData(form),epoch=pageEpoch;
  try{
    if(formId==='settings-form'){const saved=await api('settings',{revision:state.settings.revision,values:Object.fromEntries(data)});state.settings=saved;notice('设置已保存，从下一轮处理开始生效。');await refreshOverview();if(epoch===pageEpoch&&state.route==='settings'){main.innerHTML=settingsPage();}}
    else if(formId==='schedule-form'){await mutate('schedule',{action:'save',time:data.get('time'),intervalHours:Number(data.get('intervalHours')),autoStartAfterReboot:data.has('autoStartAfterReboot')},'自动安排已保存。');if(epoch===pageEpoch&&$('#schedule-anchor')){$('#schedule-anchor').innerHTML=scheduleCard();schedulePreview();}}
    else if(formId==='run-form'){await mutate('run',{limit:Number(data.get('limit')),noScan:data.has('noScan')},'本轮整理已启动。');dialog.close();navigate('pipeline');}
    else if(formId==='purpose-form'){const q=form.querySelector('[data-quality-for]');await queueMutation('purpose',{id:data.get('id'),purpose:data.get('purpose'),...(q&&data.get('purpose')==='video'?{quality:q.value}:{})});}
    else if(formId==='lookup-form'){state.lookup=String(data.get('id')||'').trim();await loadHealth();}
    else if(formId==='topic-form'){const id=form.dataset.id;const t=await api('topic',{...(id?{id:Number(id)}:{}),name:data.get('name'),description:data.get('description'),channels:String(data.get('channels')||'').split(/[,，、]/).map(s=>s.trim()).filter(Boolean)});dialog.close();await ensureLibrary(true);if(state.route==='materials'){state.materials.topic=String(t.id);renderMaterials();}notice('选题已保存');}
    else if(formId==='add-material-form'){
      let topic=form.querySelector('#topic-opts [aria-pressed=true]')?.dataset.value||'';const name=String(data.get('new_topic')||'').trim();
      if(name){const t=await api('topic',{name});topic=String(t.id);}
      const kind=form.querySelector('#kind-opts [aria-pressed=true]')?.dataset.value;
      await api('material',{item:form.dataset.id,kind,topic_id:topic?Number(topic):null,memo:data.get('memo'),excerpt:kind==='excerpt'?form.dataset.selection:undefined});
      dialog.close();await ensureLibrary(true);if(state.route==='materials')renderMaterials();
      notice(`已加入素材箱${topic?' · '+(state.library.topics.find(t=>String(t.id)===topic)?.name||''):' · 未归类'}`);
    }
    else if(formId==='material-form'){await api('material-update',{id:Number(form.dataset.id),topic_id:data.get('topic_id')?Number(data.get('topic_id')):null,status:data.get('status'),memo:data.get('memo'),...(data.has('excerpt')?{excerpt:data.get('excerpt')}:{})});dialog.close();await ensureLibrary(true);renderMaterials();notice('素材已更新');}
    else if(formId==='token-form'){const scope=form.querySelector('[aria-pressed=true]')?.dataset.value||'read';const t=await api('token',{name:data.get('name'),scope});dialog.innerHTML=dialogHead('令牌已创建')+`<div class="dialog-body"><p style="font-size:13px">这是 <b>${esc(t.name)}</b> 的令牌，<b>只显示这一次</b>，请现在复制保存。之后只能吊销重建。</p><div class="secret"><span style="flex:1">${esc(t.token)}</span>${button('复制','copy-secret',`data-value="${esc(t.token)}"`,'sm')}</div><div class="row" style="justify-content:flex-end">${button('完成','close-dialog','','primary')}</div></div>`;await loadApiTab();}
  }catch(e){notice(e.message,true);}finally{if(submit?.isConnected)submit.disabled=submit.hasAttribute('data-idle')&&busy();}
});
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#palette').hidden?openPalette():closePalette();return;}
  if(!$('#palette').hidden){
    if(e.key==='Escape')closePalette();
    else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();paletteIndex=(paletteIndex+(e.key==='ArrowDown'?1:-1)+paletteItems.length)%Math.max(1,paletteItems.length);renderPalette($('#palette-input').value);}
    else if(e.key==='Enter'){const it=paletteItems[paletteIndex];closePalette();Promise.resolve(it?.run()).catch(err=>notice(err.message,true));}
    return;
  }
  if(dialog.open||/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)||e.metaKey||e.ctrlKey||e.altKey)return;
  if(state.route==='notes'&&state.kb.view==='read'){if(e.key==='['){state.kb.list=!state.kb.list;renderNotes();}else if(e.key==='j'||e.key==='k')kbStep(e.key==='j'?1:-1);}
  if(state.route==='pending'&&state.inbox.id){
    if(e.key==='j'||e.key==='k')inboxStep(e.key==='j'?1:-1);
    else if(e.key==='n'||e.key==='v')root.querySelector(`.choice[data-purpose="${e.key==='n'?'note':'video'}"]`)?.click();
    else if(e.key==='d')root.querySelector('.choice[data-action="discard-item"]')?.click();
  }
});
$('#scrim').addEventListener('click',closePalette);
window.addEventListener('hashchange',()=>{notice('');void go(location.hash.slice(1));});
void go(location.hash.slice(1)||'overview');
setInterval(async()=>{
  if(polling||document.hidden)return;polling=true;
  try{
    const wasRunning=busy(),epoch=pageEpoch;await refreshOverview();
    if(state.route==='pipeline')await loadSession();
    if(wasRunning&&!busy()&&epoch===pageEpoch&&!dialog.open){state.index=null;if(['pending','collection','videos','pipeline'].includes(state.route))await reloadList();}
  }catch{/* 短暂轮询失败不覆盖阅读内容或未保存表单；手动刷新会显示具体错误。 */}
  finally{polling=false;}
},4000);
