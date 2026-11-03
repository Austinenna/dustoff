#!/usr/bin/env node
// 唯一的日常编排：首次只建基线，之后处理新增和持久待办，批次结束清理视频。
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DUST_HOME, makeCfg } from './scripts/config.mjs';
import { POLICY, TEMP, PauseError, mediaDecision, localPath, atomicWrite, deadlineMs } from './scripts/policy.mjs';
import { baseline, acceptScan, pendingQueue, reserveDaily, usage, retryItem, queueSkippedGalleries, migratePurposes, ScanError, itemRow } from './scripts/daily.mjs';
import { scanBilibili, processBilibili } from './scripts/sources/bilibili/index.mjs';
import { createClient } from './scripts/sources/bilibili/client.mjs';
import { scanX, processX } from './scripts/sources/x/index.mjs';
import { platformInfo, validItemId } from './scripts/platforms.mjs';
import { applyIntents, intentsById } from './scripts/intents.mjs';
import { db, importScan, importDownload, markTranscribed, markSkipped, markExtracted, markFailed, markRouting, markSaved } from './scripts/ledger.mjs';
import { createStage, EXIT } from './scripts/stage.mjs';
import { transcribeOne, cleanMedia, CONF as ASR_CONF } from './extract.mjs';
import { noteOne, writeNote, HASH, CONF as NOTES_CONF } from './notes.mjs';
import { classifyItem, PURPOSES } from './scripts/routing.mjs';
import { downloadGallery } from './scripts/gallery.mjs';
import { downloadOne } from './scripts/download.mjs';
import { cleanConvertedVideos } from './scripts/video-to-note.mjs';
import { appendHistory, codeVersion } from './scripts/run-history.mjs';
const scripts = join(dirname(fileURLToPath(import.meta.url)), 'scripts');
const fresh = id => itemRow(id);
// 抖音沿用原来的用途键（note / video …），其他平台加前缀，暂停和熔断互不影响。
const typeKey = (platform, kind) => platform === 'douyin' ? kind : `${platform}:${kind}`;
const typeLabel = key => { const [p, k] = key.includes(':') ? key.split(':') : ['douyin', key]; return `${p === 'douyin' ? '' : platformInfo(p).label}${PURPOSES[k]?.label || '用途判断'}`; };
/** 子脚本失败 → 错误。退出码 7 表示被抖音风控拦截：只暂停抖音本轮，不计这条作品的失败次数。 */
export function childError(name, code, lastError = '', timedOut = false) {
  if (!timedOut && code === 7) return Object.assign(new PauseError(`抖音读取被风控拦截：${lastError || '详情接口返回空内容'}，本轮暂停抖音，下轮重试`), { scope: 'platform', platform: 'douyin' });
  const e = new Error(timedOut ? `${name} 读取超时` : `${name} 失败（退出码 ${code}）${lastError ? `：${lastError}` : ''}`);
  e.code = code === 4 ? 4 : 1;
  return e;
}
async function script(name, args, env, log) {
  return new Promise((resolve, reject) => {
    const timeout = deadlineMs(name === 'get_collection.mjs' ? 15 * 60_000 : 90_000);
    const p = spawn(process.execPath, [join(scripts, name), ...args], { env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
    let out = '', timedOut = false, lastError = '';
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeout);
    const stop = () => p.kill('SIGTERM');
    process.once('exit', stop);
    p.stdout.on('data', d => { out += d; });
    // 子脚本把原因写在 stderr 的 "ERROR: …" 行；带进错误信息，失败记录里就能直接看到原因。
    p.stderr.on('data', d => { const text = String(d).trim(); log(text); const m = text.match(/ERROR:\s*(.+)/); if (m) lastError = m[1].slice(0, 200); });
    p.on('error', e => { clearTimeout(timer); process.removeListener('exit',stop); reject(e); });
    p.on('close', code => {
      clearTimeout(timer); process.removeListener('exit',stop);
      if (timedOut || code !== 0) { reject(childError(name, code, lastError, timedOut)); return; }
      try { resolve(JSON.parse(out)); } catch { reject(new Error('元数据输出不完整')); }
    });
  });
}
export async function main(args = process.argv.slice(2), { runScript = script, trashFile, bilibili = {}, x = {} } = {}) {
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
  const startedAt = Date.now();
  const stage = createStage({ name: 'run', dustHome: DUST_HOME, notify: makeCfg()('DUST_NOTIFY','1') !== '0', keepRuns: Number(makeCfg()('DUST_KEEP_RUNS',30)), record: !dry });
  const { log } = stage;
  stage.acquireLock();
  const summary = { mode: dry ? 'preview' : 'daily', scanned: 0, added: 0, processed: 0, notes: 0, text: 0, saved: 0, galleries: 0, review: 0, skipped: 0, failures: [], paused: null, pausedTypes: {}, pausedPlatforms: {}, quotaReached: [], scanWarning: null, cleanup: null, transcriptLayouts: [] };
  let initializedThisRun = false;
  const tmp = localPath(join(TEMP, `run-${process.pid}`));
  try {
    const old = baseline();
    if (has('--status') && has('--retry')) throw new Error('--status 不能与 --retry 同用');
    if (has('--retry') && !validItemId(value('--retry'))) throw new Error('--retry 需要作品 ID');
    // 控制台在上一轮运行期间记下的用户决定，持锁后先执行。
    if (!dry && !has('--status')) { const r = applyIntents(DUST_HOME, { log }); if (r.applied || r.failed.length) summary.intents = r; }
    if (!dry && !has('--status') && old) {
      const migrated = migratePurposes();
      if (migrated.requeued) log(`恢复 ${migrated.requeued} 条旧混合用途，按新规则重新判断；现有文件保留`);
      const restored = queueSkippedGalleries();
      if (restored) log(`恢复 ${restored} 条此前跳过的图集为待办`);
    }
    if (value('--retry')) {
      if (dry) { log('预览模式不重置失败状态'); return summary; }
      log(`恢复 ${value('--retry')} 到 ${retryItem(value('--retry'))} 阶段`);
    }
    if (has('--status')) { console.log(JSON.stringify({ baseline: old, pending: pendingQueue().length, usedToday: usage(), usedTodayByPlatform: { douyin: usage(undefined, 'douyin'), bilibili: usage(undefined, 'bilibili'), x: usage(undefined, 'x') }, policy: POLICY }, null, 2)); return summary; }
    log(`版本 ${codeVersion()} · 进程 ${process.pid}`);
    log(`日常限制：${POLICY.daily} 条/日，${POLICY.seconds} 秒，${POLICY.bytes / 1024 ** 3} GiB 媒体，至少 ${POLICY.free / 1024 ** 3} GiB 空闲；外接盘停用`);
    if (POLICY.x.enabled) log(`X 限制：${POLICY.x.daily} 条/日（全部平台合计 ${POLICY.totalDaily} 条），正文 ${POLICY.x.noteChars} 字以上另出笔记，视频转写单条 ${POLICY.x.asrSeconds / 60} 分钟`);
    if (POLICY.bilibili.enabled) log(`B站限制：${POLICY.bilibili.daily} 条/日（全部平台合计 ${POLICY.totalDaily} 条），单条 ${POLICY.bilibili.seconds / 60} 分钟，无字幕转写单条 ${POLICY.bilibili.asrSeconds / 60} 分钟、每日 ${POLICY.bilibili.dailyAsrSeconds / 60} 分钟`);
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
    // B 站扫描与抖音互不影响：失败只记警告，已有待办照常处理。
    if (!noScan && POLICY.bilibili.enabled) {
      try {
        const r = await scanBilibili({ log, client: bilibili.client });
        summary.bilibili = { scanned: r.scanned, added: r.added, folders: r.folders };
        summary.scanned += r.scanned; summary.added += r.added;
        log(`B站扫描 ${r.folders} 个收藏夹，新收藏 ${r.scanned} 条，新增待办 ${r.added} 条`);
      } catch (e) {
        if (e instanceof PauseError && !e.scope) throw e;
        const message = `B站：${e.message}`;
        summary.scanWarning = summary.scanWarning ? `${summary.scanWarning}；${message}` : message;
        log(`B站扫描未完成：${e.message}；继续处理已有待办`);
      }
    }
    // X 扫描同样互不影响：未连接、限流或额度用尽只记警告。
    if (!noScan && POLICY.x.enabled) {
      try {
        const r = await scanX({ log, client: x.client });
        summary.x = { scanned: r.scanned, added: r.added, total: r.total };
        summary.scanned += r.scanned; summary.added += r.added;
        log(`X 读取书签 ${r.total} 条${r.full ? '（完整读取）' : ''}，新书签 ${r.scanned} 条，新增待办 ${r.added} 条`);
      } catch (e) {
        if (e instanceof PauseError && !e.scope) throw e;
        const message = `X：${e.message}`;
        summary.scanWarning = summary.scanWarning ? `${summary.scanWarning}；${message}` : message;
        log(`X 扫描未完成：${e.message}；继续处理已有待办`);
      }
    }
    // 模型密钥在实际走到对应分支时检查，单纯保存视频无需 ASR/笔记密钥。
    const consecutive = {}, quotaFull = {};
    let biliClient = null;
    const biliDeps = {
      client: () => biliClient ||= bilibili.client || createClient(),
      transcribe: transcribeOne, note: noteOne, writeNote, hash: HASH,
      textDir: ASR_CONF.TEXT_DIR, notesDir: NOTES_CONF.NOTES_DIR, asrKey: ASR_CONF.API_KEY, llmKey: NOTES_CONF.API_KEY,
      ...bilibili.deps,
    };
    const xDeps = {
      transcribe: transcribeOne, note: noteOne, writeNote, hash: HASH,
      textDir: ASR_CONF.TEXT_DIR, notesDir: NOTES_CONF.NOTES_DIR, asrKey: ASR_CONF.API_KEY,
      llm: { base: NOTES_CONF.BASE, key: NOTES_CONF.API_KEY, model: NOTES_CONF.MODEL, effort: NOTES_CONF.EFFORT, maxTokens: NOTES_CONF.MAX_TOKENS },
      ...x.deps,
    };
    const processors = { bilibili: [processBilibili, biliDeps], x: [processX, xDeps] };
    const queue = pendingQueue().filter(r => (!downloadOnly || r.status === 'pending') && (!value('--retry') || r.id === value('--retry')));
    for (const candidate of queue) {
      if (summary.processed >= limit) break;
      deadlineMs();
      let row = fresh(candidate.id);
      let item = JSON.parse(candidate.metadata);
      const id = row.id, platform = row.platform;
      let kind = row.media_type === 'gallery' ? 'gallery' : row.processing_mode || 'routing';
      if (summary.pausedPlatforms[platform] || quotaFull[platform] || summary.pausedTypes[typeKey(platform, kind)]) continue;
      if (platform !== 'douyin' && !POLICY[platform]?.enabled) continue;
      // 用户刚在控制台改过的条目本轮不处理，收尾时按新决定执行。
      if (intentsById(DUST_HOME).has(id)) { log(`跳过 ${id}：有运行期间记下的操作，本轮结束后执行`); continue; }
      try {
        if (processors[platform]) {
          if (!reserveDaily(id)) {
            if (usage() >= POLICY.totalDaily) { summary.paused = `当天累计已达 ${POLICY.totalDaily} 条`; summary.quotaPaused = true; break; }
            quotaFull[platform] = true; summary.quotaReached.push(platform); log(`${platformInfo(platform).label}当天已达 ${POLICY[platform].daily} 条，其他平台继续`); continue;
          }
          summary.processed++;
          const [processItem, deps] = processors[platform];
          await processItem({ candidate, summary, log, tmp, downloadOnly, skipNotes, deps });
          consecutive[typeKey(platform, fresh(id).processing_mode || kind)] = 0;
          log(`完成 ${id}，本轮 ${summary.processed} 条`);
          continue;
        }
        if(row.delete_after_note&&row.status==='pending')throw new Error('本地原视频不可用，转换已暂停；请恢复原文件后重试');
        if (row.status === 'pending') {
          const reason = mediaDecision(item);
          if (reason && reason !== 'unknown_duration') { markSkipped(id, reason); summary.skipped++; continue; }
        }
        if (!reserveDaily(id)) {
          if (usage() >= POLICY.totalDaily) { summary.paused = `当天累计已达 ${POLICY.totalDaily} 条`; summary.quotaPaused = true; break; }
          quotaFull[platform] = true; summary.quotaReached.push(platform);
          if (!POLICY.bilibili.enabled && !POLICY.x.enabled) { summary.paused = `当天累计已达 ${POLICY.daily} 条`; summary.quotaPaused = true; break; }
          log(`抖音当天已达 ${POLICY.daily} 条，其他平台继续`); continue;
        }
        summary.processed++;
        if (kind === 'routing') {
          const decision = await classifyItem(item);
          consecutive.routing = 0;
          markRouting(id, decision); row = fresh(id); kind = decision.purpose;
          log(`用途 ${id}：${PURPOSES[kind].label}`);
          if (kind === 'review') { summary.review++; continue; }
          retryItem(id); row = fresh(id); // 可复用旧分类留下的视频或文字稿。
        }
        if (summary.pausedTypes[kind]) continue;
        if (row.media_type === 'gallery') {
          if (row.processing_mode !== 'gallery') markRouting(id,{purpose:'gallery',reason:'媒体格式为图集'});
          // 图集不调用用途模型、ASR 或笔记模型；旧地址按作品单独刷新。
          if (row.status === 'pending') {
            if (!item.fetched_at || Date.now()/1000-item.fetched_at > 1800 || !item.images?.length || item.images.some(image=>!image.urls?.length)) {
              const meta = await runScript('get_meta.mjs', [`https://www.douyin.com/note/${id}`], {}, log);
              if (meta.unavailable) { markSkipped(id, 'unavailable'); summary.skipped++; log(`作品已失效 ${id}：${meta.message}`); continue; }
              if (!meta.ok || String(meta.aweme_id) !== id || !meta.is_gallery) throw new Error('刷新图集元数据失败或作品不匹配');
              item = {...meta,fetched_at:Math.floor(Date.now()/1000)};
              importScan([item]);
              db().prepare('UPDATE daily_queue SET metadata=? WHERE id=?').run(JSON.stringify(item),id);
            }
            importDownload([await downloadGallery(item)],'douyin',{countFailures:false});
          }
          markSaved(id);summary.galleries++;consecutive[kind]=0;log(`图集已保存 ${id}`);continue;
        }
        if (row.status === 'pending') {
          // 排队地址跨天会失效；即使扫描停在更靠前的边界，也能按 ID 单独刷新。
          if (!item.fetched_at || Date.now()/1000 - item.fetched_at > 1800 || mediaDecision(item) === 'unknown_duration' || !item.play_urls?.length || (PURPOSES[row.processing_mode]?.quality === 'high' && !item.video_options?.high)) {
            const meta = await runScript('get_meta.mjs', [`https://www.douyin.com/video/${id}`], {}, log);
            if (meta.unavailable) { markSkipped(id, 'unavailable'); summary.skipped++; log(`作品已失效 ${id}：${meta.message}`); continue; }
            if (!meta.ok || String(meta.aweme_id) !== id) throw new Error('刷新元数据失败或作品 ID 不匹配');
            item = { ...meta, fetched_at: Math.floor(Date.now()/1000) };
            importScan([item]);
            db().prepare('UPDATE daily_queue SET metadata=? WHERE id=?').run(JSON.stringify(item), id);
          }
          const result = await downloadOne(item, { purpose:row.processing_mode });
          importDownload([result], 'douyin', { countFailures:false });
          row = fresh(id);
          if (row.status === 'skipped') { summary.skipped++; continue; }
        }
        if (row.processing_mode === 'video' && row.status === 'downloaded') {
          markSaved(id); summary.saved++; consecutive[kind] = 0; log(`视频已保存 ${id}`); continue;
        }
        if (downloadOnly) { consecutive[kind] = 0; continue; }
        if (row.processing_mode !== 'note') throw new Error('只有知识笔记类型可以转写和整理');
        if (row.status === 'downloaded') {
          if (!ASR_CONF.API_KEY) throw new Error('未配置 ASR Key');
          const result = await transcribeOne(row, tmp);
          markTranscribed(id, { text_source:'asr', text_chars:result.chars, text_path:result.textPath, audio_seconds:result.seconds });
          row = fresh(id); summary.text++;
        }
        if (!skipNotes && row.status === 'transcribed') {
          if (!NOTES_CONF.API_KEY) throw new Error('未配置 LLM Key');
          const result = await noteOne(row);
          if (result.skipped) { markSkipped(id, result.reason); summary.skipped++; }
          else {
            const note = writeNote(row, result.note, { dir: NOTES_CONF.NOTES_DIR });
            summary.transcriptLayouts.push({ id, ...note.transcript });
            if (note.transcript.mode === 'original') log(`转写排版回退完整原稿 ${id}：${note.transcript.reason}`);
            markExtracted(id, { text_source:'asr', text_chars:row.text_chars, note_path:note.file, category:result.note.分类, decay:note.decay, retain_media:result.missingContent, prompt_hash:HASH });
            summary.notes++;
          }
        }
        consecutive[kind] = 0; log(`完成 ${id}，本轮 ${summary.processed} 条`);
      } catch (e) {
        kind = fresh(id)?.processing_mode || kind;
        const key = typeKey(platform, kind);
        if (e instanceof PauseError) {
          if (e.scope === 'platform') { summary.pausedPlatforms[platform] = e.message; log(`${e.message}；继续其他平台`); continue; }
          if (!e.scope) { summary.paused = e.message; break; }
          summary.pausedTypes[key] = e.message;
          log(`${typeLabel(key)}暂停：${e.message}；继续其他类型`);continue;
        }
        if (e.code === 4 && platform !== 'douyin') { summary.pausedPlatforms[platform] = e.message; log(`${e.message}；继续其他平台`); continue; }
        markFailed(id, e.message, platform, 3);
        summary.failures.push({ id, platform, kind, error:e.message });
        log(`失败 ${id}：${e.message}`);
        consecutive[key] = (consecutive[key] || 0) + 1;
        if (consecutive[key] >= 3) {
          summary.pausedTypes[key] = '连续 3 条失败，本轮暂停该类型';
          log(`${typeLabel(key)}连续 3 条失败；继续其他类型`);
        }
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
      try { const r = applyIntents(DUST_HOME, { log }); if (r.applied || r.failed.length) summary.intentsAfter = r; }
      catch(e) { summary.failures.push({ error:`执行运行期间记下的操作失败：${e.message}` }); }
      // 首次建基线不清理旧素材；日常收尾按独立转写成果判断资格。
      if (baseline() && !initializedThisRun) {
        try { summary.cleanup = cleanMedia({ dryRun:false }); }
        catch(e) { summary.failures.push({ error:`收尾清理失败：${e.message}` }); }
        try {
          summary.convertedCleanup = await cleanConvertedVideos({trashFile,log});
          summary.failures.push(...summary.convertedCleanup.failures);
        } catch(e) { summary.failures.push({ error:`转换视频清理失败：${e.message}` }); }
      }
      summary.pending = pendingQueue().length; summary.usedToday = usage();
      atomicWrite(join(stage.runDir, 'result.json'), JSON.stringify(summary, null, 2));
      stage.pruneRuns();
      if (summary.failures.length || summary.paused) stage.notify('dustoff 需要留意', summary.paused || `${summary.failures.length} 项失败`);
      else if (Object.keys(summary.pausedTypes).length) stage.notify('dustoff 部分类型暂停', Object.values(summary.pausedTypes).join('；'));
      if (Object.keys(summary.pausedPlatforms).length) stage.notify('dustoff 平台暂停', Object.values(summary.pausedPlatforms).join('；'));
      if (summary.scanWarning) stage.notify('dustoff 扫描未完成', `已继续处理已有待办；${summary.scanWarning}`);
      if (summary.review) stage.notify('dustoff 用途待确认', `${summary.review} 条收藏请在作品详情选择用途`);
      log(`结束：处理 ${summary.processed}，成稿 ${summary.notes}，保存视频 ${summary.saved}，保存图集 ${summary.galleries}，待确认 ${summary.review}，待办 ${summary.pending}，${summary.paused || (Object.keys(summary.pausedTypes).length ? '部分类型暂停，其他类型已继续' : summary.scanWarning ? '已有待办处理结束，新收藏扫描未完成' : '正常收尾')}`);
      // 退出码：整轮异常已在上方 catch 置为 1（或登录 4）；本轮跑完但有条目失败、扫描受阻记 2，
      // 暂停记 5。定时服务把 2、5 视为正常结束，systemd 的 failed 只留给真正的异常。
      if (!process.exitCode) {
        if (summary.failures.length) process.exitCode = 2;
        else if (summary.paused && !summary.quotaPaused) process.exitCode = 5;
        else if (Object.keys(summary.pausedTypes).length || Object.keys(summary.pausedPlatforms).length) process.exitCode = 5;
        else if (summary.scanWarning) process.exitCode = 2;
      }
      appendHistory(DUST_HOME, stage.runId, summary, process.exitCode || 0, startedAt);
    }
    } finally { stage.releaseLock(); }
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e.message); process.exitCode=1; });
