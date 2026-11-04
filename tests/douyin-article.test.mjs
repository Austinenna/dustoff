import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { articleOf } from '../scripts/lib.mjs';

function isolated(source) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dustoff-article-')));
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, DUST_HOME: home, DUST_NOTIFY: '0', DUST_ROUTER_KEY: '', DUST_ASR_KEY: '', DUST_LLM_KEY: '', DUST_DASHSCOPE_KEY: '' }, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// 虚构的文章详情：结构与抖音 aweme_type 163 一致，正文是 JSON 字符串里的 Markdown。
const fixture = {
  aweme_id: '1', aweme_type: 163, media_type: 43, desc: '三个整理收藏的办法',
  video: { duration: 0, bit_rate: [] }, music: { duration: 129 },
  article_info: { article_content: JSON.stringify({ markdown: '三个整理收藏的办法\n\n<br/>\n\n**1.先分用途**\n\n收藏时先想好要不要看。\n\n<br/>\n\n**2.定期清理**\n\n每周清一次。' }) },
};

test('识别抖音文章并取出 Markdown 正文；普通视频、图集和没有正文的不当作文章', () => {
  const a = articleOf(fixture);
  assert.equal(a.title, '三个整理收藏的办法');
  assert.ok(a.markdown.includes('**1.先分用途**'));
  assert.ok(!a.markdown.includes('<br'));
  assert.ok(!/\n{3,}/.test(a.markdown));
  assert.equal(articleOf({ aweme_type: 0, video: { duration: 12000 } }), null);
  assert.equal(articleOf({ aweme_type: 68, images: [{}] }), null);
  assert.equal(articleOf({ aweme_type: 163, article_info: { article_content: '不是 JSON' } }), null);
  assert.equal(articleOf({ aweme_type: 163, article_info: {} }), null);
});

test('抖音文章不下载、不调用用途模型，按文字帖写入正文；拿不到时长的普通视频标为跳过而不是失败', () => isolated(`
  import assert from 'node:assert/strict';
  import {readFileSync} from 'node:fs';
  const {acceptScan,setPurpose}=await import('./scripts/daily.mjs');
  const {db}=await import('./scripts/ledger.mjs');
  const {main}=await import('./run.mjs');
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'100',duration_s:5}]});
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',aweme_type:163,desc:'文章',duration_s:null},{aweme_id:'2',aweme_type:0,desc:'没有时长',duration_s:null},{aweme_id:'100',duration_s:5}],fetched_at:Date.now()/1000});
  setPurpose('2','note');
  const markdown='三个整理收藏的办法\\n\\n**1.先分用途**\\n\\n收藏时先想好要不要看。';
  const calls=[];
  const runScript=async(name,args)=>{
    assert.equal(name,'get_meta.mjs');const id=args[0].split('/').pop();calls.push(id);
    if(id==='1')return {ok:true,aweme_id:'1',aweme_type:163,media_type:'post',is_article:true,article_title:'三个整理收藏的办法',article_markdown:markdown,desc:'三个整理收藏的办法',duration_s:null,play_urls:['https://fixture.invalid/x'],video_options:{low:{urls:['https://fixture.invalid/x']},high:{urls:['https://fixture.invalid/x']},standard:{urls:['https://fixture.invalid/x']}}};
    return {ok:true,aweme_id:id,aweme_type:0,desc:'没有时长',duration_s:null,play_urls:['https://fixture.invalid/y'],video_options:{low:{urls:['https://fixture.invalid/y']},high:{urls:['https://fixture.invalid/y']},standard:{urls:['https://fixture.invalid/y']}}};
  };
  globalThis.fetch=async()=>{throw new Error('不应下载任何文件');};
  const result=await main(['--no-scan','--skip-notes'],{runScript});
  assert.deepEqual(result.failures,[]);assert.equal(result.pausedTypes.note,undefined);
  const one=db().prepare("SELECT * FROM items WHERE id='1'").get();
  assert.equal(one.media_type,'post');assert.equal(one.processing_mode,'note');assert.equal(one.routing_source,'rule');
  assert.equal(one.status,'transcribed');assert.equal(one.text_source,'article');assert.equal(one.media_path,null);
  assert.ok(readFileSync(one.text_path,'utf8').includes('**1.先分用途**'));
  const two=db().prepare("SELECT * FROM items WHERE id='2'").get();
  assert.equal(two.status,'skipped');assert.equal(two.skip_reason,'unknown_duration');assert.equal(two.attempts,0);
  assert.deepEqual(calls.sort(),['1','2']);
  // 第二轮：文章已有正文，不再刷新元数据；没有 LLM Key 时报配置错误（实际运行会整理成笔记）。
  calls.length=0;
  const again=await main(['--no-scan'],{runScript});
  assert.deepEqual(calls,[]);assert.equal(again.failures.length,1);assert.match(again.failures[0].error,/LLM Key/);
  process.exitCode=0;
`));
