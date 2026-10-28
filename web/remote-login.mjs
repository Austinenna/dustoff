const token=document.querySelector('meta[name="dustoff-token"]').content;
let current=null,busy=false,blobURL=null,chain=Promise.resolve();
const status=(node,text)=>{const el=node.querySelector('.remote-status');if(el)el.textContent=text;};
function input(node,data){
  chain=chain.catch(()=>{}).then(async()=>{
    if(!node.isConnected)return;
    const response=await fetch('api/login-input',{method:'POST',headers:{'Content-Type':'application/json','X-Dustoff-Token':token},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
    if(!response.ok){const error=await response.json();throw new Error(error.error||'操作失败');}
  }).catch(e=>status(node,e.message));
  return chain;
}
function connect(node){
  const img=node.querySelector('img'),text=node.querySelector('input');let pointer=null,lastMove=0;
  const point=e=>{const r=img.getBoundingClientRect();return {x:Math.max(0,Math.min(1100,(e.clientX-r.left)*1100/r.width)),y:Math.max(0,Math.min(850,(e.clientY-r.top)*850/r.height))};};
  img.addEventListener('pointerdown',e=>{if(e.button!==0)return;pointer={...point(e),drag:false};img.setPointerCapture(e.pointerId);img.focus();e.preventDefault();});
  img.addEventListener('pointermove',e=>{if(!pointer)return;const p=point(e);if(!pointer.drag&&Math.hypot(p.x-pointer.x,p.y-pointer.y)>6){pointer.drag=true;void input(node,{action:'drag',phase:'start',x:pointer.x,y:pointer.y});}if(pointer.drag&&Date.now()-lastMove>80){lastMove=Date.now();void input(node,{action:'drag',phase:'move',...p});}});
  img.addEventListener('pointerup',e=>{if(!pointer)return;void input(node,{action:pointer.drag?'drag':'tap',...(pointer.drag?{phase:'end'}:{}),...point(e)});pointer=null;});
  img.addEventListener('pointercancel',e=>{if(pointer?.drag)void input(node,{action:'drag',phase:'end',...point(e)});pointer=null;});
  img.addEventListener('wheel',e=>{e.preventDefault();void input(node,{action:'wheel',...point(e),delta:Math.max(-1500,Math.min(1500,e.deltaY))});},{passive:false});
  img.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const action=e.key.length===1?{action:'text',text:e.key}:['Backspace','Enter','Tab','Escape'].includes(e.key)?{action:'key',key:e.key}:null;if(action){e.preventDefault();void input(node,action);}});
  node.querySelector('[data-remote-send]').onclick=()=>{const value=text.value;text.value='';if(value)void input(node,{action:'text',text:value});};
  text.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();node.querySelector('[data-remote-send]').click();}});
  node.querySelector('[data-remote-backspace]').onclick=()=>input(node,{action:'key',key:'Backspace'});
  node.querySelector('[data-remote-reload]').onclick=()=>input(node,{action:'reload'});
}
async function refresh(){
  if(busy||document.hidden)return;
  const node=document.querySelector('[data-remote-login]');
  if(node!==current){if(blobURL){URL.revokeObjectURL(blobURL);blobURL=null;}current=node;if(node)connect(node);}
  if(!node)return;busy=true;
  try{
    const response=await fetch('api/login-frame',{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('登录画面暂不可用，请稍候');
    const image=await response.blob();if(current!==node||!node.isConnected)return;
    const previous=blobURL;blobURL=URL.createObjectURL(image);node.querySelector('img').src=blobURL;if(previous)URL.revokeObjectURL(previous);
    status(node,'官方页面 · 画面自动更新');
  }catch(e){status(node,e.message);}finally{busy=false;}
}
setInterval(refresh,1500);
