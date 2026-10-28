import {renderMarkdown} from './markdown.mjs';
import {remainingLabel,loginFlow} from './login-ui.mjs';
import {makePlan,nextOccurrence} from './schedule-plan.mjs';
import {esc,PURPOSES,STATUSES,REASONS,SETTINGS,fmt,bytes,duration,titleOf,mediaLabel,resultLabel,runSummary,splitNoteContent} from './studio-view.mjs';

const root=document.querySelector('#dustoff-studio'),main=document.querySelector('#main'),dialog=document.querySelector('#dialog');
const token=document.querySelector('meta[name="dustoff-token"]').content;
const serverMode=document.querySelector('meta[name="dustoff-server"]')?.content==='1';
if(serverMode)document.querySelector('.local-label').textContent='服务器工作空间';
if(document.querySelector('meta[name="dustoff-access"]')?.content==='1'){const form=document.createElement('form');form.method='post';form.action='auth/logout';form.innerHTML='<button class="button quiet">退出登录</button>';document.querySelector('.sidebar-bottom').append(form);}
const routes={overview:'总览',notes:'笔记',results:'笔记',videos:'视频',galleries:'图集',collection:'收藏记录',pending:'待处理',run:'待处理',schedule:'运行',history:'运行',account:'设置',models:'设置',storage:'设置',rules:'设置'};
const state={route:'overview',overview:null,settings:null,results:{q:'',status:'notes',page:1,id:null,kind:'note',reader:false},videos:{q:'',page:1},galleries:{q:'',page:1},collection:{q:'',status:'all',page:1},review:{page:1,choices:{}},runs:[],runId:null,logKind:'business',runPage:1};
let pageEpoch=0,listEpoch=0,docEpoch=0,logEpoch=0,dialogEpoch=0,searchTimer,polling=false,drawerId=null,videoTimer;
const $=selector=>root.querySelector(selector);
const query=values=>new URLSearchParams(values).toString();
const tag=(value,tone='')=>`<span class="tag ${tone}">${esc(value)}</span>`;
const button=(label,action,attrs='',style='')=>serverMode&&['open','delete-video','video-to-note'].includes(action)?'':`<button type="button" class="button ${style}" data-action="${action}" ${attrs}>${label}</button>`;
const empty=(text='暂无内容')=>`<div class="empty">${esc(text)}</div>`;
const busy=()=>!!state.overview?.execution.running;
const icons={book:'M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z',layers:'m12 3 10 5-10 5L2 8zm-10 9 10 5 10-5M2 16l10 5 10-5',play:'M9 7v10l8-5z M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',settings:'M4 7h16M4 17h16M8 4v6M16 14v6'};
icons.overview='M3 3h7v7H3zM14 3h7v11h-7zM3 14h7v7H3zM14 18h7v3h-7z';
icons.pending='M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01';
icons.gallery='M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M15 7h.01';
icons.video='M3 5h18v16H3zM3 10h18M7 5l3 5M14 5l3 5m-7 3v5l5-2.5z';
root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="${icons[el.dataset.icon]}"></path></svg>`;});

async function api(path,data) {
  const response=await fetch('api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Dustoff-Token':token},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
  if(response.status===401){location.href='./';throw new Error('请重新登录控制台');}
  const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败');return value;
}
function notice(message,error=false) {
  const el=$('#notice');el.hidden=!message;el.className=error?'error':'';
  el.innerHTML=message?`<span>${esc(message)}</span>${button('关闭提示','dismiss','','quiet')}`:'';
  const previous=dialog.querySelector('.dialog-notice');if(previous)previous.remove();
  if(dialog.open&&message){const local=document.createElement('p');local.className='dialog-notice'+(error?' error':'');local.setAttribute('role','status');local.textContent=message;dialog.querySelector('.dialog-head')?.after(local);}
}
function head(title,meta='',actions='') {
  return `<header class="pagehead"><h1>${title}</h1><span class="head-meta">${meta}</span><div class="head-actions">${actions}</div></header>`;
}
function tabs(group) {
  const links=group==='run'?[['schedule','自动安排'],['history','运行记录']]:[['account','账号连接'],['models','模型服务'],['storage','文件与空间'],['rules','处理规则']];
  return `<nav class="tabs" aria-label="${group==='run'?'运行':'设置'}页面">${links.map(([id,label])=>`<a href="#${id}" ${state.route===id?'aria-current="page"':''}>${label}</a>`).join('')}</nav>`;
}
function syncChrome() {
  const o=state.overview;if(!o)return;
  const group=['schedule','history'].includes(state.route)?'run':SETTINGS[state.route]?'settings':state.route==='results'?'notes':state.route;
  root.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===group)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  $('#collection-count').textContent=o.total;
  $('#pending-count').textContent=o.pending+o.review;
  $('#notes-count').textContent=o.notes;
  $('#videos-count').textContent=o.videos;
  $('#galleries-count').textContent=o.galleries||0;
  $('#running-dot').className=o.execution.running?'dot':'';
  const s=o.scheduler;
  $('#schedule-summary').innerHTML=s.error?'自动安排暂不可用':`${s.loaded?'自动整理已开启':'自动整理已关闭'}<small>${s.loaded?'下一次 · '+esc(fmt(s.nextRun)):'可在运行中开启'}</small>`;
  root.querySelectorAll('[data-idle]').forEach(b=>{b.disabled=o.execution.running;});
  if($('#run-status'))$('#run-status').innerHTML=executionPanel();
}
const overviewKey=o=>o&&JSON.stringify([o.notes,o.todayNotes,o.videos,o.galleries,o.pending,o.usedToday,o.review,o.failed,o.scheduler,o.execution,o.lastRun,o.recent,o.recentVideos,o.session.online,o.baseline]);
async function refreshOverview() {const before=overviewKey(state.overview);state.overview=await api('overview');syncChrome();if(state.route==='overview'&&!dialog.open&&before!==overviewKey(state.overview))main.innerHTML=overviewPage();}
function filterButtons(items,selected,action) {
  return `<div class="filters" aria-label="筛选">${items.map(([value,label])=>button(esc(label),action,`data-filter="${value}" aria-pressed="${selected===value}"`,'quiet')).join('')}</div>`;
}
function searchField(value,label,id) {
  return `<label class="search"><span aria-hidden="true">⌕</span><input id="${id}" type="search" maxlength="200" aria-label="${label}" placeholder="${label}" value="${esc(value)}"></label>`;
}
function pagination(data,kind) {
  return `<div class="pagination"><span>共 ${data.total} 条</span><div>${button('上一页','paginate',`data-kind="${kind}" data-step="-1" ${data.page<=1?'disabled':''}`,'quiet')}<span>${data.page} / ${data.pages}</span>${button('下一页','paginate',`data-kind="${kind}" data-step="1" ${data.page>=data.pages?'disabled':''}`,'quiet')}</div></div>`;
}

function videoCards(items) {
  return items.map(i=>`<button class="video-card" data-action="play-video" data-id="${i.id}"><span class="video-cover"><img src="api/video-poster?id=${i.id}" alt="" loading="lazy"><small class="video-duration">${i.media_type==='gallery'?'图集':duration(i.duration_s)}</small></span><strong>${esc(titleOf(i))}</strong><small>${esc(i.author||'未知作者')} · ${esc(mediaLabel(i))}</small>${i.delete_after_note?`<span class="video-note-label">${esc(videoNoteLabel(i))}</span>`:i.note_path?'<span class="video-note-label">也有知识笔记</span>':''}</button>`).join('');
}
function overviewPage() {
  const o=state.overview,s=o.scheduler,summary=runSummary(o.lastRun);
  const next=s.nextRun?new Date(s.nextRun):null;
  const nextTime=next&&!Number.isNaN(next.getTime())?next.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'尚未安排';
  return `${head('总览',`最近同步 · ${esc(fmt(o.baseline?.scanned_at))}`,button('刷新','refresh','','quiet'))}
    <div class="overview-metrics"><a href="#notes"><span>知识笔记</span><div><strong>${o.notes}</strong><small>篇 · 今天 +${o.todayNotes}</small></div></a><a href="#videos"><span>本地视频</span><div><strong>${o.videos}</strong><small>个 · 已保留</small></div></a><a href="#galleries"><span>本地图集</span><div><strong>${o.galleries||0}</strong><small>组 · 已保留</small></div></a><a href="#pending"><span>待处理</span><div><strong>${o.pending+o.review}</strong><small>条</small></div></a></div>
    <div class="overview-columns"><div class="overview-content"><section><div class="section-heading"><h2>最近笔记</h2><a href="#notes">全部笔记 ↗</a></div><div class="recent-notes">${o.recent.length?o.recent.map(i=>`<button class="recent-note" data-action="read" data-id="${i.id}" data-kind="note"><span class="note-symbol" aria-hidden="true">▤</span><span><strong>${esc(titleOf(i))}</strong><small>${esc(i.author||'未知作者')} · ${esc(i.category||'未分类')} · ${esc(fmt(i.extracted_at))}</small></span><span aria-hidden="true">›</span></button>`).join(''):empty('整理完成的知识笔记会显示在这里')} </div>${o.textOnly?`<button class="button quiet text-only-link" data-action="text-only">还有 ${o.textOnly} 份独立文字稿 →</button>`:''}</section>
    <section><div class="section-heading"><h2>最近保存的视频</h2><a href="#videos">全部视频 ↗</a></div><div class="video-grid">${o.recentVideos.length?videoCards(o.recentVideos):empty('选择「保存视频」或「视频和笔记」后，保留的视频会显示在这里')}</div></section></div>
    <aside class="overview-aside"><section class="overview-schedule"><a class="schedule-state-label" href="#schedule"><span class="dot"></span>${s.error?'自动安排暂不可用':s.loaded?'自动整理已开启':'自动整理已关闭'}</a><p>下一次运行</p><a class="next-time" href="#schedule">${s.loaded?esc(nextTime):'尚未安排'}</a><small>${s.loaded?`${esc(fmt(s.nextRun))} · 每 ${s.intervalHours} 小时一次`:'在自动安排中设置时间'}</small>${button(busy()?'查看本轮进度':'▷ 运行一轮',busy()?'pending-page':'manual-run','','primary')}<dl><dt>今日已处理</dt><dd>${o.usedToday} / ${o.policy.daily} 条</dd><dt>最近一轮</dt><dd><a href="#history">${o.lastRun?esc(summary.label):'暂无记录'}</a></dd><dt>账号连接</dt><dd><a href="#account">${o.session.online==='verified'?'上次验证可用':o.session.online==='login_required'?'需要重新登录':'尚未在线确认'}</a></dd></dl></section>
    <section class="overview-attention"><h2>需要你看一下</h2>${o.review?button(`${o.review} 条用途待确认 ›`,'review-items','','attention-link'):''}${o.failed?button(`${o.failed} 条处理失败 ›`,'failed-items','','attention-link'):''}${!o.review&&!o.failed?'<p class="muted">暂时没有需要处理的事项。</p>':''}</section></aside></div><footer class="overview-footer">共 ${o.total} 条收藏 · <a href="#collection">查看收藏记录</a> · 视频保存在${serverMode?'服务器':'本机'}</footer>`;
}
function videosPage() {
  return `${head('视频','<span id="video-count">读取中</span>')}<div class="toolbar"><span class="muted">已保留的视频，与笔记独立浏览</span>${searchField(state.videos.q,'搜索标题、作者','videos-search')}</div><div id="video-list">${empty('正在读取…')}</div>`;
}
async function loadVideos() {
  const epoch=++listEpoch,page=pageEpoch,s=state.videos;
  const data=await api('items?'+query({videos:1,size:12,q:s.q,page:s.page}));
  if(epoch!==listEpoch||page!==pageEpoch)return;s.data=data;s.page=data.page;
  $('#video-count').textContent=`${data.total} 个视频`;
  $('#video-list').innerHTML=data.items.length?`<div class="video-grid video-library">${videoCards(data.items)}</div>${pagination(data,'videos')}`:empty(s.q?'没有找到匹配的视频':'还没有保留的视频，可在收藏记录中选择视频用途');
}
function galleriesPage() {
  return `${head('图集','<span id="gallery-count">读取中</span>',button('刷新','refresh','','quiet'))}<div class="toolbar"><span class="muted">整组图片保存在${serverMode?'服务器':'本机'}，按原顺序浏览 · 暂不整理笔记</span>${searchField(state.galleries.q,'搜索标题、作者','galleries-search')}</div><div id="gallery-list">${empty('正在读取…')}</div>`;
}
async function loadGalleries() {
  const epoch=++listEpoch,page=pageEpoch,s=state.galleries;
  const data=await api('items?'+query({galleries:1,size:12,q:s.q,page:s.page}));
  if(epoch!==listEpoch||page!==pageEpoch)return;s.data=data;s.page=data.page;
  $('#gallery-count').textContent=`${data.total} 组图集`;
  $('#gallery-list').innerHTML=data.items.length?`<div class="gallery-grid">${data.items.map(i=>`<button class="gallery-card" data-action="view-gallery" data-id="${i.id}"><span class="gallery-cover"><img src="api/gallery-image?id=${i.id}&index=0" alt="" loading="lazy"><small>${i.image_count||'多'} 张</small></span><strong>${esc(titleOf(i))}</strong><span>${esc(i.author||'未知作者')} · 已保存到${serverMode?'服务器':'本机'}</span></button>`).join('')}</div>${pagination(data,'galleries')}`:empty(s.q?'没有找到匹配的图集':'还没有保存的图集。运行后会处理新收藏及此前因不支持图集而跳过的作品，历史基线保持不变。');
}
let galleryData=null,galleryIndex=0;
async function viewGallery(id) {
  const epoch=++dialogEpoch;galleryData=null;galleryIndex=0;drawerId=null;
  openDialog(dialogHead('图集')+empty('正在读取本地图片…'));
  dialog.className='gallery-modal';
  try {
    const data=await api('gallery?'+query({id}));if(epoch!==dialogEpoch||!dialog.open)return;
    galleryData=data;renderGallery();
  }catch(e){if(epoch===dialogEpoch&&dialog.open)dialog.innerHTML=dialogHead('图集')+empty(e.message);}
}
function renderGallery() {
  if(!galleryData)return;
  const {item,images}=galleryData,id=item.id;
  galleryIndex=Math.max(0,Math.min(images.length-1,galleryIndex));
  const src='api/gallery-image?'+query({id,index:galleryIndex});
  dialog.innerHTML=dialogHead(esc(titleOf(item)))+`<div class="gallery-viewer"><div class="gallery-stage"><a href="${src}" target="_blank" rel="noopener" aria-label="打开第 ${galleryIndex+1} 张原图"><img src="${src}" alt="第 ${galleryIndex+1} 张图片"></a></div><div class="gallery-controls">${button('← 上一张','gallery-step',`data-step="-1" ${galleryIndex===0?'disabled':''}`,'quiet')}<span aria-live="polite">${galleryIndex+1} / ${images.length}</span>${button('下一张 →','gallery-step',`data-step="1" ${galleryIndex===images.length-1?'disabled':''}`,'quiet')}</div><div class="gallery-thumbnails" aria-label="选择图片">${images.map((image,index)=>`<button data-action="gallery-select" data-index="${index}" aria-label="第 ${index+1} 张" aria-pressed="${index===galleryIndex}"><img loading="lazy" src="api/gallery-image?id=${id}&index=${index}" alt=""></button>`).join('')}</div><footer><small>${esc(item.author||'未知作者')} · ${images.length} 张 · ${bytes(item.media_bytes)}</small><div class="row"><a class="button quiet" href="${src}" target="_blank" rel="noopener">查看原图 ↗</a>${button('打开本地文件夹','open',`data-kind="gallery-folder" data-id="${id}"`,'quiet')}${button('原图集 ↗','open',`data-kind="source" data-id="${id}"`,'quiet')}</div></footer></div>`;
  const selected=dialog.querySelector('.gallery-thumbnails [aria-pressed=true]');
  selected?.focus({preventScroll:true});selected?.scrollIntoView({block:'nearest',inline:'nearest'});
}
dialog.addEventListener('keydown',event=>{
  if(!galleryData||!dialog.classList.contains('gallery-modal')||!['ArrowLeft','ArrowRight'].includes(event.key))return;
  event.preventDefault();galleryIndex+=event.key==='ArrowRight'?1:-1;renderGallery();
});
function resultsPage() {
  const s=state.results;
  return `${head('笔记','<span id="result-count">读取中</span>',button('笔记目录 ↗','open','data-kind="notes-folder"','quiet'))}<section class="reading" data-reader="${s.reader}">
    <aside class="reading-list" aria-label="结果列表">${searchField(s.q,'搜索标题、作者','results-search')}${filterButtons([['all','全部'],['notes','笔记'],['text','仅文字稿']],s.status,'result-filter')}<div id="result-list">${empty('正在读取…')}</div><div id="result-pagination"></div></aside>
    <section id="reader" class="reader" aria-label="阅读正文">${empty('选择一份内容开始阅读')}</section></section>`;
}
function resultRows() {
  const s=state.results,data=s.data;
  $('#result-count').textContent=`${data.total} 份结果`;
  $('#result-list').innerHTML=data.items.length?data.items.map(i=>`<button type="button" class="note-item ${i.id===s.id?'active':''}" data-action="select-result" data-id="${i.id}" aria-pressed="${i.id===s.id}"><strong>${esc(titleOf(i))}</strong><small>${esc(i.author||'未知作者')} · ${i.media_type==='gallery'?'图集':duration(i.duration_s)}</small><span class="between"><small>${esc(fmt(i.extracted_at||i.transcribed_at))}</small>${tag(i.note_path?'笔记':'文字稿')}</span></button>`).join(''):empty(s.q?'没有找到匹配的结果':'整理完成的笔记和文字稿会显示在这里');
  $('#result-list').scrollTop=0;
  $('#result-pagination').innerHTML=data.items.length?pagination(data,'results'):'';
}
async function loadResults() {
  const epoch=++listEpoch,page=pageEpoch,s=state.results;
  const data=await api('items?'+query({results:1,size:8,q:s.q,status:s.status,page:s.page}));
  if(epoch!==listEpoch||page!==pageEpoch)return;
  s.data=data;s.page=data.page;
  if(!data.items.some(i=>i.id===s.id)){s.id=data.items[0]?.id||null;s.kind=data.items[0]?.note_path?'note':'formatted';}
  resultRows();await loadDocument();
}
async function loadDocument() {
  const epoch=++docEpoch,page=pageEpoch,s=state.results,id=s.id,kind=s.kind;
  // 桌面固定阅读外框；窄屏在加载前定位，避免异步返回再拖动页面。
  if(s.reader&&matchMedia('(max-width:760px)').matches)$('#reader').scrollIntoView({block:'start',behavior:'instant'});
  if(!id){$('#reader').innerHTML=empty('还没有可阅读的内容');return;}
  const i=s.data.items.find(i=>i.id===id);
  const tools=`<div class="reader-tools"><div class="row">${button('‹ 返回列表','reader-back','','quiet mobile-back')}${filterButtons([...(i.note_path?[['note','知识笔记']]:[]),['formatted','格式化转写']],kind,'document-kind')}</div><div class="row">${kind==='note'?button('Obsidian ↗','open',`data-kind="note" data-id="${id}"`,'quiet'):''}${button('原视频 ↗','open',`data-kind="source" data-id="${id}"`,'quiet')}</div></div>`;
  $('#reader').innerHTML=tools+empty('正在读取正文…');
  try {
    const doc=i.note_path?await api('document?'+query({id,kind:'note'})):{item:i,content:''};if(epoch!==docEpoch||page!==pageEpoch)return;
    const content=splitNoteContent(doc.content)[kind];
    $('#reader').innerHTML=tools+`<div class="reader-content" tabindex="0" role="region" aria-label="正文阅读区"><article class="article"><div class="kicker">${kind==='note'?'知识笔记':'格式化转写'}</div><h2>${esc(titleOf(doc.item))}</h2><div class="byline">${esc(doc.item.author||'未知作者')} · ${duration(doc.item.duration_s)} · ${esc(fmt(kind==='note'?doc.item.extracted_at:doc.item.transcribed_at))}</div><div class="prose">${content===null?empty('尚未生成格式化转写，原始转写仍保留在本地。'):renderMarkdown(content,{headingOffset:1})}</div></article><footer class="reader-footer"><span>${esc(doc.item.category||'未分类')}</span>${i.note_path?button('在文件夹中显示','open',`data-kind="folder" data-file-kind="note" data-id="${id}"`,'quiet'):''}</footer></div>`;
  }catch(e){if(epoch===docEpoch&&page===pageEpoch)$('#reader').innerHTML=tools+empty(e.message);}
}
function collectionPage() {
  const s=state.collection,o=state.overview;
  return `${head('收藏记录',`${o.total} 条 · 最近同步 ${esc(fmt(o.baseline?.scanned_at))}`,button('刷新','refresh','','quiet'))}<p class="muted">知识笔记：语音转写与整理 · 视频：保存高清原声 · 图集：保存图片。三类独立处理，信息不足时待确认。</p><div class="toolbar">${filterButtons([['all','全部'],['review',`待确认 · ${o.review}`],['failed',`失败 · ${o.failed}`],['saved','已保存']],s.status,'collection-filter')}${searchField(s.q,'搜索标题、作者','collection-search')}<label class="extra-filter">更多状态<select id="collection-status" aria-label="更多收藏状态"><option value="all">更多状态</option>${Object.entries(STATUSES).map(([key,label])=>`<option value="${key}" ${s.status===key?'selected':''}>${label}</option>`).join('')}<option value="baseline" ${s.status==='baseline'?'selected':''}>历史基线</option></select></label></div><div id="collection-list">${empty('正在读取…')}</div>`;
}
async function loadCollection() {
  const epoch=++listEpoch,page=pageEpoch,s=state.collection;
  const data=await api('items?'+query({size:15,q:s.q,status:s.status,page:s.page}));if(epoch!==listEpoch||page!==pageEpoch)return;
  s.data=data;s.page=data.page;
  $('#collection-list').innerHTML=data.items.length?`<div class="table-wrap"><table class="collection-table"><thead><tr><th>收藏内容</th><th>处理类型</th><th>媒体现状</th><th>当前结果</th><th aria-label="操作"></th></tr></thead><tbody>${data.items.map(i=>`<tr><td><button class="item-title" data-action="detail" data-id="${i.id}">${esc(titleOf(i))}</button><small>${esc(i.author||'未知作者')} · ${i.media_type==='gallery'?'图集':duration(i.duration_s)}</small>${i.last_error?`<span class="cell-error">${esc(i.last_error)}</span>`:''}</td><td>${esc(i.media_type==='gallery'?'图集':PURPOSES[i.processing_mode]||'尚未分流')}${i.routing_preview?`<small class="suggestion">建议：${esc(PURPOSES[i.routing_preview.purpose]||i.routing_preview.purpose)} · 未应用</small>`:''}</td><td>${esc(mediaLabel(i))}</td><td>${['failed','review'].includes(i.status)&& (i.note_path||i.text_path)?tag(STATUSES[i.status],i.status==='failed'?'danger':'warn')+' ':''}${tag(resultLabel(i),i.status==='failed'?'danger':i.status==='review'?'warn':i.note_path||i.status==='saved'?'green':'')}${i.skip_reason?`<small>${esc(REASONS[i.skip_reason]||i.skip_reason)}</small>`:''}</td><td>${i.media_type==='gallery'&&i.status==='saved'?button('查看图集','view-gallery',`data-id="${i.id}"`,'quiet'):i.note_path||i.text_path?button('阅读','read',`data-id="${i.id}" data-kind="${i.note_path?'note':'formatted'}"`,'quiet'):button('详情','detail',`data-id="${i.id}"`,'quiet')}</td></tr>`).join('')}</tbody></table></div>${pagination(data,'collection')}`:empty(s.q?'没有找到匹配的收藏':'这个筛选下还没有收藏');
}
function openDialog(html,drawer=false) {
  stopVideo();
  dialog.className=drawer?'drawer':'modal';dialog.innerHTML=html;if(!dialog.open)dialog.showModal();
}
const dialogHead=title=>`<header class="dialog-head"><h2 id="dialog-title">${title}</h2>${button('关闭','close-dialog','','quiet')}</header>`;
function stopVideo(){clearTimeout(videoTimer);const v=dialog.querySelector('video');if(v){v.pause();v.removeAttribute('src');v.load();}}
function videoMessage(message){const p=dialog.querySelector('#video-message');if(p)p.textContent=message;}
function videoDeleteButton(item) {
  return item.media_type!=='gallery'&&item.media_path&&!item.media_deleted
    ?button('删除视频','delete-video',`data-id="${item.id}" data-idle ${busy()?'disabled':''}`,'quiet danger'):'';
}
function processingButtons(item) {
  const attrs=`data-id="${item.id}" data-idle ${busy()?'disabled':''}`;
  return (item.can_discard?button('放弃处理','discard-item',`${attrs} title="停止自动处理，保留收藏记录和本地文件"`,'quiet danger'):'')
    +(item.can_delete?button('删除记录','delete-item',`${attrs} title="从本机列表移除，不取消抖音收藏"`,'quiet danger'):'');
}
function processingPanel(item) {
  if(!item.can_discard&&!item.can_delete&&item.skip_reason!=='user_discarded')return '';
  const hint=item.skip_reason==='user_discarded'?'已放弃处理。重新选择用途并保存即可恢复。'
    :'放弃处理会停止自动处理，保留收藏记录和本地文件。';
  return `<section><h3>处理操作</h3><p class="muted">${hint}${item.can_delete?' 删除记录会从本机列表移除，不取消抖音收藏。':''}</p><div class="row">${processingButtons(item)}</div></section>`;
}
async function stopProcessing(action,id) {
  if(action==='delete-item'&&!window.confirm('删除这条收藏记录？只会从本机列表移除，不会取消抖音收藏；此操作不可恢复。'))return;
  if(action==='discard'&&!window.confirm('放弃处理这条收藏？记录和已有本地文件会保留，之后仍可重新选择用途。'))return;
  const epoch=dialogEpoch;
  await api(action,{id});
  delete state.review.choices[id];
  if(action==='delete-item'&&dialog.open&&epoch===dialogEpoch&&drawerId===id)closeDialog();
  await refreshOverview();
  if(state.route==='pending')await loadPending();
  else if(state.route==='collection'){
    if(action==='delete-item')await go('collection');
    else await loadCollection();
  }
  if(action==='discard'&&dialog.open&&epoch===dialogEpoch&&drawerId===id)await detail(id);
  notice(action==='discard'?'已放弃处理，记录和本地文件保留；可在收藏详情重新选择用途恢复。':'记录已从本机列表移除，再次扫描不会重新处理；抖音收藏保持不变。');
}
function videoNoteLabel(item) {
  return item.status==='extracted'?(item.retain_media?'内容不足，视频保留':'笔记已生成，待清理视频')
    :['failed','skipped'].includes(item.status)?'转换未完成，视频保留':'待转为笔记';
}
function videoNoteButton(item) {
  if(item.media_deleted||item.media_type==='gallery')return '';
  if(item.delete_after_note&&item.processing_mode==='note')return `<span data-video-note-button>${button(esc(videoNoteLabel(item)),'','disabled','quiet')}</span>`;
  return item.can_convert_to_note?`<span data-video-note-button>${button('转为笔记','video-to-note',`data-id="${item.id}" data-idle ${busy()?'disabled':''}`,'quiet')}</span>`:'';
}
function videoNoteHint(item) {
  if(serverMode)return '';
  if(item.media_deleted||(!item.can_convert_to_note&&!item.delete_after_note))return '';
  let text='使用本地视频整理笔记，成功后原视频自动移入废纸篓。';
  if(item.delete_after_note) {
    if(['failed','skipped'].includes(item.status)||item.retain_media)text='转换未完整完成，原视频已保留。可在收藏详情查看原因。';
    else if(item.status==='extracted')text='笔记已保存，原视频将在运行收尾时移入废纸篓；清理失败会在下次运行重试。';
    else text=state.overview?.scheduler.loaded?'已加入待办，下次定时运行时整理笔记，成功后原视频自动移入废纸篓。':'已加入待办。自动整理已关闭，请开启自动安排或手动运行；成功后原视频自动移入废纸篓。';
  }
  return `<p class="muted" data-video-note-hint>${esc(text)}</p>`;
}
async function queueVideoNote(id) {
  const epoch=dialogEpoch;
  await api('video-to-note',{id});
  await refreshOverview();
  const item=await api('item?'+query({id}));
  if(dialog.open&&dialogEpoch===epoch) {
    if(drawerId===id)await detail(id);
    else {
      const control=dialog.querySelector('[data-video-note-button]'),hint=dialog.querySelector('[data-video-note-hint]');
      if(control)control.outerHTML=videoNoteButton(item);
      if(hint)hint.outerHTML=videoNoteHint(item);
    }
  }
  if(state.route==='videos')await loadVideos();
  else if(state.route==='collection')await loadCollection();
  else if(state.route==='pending')await loadPending();
  notice(state.overview.scheduler.loaded?'已加入待办，下次定时运行时转为笔记。':'已加入待办。自动整理已关闭，请开启自动安排或手动运行。');
}
async function deleteVideo(id) {
  const epoch=dialogEpoch;
  stopVideo();
  try {await api('video-delete',{id,confirm:true});}
  catch(error){if(epoch===dialogEpoch&&dialog.open)await playVideo(id);throw error;}
  if(epoch===dialogEpoch&&dialog.open)closeDialog();
  await refreshOverview();
  if(state.route==='videos')await loadVideos();
  else if(state.route==='collection')await loadCollection();
  else if(state.route==='notes')await loadResults();
  notice('视频已移入废纸篓，笔记、文字稿和收藏记录已保留。');
}
const videoAudioKey='dustoff.video-audio';
let videoAudio={volume:0.2,muted:false};
try {
  const saved=JSON.parse(localStorage.getItem(videoAudioKey));
  if(typeof saved?.volume==='number'&&Number.isFinite(saved.volume)&&saved.volume>=0&&saved.volume<=1)videoAudio.volume=saved.volume;
  if(typeof saved?.muted==='boolean')videoAudio.muted=saved.muted;
} catch {} // 存储不可用时仍以低音量播放，并在当前页面内记住调整。
function restoreVideoAudio(video) {
  video.volume=videoAudio.volume;video.muted=videoAudio.muted;
  video.addEventListener('volumechange',()=>{
    videoAudio={volume:video.volume,muted:video.muted};
    try {localStorage.setItem(videoAudioKey,JSON.stringify(videoAudio));} catch {}
  });
}
async function preparePlayback(id,epoch) {
  if(epoch!==dialogEpoch||!dialog.open)return;
  const v=dialog.querySelector('video');if(!v||v.dataset.preparing==='true')return;
  v.dataset.preparing='true';v.pause();videoMessage('正在准备兼容播放，首次需要稍等；原视频会保留。');
  try {
    let status=await api('video-prepare',{id});
    const check=async()=>{
      if(epoch!==dialogEpoch||!dialog.open)return;
      if(status.state==='ready'){
        v.dataset.compatible='true';v.dataset.preparing='false';v.src='api/video?'+query({id,compatible:1});v.load();void v.play().catch(()=>{});videoMessage('播放兼容副本 · 原视频保留');return;
      }
      if(status.state==='failed')throw new Error(status.error);
      videoTimer=setTimeout(async()=>{try{status=await api('video-status?'+query({id}));await check();}catch(e){if(epoch===dialogEpoch){v.dataset.preparing='false';videoMessage(e.message);}}},1200);
    };
    await check();
  } catch(e){if(epoch===dialogEpoch){v.dataset.preparing='false';videoMessage(e.message);}}
}
async function playVideo(id) {
  const epoch=++dialogEpoch;drawerId=null;
  openDialog(dialogHead('视频 · 页内播放')+empty('正在读取本地视频…'));dialog.classList.add('video-dialog');
  try {
    const [i]=await Promise.all([api('item?'+query({id})),api('video-status?'+query({id}))]);
    if(epoch!==dialogEpoch||!dialog.open)return;
    // 即使已有兼容缓存，也优先尝试原片，避免支持原格式的浏览器默认降画质。
    const compatible=false;
    dialog.innerHTML=dialogHead('视频 · 页内播放')+`<video class="local-video" controls playsinline preload="metadata" aria-label="${esc(titleOf(i))}" poster="api/video-poster?id=${id}" data-compatible="${compatible}"></video><div class="video-details"><h3>${esc(titleOf(i))}</h3><p class="muted">${esc(i.author||'未知作者')} · ${i.media_type==='gallery'?'图集':duration(i.duration_s)} · ${esc(mediaLabel(i))}</p><p id="video-message" role="status" aria-live="polite">${compatible?'播放兼容副本 · 原视频保留':'正在载入本地视频…'}</p><div class="row">${i.note_path||i.text_path?button('阅读笔记 / 文字稿','read',`data-id="${id}" data-kind="${i.note_path?'note':'formatted'}"`,'quiet'):''}${button('用外部播放器打开 ↗','open',`data-id="${id}" data-kind="video"`,'quiet')}${button('切换兼容播放','prepare-video',`data-id="${id}"`,'quiet')}${videoNoteButton(i)}${videoDeleteButton(i)}</div>${videoNoteHint(i)}</div>`;
    const v=dialog.querySelector('video');
    v.addEventListener('loadeddata',()=>{if(epoch===dialogEpoch)videoMessage(v.dataset.compatible==='true'?'播放兼容副本 · 原视频保留':'本地原视频 · 无需上传');});
    v.addEventListener('error',()=>{if(epoch!==dialogEpoch||!dialog.open)return;if(v.dataset.compatible==='true')videoMessage('播放失败，可尝试外部播放器，或重新打开此视频。');else void preparePlayback(id,epoch);});
    // 在设置视频源和开始播放之前恢复音量，避免开头瞬间以满音量出声。
    restoreVideoAudio(v);
    v.src='api/video?'+query({id,...(compatible?{compatible:1}:{})});
    void v.play().catch(()=>{});
  }catch(e){if(epoch===dialogEpoch&&dialog.open)dialog.innerHTML=dialogHead('视频暂不可播放')+empty(e.message);}
}
async function detail(id) {
  drawerId=id;const epoch=++dialogEpoch;
  openDialog(dialogHead('收藏详情')+empty('正在读取…'),true);
  try {
    const i=await api('item?'+query({id}));if(epoch!==dialogEpoch||!dialog.open)return;
    dialog.innerHTML=dialogHead('收藏详情')+`<div class="drawer-body"><h3>${esc(titleOf(i))}</h3><p class="muted">${esc(i.author||'未知作者')} · ${i.media_type==='gallery'?'图集':duration(i.duration_s)}</p><div class="row">${tag(STATUSES[i.status]||i.status)}${tag(mediaLabel(i))}</div><section><h3>留下的内容</h3><div class="file-actions">${i.note_path?button('阅读知识笔记','read',`data-id="${id}" data-kind="note"`):''}${i.note_path||i.text_path?button('阅读格式化转写','read',`data-id="${id}" data-kind="formatted"`):''}${i.media_path&&!i.media_deleted?button(i.media_type==='gallery'?'查看图集':'播放视频',i.media_type==='gallery'?'view-gallery':'play-video',`data-id="${id}"`):''}${button('查看原作品 ↗','open',`data-id="${id}" data-kind="source"`,'quiet')}${videoNoteButton(i)}${videoDeleteButton(i)}</div>${videoNoteHint(i)}${!i.note_path&&!i.text_path?`<p class="muted">${i.media_type==='gallery'?'图集仅保存图片，暂不整理笔记。':'暂未生成文字内容。'}</p>`:''}</section>${i.media_type==='gallery'?'<section><h3>保存图集</h3><p class="muted">按原顺序保存整组图片，每组计一条每日额度。</p></section>':`<section><h3>这条收藏用来做什么</h3><p class="muted">${esc(i.routing_reason||'用途决定接下来保留视频还是提取知识。')}</p>${i.routing_preview?`<div class="callout">建议：${esc(PURPOSES[i.routing_preview.purpose]||i.routing_preview.purpose)}，尚未应用。${esc(i.routing_preview.reason||'')}</div>`:''}<form method="post" id="purpose-form"><input type="hidden" name="id" value="${id}"><div class="purpose-options">${Object.entries(PURPOSES).filter(([key])=>key!=='gallery').map(([key,label])=>`<label><input type="radio" name="purpose" value="${key}" ${i.processing_mode===key?'checked':''} ${!i.can_change_purpose?'disabled':''} required><span>${label}<small>${({note:'语音转写并整理知识笔记',video:'只保存高清原声视频',review:'暂不处理，等你确认'})[key]}</small></span></label>`).join('')}</div>${i.can_change_purpose?`<p class="muted">保存后更新用途与待办状态，下一轮运行时处理；已有文件保留。</p><button class="button primary" data-idle ${busy()?'disabled':''}>保存用途</button>`:'<p class="muted">这条收藏不在可修改用途的处理范围内。</p>'}</form></section>`}${i.last_error?`<section class="error-detail"><h3>上次未完成</h3><p>${esc(i.last_error)}</p>${i.status==='failed'?button('恢复为待办','retry',`data-id="${id}" data-idle ${busy()?'disabled':''}`):''}</section>`:''}<details><summary>作品信息</summary><dl><dt>作品 ID</dt><dd>${id}</dd><dt>处理状态</dt><dd>${esc(STATUSES[i.status]||i.status)}</dd><dt>跳过原因</dt><dd>${esc(REASONS[i.skip_reason]||i.skip_reason||'无')}</dd><dt>更新时间</dt><dd>${esc(fmt(i.updated_at))}</dd></dl></details></div>`;
    if(i.media_type!=='gallery'&&(i.can_discard||i.can_delete||i.skip_reason==='user_discarded'))dialog.querySelector('.drawer-body')?.insertAdjacentHTML('beforeend',processingPanel(i));
  }catch(e){if(epoch===dialogEpoch&&dialog.open)dialog.innerHTML=dialogHead('收藏详情')+empty(e.message);}
}
function executionPanel() {
  const e=state.overview.execution;
  return `<div class="execution ${e.running?'active':''}"><div><span class="dot"></span><strong>${e.running?'正在执行'+({run:'本轮整理',retry:'恢复待办',purpose:'保存用途',login:'扫码登录','session-check':'登录检查'}[e.kind]||'任务'):'准备好整理下一批收藏'}</strong><small>${e.running?`开始于 ${esc(fmt(e.startedAt))}${e.owned?'':' · 由其他入口启动'}`:'完成后，可在笔记、视频和图集栏目查看成果。'}</small></div><div class="row">${e.running?(e.owned?button('停止本轮','stop'):'')+`<a class="button quiet" href="#history">查看记录 ›</a>`:button('现在运行','manual-run','data-idle','primary')}</div></div>`;
}
function pendingPage() {
  return `${head('待处理','',button('刷新','refresh','','quiet'))}<div id="pending-content">${empty('正在读取…')}</div>`;
}
function reviewRow(i) {
  const choice=state.review.choices[i.id];
  return `<article class="review-row"><div class="review-info"><h3><button class="item-title" data-action="detail" data-id="${i.id}">${esc(i.title||i.id)}</button></h3><small>${esc(i.author||'未知作者')} · ${duration(i.duration_s)}</small><p class="muted">${esc(i.routing_reason||'需要你确认这条收藏的用途。')}</p><div class="row">${button('查看原作品 ↗','open',`data-id="${i.id}" data-kind="source"`,'quiet')}${processingButtons(i)}</div></div><form class="review-form" method="post" aria-label="确认 ${esc(i.title||i.id)} 的用途"><input type="hidden" name="id" value="${i.id}"><fieldset><legend>选择用途</legend>${[['note','知识笔记','语音转写并整理笔记'],['video','视频','保存高清原声视频']].map(([key,label,hint])=>`<label><input type="radio" name="purpose" value="${key}" required ${choice===key?'checked':''}><span>${label}<small>${hint}</small></span></label>`).join('')}</fieldset><button type="submit" class="button primary" data-idle ${busy()?'disabled':''}>确认用途</button></form></article>`;
}
async function loadPending() {
  const epoch=++listEpoch,page=pageEpoch;
  const [reviews,queue]=await Promise.all([api('items?'+query({status:'review',page:state.review.page,size:10})),api('queue')]);
  if(epoch!==listEpoch||page!==pageEpoch||state.route!=='pending')return;
  state.review.page=reviews.page;
  const o=state.overview;
  $('#pending-content').innerHTML=`<section class="review-section" aria-label="待确认用途"><div class="between"><h2>待确认 · ${reviews.total} 条</h2><small>确认后，下轮运行时处理</small></div><p class="muted">知识笔记用于语音转写与整理，视频用于保存高清原声。选择用途后点击确认；不需要处理的内容可放弃处理或删除记录。</p>${reviews.items.length?reviews.items.map(reviewRow).join('')+pagination(reviews,'review'):empty('没有待确认的收藏。需要你判断用途的内容会显示在这里。')}</section><section class="run-section" aria-label="等待自动处理"><div class="between"><h2>等待自动处理 · ${o.pending} 条</h2><small>按实际处理顺序 · 最多显示 10 条</small></div>${queue.items.length?queue.items.map(i=>`<div class="queue-row"><div><button class="item-title" data-action="detail" data-id="${i.id}">${esc(titleOf(i))}</button><small>${esc(i.author||'未知作者')} · ${i.media_type==='gallery'?'图集':duration(i.duration_s)}</small></div><span>${esc(i.media_type==='gallery'?'图集':PURPOSES[i.processing_mode]||'等待判断用途')}</span>${tag(STATUSES[i.status]||i.status)}</div>`).join(''):empty('当前没有等待自动处理的收藏。')}${!o.baseline?'<div class="callout">第一次运行只建立历史收藏参照，不下载历史视频。之后处理新收藏。</div>':''}${o.needsLogin||o.session.level==='expired'?'<div class="callout">登录需要更新，新收藏扫描可能受阻。<a href="#account">前往账号连接 ›</a></div>':''}<div id="run-status">${executionPanel()}</div><p class="muted">今日已处理 ${o.usedToday} / ${o.policy.daily} 条${o.failed?` · ${button(`${o.failed} 条失败需查看 ›`,'failed-items','','quiet')}`:''}</p></section><div class="footnote"><a href="#schedule">设置自动安排 ›</a><a href="#rules">调整处理规则 ›</a></div>`;
}
function manualRun() {
  const o=state.overview;
  drawerId=null;++dialogEpoch;
  openDialog(dialogHead('运行一轮')+`<form method="post" id="run-form" class="modal-body"><p class="muted">${o.baseline?`本地待办 ${o.pending} 条，今日剩余额度 ${Math.max(0,o.policy.daily-o.usedToday)} 条。`:'第一次运行只建立历史参照，不下载视频。'}</p><label class="form-row"><span>本轮最多处理<small>同时受每日额度限制</small></span><input name="limit" aria-label="本轮最多处理" type="number" min="1" max="${o.policy.daily}" value="${Math.max(1,Math.min(10,o.policy.daily-o.usedToday))}" required></label><label class="check-row"><input name="noScan" type="checkbox" ${!o.baseline?'disabled':''}><span>只继续已有待办<small>跳过本次新收藏扫描</small></span></label><p class="muted">可在待处理页面停止；已经完成的阶段会保留。</p><div class="savebar"><button class="button primary" data-idle ${busy()?'disabled':''}>开始运行</button>${button('取消','close-dialog')}</div></form>`);
}
function schedulePage() {
  const s=state.overview.scheduler;
  if(s.error)return `${head('运行')}${tabs('run')}<div class="callout">${esc(s.error)}</div>${button('重试','refresh')}`;
  return `${head('运行')}${tabs('run')}${s.warning?`<div class="callout">${esc(s.warning)}</div>`:''}<div class="two-col"><form method="post" id="schedule-form"><h2>自动安排</h2><p class="muted">后台启动时自动开启；刷新或重新打开网页不会改变开关状态。</p><label class="form-row"><span>起始时间<small>按${serverMode?'服务器':'本机'}时区 ${esc(s.timezone||'')}</small></span><input name="time" type="time" value="${esc(s.time)}" required></label><label class="form-row"><span>重复间隔<small>从起始时间起，每隔这些小时运行</small></span><span class="input-unit"><input name="intervalHours" aria-label="重复间隔小时" type="number" min="1" max="720" value="${s.intervalHours}" required>小时</span></label><label class="form-row"><span>${serverMode?'服务器重启后自动启用':'登录电脑后自动启用'}<small>${serverMode?'无需保持浏览器或 Mac 开机':'关机或注销后，在下次登录时加载安排'}</small></span><input class="toggle" name="autoStartAfterReboot" type="checkbox" ${s.autoStartAfterReboot?'checked':''}></label><div class="savebar"><button class="button primary">保存安排</button><small>已开启时保存立即更新；关闭时只保存配置。</small></div></form><aside><div class="schedule-state">${tag(s.loaded?'自动整理已开启':'自动整理已关闭',s.loaded?'green':'')}<h2>${s.loaded?esc(fmt(s.nextRun)):'等待开启'}</h2><p class="muted">${s.loaded?'下一次安排':'保存好时间后，开启自动整理。'}</p>${button(s.loaded?'关闭自动整理':'开启自动整理','schedule-toggle',`data-value="${s.loaded?'stop':'start'}" ${s.running?'disabled':''}`)}</div><h3>接下来三次</h3><div id="schedule-preview"></div><p class="muted">预览以当前表单为准。${serverMode?'任务在服务器运行，关闭网页不影响自动整理。':'电脑需要处于登录状态；睡眠期间由系统恢复后触发。'}</p></aside></div>`;
}
function schedulePreview() {
  const form=$('#schedule-form');if(!form)return;
  try {
    const data=new FormData(form),saved=state.overview.scheduler,time=data.get('time'),intervalHours=Number(data.get('intervalHours'));
    const unchanged=time===saved.time&&intervalHours===saved.intervalHours;
    const plan=makePlan({time,intervalHours,startAt:unchanged?saved.startAt||null:null});
    const start=Date.parse(nextOccurrence(plan));
    $('#schedule-preview').innerHTML=Array.from({length:3},(_,n)=>`<div class="upcoming"><span>${n===0?'下一次':'然后'}</span><strong>${esc(fmt(start+n*intervalHours*3600000))}</strong></div>`).join('');
  }catch(e){$('#schedule-preview').textContent=e.message;}
}
function historyPage() {
  return `${head('运行','',button('刷新','refresh','','quiet'))}${tabs('run')}<div class="toolbar"><h2>运行记录</h2>${filterButtons([['business','整理批次'],['scheduler','定时输出'],['console','控制台操作']],state.logKind,'log-kind')}</div><div class="history-layout" data-kind="${state.logKind}"><aside id="run-list" aria-label="运行批次"></aside><section id="log-detail" aria-label="运行详情">${empty('正在读取…')}</section></div>`;
}
function runRows() {
  const pages=Math.max(1,Math.ceil(state.runs.length/8));state.runPage=Math.min(state.runPage,pages);
  $('#run-list').innerHTML=state.runs.slice((state.runPage-1)*8,state.runPage*8).map(r=>{const summary=runSummary(r);return `<button class="history-item ${r.id===state.runId?'active':''}" data-action="select-run" data-id="${r.id}" aria-pressed="${r.id===state.runId}"><span>${esc(fmt(r.modifiedAt))}</span><small>${esc(summary.label)}</small><small>${r.id.endsWith('-console-action')?'收藏操作':r.id.endsWith('-run')?'日常整理':esc(r.id.split('-').at(-1))}</small></button>`;}).join('')+(state.runs.length?pagination({page:state.runPage,pages,total:state.runs.length},'runs'):empty('还没有运行记录'));
}
async function loadLog() {
  const epoch=++logEpoch,page=pageEpoch;
  if(state.logKind==='business'&&!state.runId){$('#log-detail').innerHTML=empty('开始运行后，可在这里查看结果。');return;}
  $('#log-detail').innerHTML=empty('正在读取记录…');
  try {
    const data=await api('log?'+query({kind:state.logKind,id:state.runId||''}));if(epoch!==logEpoch||page!==pageEpoch)return;
    const summary=runSummary(data),r=data.result;
    $('#log-detail').innerHTML=state.logKind!=='business'?`<h2>${state.logKind==='console'?'控制台最近操作':'定时最近输出'}</h2><pre class="log">${esc(data.log||'暂无日志')}</pre>`:`<div class="between"><h2>${esc(summary.label)}</h2>${tag(({daily:'日常整理',baseline:'历史基线'})[r?.mode]||'批次记录')}</div><p class="muted">${esc(data.id)}</p>${summary.detail?`<div class="callout ${summary.tone}">${esc(summary.detail)}</div>`:''}${r?`<div class="run-result">${[['processed','处理'],['notes','笔记'],['saved','视频'],['galleries','图集'],['pending','剩余待办']].filter(([key])=>typeof r[key]==='number').map(([key,label])=>`<div><strong>${r[key]}</strong><small>${label}</small></div>`).join('')}</div>`:''}${r?.scanWarning&&summary.detail!==r.scanWarning?`<div class="callout">${esc(r.scanWarning)}</div>`:''}${r?.failures?.length?`<ul class="failure-list">${r.failures.map(f=>`<li>${esc(f.id?f.id+'：':'')}${esc(f.error||'处理失败')}</li>`).join('')}</ul>`:''}${runEvents(data.log)}<details ${!r?'open':''}><summary>查看执行日志</summary><pre class="log">${esc(data.log||'暂无日志')}</pre></details>${r?`<details><summary>查看完整运行数据</summary><pre class="log">${esc(JSON.stringify(r,null,2))}</pre></details>`:''}`;
  }catch(e){if(epoch===logEpoch&&page===pageEpoch)$('#log-detail').innerHTML=empty(e.message);}
}
function runEvents(log='') {
  const events=log.split('\n').map(line=>line.match(/^\[([^\]]+)\]\s*(.+)$/)).filter(match=>match&&/扫描|新增|完成|失败|结束|暂停|保存|基线|恢复|用途|放弃|删除/.test(match[2])).slice(-6);
  return events.length?`<div class="timeline" aria-label="最近执行节点">${events.map(([,time,message])=>`<div><time>${esc(time.match(/\d{2}:\d{2}(?::\d{2})?/)?.[0]||time)}</time><span>${esc(message.slice(0,300))}</span></div>`).join('')}</div>`:'';
}
function field(key) {
  const f=state.settings.fields.find(f=>f.key===key);if(!f)return '';
  const attrs=`name="${key}" ${f.overridden?'disabled':''}`;
  const input=f.type==='select'?`<select ${attrs}>${f.options.map(v=>`<option value="${v}" ${String(f.value)===v?'selected':''}>${key==='DUST_NOTIFY'?(v==='1'?'开启':'关闭'):esc(v)}</option>`).join('')}</select>`:f.type==='textarea'?`<textarea ${attrs} rows="3">${esc(f.value)}</textarea>`:`<input ${attrs} type="${f.type==='path'?'text':f.type}" value="${esc(f.value)}" ${f.type==='number'?`min="${f.min}" max="${f.max}" step="${f.step}"`:''} ${f.type==='password'?`autocomplete="new-password" placeholder="${f.configured?'已配置 · 留空保留':'尚未配置'}"`:'required'}>`;
  return `<label class="field ${f.type==='path'||f.type==='textarea'?'wide':''}"><span>${esc(f.label)}</span>${input}${f.overridden?'<small>由环境变量覆盖，此处只读</small>':f.type==='password'?'<small>留空保留已有密钥</small>':f.clamped?'<small>已显示当前规则下的实际生效值</small>':''}</label>`;
}
function sectionFields(title,keys,note='') {return `<section class="settings-section"><h2>${title}</h2>${note?`<p class="muted">${note}</p>`:''}<div class="fields">${keys.map(field).join('')}</div></section>`;}
function settingsPage() {
  const route=state.route,o=state.overview,s=state.settings;
  let content;
  if(route==='account')content=`<div id="session-card">${sessionCard(o.session)}</div><div id="login-flow"></div>${sectionFields('登录提醒',SETTINGS.account)}`;
  if(route==='models')content=`<div class="model-grid">${[['用途判断','选择如何处理收藏',SETTINGS.models.slice(0,3)],['语音转写','把口播内容转换为文字',SETTINGS.models.slice(3,6)],['笔记整理','从文字稿中整理知识',SETTINGS.models.slice(6,11)]].map(([title,desc,keys])=>`<section class="model-card"><span class="model-mark">${title.slice(0,1)}</span><h2>${title}</h2><p class="muted">${desc}</p>${keys.map(field).join('')}</section>`).join('')}</div><details><summary>转写热词、请求超时与直连配置</summary><div class="fields">${SETTINGS.models.slice(11).map(field).join('')}</div></details>`;
  if(route==='storage')content=`<div class="storage-summary"><div><small>保留的视频与图集</small><strong>${bytes(o.storage.savedUsed)}</strong></div><div><small>临时媒体缓存</small><strong>${bytes(o.storage.used)}</strong></div><div><small>磁盘可用</small><strong>${bytes(o.storage.available)}</strong></div></div><p class="muted">封面与播放副本缓存：${bytes(o.storage.previewUsed)} · 最多 512 MiB，自动回收，可重新生成；原视频不受影响。</p>${o.storage.error?`<div class="callout">部分空间信息未能读取：${esc(o.storage.error)}</div>`:''}${sectionFields('保存位置',SETTINGS.storage.slice(0,3),'修改目录只影响新产物，已有文件不会搬迁。')}<div class="row">${button('打开笔记目录 ↗','open','data-kind="notes-folder"','quiet')}${button('打开运行日志目录 ↗','open','data-kind="runs-folder"','quiet')}</div>${sectionFields('空间与保留',SETTINGS.storage.slice(3),'视频与图集收藏独立保存，不自动清理；缓存按现有清理规则回收。')}<details><summary>数据与缓存路径</summary><dl>${[['运行数据',s.home],['账本数据库',s.database],['媒体缓存',s.media]].map(([name,path])=>`<dt>${name}</dt><dd>${esc(path)}</dd>`).join('')}</dl></details>`;
  if(route==='rules')content=`${sectionFields('日常处理',SETTINGS.rules.slice(0,3),'发现新收藏后，视频按用途保存或提取知识，图集直接保存图片。已有历史基线不会自动进入待办。')}<section class="flow-explanation"><span>发现新收藏</span><b>›</b><span>判断用途</span><b>›</b><span>保存视频 / 保存图集 / 整理笔记</span></section><details><summary>扫描与整轮时限</summary><div class="fields">${SETTINGS.rules.slice(3).map(field).join('')}</div><p class="muted">起始窗口只是首次扫描的数量；未确认到历史边界时会继续翻页。已有基线时，可恢复的扫描错误不会阻断原有待办。</p></details>`;
  return `${head('设置')}${tabs('settings')}<form method="post" id="settings-form"><div class="settings-body">${content}<div class="savebar"><button class="button primary">保存设置</button><small>新配置从下一轮处理开始生效。</small></div></div></form>`;
}
function sessionCard(s) {
  return `<section class="account-card"><div class="account-head"><div class="service-icon">♪</div><div><h2>抖音</h2><p class="muted">连接收藏来源</p></div>${tag(s.online==='verified'?'上次验证可用':s.online==='login_required'?'需要重新登录':'尚未在线确认',s.online==='verified'?'green':'warn')}</div><div class="account-grid"><div><small>登录有效期</small><strong>${esc(remainingLabel(s))}</strong><small>${s.expires_at?'预计到期 '+esc(fmt(s.expires_at)):'尚无固定到期时间'}</small></div><div><small>最近检查</small><strong>${esc(fmt(s.last_check_at))}</strong><small>${s.stale?'建议更新检查':'已记录登录状态'}</small></div><div><small>在线验证</small><strong>${s.online==='verified'?'已确认可用':s.online==='login_required'?'需要登录':'尚未确认'}</strong><small>${esc(fmt(s.online_checked_at))}</small></div></div><div class="account-foot"><p class="muted">有效期按凭据估算；是否可用以在线验证为准。</p><div class="row">${button('立即检查','check-session',`data-idle ${busy()?'disabled':''}`)}${button('扫码登录','login',`data-idle ${busy()?'disabled':''}`,'primary')}</div></div></section>`;
}
async function loadSession() {
  const epoch=pageEpoch,data=await api('session');if(epoch!==pageEpoch||state.route!=='account')return;
  // 不重建设置表单，避免轮询覆盖用户未保存的输入。
  const card=sessionCard(data.session),flow=loginFlow(data);
  if($('#session-card').innerHTML!==card)$('#session-card').innerHTML=card;
  if($('#login-flow').innerHTML!==flow)$('#login-flow').innerHTML=flow;
}
async function go(route) {
  clearTimeout(searchTimer);if(route!==state.route){window.scrollTo({top:0,behavior:'instant'});$('.workspace').scrollTo({top:0,left:0,behavior:'instant'});}const epoch=++pageEpoch;++listEpoch;++docEpoch;++logEpoch;
  if(dialog.open)dialog.close();state.route=routes[route]?(route==='results'?'notes':route==='run'?'pending':route):'overview';route=state.route;
  root.dataset.page=route;
  document.title=`dustoff · ${routes[route]}`;main.innerHTML=empty('正在读取…');syncChrome();
  try {
    const [o,extra]=await Promise.all([api('overview'),SETTINGS[route]?api('settings'):route==='history'?api('runs'):null]);
    if(epoch!==pageEpoch)return;state.overview=o;syncChrome();
    if(SETTINGS[route])state.settings=extra;
    if(route==='history'){state.runs=extra.runs;state.runId=state.runs.some(r=>r.id===state.runId)?state.runId:state.runs[0]?.id;}
    main.innerHTML=route==='overview'?overviewPage():route==='videos'?videosPage():route==='galleries'?galleriesPage():route==='notes'?resultsPage():route==='collection'?collectionPage():route==='pending'?pendingPage():route==='schedule'?schedulePage():route==='history'?historyPage():settingsPage();
    if(route==='pending')await loadPending();if(route==='notes')await loadResults();if(route==='videos')await loadVideos();if(route==='galleries')await loadGalleries();if(route==='collection')await loadCollection();if(route==='schedule')schedulePreview();if(route==='history'){runRows();await loadLog();}if(route==='account')await loadSession();
  }catch(e){if(epoch===pageEpoch)main.innerHTML=`${head(routes[route])}${empty(e.message)}${button('重新读取','refresh')}`;}
}
function navigate(route) {if(location.hash==='#'+route)void go(route);else location.hash=route;}
function closeDialog(){dialog.close();}
dialog.addEventListener('close',()=>{++dialogEpoch;drawerId=null;stopVideo();});
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
async function mutate(path,data,message) {const result=await api(path,data);if(result.error)throw new Error(result.error);await refreshOverview();notice(message);return result;}
async function queueMutation(path,data) {
  const e=await mutate(path,data,path==='purpose'?'正在保存用途…':'正在恢复待办…');
  const expected=e.startedAt;const originalDrawer=dialogEpoch;
  for(let n=0;n<20;n++){
    await new Promise(resolve=>setTimeout(resolve,200));await refreshOverview();
    const current=state.overview.execution;
    if(current.lastAction?.startedAt===expected){
      if(current.lastAction.exitCode!==0)throw new Error('操作未完成，请在「运行 → 运行记录 → 控制台操作」查看原因。');
      notice(path==='purpose'?'用途已保存，下一轮运行时处理。':'已恢复为待办，下一轮运行时处理。');
      delete state.review.choices[data.id];
      if(state.route==='collection')await loadCollection();
      if(state.route==='pending')await loadPending();
      if(dialog.open&&originalDrawer===dialogEpoch&&drawerId===data.id)await detail(data.id);
      return;
    }
  }
  notice('操作仍在执行，可在运行记录中查看结果。');
}
root.addEventListener('click',async event=>{
  const b=event.target.closest('button[data-action]');if(!b||b.disabled)return;
  const a=b.dataset.action,id=b.dataset.id;b.disabled=true;
  try {
    if(a==='dismiss')notice('');
    else if(a==='refresh')await go(state.route);
    else if(a==='close-dialog')closeDialog();
    else if(a==='detail')await detail(id);
    else if(a==='view-gallery')await viewGallery(id);
    else if(a==='gallery-step'){galleryIndex+=Number(b.dataset.step);renderGallery();}
    else if(a==='gallery-select'){galleryIndex=Number(b.dataset.index);renderGallery();}
    else if(a==='play-video')await playVideo(id);
    else if(a==='delete-video')await deleteVideo(id);
    else if(a==='discard-item'||a==='delete-item')await stopProcessing(a==='discard-item'?'discard':'delete-item',id);
    else if(a==='video-to-note')await queueVideoNote(id);
    else if(a==='prepare-video')await preparePlayback(id,dialogEpoch);
    else if(a==='manual-run')manualRun();
    else if(a==='pending-page')navigate('pending');
    else if(a==='text-only'){Object.assign(state.results,{q:'',page:1,status:'text',reader:false});navigate('notes');}
    else if(a==='open')await mutate('open',{kind:b.dataset.kind,id,fileKind:b.dataset.fileKind},'已在本机打开。');
    else if(a==='stop')await mutate('stop',{},'已发送停止请求，正在完成收尾。');
    else if(a==='retry')await queueMutation('retry',{id});
    else if(a==='review-items'){state.review.page=1;navigate('pending');}
    else if(a==='failed-items'){Object.assign(state.collection,{status:'failed',q:'',page:1});navigate('collection');}
    else if(a==='read'){Object.assign(state.results,{id,q:id,page:1,status:b.dataset.kind==='note'?'notes':'all',kind:b.dataset.kind,reader:true});closeDialog();navigate('notes');}
    else if(a==='select-result'){
      const changed=state.results.id!==id;state.results.reader=true;$('.reading').dataset.reader='true';
      if(changed){
        state.results.id=id;state.results.kind=state.results.data.items.find(i=>i.id===id).note_path?'note':'formatted';
        // 保留目录节点、键盘焦点和滚动位置，只更新选中状态。
        root.querySelectorAll('.note-item').forEach(item=>{const active=item.dataset.id===id;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});
        await loadDocument();
      }else if(matchMedia('(max-width:760px)').matches)$('#reader').scrollIntoView({block:'start',behavior:'instant'});
    }
    else if(a==='reader-back'){state.results.reader=false;$('.reading').dataset.reader='false';$('.reading').scrollIntoView({block:'start'});}
    else if(a==='document-kind'&&state.results.kind!==b.dataset.filter){state.results.kind=b.dataset.filter;await loadDocument();}
    else if(a==='result-filter'||a==='collection-filter'){
      const kind=a==='result-filter'?'results':'collection';Object.assign(state[kind],{status:b.dataset.filter,page:1});
      if(kind==='results'){main.innerHTML=resultsPage();await loadResults();}else{main.innerHTML=collectionPage();await loadCollection();}
    }else if(a==='paginate'){
      const kind=b.dataset.kind,step=Number(b.dataset.step);
      if(kind==='runs'){state.runPage+=step;runRows();}else{state[kind].page+=step;if(kind==='results')await loadResults();else if(kind==='videos')await loadVideos();else if(kind==='galleries')await loadGalleries();else if(kind==='review')await loadPending();else await loadCollection();}
    }else if(a==='schedule-toggle'){await mutate('schedule',{action:b.dataset.value},b.dataset.value==='start'?'自动整理已开启。':'自动整理及登录自动启用已关闭。');await go('schedule');}
    else if(a==='log-kind'){state.logKind=b.dataset.filter;main.innerHTML=historyPage();runRows();await loadLog();}
    else if(a==='select-run'){state.runId=id;runRows();await loadLog();}
    else if(a==='login'||a==='check-session'){await mutate(a==='login'?'login':'session-check',{},a==='login'?'正在打开 Chrome 官方登录页。':'正在检查登录状态。');await loadSession();}
    else if(a==='cancel-login'){await mutate('login-control',{action:'cancel'},'已请求取消登录操作。');await loadSession();}
  }catch(e){notice(e.message,true);}finally{if(b.isConnected)b.disabled=b.hasAttribute('data-idle')&&busy();}
});
root.addEventListener('input',event=>{
  const input=event.target;
  if(input.name==='purpose'&&input.closest('.review-form'))state.review.choices[input.form.elements.id.value]=input.value;
  if(['results-search','collection-search','videos-search','galleries-search'].includes(input.id)){
    const kind=input.id.split('-')[0];state[kind].q=input.value;state[kind].page=1;
    // 立即使旧请求失效，避免请求返回时覆盖正在输入的新查询。
    ++listEpoch;++docEpoch;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{(kind==='results'?loadResults():kind==='videos'?loadVideos():kind==='galleries'?loadGalleries():loadCollection()).catch(e=>notice(e.message,true));},250);
  }
  if(input.closest('#schedule-form'))schedulePreview();
});
root.addEventListener('error',event=>{if(event.target.matches?.('.video-cover img'))event.target.hidden=true;},true);
root.addEventListener('change',event=>{if(event.target.id==='collection-status'){state.collection.status=event.target.value;state.collection.page=1;main.innerHTML=collectionPage();loadCollection().catch(e=>notice(e.message,true));}});
root.addEventListener('submit',async event=>{
  const form=event.target,formId=form.getAttribute('id');if(!['settings-form','schedule-form','purpose-form','run-form'].includes(formId)&&!form.matches('.review-form'))return;event.preventDefault();
  const submit=event.submitter||form.querySelector('button:not([type=button])');submit.disabled=true;
  const data=new FormData(form),epoch=pageEpoch;
  try {
    if(formId==='settings-form'){
      const saved=await api('settings',{revision:state.settings.revision,values:Object.fromEntries(data)});notice('设置已保存，从下一轮处理开始生效。');
      if(epoch===pageEpoch){state.settings=saved;main.innerHTML=settingsPage();if(state.route==='account')await loadSession();}await refreshOverview();
    }else if(formId==='schedule-form'){
      await mutate('schedule',{action:'save',time:data.get('time'),intervalHours:Number(data.get('intervalHours')),autoStartAfterReboot:data.has('autoStartAfterReboot')},'自动安排已保存。');if(epoch===pageEpoch)await go('schedule');
    }else if(formId==='run-form'){
      await mutate('run',{limit:Number(data.get('limit')),noScan:data.has('noScan')},'本轮整理已启动。');closeDialog();navigate('pending');
    }else await queueMutation('purpose',{id:data.get('id'),purpose:data.get('purpose')});
  }catch(e){notice(e.message,true);}finally{if(submit.isConnected)submit.disabled=submit.hasAttribute('data-idle')&&busy();}
});
window.addEventListener('hashchange',()=>{notice('');void go(location.hash.slice(1));});
void go(location.hash.slice(1)||'overview');
setInterval(async()=>{
  if(polling||document.hidden)return;polling=true;
  try{
    const wasRunning=busy(),epoch=pageEpoch;await refreshOverview();
    if(state.route==='account')await loadSession();
    if(wasRunning&&!busy()&&epoch===pageEpoch){
      if(state.route==='pending')await loadPending();
      else if(['collection','galleries'].includes(state.route)&&!dialog.open)await go(state.route);
    }
  }catch{/* 短暂轮询失败不覆盖阅读内容或未保存表单；手动刷新会显示具体错误。 */}
  finally{polling=false;}
},4000);
