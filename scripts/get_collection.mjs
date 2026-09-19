#!/usr/bin/env node
// dustoff / get_collection.mjs
// 用已登录的持久化 profile，headless 打开抖音收藏页，CDP 截获收藏列表接口
// (aweme/v1/web/aweme/listcollection) 的响应体，输出收藏视频的 aweme_id 列表 + 标题。
//
// 用法:  node get_collection.mjs [最多取多少条=200]
//        收藏页是「最近收藏在前」，所以取前 N 条 = 最近收藏的 N 条。
//        环境变量 DUST_MAX_ROUNDS 控制滚动轮数上限（兜底防死循环，默认 400）。
// 前置:  先跑过 login.mjs 完成扫码登录（profile 里有 sessionid）。
// 输出 (stdout 单行 JSON):
//   { ok, count, logged_in, items:[{aweme_id, desc, author, create_time}] }
// 未登录时输出 { ok:false, logged_in:false }，退出码 4。

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { boundaryIndex, collectionChain } from './incremental.mjs';
import { makeCfg, DUST_HOME } from './config.mjs';
import { localPath, POLICY, requestSignal } from './policy.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { galleryImages, videoOptions, pickGear, playAddrUrls, isGallery, expiryOf } from './lib.mjs';
import { guardSession } from './session_guard.mjs';

const CHROME = process.env.DUST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = localPath(makeCfg()('DUST_PROFILE', join(DUST_HOME, 'chrome-profile')));
const PORT = Number(process.env.DUST_CDP_PORT || 9335);
const LIMIT = Math.min(100, Math.max(1, Number(process.argv[2] || POLICY.scan)));
const anchorFile = process.env.DUST_ANCHORS_FILE;
const anchors = anchorFile ? JSON.parse(readFileSync(anchorFile, 'utf8')) : null;
const MAX_ROUNDS = Number(process.env.DUST_MAX_ROUNDS || 400);
const STALL_LIMIT = Number(process.env.DUST_STALL || 4);  // 连续几轮没新条目就收工
const REQUIRE_AUDIO = process.env.DUST_REQUIRE_AUDIO !== '0';  // ASR 需要音轨，默认优先带音轨的档
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!existsSync(PROFILE)) { console.error('ERROR: 未找到登录 profile，请先跑 login.mjs'); process.exit(4); }

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--mute-audio', '--window-size=1280,2000',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

/**
 * 把 JSON 写到 stdout，**等真正冲刷完**再退出。
 *
 * 不能写成 console.log(...) + process.exit()：stdout 是管道时写入是异步的，
 * 超过管道缓冲区（macOS 64 KB）的部分会排队，而 process.exit() 立刻终止进程，
 * 排队的部分直接丢弃——结果就是一个正好 65536 字节、被腰斩的 JSON。
 *
 * 这个坑只在被父进程用管道接收时才出现：直接跑到终端（TTY）或
 * shell 重定向到文件都是同步写，看不出问题。所以它潜伏到
 * sync.mjs 第一次接管扫描输出时才暴露。
 */
function emit(obj, code = 0, done = null) {
  process.stdout.write(JSON.stringify(obj) + '\n', () => { if (done) done(); process.exit(code); });
}


async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: requestSignal() });
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome CDP 未就绪');
}

function cdp(ws) {
  let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach(fn => fn(m));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); rej(new Error('CDP 请求超时')); }, 15000);
    pending.set(mid, m => { clearTimeout(timer); m.error ? rej(new Error(m.error.message)) : res(m.result); });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  return { send, on: fn => listeners.push(fn) };
}

