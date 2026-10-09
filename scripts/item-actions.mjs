// 控制台与实际写操作共用相同范围；放弃/删除不作为模型可选择的用途。
export function processingActions(item, inScope) {
  const eligible=inScope&&item.media_type!=='gallery'
    &&!['baseline','gallery','too_long','user_deleted'].includes(item.skip_reason);
  return {
    can_discard:eligible&&['pending','downloaded','transcribed','review','failed'].includes(item.status),
    can_delete:eligible&&(item.status==='review'||item.status==='skipped'&&item.skip_reason==='user_discarded')
      &&(!item.media_path||!!item.media_deleted)&&!item.text_path&&!item.note_path,
  };
}
