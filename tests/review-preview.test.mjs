import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function isolated(source, env = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dustoff-preview-')));
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, DUST_HOME: home, DUST_NOTIFY: '0', DUST_ROUTER_KEY: '', DUST_ASR_KEY: '', DUST_LLM_KEY: '', DUST_DASHSCOPE_KEY: '', ...env }, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('收件箱预下载：保存视频移进收藏并直接已保存；笔记原地转写、整理后清理；放弃和删除记录删掉暂存文件', () => isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
  const {acceptScan,setPurpose,discardItem,deleteItem}=await import('./scripts/daily.mjs');
  const {db,markRouting,recordPreview,markTranscribed,markExtracted}=await import('./scripts/ledger.mjs');
  const {REVIEW_MEDIA,SAVED_MEDIA}=await import('./scripts/policy.mjs');
  const {previewEligible,isPreview}=await import('./scripts/review-preview.mjs');
  const {cleanMedia}=await import('./extract.mjs');
  const {processingActions}=await import('./scripts/item-actions.mjs');
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'100',duration_s:5}]});
  acceptScan({ok:true,logged_in:true,truncated:false,items:['1','2','3','4','5'].map(aweme_id=>({aweme_id,desc:'拿不准',duration_s:aweme_id==='5'?1860:5})).concat({aweme_id:'100',duration_s:5}),fetched_at:Date.now()/1000});
  const row=id=>db().prepare('SELECT * FROM items WHERE id=?').get(id);
  for(const id of ['1','2','3','4','5'])markRouting(id,{purpose:'review',reason:'测试'});
  assert.equal(previewEligible(row('1')),true);assert.equal(previewEligible(row('5')),false); // 超过 30 分钟不预下载
  for(const id of ['1','2','3','4']){const dir=join(REVIEW_MEDIA,id);mkdirSync(dir,{recursive:true});const path=join(dir,'video.mp4');writeFileSync(path,'preview '+id);recordPreview(id,{path,bytes:9,gear:'high',has_audio:true,quality:'high'});}
  assert.equal(row('1').status,'review');assert.equal(isPreview(row('1')),true);
  assert.equal(previewEligible(row('1')),false); // 已有预下载不重复下载
  // 预下载不算正式产物：待确认时仍可删除记录。
  assert.equal(processingActions(row('4'),true).can_delete,true);
  setPurpose('1','video');
  assert.equal(row('1').status,'saved');assert.equal(row('1').media_path,join(SAVED_MEDIA,'1','video.mp4'));assert.ok(existsSync(join(SAVED_MEDIA,'1','video.mp4')));assert.ok(!existsSync(join(REVIEW_MEDIA,'1')));
  setPurpose('2','note');
  assert.equal(row('2').status,'downloaded');assert.equal(row('2').media_path,join(REVIEW_MEDIA,'2','video.mp4'));
  const text=join(process.env.DUST_HOME,'2.txt');writeFileSync(text,'转写内容');
  markTranscribed('2',{text_source:'asr',text_chars:4,text_path:text,audio_seconds:5});
  markExtracted('2',{text_source:'asr',text_chars:4,note_path:join(process.env.DUST_HOME,'2.md'),category:null,decay:null,retain_media:false,prompt_hash:'x'});
  assert.equal(cleanMedia().n,1);assert.ok(!existsSync(join(REVIEW_MEDIA,'2')));assert.equal(row('2').media_deleted,1);
  discardItem('3');
  assert.equal(row('3').skip_reason,'user_discarded');assert.equal(row('3').media_path,null);assert.ok(!existsSync(join(REVIEW_MEDIA,'3')));
  deleteItem('4');
  assert.equal(row('4').skip_reason,'user_deleted');assert.ok(!existsSync(join(REVIEW_MEDIA,'4')));
  // 选回待确认时保留预下载；暂存目录以外的文件不当作预下载处理。
  setPurpose('1','review');assert.ok(existsSync(join(SAVED_MEDIA,'1','video.mp4')));assert.equal(isPreview(row('1')),false);
