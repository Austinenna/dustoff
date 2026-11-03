// X 书签扫描：书签总数不多（官方接口最多返回最近 800 条），首次全部读入，之后只读顶部新增。
//
// X 不提供收藏时间，书签按收藏先后倒序排列。首次扫描翻到底；之后每次从顶部读一页，
// 遇到账本里已有的推文就停（之前的都是新书签），并设页数上限。
// 取消再重新收藏的推文会回到顶部，但已入账，按 ID 去重不会重复处理。

export const FULL_PAGE = 100;
export const toId = tweetId => `x${tweetId}`;
export const tweetIdOf = id => String(id).replace(/^x/, '');

const isMediaLink = u => /^(pic\.(x|twitter)\.com)\//.test(u.display_url || '') || /\/(photo|video)\/\d+$/.test(u.expanded_url || '');
/** t.co 短链换成原地址，媒体自带的图片链接去掉。 */
export function expandText(text, urls = []) {
  let out = String(text || '');
  for (const u of urls) {
    if (!u?.url) continue;
    out = out.split(u.url).join(isMediaLink(u) ? '' : (u.unwound_url || u.expanded_url || u.url));
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}
export const links = (urls = []) => [...new Map(urls.filter(u => u?.url && !isMediaLink(u)).map(u => {
  const href = u.unwound_url || u.expanded_url || u.url;
  return [href, { url: href, title: u.title || null }];
})).values()];
/** 计算正文长度：去掉链接后按字符计（中英文都算一个）。 */
export const textChars = text => [...String(text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '')].length;

const mp4s = (variants = []) => [...variants].filter(v => v?.content_type === 'video/mp4' && /^https:\/\//.test(v.url || ''))
  .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
export function mediaOf(m) {
  if (m.type === 'photo') return { type: 'photo', url: m.url, width: m.width || null, height: m.height || null, alt: m.alt_text || '' };
  // 保存视频取最高码率，转写只需音频，取最低码率。
  const list = mp4s(m.variants);
  return { type: m.type, url: list[0]?.url || null, low: list.at(-1)?.url || null, preview: m.preview_image_url || null, duration_s: m.duration_ms ? Math.round(m.duration_ms / 1000) : null, width: m.width || null, height: m.height || null };
}
const isArticleLink = u => /^https:\/\/(x|twitter)\.com\/i\/article\/\d+$/.test(u.unwound_url || u.expanded_url || '');
/** 正文：X 长文取标题和全文（推文本身只有一个长文链接），长帖取全文，普通推文取原文。 */
const bodyOf = t => {
  const article = t.article?.plain_text ? t.article : null;
  const note = t.note_tweet?.text ? t.note_tweet : null;
  const urls = ((note?.entities || t.entities)?.urls || []).filter(u => !(article && isArticleLink(u)));
  if (article) return { text: String(article.plain_text).trim(), title: String(article.title || '').trim() || null, links: links(urls), long: true, article: true };
  return { text: expandText(note?.text || t.text, urls), title: null, links: links(urls), long: !!note, article: false };
};

/** 把接口返回的一条推文转成账本条目。includes 为同一页的 users / media / tweets。 */
export function toItem(tweet, includes = {}, fetchedAt = Math.floor(Date.now() / 1000)) {
  const users = new Map((includes.users || []).map(u => [u.id, u]));
  const medias = new Map((includes.media || []).map(m => [m.media_key, m]));
  const tweets = new Map((includes.tweets || []).map(t => [t.id, t]));
  const author = users.get(tweet.author_id) || {};
  const body = bodyOf(tweet);
  const media = (tweet.attachments?.media_keys || []).map(k => medias.get(k)).filter(Boolean).map(mediaOf);
  const refs = tweet.referenced_tweets || [];
  const quotedRaw = tweets.get(refs.find(r => r.type === 'quoted')?.id);
  let quoted = null;
  if (quotedRaw) {
    const qa = users.get(quotedRaw.author_id) || {}, qb = bodyOf(quotedRaw);
    quoted = { id: quotedRaw.id, author: qa.name || '', username: qa.username || '', text: qb.text, links: qb.links };
  }
  const videos = media.filter(m => m.type !== 'photo');
  const duration = videos.length ? Math.max(0, ...videos.map(v => v.duration_s || 0)) || null : null;
  return {
    aweme_id: toId(tweet.id), platform: 'x', tweet_id: tweet.id,
    media_type: videos.length ? 'video' : 'post', is_gallery: false,
    // 长文以标题作为条目标题，全文另存；普通推文的标题就是正文。
    desc: body.title || body.text, text: body.text, article_title: body.title, is_article: body.article,
    chars: textChars(body.text), long_post: body.long,
    author: author.name || '', username: author.username || '',
    create_time: tweet.created_at ? Math.floor(Date.parse(tweet.created_at) / 1000) : null,
    duration_s: duration, media, links: body.links, quoted,
    reply_to: refs.find(r => r.type === 'replied_to')?.id || null, conversation_id: tweet.conversation_id || null, lang: tweet.lang || null,
    collected_at: null, fetched_at: fetchedAt,
  };
}

/**
 * @param {{client, state, known:(id)=>boolean, pageSize?, maxPages?, log?, now?}} opts
 * @returns {{items, nextState, warnings, total, full}}
 */
export async function scanBookmarks({ client, state = null, known = () => false, pageSize = 20, maxPages = 5, log = () => {}, now = Date.now() }) {
  const me = await client.me();
  if (state?.user_id && state.user_id !== me.id) throw new Error(`X 授权账号 @${me.username} 与此前扫描的账号不同，已停止；如需更换账号请先重置 X 扫描状态`);
  const full = !state?.complete, fetchedAt = Math.floor(now / 1000);
  const items = [], seen = new Set(), warnings = [];
  let cursor, page = 0, total = 0, truncated = false;
  for (;;) {
    const res = await client.bookmarks(me.id, { max: full ? FULL_PAGE : pageSize, cursor });
    page++;
    let hitKnown = false;
    for (const tweet of res.data || []) {
      total++;
      const item = toItem(tweet, res.includes, fetchedAt);
      if (seen.has(item.aweme_id)) continue;
      seen.add(item.aweme_id);
      if (known(item.aweme_id)) { hitKnown = true; continue; }
      items.push(item);
    }
    cursor = res.meta?.next_token;
    if (!cursor || (!full && hitKnown)) break;
    if (!full && page >= maxPages) { truncated = true; warnings.push(`新书签超过 ${maxPages * pageSize} 条，本轮只读前 ${maxPages} 页，下轮重新完整读取`); break; }
  }
  if (full) log(`X 完整读取书签 ${total} 条`);
  // 没有衔接上旧书签就停下时，下轮改为完整读取，避免中间的新书签被顶部已入账的条目挡住。
  const nextState = { version: 1, user_id: me.id, username: me.username, complete: !truncated, created_at: state?.created_at ?? fetchedAt, scanned_at: fetchedAt };
  return { items, nextState, warnings, total, full, me };
}
