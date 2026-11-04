// 控制台与实际写操作共用相同范围；放弃/删除不作为模型可选择的用途。
export function processingActions(item, inScope) {
  const eligible=inScope&&item.media_type!=='gallery'
    &&!['baseline','gallery','too_long','user_deleted'].includes(item.skip_reason);
  return {
    can_discard:eligible&&['pending','downloaded','transcribed','review','failed'].includes(item.status),
    can_delete:eligible&&(item.status==='review'||item.status==='skipped'&&item.skip_reason==='user_discarded')
      // 收件箱预下载的暂存文件（.review）不算本地产物，删除记录时一并删掉。
      &&(!item.media_path||!!item.media_deleted||String(item.media_path).includes('/.review/'))&&!item.text_path&&!item.note_path,
  };
}
