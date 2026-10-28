// 仅转发当前登录页的画面与有限输入；不接收脚本、URL 或 CDP 方法名。
export function validateLoginInput(value) {
  if (!value || typeof value !== 'object') throw new Error('登录操作无效');
  const {action}=value;
  if (action==='tap'||action==='drag'||action==='wheel') {
    for(const key of ['x','y']) if(!Number.isFinite(value[key])||value[key]<0||value[key]>(key==='x'?1100:850))throw new Error('操作位置无效');
    if(action==='drag'&&!['start','move','end'].includes(value.phase))throw new Error('拖动状态无效');
    if(action==='wheel'&&(!Number.isFinite(value.delta)||Math.abs(value.delta)>2000))throw new Error('滚动距离无效');
    return {action,x:value.x,y:value.y,...(action==='drag'?{phase:value.phase}:{}),...(action==='wheel'?{delta:value.delta}:{})};
  }
  if(action==='text'&&typeof value.text==='string'&&value.text.length>0&&value.text.length<=100)return {action,text:value.text};
  if(action==='key'&&['Backspace','Enter','Tab','Escape'].includes(value.key))return {action,key:value.key};
  if(action==='reload')return {action};
  throw new Error('登录操作无效');
}

export function createLoginControl() {
  let page=null,queue=Promise.resolve();
  return {
    setPage(value){page=value;},
    request(value){
      const selected=page;
      const task=queue.then(async()=>{
        if(!selected||selected!==page)throw new Error('当前没有可操作的登录页面');
        if(value.action==='frame') {
          const frame=await selected.command('Page.captureScreenshot',{format:'jpeg',quality:75});
          if(frame.data.length>6*1024**2)throw new Error('登录画面过大');
          return {image:frame.data};
        }
        const input=validateLoginInput(value);
        if(input.action==='tap') {
          // 普通表单按最上层元素定位，避免点到验证弹窗后方的同名输入框。
          await selected.evaluate(`(()=>{const e=document.elementFromPoint(${input.x},${input.y});if(!e)return;if(e.matches('input,textarea')){e.focus();return;}const control=e.closest('button,a,[role="button"],input,label')||e;control.click();})()`);
        } else if(input.action==='text')await selected.command('Input.insertText',{text:input.text});
        else if(input.action==='key') {
          const code={Backspace:8,Enter:13,Tab:9,Escape:27}[input.key];
          for(const type of ['keyDown','keyUp'])await selected.command('Input.dispatchKeyEvent',{type,key:input.key,windowsVirtualKeyCode:code});
        } else if(input.action==='reload')await selected.command('Page.reload');
        else if(input.action==='wheel')await selected.command('Input.dispatchMouseEvent',{type:'mouseWheel',x:input.x,y:input.y,deltaX:0,deltaY:input.delta});
        else {
          const type={start:'mousePressed',move:'mouseMoved',end:'mouseReleased'}[input.phase];
          await selected.command('Input.dispatchMouseEvent',{type,x:input.x,y:input.y,button:'left',buttons:input.phase==='end'?0:1,clickCount:1});
        }
        return {accepted:true};
      });
      queue=task.catch(()=>{});return task;
    },
  };
}
