import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('迁移后启动器转到服务器，旧数据拒绝再次启动本机处理',()=>{
  const home=mkdtempSync(join(tmpdir(),'dustoff-migrated-'));
  try{
    writeFileSync(join(home,'server.json'),JSON.stringify({version:1,url:'https://example.invalid:8443/'}));
    const env={...process.env,DUST_HOME:home,DUST_NOTIFY:'0'};
    const launcher=spawnSync(process.execPath,['scripts/open-console.mjs','--no-open'],{env,encoding:'utf8'});
    assert.equal(launcher.status,0,launcher.stderr);assert.match(launcher.stdout,/https:\/\/example.invalid:8443/);assert.equal(existsSync(join(home,'console')),false);
    const code=`import{createStage}from${JSON.stringify(new URL('../scripts/stage.mjs',import.meta.url).href)};createStage({name:'fixture',dustHome:process.env.DUST_HOME,record:false}).acquireLock();`;
    const run=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8'});
    assert.equal(run.status,1);assert.match(run.stderr,/本机处理已停用/);assert.equal(existsSync(join(home,'.lock.pipeline')),false);
  }finally{rmSync(home,{recursive:true,force:true});}
});