/**
 * 还原每条的收藏时刻。
 *
 * 抖音的 aweme 对象里**没有**收藏时间——132 个字段全查过，只有 create_time（发布）、
 * mix_info.*（合集）、play_progress.last_modified_time（我看到哪儿了）。
 * 唯一的来源是 listcollection 响应顶层的 `cursor`：微秒级 unix 时间戳，
 * 等于**这一页最后一条的收藏时刻**，逐页严格递减。
 *
 * 实测验证：账本里「昨天扫描之后才新增」的 8 条，全部落在第 1 页，一条不落。
 *
 * ## 精度：只有页边界是准的
 *
 * 每页最后一条精确到秒；页内其余按位次线性插值——但**插值假设页内均匀分布，
 * 而真实收藏是成簇的**（一次刷十分钟连收五条，然后隔一天）。实测 40 条里
 * 有 4 条（10%）被插值推到了发布时间之前，最多早 8.7 小时，说明误差可以很大。
 *
 * 真正的保证只有一条：**每条落在它所属那一页的区间内**。抖音一页 10 条，
 * 页跨度实测 9~34 小时；收藏稀疏的年份会更宽。所以这是个「大致哪天」的估计，
 * 不是精确时刻——对文件名的日期前缀够用，别拿它做别的推断。
 *
 * 用三个约束把估计值收紧：
 *   ① 收藏不可能早于发布 → 下限 create_time
 *   ② 收藏不可能晚于本页上界 → 上限 upper
 *   ③ 列表顺序就是收藏顺序 → 某条的下限对它上面所有条目同样成立，
 *      所以从页尾往页首走，把下限一路顶上去。这不只是为了单调好看：
 *      一条「8-25 发布、被顶到 8-25」的条目，等于告诉你它上面那些
 *      至少也是 8-25 之后收藏的——是白捡的信息
 *
 * @returns {{dated:number, clamped:number}} 赋值条数 / 被 create_time 抬上来的条数
 */
