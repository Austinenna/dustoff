import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {galleryImages} from '../scripts/lib.mjs';

function isolated(source) {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-gallery-')));
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('..',import.meta.url),env:{...process.env,DUST_HOME:home,DUST_NOTIFY:'0',DUST_ROUTER_KEY:'',DUST_DASHSCOPE_KEY:'',DUST_LLM_KEY:''},encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  } finally {rmSync(home,{recursive:true,force:true});}
}

test('图片元数据保留原顺序与备用地址，缺地址图片不被丢弃',()=>{
  const images=galleryImages({images:[{uri:'first',width:1200,height:1800,url_list:['https://one/a','https://one/a'],download_url_list:['https://two/a']},{uri:'second',url_list:[]}]});
  assert.deepEqual(images.map(i=>i.uri),['first','second']);
  assert.deepEqual(images[0].urls,['https://one/a','https://two/a']);assert.equal(images[1].urls.length,0);
});

test('图集整组保存：坏内容回退、部分失败续跑、独立浏览、无模型调用且不清理',()=>isolated(`
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  import {spawnSync} from 'node:child_process';
  import {readFileSync,existsSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
  import {join,dirname} from 'node:path';
  const image=join(process.env.DUST_HOME,'fixture.png');
  const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=80x120','-frames:v','1',image]);assert.equal(made.status,0,String(made.stderr));
  const content=readFileSync(image),requests=[];let fail=true;
  const server=createServer((req,res)=>{requests.push(req.url);if(req.url==='/bad'){res.end('<html>not image</html>');return;}if(req.url==='/2'&&fail){res.writeHead(503);res.end();return;}res.setHeader('Content-Type','image/png');res.end(content);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const {acceptScan,pendingQueue,usage,setPurpose}=await import('./scripts/daily.mjs');
  const {db,cleanable}=await import('./scripts/ledger.mjs');
  const {main}=await import('./run.mjs');
  const {readGallery}=await import('./scripts/gallery.mjs');
  const {createConsole}=await import('./console.mjs');
  const seed={aweme_id:'100',is_gallery:true};
  acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  const item={aweme_id:'1',is_gallery:true,desc:'两张图片',author:'测试作者',images:[{uri:'1',urls:[base+'/bad',base+'/1']},{uri:'2',urls:[base+'/2']}]};
  acceptScan({ok:true,logged_in:true,truncated:false,items:[item,seed],fetched_at:Date.now()/1000});
  assert.equal(pendingQueue().length,1);assert.throws(()=>setPurpose('1','note'));
  const manifest=join(process.env.DUST_HOME,'saved-media','1','images','gallery.json');
  let app;
  try {
    const first=await main(['--no-scan']);assert.equal(first.failures.length,1);assert.equal(first.galleries,0);assert.equal(existsSync(manifest),false);
    assert.equal(existsSync(join(dirname(manifest),'001.png')),true);assert.equal(existsSync(join(dirname(manifest),'002.part')),false);process.exitCode=0;
    fail=false;const second=await main(['--no-scan']);assert.deepEqual(second.failures,[]);assert.equal(second.galleries,1);assert.equal(second.saved,0);assert.equal(second.notes,0);assert.equal(second.text,0);
    assert.equal(requests.filter(url=>url==='/1').length,1);assert.equal(usage(),1);assert.equal(pendingQueue().length,0);
    const row=db().prepare("SELECT * FROM items WHERE id='1'").get();assert.equal(row.status,'saved');assert.equal(row.image_count,2);assert.equal(row.text_path,null);assert.equal(row.processing_mode,'gallery');assert.equal(row.media_bytes,2*content.length);assert.deepEqual(cleanable(),[]);
    const gallery=readGallery(manifest,'1');assert.deepEqual(gallery.images.map(i=>i.file),['001.png','002.png']);assert.ok(!readFileSync(manifest,'utf8').includes(base));
    const before=requests.length;await main(['--no-scan']);assert.equal(requests.length,before);
    const opened=[];app=createConsole({home:process.env.DUST_HOME,scheduler:{status:()=>({loaded:false})},openFile:async args=>opened.push(args)});const url=await app.listen(0);
    assert.equal(app.store.overview().galleries,1);assert.equal(app.store.overview().videos,0);assert.equal(app.store.listItems({galleries:'1',q:'两张'}).total,1);assert.equal(app.store.listItems({results:'1'}).total,0);
    assert.equal(app.store.item('1').can_change_purpose,false);
    const data=await(await fetch(url+'/api/gallery?id=1')).json();assert.equal(data.images.length,2);assert.ok(!JSON.stringify(data).includes(base));
    const picture=await fetch(url+'/api/gallery-image?id=1&index=1');assert.equal(picture.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await picture.arrayBuffer()),content);
    const head=await fetch(url+'/api/gallery-image?id=1&index=0',{method:'HEAD'});assert.equal(head.headers.get('Content-Length'),String(content.length));assert.equal(await head.text(),'');
    assert.equal((await fetch(url+'/api/gallery-image?id=1&index=../0')).status,400);assert.equal((await fetch(url+'/api/gallery-image?id=1&index=99')).status,404);assert.equal((await fetch(url+'/api/gallery?id=100')).status,404);assert.equal((await fetch(url+'/api/video?id=1')).status,400);
    const html=await(await fetch(url)).text(),token=html.match(/name="dustoff-token" content="([^"]+)"/)[1];assert.ok(html.includes('href="#galleries"'));
    const post=body=>fetch(url+'/api/open',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Dustoff-Token':token},body:JSON.stringify(body)});
    assert.equal((await post({kind:'gallery-folder',id:'1'})).status,200);assert.deepEqual(opened[0],[dirname(manifest)]);
    await post({kind:'source',id:'1'});assert.deepEqual(opened[1],['https://www.douyin.com/note/1']);
    const original=readFileSync(manifest,'utf8'),malicious=JSON.parse(original);malicious.images[0].file='../../fixture.png';writeFileSync(manifest,JSON.stringify(malicious));assert.equal((await fetch(url+'/api/gallery-image?id=1&index=0')).status,404);
    writeFileSync(manifest,original);const saved=gallery.images[0].path;unlinkSync(saved);symlinkSync(image,saved);assert.equal((await fetch(url+'/api/gallery-image?id=1&index=0')).status,404);
  } finally {if(app)await new Promise(r=>app.server.close(r));await new Promise(r=>server.close(r));}
`));

