// dustoff / stage.mjs
// 「一个阶段」共用的骨架：加锁、日志落盘、运行记录、系统通知、退出码、磁盘检查。
//
// 为什么要抽出来：
//   两段是平级的独立入口，各自被定时器触发，所以各自都需要这一整套东西。
//   原先它内联在 sync.mjs 里，第二段要么复制一份（两份实现迟早跑偏），
//   要么干脆没有（那它就不够格当一个独立阶段）。
//
// 每个阶段有自己的锁，不共用：
//   两段本来就该能重叠跑——采集在下新的，提取在转积压的，互不干扰。
//   账本开了 WAL，并发读写是安全的；而且条目只有在 mp4 完整落盘之后
//   才会被标成 downloaded，提取不会捞到写了一半的文件。
//
// 退出码约定（定时任务据此判断要不要告警）:
//   0  成功
//   1  出错
//   3  已有同阶段实例在跑（不排队，直接退出）
//   4  登录态失效，需要重新扫码（仅采集）
//   5  目标磁盘不可用
//   6  缺少必要配置（如 API key）

import {
  mkdirSync, existsSync, readFileSync, writeFileSync,
  appendFileSync, unlinkSync, readdirSync, statSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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
  const RUNS_DIR = join(dustHome, 'runs');
  const LOCK = join(dustHome, `.lock.${name}`);
  const runId = fixedRunId || `${runStamp()}-${name}`;
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
      execSync(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}" sound name "Basso"'`,
        { timeout: 5000, stdio: 'ignore' });
    } catch {}
  }

  function releaseLock() { try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch {} }

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
      try { process.kill(pid, 0); alive = true; } catch {}
      if (alive) {
        console.error(`[${stamp()}] ✗ 已有 ${name} 实例在跑（pid ${pid}），本次退出`);
        process.exit(EXIT.RUNNING);
      }
      log(`发现过期的锁（pid ${pid} 已不存在），接管`);
      try { unlinkSync(LOCK); } catch {}
    }
    mkdirSync(dustHome, { recursive: true });
    writeFileSync(LOCK, String(process.pid));
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
    return n;
  }

  return { runId, runDir, RUNS_DIR, ensureDir, log, die, notify, acquireLock, releaseLock, pruneRuns };
}

/** 某个路径所在盘的剩余空间（GB）。取不到返回 null。 */
export function freeGB(path) {
  try {
    const o = execSync(`df -k ${JSON.stringify(path)}`, { encoding: 'utf8' }).trim().split('\n').pop();
    return Number(o.split(/\s+/)[3]) / 1024 / 1024;
  } catch { return null; }
}
