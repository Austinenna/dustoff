// 当前运行策略：本地、小批量。旧配置只能收紧上限，不能绕过已确认的限制。
import { existsSync, lstatSync, readlinkSync, readFileSync, statfsSync, readdirSync, mkdirSync, openSync, writeSync, closeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { makeCfg, DUST_HOME } from './config.mjs';
import { platformOfId } from './platforms.mjs';
const cfg = makeCfg();
export const GiB = 1024 ** 3;
export function readPolicy(conf) {
  const cfg = makeCfg({ conf });
  const positive = (key, fallback) => { const n = Number(cfg(key, fallback)); if (!Number.isFinite(n) || n <= 0) throw new Error(`配置 ${key} 必须为正数`); return n; };
  return Object.freeze({
  scan: Math.max(1, Math.min(100, Math.floor(positive('DUST_SCAN_COUNT', 100)))),
  daily: Math.max(1, Math.min(50, Math.floor(positive('DUST_DAILY_LIMIT', 50)))),
  seconds: Math.min(600, positive('DUST_MAX_DURATION_MIN', 10) * 60),
  bytes: Math.min(1, positive('DUST_MEDIA_MAX_GB', 1)) * GiB,
  savedBytes: positive('DUST_SAVED_MEDIA_MAX_GB', 1) * GiB,
  free: Math.max(10, positive('DUST_MIN_FREE_GB', 10)) * GiB,
  requestMs: positive('DUST_REQUEST_TIMEOUT_S', 180) * 1000,
  runMs: positive('DUST_RUN_TIMEOUT_S', 7200) * 1000,
  external: false,
  // 各平台单独计每日额度，同时受总额度约束。
  totalDaily: Math.max(1, Math.min(100, Math.floor(positive('DUST_TOTAL_DAILY_LIMIT', 60)))),
  bilibili: Object.freeze({
    enabled: cfg('DUST_BILI_ENABLED', '0') === '1',
    daily: Math.max(1, Math.min(50, Math.floor(positive('DUST_BILI_DAILY_LIMIT', 20)))),
    // 有字幕时不产生转写费用，只防异常超长；没有字幕时另设转写上限和每日转写总量。
    seconds: Math.min(600 * 60, positive('DUST_BILI_MAX_DURATION_MIN', 240) * 60),
    asrSeconds: Math.min(180 * 60, positive('DUST_BILI_MAX_ASR_MIN', 30) * 60),
    dailyAsrSeconds: Math.min(1440 * 60, positive('DUST_BILI_DAILY_ASR_MIN', 120) * 60),
    // 保存视频的最高画质（B 站 qn）：64=720p 80=1080p 116=1080p 高帧率/高码率 120=4K 0=不限。
    maxQuality: [64, 80, 116, 120, 0].includes(Number(cfg('DUST_BILI_MAX_QUALITY', 80))) ? Number(cfg('DUST_BILI_MAX_QUALITY', 80)) : 80,
  }),
  x: Object.freeze({
    enabled: cfg('DUST_X_ENABLED', '0') === '1',
    daily: Math.max(1, Math.min(50, Math.floor(positive('DUST_X_DAILY_LIMIT', 30)))),
    // 视频推文：超过时长上限不处理；转为笔记时另受转写单条上限约束。
    seconds: Math.min(180 * 60, positive('DUST_X_MAX_DURATION_MIN', 60) * 60),
    asrSeconds: Math.min(60 * 60, positive('DUST_X_MAX_ASR_MIN', 20) * 60),
    // 正文达到这个字数（去掉链接）才另外整理成笔记，短帖只存原帖。
    noteChars: Math.max(50, Math.floor(positive('DUST_X_NOTE_MIN_CHARS', 280))),
  }),
});
}
export const POLICY = readPolicy();
export class PauseError extends Error { constructor(message) { super(message); this.code = 5; } }
// 不触碰 /Volumes；同时拦住指向它的符号链接。其他符号链接逐级解析，避免路径绕过。
export function localPath(input, depth = 0) {
  const p = resolve(input);
  if (depth > 20 || p === '/Volumes' || p.startsWith('/Volumes/')) throw new PauseError('外接盘功能已停用，请使用本地路径');
  let part = sep;
  const bits = p.split(sep).filter(Boolean);
  for (let i = 0; i < bits.length; i++) {
    part = join(part, bits[i]);
    let st;
    try { st = lstatSync(part); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) return localPath(resolve(dirname(part), readlinkSync(part), ...bits.slice(i + 1)), depth + 1);
  }
  return p;
}
export const MEDIA = localPath(cfg('DUST_MEDIA', join(DUST_HOME, 'media')));
export const TEMP = localPath(join(DUST_HOME, 'tmp-media'));
export const SAVED_MEDIA = localPath(cfg('DUST_SAVED_MEDIA', join(DUST_HOME, 'saved-media')));
if ([MEDIA,TEMP].some(p => p === SAVED_MEDIA || under(p,SAVED_MEDIA) || under(SAVED_MEDIA,p))) throw new Error('视频收藏目录必须与缓存和临时目录分开');
export function under(path, root) { const p = resolve(path), r = resolve(root); return p.startsWith(r + sep); }
export function treeBytes(path) {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new PauseError('媒体目录中存在符号链接，暂停处理');
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}
export function storage(extra = 0, { retain = false } = {}) {
  const root = retain ? SAVED_MEDIA : MEDIA, cap = retain ? POLICY.savedBytes : POLICY.bytes;
  let probe = localPath(root);
  while (!existsSync(probe)) probe = dirname(probe);
  const fs = statfsSync(probe);
  const available = Number(fs.bavail) * Number(fs.bsize);
  const used = retain ? treeBytes(SAVED_MEDIA) : treeBytes(MEDIA) + (under(TEMP, MEDIA) ? 0 : treeBytes(TEMP));
  if (used + extra > cap || (extra === 0 && used >= cap)) throw Object.assign(new PauseError(`${retain ? '视频收藏' : '本地媒体'}达到 ${cap / GiB} GiB 上限`), {scope:retain?'saved-media':'media'});
  if (available - extra < POLICY.free) throw new PauseError(`本机剩余空间低于 ${POLICY.free / GiB} GiB`);
  return { used, available, remaining: Math.min(cap - used, available - POLICY.free) };
}
export function deadlineMs(cap = POLICY.requestMs) {
  const remaining = Number(process.env.DUST_DEADLINE_MS || (Date.now() + POLICY.runMs)) - Date.now();
  if (remaining <= 0) throw new PauseError('本轮达到执行时间上限');
  return Math.max(1, Math.min(cap, remaining));
}
export function requestSignal() { return AbortSignal.timeout(deadlineMs()); }
export function atomicWrite(path, text, { verify } = {}) {
  path = localPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    const bytes = Buffer.from(text); let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    // 可选的成果校验在替换目标前执行；失败时保留已有文件。
    if (verify) verify(readFileSync(temp));
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
// 每块在写入前核实真实总占用，远端未提供 Content-Length 也不能超预算落盘。
export async function writeMedia(stream, path) {
  path = localPath(path);
  const retain = under(path, SAVED_MEDIA);
  if (!retain && !under(path, MEDIA) && !under(path, TEMP)) throw new PauseError('媒体写入位置不在预算目录中');
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w', 0o600);
  try {
    for await (const chunk of stream) {
      deadlineMs(); storage(chunk.length, { retain });
      let at = 0;
      while (at < chunk.length) at += writeSync(fd, chunk, at, chunk.length - at);
    }
    fsyncSync(fd);
  } catch (e) { rmSync(path, { force: true }); throw e; }
  finally { closeSync(fd); }
}
const platformOf = item => item.platform || platformOfId(item.aweme_id ?? item.id) || 'douyin';
export const dailyLimitFor = platform => POLICY[platform]?.daily ?? POLICY.daily;
/** 能送进 ASR 的最长音频。 */
export const asrSecondsFor = item => POLICY[platformOf(item)]?.asrSeconds ?? POLICY.seconds;
export function mediaDecision(item) {
  if (item.is_gallery || item.media_type === 'gallery' || item.media_type === 'post') return null;
  const seconds = Number(item.duration_s);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown_duration';
  const cap = POLICY[platformOf(item)]?.seconds ?? POLICY.seconds;
  return seconds > cap ? 'too_long' : null;
}
