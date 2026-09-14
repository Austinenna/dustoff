// 仅按作品 ID 和列表顺序确认交叠，不把收藏时间估计值用于边界判断。
export function boundaryIndex(items, anchors) {
  if (!anchors.length) return 0; // 仅由确实为空的初始收藏列表产生
  const positions = new Map(anchors.map((id, i) => [id, i]));
  const required = Math.min(3, anchors.length);
  let start = -1, last = -1, count = 0;
  for (let i = 0; i < items.length; i++) {
    const pos = positions.get(String(items[i].aweme_id));
    if (pos === undefined) { start = -1; last = -1; count = 0; continue; }
    if (count && pos <= last) { start = -1; count = 0; }
    if (!count) start = i;
    last = pos;
    if (++count >= required) return start;
  }
  return -1;
}
// 网络响应可乱序返回；只接受从 cursor=0 连续衔接的页，不能跳过丢失页。
export function collectionChain(pages) {
  const byCursor = new Map(pages.map(p => [String(p.request_cursor), p]));
  const seenCursors = new Set(), seenIds = new Set(), items = [];
  let cursor = '0', complete = false;
  while (byCursor.has(cursor) && !seenCursors.has(cursor)) {
    seenCursors.add(cursor);
    const page = byCursor.get(cursor);
    for (const item of page.items) {
      if (!seenIds.has(item.aweme_id)) { items.push(item); seenIds.add(item.aweme_id); }
    }
    if (page.has_more === 0) { complete = true; break; }
    cursor = String(page.cursor);
  }
  return { items, complete, pages: seenCursors.size, gap: seenCursors.size !== byCursor.size };
}
