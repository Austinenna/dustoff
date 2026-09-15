import {escapeHtml as esc} from './markdown.mjs';
const date=seconds=>seconds?new Date(seconds*1000).toLocaleString('zh-CN',{hour12:false}):'尚未检查';
export function remainingLabel(session){
  if(session?.logged_in===false||session?.level==='expired')return '需要重新登录';
  if(session?.remainingSeconds==null)return '到期时间未知';
  const hours=Math.floor(session.remainingSeconds/3600);
  return hours>=24?`剩余约 ${Math.floor(hours/24)} 天 ${hours%24} 小时`:hours>0?`剩余约 ${hours} 小时`:'即将到期';
}
export function statusCard(session,{compact=false,busy=false}={}){
  const s=session||{},warning=['warn','expired'].includes(s.level);
  return `<div class="row between"><div><small>抖音登录</small><h2 class="session-remaining ${warning?'session-warning':''}">${esc(remainingLabel(s))}</h2></div><div class="row">${compact?'<button type="button" data-action="go-login" class="link">登录管理 ›</button>':`<button type="button" data-action="check-session" ${busy?'disabled':''}>立即检查</button><button type="button" data-action="login" class="primary" ${busy?'disabled':''}>扫码登录</button>`}</div></div>${compact?'':`<div class="session-facts"><div><small>预计到期</small><p>${s.expires_at?date(s.expires_at):'抖音未提供固定到期时间'}</p></div><div><small>最后检查</small><p>${date(s.last_check_at)}${s.stale?' · 建议更新':''}</p></div><div><small>在线验证</small><p>${s.online==='verified'?'上次已确认可用':s.online==='login_required'?'抖音要求重新登录':'尚未确认'}${s.online_checked_at?'<br><small>'+date(s.online_checked_at)+'</small>':''}</p></div></div><p class="settings-note">剩余时间按登录凭据估算，抖音可能提前使其失效。每天运行时更新到期记录，也可立即检查；剩余不足 ${s.warnDays||7} 天时提醒。</p>`}`;
}
export function loginFlow(data){
  const a=data?.auth,active=data?.active;
  if(!a)return '<div class="empty">点击「扫码登录」获取抖音官方二维码。</div>';
  const scan=active&&data.kind!=='session-check',showQr=scan&&data.qrAt&&['qr','scanned'].includes(a.phase);
  return `<div class="login-flow-content"><div class="qr-frame">${showQr?'<img id="official-qr" alt="本次抖音官方登录二维码" width="240" height="240">':`<div class="qr-placeholder">${esc(a.phase==='success'?'登录已完成':a.phase==='checked'?'检查已完成':a.phase==='expired'?'二维码已过期':active?'正在准备…':'本次登录已结束')}</div>`}</div><div class="login-instructions"><h2>${esc(a.message)}</h2>${scan?'<p>打开手机抖音，使用「扫一扫」，并在手机上核对、确认本次电脑登录。</p><p class="settings-note">二维码来自抖音官方登录页，仅用于本次登录。不要扫描他人转发的登录二维码。</p>':''}<div class="row">${scan?'<button type="button" data-action="refresh-qr">刷新二维码</button><button type="button" data-action="login-window">在 Chrome 中完成</button>':''}${active?'<button type="button" data-action="cancel-login" class="link">取消本次操作</button>':a.phase!=='checked'?'<button type="button" data-action="login">重新扫码</button>':''}</div>${scan?'<p class="settings-note login-terms">官方页面提示：登录即代表同意<a href="https://www.douyin.com/agreements/?id=6773906068725565448" target="_blank" rel="noopener noreferrer">用户协议</a>和<a href="https://www.douyin.com/agreements/?id=6773901168964798477" target="_blank" rel="noopener noreferrer">隐私政策</a>。请自行阅读并在手机端决定是否确认。需要额外验证时，使用 Chrome 官方窗口完成。</p>':''}</div></div>`;
}
