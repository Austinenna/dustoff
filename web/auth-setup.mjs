const token=location.hash.slice(1);
history.replaceState(null,'',location.pathname);
const form=document.querySelector('#setup-form'),error=document.querySelector('#error');
if(!/^[a-f0-9]{64}$/.test(token)){error.textContent='设置链接不完整或已失效，请重新获取一次性链接。';form.querySelector('button').disabled=true;}
form.addEventListener('submit',async event=>{
  event.preventDefault();error.textContent='';
  const data=new FormData(form);
  if(data.get('password')!==data.get('confirm')){error.textContent='两次输入的密码不一致。';return;}
  const button=form.querySelector('button');button.disabled=true;
  try{
    const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:data.get('password')})});
    if(response.ok||response.redirected){form.reset();location.href=location.pathname.replace(/auth\/setup$/,'');return;}
    error.textContent=(await response.json()).error||'设置失败，请重试。';
  }catch{error.textContent='连接失败，请重试。';}
  finally{button.disabled=false;}
});
