// dustoff / stage.mjs
// 共享运行骨架：所有正式入口共用 pipeline 互斥锁，各自保存有限的运行记录。
// 退出码：0 完成 / 1 失败 / 3 已有任务 / 4 登录失效 / 5 资源暂停 / 6 配置错误。

import {
  mkdirSync, existsSync, readFileSync, writeFileSync,
  appendFileSync, unlinkSync, readdirSync, statSync, rmSync, statfsSync, linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { localPath } from './policy.mjs';

export const EXIT = { OK: 0, ERROR: 1, RUNNING: 3, LOGIN: 4, DISK: 5, CONFIG: 6 };

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const runStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');

/**
 * 造一个阶段。
 * @param {{name:string, dustHome:string, notify?:boolean, keepRuns?:number, record?:boolean}} opts
 *   name    阶段名，用于锁文件名和运行记录目录后缀
 *   record  是否建运行记录目录。--dry-run 之类的探查跑法可以关掉
 */
export function createStage({
  name, dustHome, notify: notifyOn = true, keepRuns = 30, record = true,
  runId: fixedRunId = null, pruneLegacy = false,
}) {
  dustHome = localPath(dustHome);
  const RUNS_DIR = join(dustHome, 'runs');
  const LOCK = join(dustHome, '.lock.pipeline');
  let ownsLock = false;
  const runId = fixedRunId || `${runStamp()}-${process.pid}-${name}`;
  const runDir = join(RUNS_DIR, runId);

  // 惰性建目录：被锁挡住的那次不该留下一个空的运行记录。
  let dirReady = false;
  function ensureDir() {
    if (!record || dirReady) return record;
    mkdirSync(runDir, { recursive: true });
    dirReady = true;
    return true;
  }

  // 日志同时打屏幕和落盘——定时任务没有终端，出问题时这是唯一的现场。
  // 走 stderr 是为了让 stdout 留给结构化输出。
  function log(...a) {
    const line = `[${stamp()}] ${a.join(' ')}`;
    console.error(line);
    if (ensureDir()) { try { appendFileSync(join(runDir, 'run.log'), line + '\n'); } catch {} }
  }

  function notify(title, message) {
    if (!notifyOn || process.platform !== 'darwin') return;
    const esc = s => String(s).replace(/["\\]/g, '\\$&').replace(/\n/g, ' ');
    try {
      execFileSync('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Basso"`],
        { timeout: 5000, stdio: 'ignore' });
    } catch {}
  }

  function releaseLock() {
    try { if (ownsLock && readFileSync(LOCK, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK); } catch {}
    ownsLock = false;
  }

  function die(code, msg) {
    log(`✗ ${msg}`);
    releaseLock();
    process.exit(code);
  }

  /** 抢锁。锁里存 pid，进程没了就接管——否则一次崩溃会把后续所有定时执行堵死。 */
  function acquireLock() {
    if (existsSync(LOCK)) {
      const pid = Number(readFileSync(LOCK, 'utf8').trim());
      let alive = false;
      try { if (pid > 0) { process.kill(pid, 0); alive = true; } else alive = true; } catch (e) { alive = e.code !== 'ESRCH'; }
      if (alive) {
        console.error(`[${stamp()}] ✗ 已有 ${name} 实例在跑（pid ${pid}），本次退出`);
        process.exit(EXIT.RUNNING);
      }
      log(`发现过期的锁（pid ${pid} 已不存在），接管`);
      try { unlinkSync(LOCK); } catch {}
    }
    mkdirSync(dustHome, { recursive: true });
    const prepared = `${LOCK}.${process.pid}.tmp`;
    writeFileSync(prepared, String(process.pid), { mode:0o600 });
    try { linkSync(prepared, LOCK); ownsLock = true; }
    catch (e) { if (e.code === 'EEXIST') { rmSync(prepared,{force:true}); process.exit(EXIT.RUNNING); } throw e; }
    finally { rmSync(prepared,{force:true}); }
    process.on('exit', releaseLock);
    process.on('SIGINT', () => { releaseLock(); process.exit(130); });
    process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
  }

  /**
   * 清理超期的运行记录。只清自己这个阶段的，别扫了别人的现场。
   * pruneLegacy 是为了兼容分阶段之前留下的、没有阶段后缀的目录。
   */
  function pruneRuns() {
    if (!existsSync(RUNS_DIR) || !(keepRuns > 0)) return 0;
    const legacy = /^\d{8}T\d{6}$/;
    const cutoff = Date.now() - keepRuns * 86400_000;
    let n = 0;
    for (const d of readdirSync(RUNS_DIR)) {
      if (!d.endsWith(`-${name}`) && !(pruneLegacy && legacy.test(d))) continue;
      const p = join(RUNS_DIR, d);
      try {
        if (statSync(p).mtimeMs < cutoff) { rmSync(p, { recursive: true, force: true }); n++; }
      } catch {}
    }
    const own = readdirSync(RUNS_DIR).filter(d => d.endsWith(`-${name}`)).sort().reverse();
    for (const d of own.slice(100)) { try { rmSync(join(RUNS_DIR,d),{recursive:true,force:true}); n++; } catch {} }
    return n;
  }

  return { runId, runDir, RUNS_DIR, ensureDir, log, die, notify, acquireLock, releaseLock, pruneRuns };
}

/** 某个路径所在盘的剩余空间（GB）。取不到返回 null。 */
export function freeGB(path) {
  try { const s = statfsSync(localPath(path)); return Number(s.bavail) * Number(s.bsize) / 1024 ** 3; }
  catch { return null; }
}