test('只恢复历史上因图集类型跳过的作品，基线不动且预览不写状态',()=>isolated(`
  import assert from 'node:assert/strict';
  const {db,importScan,markSkipped}=await import('./scripts/ledger.mjs');
  const {acceptScan,queueSkippedGalleries,pendingQueue,usage}=await import('./scripts/daily.mjs');
  const {main}=await import('./run.mjs');
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'100',is_gallery:true}]});
  importScan([{aweme_id:'1',is_gallery:true},{aweme_id:'2',is_gallery:true}]);markSkipped('1','gallery');markSkipped('2','too_long');
  await main(['--dry-run']);assert.equal(pendingQueue().length,0);
  assert.equal(queueSkippedGalleries(),1);assert.equal(queueSkippedGalleries(),0);assert.deepEqual(pendingQueue().map(i=>i.id),['1']);assert.equal(usage(),0);
  assert.equal(db().prepare("SELECT skip_reason FROM items WHERE id='100'").get().skip_reason,'baseline');assert.equal(db().prepare("SELECT skip_reason FROM items WHERE id='2'").get().skip_reason,'too_long');
`));

test('图集流式写入遵守收藏总预算，超限不发布整组清单',()=>isolated(`
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  import {existsSync} from 'node:fs';
  import {join} from 'node:path';
  process.env.DUST_SAVED_MEDIA_MAX_GB='0.000001';
  const {downloadGallery}=await import('./scripts/gallery.mjs');
  const server=createServer((req,res)=>{res.write(Buffer.alloc(700));setTimeout(()=>res.end(Buffer.alloc(700)),10);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    await assert.rejects(()=>downloadGallery({aweme_id:'1',images:[{urls:['http://127.0.0.1:'+server.address().port]}]}),/达到/);
    const dir=join(process.env.DUST_HOME,'saved-media','1','images');assert.equal(existsSync(join(dir,'001.part')),false);assert.equal(existsSync(join(dir,'gallery.json')),false);
  }finally{await new Promise(r=>server.close(r));}
`));
