import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:http';
import {createConsole} from '../console.mjs';
import {setConsolePassword,createPasswordSetup} from '../scripts/console-auth.mjs';

test('公网入口强制认证，覆盖媒体和登录画面，支持子路径和安全退出',async()=>{
  const home=mkdtempSync(join(tmpdir(),'dustoff-access-'));let app;
  try{
    assert.throws(()=>createConsole({home,publicUrl:'https://dustoff.invalid/dustoff'}),/先设置/);
    const password='fixture-password-123';await setConsolePassword(home,password);
    assert.ok(!readFileSync(join(home,'console-access/password.json'),'utf8').includes(password));
    app=createConsole({home,publicUrl:'https://dustoff.invalid/dustoff',serverMode:true,scheduler:{status:()=>({loaded:true})}});
    await app.listen(0);const port=app.server.address().port;
    const call=(path,{method='GET',cookie,body='',origin='https://dustoff.invalid',headers={}}={})=>new Promise((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port,path,method,headers:{Host:'dustoff.invalid',Origin:origin,...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...headers}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end(body);
    });
    const page=await call('/dustoff/');assert.equal(page.status,200);assert.equal(page.headers['referrer-policy'],'same-origin');assert.ok(page.body.includes('type="password"'));assert.ok(!page.body.includes('dustoff-token'));
    for(const path of ['/api/overview','/api/settings','/api/video?id=1','/api/gallery-image?id=1','/api/login-frame','/studio.mjs'])assert.equal((await call('/dustoff'+path)).status,401,path);
    assert.equal((await call('/dustoff/auth/login',{method:'POST',body:'password='+password,origin:'https://other.invalid'})).status,403);
    assert.equal((await call('/dustoff/auth/login',{method:'POST',body:'password=wrong',origin:'null'})).status,403);
    assert.equal((await call('/dustoff/auth/login',{method:'POST',body:'password=wrong'})).status,401);
    const login=await call('/dustoff/auth/login',{method:'POST',body:'password='+password});assert.equal(login.status,303);assert.equal(login.headers.location,'/dustoff/');
    const setCookie=login.headers['set-cookie'][0];for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/dustoff'])assert.ok(setCookie.includes(flag));const cookie=setCookie.split(';')[0];
    assert.equal((await call('/dustoff/api/overview',{cookie})).status,200);
    const main=await call('/dustoff/',{cookie});assert.ok(main.body.includes('content="1"'));assert.ok(main.body.includes('./studio.mjs'));
    const token=main.body.match(/name="dustoff-token" content="([^"]+)"/)[1];
    const mutation=await call('/dustoff/api/open',{method:'POST',cookie,body:JSON.stringify({kind:'notes-folder'}),headers:{'Content-Type':'application/json','X-Dustoff-Token':token}});assert.equal(mutation.status,409);
    assert.equal((await call('/dustoff/auth/logout',{method:'POST',cookie})).status,303);assert.equal((await call('/dustoff/api/overview',{cookie})).status,401);
    const second=await call('/dustoff/auth/login',{method:'POST',body:'password='+password});const old=second.headers['set-cookie'][0].split(';')[0];
    await setConsolePassword(home,'changed-password-123');assert.equal((await call('/dustoff/api/overview',{cookie:old})).status,401);
    for(let i=0;i<8;i++)await call('/dustoff/auth/login',{method:'POST',body:'password=wrong'});
    assert.equal((await call('/dustoff/auth/login',{method:'POST',body:'password=wrong'})).status,429);
    const setup=createPasswordSetup(home);assert.ok(!readFileSync(join(home,'console-access/setup.json'),'utf8').includes(setup));
    assert.equal((await call('/dustoff/auth/setup')).status,200);
    assert.equal((await call('/dustoff/auth/setup.js')).status,200);
    const setupBody=JSON.stringify({token:setup,password:'user-chosen-fixture-password'}),setupHeaders={'Content-Type':'application/json'};
    assert.equal((await call('/dustoff/auth/setup',{method:'POST',body:setupBody,headers:setupHeaders,origin:'https://other.invalid'})).status,403);
    assert.equal((await call('/dustoff/auth/setup',{method:'POST',body:JSON.stringify({token:'0'.repeat(64),password:'user-chosen-fixture-password'}),headers:setupHeaders})).status,403);
    assert.equal((await call('/dustoff/auth/setup',{method:'POST',body:setupBody,headers:setupHeaders})).status,303);
    assert.equal((await call('/dustoff/auth/setup',{method:'POST',body:setupBody,headers:setupHeaders})).status,410);
  }finally{if(app?.server.listening)await new Promise(r=>app.server.close(r));rmSync(home,{recursive:true,force:true});}
});
