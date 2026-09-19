#!/usr/bin/env node
// 唯一的日常编排：首次只建基线，之后处理新增和持久待办，批次结束清理视频。
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DUST_HOME, makeCfg } from './scripts/config.mjs';
import { POLICY, TEMP, PauseError, mediaDecision, localPath, atomicWrite, deadlineMs } from './scripts/policy.mjs';
import { baseline, acceptScan, pendingQueue, reserveDaily, usage, retryItem, queueSkippedGalleries, ScanError } from './scripts/daily.mjs';
import { db, importScan, importDownload, markTranscribed, markSkipped, markExtracted, markFailed, markRouting, markSaved } from './scripts/ledger.mjs';
import { createStage, EXIT } from './scripts/stage.mjs';
import { transcribeOne, cleanMedia, CONF as ASR_CONF } from './extract.mjs';
import { noteOne, writeNote, HASH, CONF as NOTES_CONF } from './notes.mjs';
import { classifyItem, PURPOSES } from './scripts/routing.mjs';
import { downloadGallery } from './scripts/gallery.mjs';
import { downloadOne } from './scripts/download.mjs';
const scripts = join(dirname(fileURLToPath(import.meta.url)), 'scripts');
const fresh = id => db().prepare("SELECT * FROM items WHERE platform='douyin' AND id=?").get(id);
async function script(name, args, env, log) {
  return new Promise((resolve, reject) => {
    const timeout = deadlineMs(name === 'get_collection.mjs' ? 15 * 60_000 : 90_000);
    const p = spawn(process.execPath, [join(scripts, name), ...args], { env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
    let out = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeout);
    const stop = () => p.kill('SIGTERM');
    process.once('exit', stop);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => log(String(d).trim()));
    p.on('error', e => { clearTimeout(timer); process.removeListener('exit',stop); reject(e); });
    p.on('close', code => {
      clearTimeout(timer); process.removeListener('exit',stop);
      if (timedOut || code !== 0) { const e = new Error(timedOut ? '浏览器读取超时' : `元数据脚本失败，退出码 ${code}`); e.code = code === 4 ? 4 : 1; reject(e); return; }
      try { resolve(JSON.parse(out)); } catch { reject(new Error('元数据输出不完整')); }
    });
  });
}
export async function main(args = process.argv.slice(2), { runScript = script } = {}) {
  const has = f => args.includes(f);
  const value = f => { const i = args.indexOf(f); return i < 0 ? null : args[i+1]; };
  const dry = has('--dry-run'), noScan = has('--no-scan'), downloadOnly = has('--download-only'), skipNotes = has('--skip-notes');
  const allowed = new Set(['--dry-run','--no-scan','--download-only','--skip-notes','--status','--limit','--scan','--retry']);
  for (const arg of args) if (arg.startsWith('--') && !allowed.has(arg)) throw new Error(`不支持参数 ${arg}`);
  for (const flag of ['--init','--resume','--force','--archive-only','--backup-only']) if (has(flag)) throw new Error(`${flag} 在当前本地增量模式已停用`);
  const limit = Number(value('--limit') ?? POLICY.daily);
  const scanCount = Number(value('--scan') ?? POLICY.scan);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(scanCount) || scanCount < 1 || scanCount > 100) throw new Error('--limit 必须为 1–50，--scan 必须为 1–100');
  process.env.DUST_DEADLINE_MS = String(Date.now() + POLICY.runMs);
  const stage = createStage({ name: 'run', dustHome: DUST_HOME, notify: makeCfg()('DUST_NOTIFY','1') !== '0', keepRuns: Number(makeCfg()('DUST_KEEP_RUNS',30)), record: !dry });
  const { log } = stage;
  stage.acquireLock();
  const summary = { mode: dry ? 'preview' : 'daily', scanned: 0, added: 0, processed: 0, notes: 0, text: 0, saved: 0, galleries: 0, review: 0, skipped: 0, failures: [], paused: null, scanWarning: null, cleanup: null, transcriptLayouts: [] };
  let initializedThisRun = false;
  const tmp = localPath(join(TEMP, `run-${process.pid}`));
  try {
    const old = baseline();
    if (has('--status') && has('--retry')) throw new Error('--status 不能与 --retry 同用');
    if (has('--retry') && !/^\d+$/.test(value('--retry') || '')) throw new Error('--retry 需要作品 ID');
    if (!dry && !has('--status') && old) {
      const restored = queueSkippedGalleries();
      if (restored) log(`恢复 ${restored} 条此前跳过的图集为待办`);
    }
    if (value('--retry')) {
      if (dry) { log('预览模式不重置失败状态'); return summary; }
      log(`恢复 ${value('--retry')} 到 ${retryItem(value('--retry'))} 阶段`);
    }
    if (has('--status')) { console.log(JSON.stringify({ baseline: old, pending: pendingQueue().length, usedToday: usage(), policy: POLICY }, null, 2)); return summary; }
    log(`日常限制：${POLICY.daily} 条/日，${POLICY.seconds} 秒，${POLICY.bytes / 1024 ** 3} GiB 媒体，至少 ${POLICY.free / 1024 ** 3} GiB 空闲；外接盘停用`);
    if (dry) {
      summary.mode = old ? 'preview-queue' : 'preview-baseline';
      log(old ? `已建基线；待办 ${pendingQueue().length} 条，今日额度已用 ${usage()}` : '尚无基线；真实运行将只登记最近 100 条，不下载');
      return summary;
    }
    mkdirSync(tmp, { recursive: true });
    // 共享锁下回收旧进程的临时媒体；不触碰视频和文字成果。
    for (const name of readdirSync(TEMP)) if (/^(run|asr)-\d+$/.test(name) && name !== `run-${process.pid}`) rmSync(localPath(join(TEMP,name)), { recursive:true, force:true });
    if (old) summary.cleanup = cleanMedia({ dryRun:false });
    if (!noScan) {
      const anchorFile = join(tmp, 'anchors.json');
      if (old) atomicWrite(anchorFile, JSON.stringify(old.anchors));
      try {
        let scan;
        try {
          scan = await runScript('get_collection.mjs', [String(old ? scanCount : 100)], old ? { DUST_ANCHORS_FILE: anchorFile } : { DUST_ANCHORS_FILE: '' }, log);
        } catch(e) {
          if (e instanceof PauseError) throw e;
          throw new ScanError(e.code === 4 ? '收藏扫描需要重新登录' : e.message);
        }
        const accepted = acceptScan(scan);
        Object.assign(summary, accepted);
        log(`扫描 ${accepted.scanned} 条，新增待办 ${accepted.added} 条`);
        if (accepted.initialized) { initializedThisRun = true; summary.mode = 'baseline'; log('基线建立完成，本次不下载历史视频'); return summary; }
      } catch(e) {
        // 扫描只负责发现新增；已有可靠待办不依赖本轮扫描成功。
        // 首次建基线、存储/数据库异常或总时限耗尽仍须停止。
        if (!old || !(e instanceof ScanError)) throw e;
        summary.scanWarning = e.message;
        log(`扫描未完成：${e.message}；本轮不导入扫描结果，继续处理已有待办`);
      }
    } else if (!old) throw new Error('尚无基线，请先正常运行一次');
    // 模型密钥在实际走到对应分支时检查，单纯保存视频无需 ASR/笔记密钥。
    let consecutive = 0;
    const queue = pendingQueue().filter(r => (!downloadOnly || r.status === 'pending') && (!value('--retry') || r.id === value('--retry')));
    for (const candidate of queue) {
      if (summary.processed >= limit) break;
      deadlineMs();
      let row = fresh(candidate.id);
      let item = JSON.parse(candidate.metadata);
      const id = row.id;
      try {
        if (row.status === 'pending') {
          const reason = mediaDecision(item);
          if (reason && reason !== 'unknown_duration') { markSkipped(id, reason); summary.skipped++; continue; }
        }
        if (!reserveDaily(id)) { summary.paused = `当天累计已达 ${POLICY.daily} 条`; break; }
        summary.processed++;
        if (row.media_type === 'gallery') {
          // 图集不调用用途模型、ASR 或笔记模型；旧地址按作品单独刷新。
          if (row.status === 'pending') {
            if (!item.fetched_at || Date.now()/1000-item.fetched_at > 1800 || !item.images?.length || item.images.some(image=>!image.urls?.length)) {
              const meta = await runScript('get_meta.mjs', [`https://www.douyin.com/note/${id}`], {}, log);
              if (!meta.ok || String(meta.aweme_id) !== id || !meta.is_gallery) throw new Error('刷新图集元数据失败或作品不匹配');
              item = {...meta,fetched_at:Math.floor(Date.now()/1000)};
              importScan([item]);
              db().prepare('UPDATE daily_queue SET metadata=? WHERE id=?').run(JSON.stringify(item),id);
            }
            importDownload([await downloadGallery(item)],'douyin',{countFailures:false});
          }
          markSaved(id);summary.galleries++;consecutive=0;log(`图集已保存 ${id}`);continue;
        }
        if (row.status === 'pending') {
          if (!row.processing_mode) {
            const decision = await classifyItem(item);
            markRouting(id, decision); row = fresh(id);
            log(`用途 ${id}：${PURPOSES[decision.purpose].label}`);
          }
          if (row.processing_mode === 'review') { summary.review++; consecutive = 0; continue; }
          // 排队地址跨天会失效；即使扫描停在更靠前的边界，也能按 ID 单独刷新。
          if (!item.fetched_at || Date.now()/1000 - item.fetched_at > 1800 || mediaDecision(item) === 'unknown_duration' || !item.play_urls?.length || (PURPOSES[row.processing_mode]?.quality === 'high' && !item.video_options?.high)) {
            const meta = await runScript('get_meta.mjs', [`https://www.douyin.com/video/${id}`], {}, log);
            if (!meta.ok || String(meta.aweme_id) !== id) throw new Error('刷新元数据失败或作品 ID 不匹配');
            item = { ...meta, fetched_at: Math.floor(Date.now()/1000) };
            importScan([item]);
            db().prepare('UPDATE daily_queue SET metadata=? WHERE id=?').run(JSON.stringify(item), id);
          }
          const result = await downloadOne(item, { purpose:row.processing_mode || 'speech' });
          importDownload([result], 'douyin', { countFailures:false });
          row = fresh(id);
          if (row.status === 'skipped') { summary.skipped++; continue; }
        }
        if (row.processing_mode === 'video' && row.status === 'downloaded') {
          markSaved(id); summary.saved++; consecutive = 0; log(`视频已保存 ${id}`); continue;
        }
        if (downloadOnly) { consecutive = 0; continue; }
        if (row.status === 'downloaded') {
          if (!ASR_CONF.API_KEY) throw new Error('未配置 ASR Key');
          const result = await transcribeOne(row, tmp);
          markTranscribed(id, { text_source:'asr', text_chars:result.chars, text_path:result.textPath, audio_seconds:result.seconds });
          row = fresh(id); summary.text++;
        }
        if (!skipNotes && row.status === 'transcribed') {
          if (!NOTES_CONF.API_KEY) throw new Error('未配置 LLM Key');
          const result = await noteOne(row);
          if (result.skipped) { markSkipped(id, result.reason, { needsOcr:true }); summary.skipped++; }
          else {
            const note = writeNote(row, result.note, { dir: NOTES_CONF.NOTES_DIR });
            summary.transcriptLayouts.push({ id, ...note.transcript });
            if (note.transcript.mode === 'original') log(`转写排版回退完整原稿 ${id}：${note.transcript.reason}`);
            markExtracted(id, { text_source:'asr', text_chars:row.text_chars, note_path:note.file, category:result.note.分类, decay:note.decay, needs_ocr:result.needsOcr, prompt_hash:HASH });
            summary.notes++;
          }
        }
        consecutive = 0; log(`完成 ${id}，本轮 ${summary.processed} 条`);
      } catch (e) {
        if (e instanceof PauseError) { summary.paused = e.message; break; }
        markFailed(id, e.message, 'douyin', 3);
        summary.failures.push({ id, error:e.message });
        log(`失败 ${id}：${e.message}`);
        if (++consecutive >= 3) { summary.paused = '连续 3 条失败，停止本轮'; break; }
      }
    }
    return summary;
  } catch(e) {
    summary.paused = e.message;
    if (!(e instanceof PauseError)) summary.failures.push({ error:e.message });
    process.exitCode = e.code || 1;
    return summary;
  } finally {
    try {
    if (!dry && !has('--status')) {
      rmSync(tmp, { recursive:true, force:true });
      // 首次建基线不清理旧素材；日常收尾按独立转写成果判断资格。
      if (baseline() && !initializedThisRun) {
        try { summary.cleanup = cleanMedia({ dryRun:false }); }
        catch(e) { summary.failures.push({ error:`收尾清理失败：${e.message}` }); }
      }
      summary.pending = pendingQueue().length; summary.usedToday = usage();
      atomicWrite(join(stage.runDir, 'result.json'), JSON.stringify(summary, null, 2));
      stage.pruneRuns();
      if (summary.failures.length || summary.paused) stage.notify('dustoff 需要留意', summary.paused || `${summary.failures.length} 项失败`);
      if (summary.scanWarning) stage.notify('dustoff 扫描未完成', `已继续处理已有待办；${summary.scanWarning}`);
      if (summary.review) stage.notify('dustoff 用途待确认', `${summary.review} 条收藏请在作品详情选择用途`);
      log(`结束：处理 ${summary.processed}，成稿 ${summary.notes}，保存视频 ${summary.saved}，保存图集 ${summary.galleries}，待确认 ${summary.review}，待办 ${summary.pending}，${summary.paused || (summary.scanWarning ? '已有待办处理结束，新收藏扫描未完成' : '正常收尾')}`);
      if (summary.failures.length) process.exitCode = 1;
      else if (summary.paused && summary.paused !== `当天累计已达 ${POLICY.daily} 条`) process.exitCode = 5;
      else if (summary.scanWarning) process.exitCode = 1;
    }
    } finally { stage.releaseLock(); }
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e.message); process.exitCode=1; });