function assignCollectedAt(items, pages, fetchedAt) {
  const US = 1e6;
  const born = new Map(items.map(i => [i.aweme_id, i.create_time || 0]));
  const ok = pages
    // has_more=0 的最后一页 cursor 可能是 0 或垃圾值，按合理区间挡掉
    .filter(p => Number.isFinite(p.cursor) && p.cursor / US > 1.4e9 && p.cursor / US < 2e9 && p.ids.length)
    // 响应体是异步读的，到达顺序不保证；按 cursor 倒序才是真实页序
    .sort((a, b) => b.cursor - a.cursor);

  const when = new Map();
  let clamped = 0;
  let upperUs = fetchedAt * US;        // 第一页的上界就是本次扫描时刻
  for (const pg of ok) {
    const lowerUs = pg.cursor, k = pg.ids.length;
    const upper = Math.round(upperUs / US), lower = Math.round(lowerUs / US);
    // 页尾 → 页首。ids[0] 是最新收藏的，所以倒着走才是时间递增的方向
    let floor = lower;
    for (let j = k - 1; j >= 0; j--) {
      const id = pg.ids[j];
      // 第 j+1 条（从 1 数）；最后一条正好落在 lower 上，即精确值
      const interp = Math.round((upperUs - (upperUs - lowerUs) * (j + 1) / k) / US);
      floor = Math.max(floor, born.get(id) || 0);
      if (floor > interp) clamped++;
      floor = Math.min(Math.max(interp, floor), upper);
      if (!when.has(id)) when.set(id, floor);
    }
    upperUs = lowerUs;
  }

  let dated = 0;
  for (const it of items) {
    const t = when.get(it.aweme_id);
    if (t) { it.collected_at = t; dated++; } else { it.collected_at = null; }
  }
  return { dated, clamped };
}

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const { send, on } = cdp(ws);

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Network.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  // 登录态自检。顺带把 sessionid 的到期时间读出来交给守卫——
  // 这次 getCookies 本来就要做，读 expires 字段是白送的，不额外开销。
  // 守卫内部按自然日节流：一天只真正评估一次，不管今天被触发多少次。
  const { cookies } = await send('Network.getCookies', { urls: ['https://www.douyin.com/'] }, sessionId);
  const sess = cookies.find(c => /^sessionid$/.test(c.name) && c.value)
            || cookies.find(c => /^sessionid_ss$/.test(c.name) && c.value);
  const loggedIn = !!sess;
  const expiresAt = sess && sess.expires > 0 ? Math.floor(sess.expires) : null;

  const guard = guardSession({ loggedIn, expiresAt });
  if (guard.checked) {
    const tag = { ok: '✅', warn: '⚠️', expired: '❌', unknown: '❔' }[guard.level] || '·';
    console.error(`   登录态 ${tag} ${guard.reason}` + (guard.auto_renewing === true ? '（观察到到期时间在自动延长）' : ''));
  } else {
    console.error(`   登录态 · ${guard.reason}`);
  }

  if (!loggedIn) {
    return emit({
      ok: false, logged_in: false,
      hint: '请先跑 login.mjs 扫码登录（已写 ~/.dustoff/NEEDS_LOGIN 标记文件）',
    }, 4, cleanup);
  }

  // 收集 listcollection 响应。注意必须在 loadingFinished 时立刻读 body，
  // 否则请求一多，Chrome 会把早期响应体从缓冲区淘汰掉，最后统一读会大面积失败。
  let items = [];
  const pages = [];        // 每页的 { cursor, ids }，用来还原收藏时间，见 assignCollectedAt
  const tracked = new Map();
  const requestCursors = new Map();
  let scanError = null;
  const refresh = () => { const chain = collectionChain(pages); items = chain.items; sawNoMore = chain.complete; return chain; };
  let sawNoMore = false;
  let pending = 0;
  on(m => {
    if (m.method === 'Network.requestWillBeSent' && /aweme\/v1\/web\/aweme\/listcollection/.test(m.params.request.url)) {
      const req = m.params.request;
      let body = {};
      try { body = JSON.parse(req.postData || '{}'); } catch { body = Object.fromEntries(new URLSearchParams(req.postData || '')); }
      const cursor = new URL(req.url).searchParams.get('cursor') ?? body.cursor;
      requestCursors.set(m.params.requestId, cursor === undefined ? null : String(cursor));
    } else if (m.method === 'Network.responseReceived' &&
        /aweme\/v1\/web\/aweme\/listcollection/.test(m.params.response.url)) {
      const url = new URL(m.params.response.url);
      const cursor = url.searchParams.get('cursor') ?? requestCursors.get(m.params.requestId) ?? null;
      if (cursor === null) scanError = '收藏响应缺少请求游标';
      tracked.set(m.params.requestId, cursor);
    } else if (m.method === 'Network.loadingFinished' && tracked.has(m.params.requestId)) {
      const requestCursor = tracked.get(m.params.requestId);
      tracked.delete(m.params.requestId);
      pending++;
      send('Network.getResponseBody', { requestId: m.params.requestId }, sessionId)
        .then(r => {
          const j = JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body);
          if ((j.status_code !== undefined && j.status_code !== 0) || !Array.isArray(j.aweme_list)) throw new Error('收藏接口响应不完整');
          const pageItems = [];
          // cursor 是这一页最后一条的收藏时刻（微秒）。逐条对象里没有收藏时间，
          // 只有这里有——丢掉就再也拿不回来了。

          for (const a of (j.aweme_list || [])) {
            if (!a.aweme_id) continue;
            // listcollection 的响应里已经带了 play_addr / bit_rate / images，
            // 所以批量流程不需要再对每条视频单独跑 get_meta.mjs（省约 6s/条）。
            const gallery = isGallery(a);
            // requireAudio：ASR 需要音轨，而最低档常常是纯视频（实测 58%）
            const gear = gallery ? null : pickGear(a, { requireAudio: REQUIRE_AUDIO });
            pageItems.push({
              aweme_id: a.aweme_id,
              aweme_type: a.aweme_type ?? null,      // 0=视频 68=图集
              is_gallery: gallery,
              images: gallery ? galleryImages(a) : [],
              video_options: gallery ? null : videoOptions(a),
              desc: a.desc || '',
              author: (a.author && a.author.nickname) || '',
              create_time: a.create_time || null,
              duration_s: a.video && a.video.duration ? (a.video.duration / 1000) : null,
              // 下载用：码率尽量低、但优先带音轨的档位
              gear: gear ? gear.gear : null,
              gear_source: gear ? gear.source : null,
              gear_count: gear ? gear.gear_count : 0,
              width: gear ? gear.width : null,
              height: gear ? gear.height : null,
              size_bytes: gear ? gear.size : null,
              play_urls: gear ? gear.urls : [],
              // 兜底：万一选中的档位没音轨，下载端回落到这个（网页播放器用的地址）
              play_urls_fallback: gallery ? [] : playAddrUrls(a),
              // CDN 地址带签名有时效（实测 3~24 小时不等），过期返回 403
              url_expires_at: gear ? expiryOf(gear.urls) : null,
            });
          }
          pages.push({ request_cursor: requestCursor, cursor: j.cursor, has_more: j.has_more, ids: pageItems.map(i => i.aweme_id), items: pageItems });
          refresh();
        })
        .catch(e => { scanError = e.message; })
        .finally(() => { pending--; });
    }
  });

  await send('Page.navigate', { url: 'https://www.douyin.com/user/self?showTab=favorite_collection' }, sessionId);
  await sleep(4000);

  // 滚动触发分页加载。
  // 坑：抖音这个页面 window/body 是不滚动的（body.scrollHeight 恒等于视口高，scrollY 永远 0），
  // 真正的滚动容器是 .parent-route-container。用 window.scrollTo 会一条都翻不动。
  const SCROLL_JS = `(() => {
    const el = document.querySelector('.parent-route-container') ||
      [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 300);
    if (!el) return -1;
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  })()`;
  let stall = 0, lastCount = -1;
  for (let r = 0; r < MAX_ROUNDS; r++) {
    if (anchors !== null && (anchors.length ? boundaryIndex(items, anchors) >= 0 : sawNoMore)) break;
    if (anchors === null && items.length >= LIMIT) break;
    await send('Runtime.evaluate', { expression: SCROLL_JS }, sessionId);
    await sleep(1800);
    if (items.length === lastCount) stall++; else stall = 0;
    lastCount = items.length;
    if (r % 5 === 0) console.error(`   ... 第 ${r + 1} 轮，已收 ${items.length} 条`);
    if (anchors === null && items.length >= LIMIT) break;
    if (anchors !== null && (anchors.length ? boundaryIndex(items, anchors) >= 0 : sawNoMore)) break;
    if (sawNoMore && stall >= 2) break;
    if (stall >= STALL_LIMIT) break;
  }
  // 等还在飞的 getResponseBody 落地
  for (let i = 0; i < 20 && pending > 0; i++) await sleep(200);
  console.error(`   滚动结束，共 ${items.length} 条（has_more=0 ${sawNoMore ? '已出现' : '未出现'}）`);

  const fetchedAt = Math.floor(Date.now() / 1000);
  const ca = assignCollectedAt(items, pages, fetchedAt);
  console.error(`   收藏时刻：${ca.dated}/${items.length} 条已还原（${pages.length} 页游标，` +
    `${ca.clamped} 条被发布时间抬正）`);

  const chain = refresh();
  if (pending || tracked.size || chain.gap) scanError ||= '收藏分页缺失或尚未读完';
  if (!pages.length) scanError ||= '未收到收藏列表响应';
  const out = anchors === null ? items.slice(0, LIMIT) : items;
  const vids = out.filter(i => !i.is_gallery);
  const withUrls = vids.filter(i => i.play_urls.length);
  console.error(`   视频 ${vids.length} 条（其中 ${withUrls.length} 条已带下载地址）/ 图集 ${out.length - vids.length} 条`);
  emit({
    ok: !scanError, logged_in: true, scan_error: scanError, count: out.length,
    truncated: out.length < items.length || !sawNoMore,   // 还有更多没取
    page_cursors: pages.map(p => ({ request_cursor:p.request_cursor, cursor:p.cursor, count:p.items.length, has_more:p.has_more })),
    fetched_at: fetchedAt,                           // 下载端据此判断地址是否还新鲜
    session: { level: guard.level, days_left: guard.days_left },
    items: out,
  }, 0, () => { ws.close(); cleanup(); });
})().catch(e => { console.error('ERROR:', e.message); cleanup(); process.exit(1); });
