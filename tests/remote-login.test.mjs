import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createLoginControl,validateLoginInput} from '../scripts/remote-login.mjs';
import {createConsole} from '../console.mjs';

test('远程登录拒绝脚本、越界坐标和任意协议方法；文字不插入执行表达式',async()=>{
  for(const input of [{action:'evaluate',text:'secret'},{action:'tap',x:NaN,y:1},{action:'tap',x:1101,y:0},{action:'key',key:'F12'},{action:'text',text:'x'.repeat(101)},{action:'drag',x:0,y:0,phase:'invalid'}])assert.throws(()=>validateLoginInput(input));
  const calls=[],control=createLoginControl();
  await assert.rejects(control.request({action:'frame'}));
  control.setPage({command:async(...args)=>{calls.push(args);return {data:'aGVsbG8='};},evaluate:async script=>calls.push(['evaluate',script])});
  const text="'); sensitive-input //";
  await control.request({action:'text',text});assert.deepEqual(calls[0],['Input.insertText',{text}]);
  await control.request({action:'tap',x:550,y:510});assert.ok(!calls[1][1].includes(text));
  assert.deepEqual(await control.request({action:'frame'}),{image:'aGVsbG8='});
  control.setPage(null);await assert.rejects(control.request({action:'frame'}));
});

test('登录画面和输入只交给当前登录子进程，POST 受来源和 token 保护',async()=>{
  const home=mkdtempSync(join(tmpdir(),'dustoff-remote-login-'));let child;
  const app=createConsole({home,scheduler:{status:()=>({loaded:true})},spawnProcess:()=>{
    child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.send=(m,cb)=>{cb?.();if(m.type==='browser-request')queueMicrotask(()=>child.emit('message',{type:'browser-response',requestId:m.requestId,data:m.input.action==='frame'?{image:Buffer.from('frame-fixture').toString('base64')}:{accepted:true}}));};return child;
  }});
  try{
    const url=await app.listen(0),html=await(await fetch(url)).text(),token=html.match(/name="dustoff-token" content="([^"]+)/)[1];
    const post=(path,data,headers={})=>fetch(url+'/api/'+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Dustoff-Token':token,...headers},body:JSON.stringify(data)});
    assert.equal((await fetch(url+'/api/login-frame')).status,409);
    assert.equal((await post('login',{})).status,200);
    child.emit('message',{type:'session',phase:'window',message:'ready',remote:true});
    const frame=await fetch(url+'/api/login-frame');assert.equal(frame.headers.get('Content-Type'),'image/jpeg');assert.equal(await frame.text(),'frame-fixture');
    assert.equal((await post('login-input',{action:'tap',x:1,y:1},{'X-Dustoff-Token':'invalid'})).status,403);
    assert.equal((await post('login-input',{action:'evaluate'})).status,400);
    assert.equal((await post('login-input',{action:'text',text:'fixture'})).status,200);
    assert.equal((await post('login-control',{action:'cancel'})).status,200);
    assert.equal((await fetch(url+'/api/login-frame')).status,409);
    child.emit('close',0);
  }finally{await new Promise(r=>app.server.close(r));rmSync(home,{recursive:true,force:true});}
});