`));

test('B站待确认在运行收尾预下载并占当天额度；笔记优先字幕不复用，换画质重新下载，同画质直接保存；超长不预下载', () => isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
  import {DUST_HOME} from './scripts/config.mjs';
  import {db} from './scripts/ledger.mjs';
  import {REVIEW_MEDIA,SAVED_MEDIA} from './scripts/policy.mjs';
  import {startAt} from './scripts/sources/bilibili/favorites.mjs';
  import {setPurpose,setVideoQuality} from './scripts/daily.mjs';
  import {main} from './run.mjs';
  const T0=startAt('2026-11-01');
  db().exec("CREATE TABLE IF NOT EXISTS daily_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db().prepare("INSERT INTO daily_state VALUES('baseline',?)").run(JSON.stringify({created_at:1,scanned_at:1,anchors:[]}));
  mkdirSync(join(DUST_HOME,'bilibili'),{recursive:true});
  writeFileSync(join(DUST_HOME,'bilibili','cookies.json'),JSON.stringify([{name:'SESSDATA',value:'s',domain:'.bilibili.com'},{name:'DedeUserID',value:'42',domain:'.bilibili.com'}]));
  const durations={BV1test00001:300,BV1test00002:300,BV1test00003:2400,BV1test00004:300};
  const m=n=>({type:2,attr:0,bvid:'BV1test0000'+n,id:n,title:'虚构 '+n,upper:{name:'作者'},pubtime:T0,duration:durations['BV1test0000'+n],fav_time:T0+n,page:1});
  const client={nav:async()=>({mid:'42'}),get:async path=>path.endsWith('list-all')?{list:[{id:1,title:'其他',media_count:4}]}:{medias:[m(1),m(2),m(3),m(4)],has_more:false}};
  const downloads=[];
  const deps={
    meta:async(_,id)=>({aweme_id:id,platform:'bilibili',media_type:'video',is_gallery:false,desc:'虚构',author:'作者',duration_s:durations[id],pages:[{cid:1,part:'',duration:durations[id]}]}),
    video:async(_,item,opts)=>{downloads.push([item.aweme_id,opts.maxQuality,opts.root]);const dir=join(opts.root||SAVED_MEDIA,item.aweme_id);mkdirSync(dir,{recursive:true});const path=join(dir,'video.mp4');writeFileSync(path,'v');return {aweme_id:item.aweme_id,status:'done',path,bytes:1,has_audio:true,gear:'dash-80',quality:'high'};},
  };
  const runScript=async()=>({ok:true,logged_in:true,items:[],truncated:false,fetched_at:1});
  const row=id=>db().prepare("SELECT * FROM items WHERE platform='bilibili' AND id=?").get(id);
  const result=await main(['--limit','5'],{runScript,bilibili:{client,deps}});
  assert.equal(result.previews,3);
  assert.deepEqual(downloads.map(d=>d[0]).sort(),['BV1test00001','BV1test00002','BV1test00004']);
  assert.ok(downloads.every(d=>d[1]===80&&d[2]===REVIEW_MEDIA));
  for(const id of ['BV1test00001','BV1test00002','BV1test00004']){assert.equal(row(id).status,'review');assert.ok(row(id).media_path.startsWith(REVIEW_MEDIA+'/'+id+'/'));}
  assert.equal(row('BV1test00003').media_path,null); // 40 分钟，超过预下载上限
  const used=db().prepare('SELECT id FROM daily_usage').all().map(r=>r.id).sort();
  assert.deepEqual(used,['BV1test00001','BV1test00002','BV1test00004']);
  assert.equal(JSON.parse(db().prepare("SELECT metadata FROM daily_queue WHERE id='BV1test00001'").get().metadata).preview_quality,80);
  setPurpose('BV1test00001','note');
  assert.equal(row('BV1test00001').status,'pending');assert.equal(row('BV1test00001').media_path,null);assert.ok(!existsSync(join(REVIEW_MEDIA,'BV1test00001')));
  setVideoQuality('BV1test00002','64');setPurpose('BV1test00002','video');
  assert.equal(row('BV1test00002').status,'pending');assert.equal(row('BV1test00002').media_path,null);
  setPurpose('BV1test00004','video');
  assert.equal(row('BV1test00004').status,'saved');assert.equal(row('BV1test00004').media_path,join(SAVED_MEDIA,'BV1test00004','video.mp4'));
  // 第二轮不重复预下载。
  const again=await main(['--limit','5'],{runScript,bilibili:{client,deps:{...deps,video:async()=>{throw new Error('不应再次预下载');}}}});
  assert.equal(again.previews||0,0);
  process.exitCode=0;
`, { DUST_BILI_ENABLED: '1', DUST_BILI_START_DATE: '2026-11-01', DUST_BILI_INTERVAL_MS: '0' }));
