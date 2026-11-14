// 演示站：游客的已读、看过的综述、素材箱和在收件箱里做的决定都存在这个浏览器里，不发给服务器。
// 服务器只提供演示数据，写操作一律拒绝；这里拦下控制台的写请求，在本地做出同样的效果。
export const guest=document.querySelector('meta[name="dustoff-guest"]')?.content==='1';
const snapshot=Number(document.querySelector('meta[name="dustoff-now"]')?.content)||null;
// 演示数据生成的那一刻。今日、本周、重温都按这天算，不随真实日期往后走。
export const now=()=>guest&&snapshot?snapshot:Date.now();
export const snapshotAt=snapshot;

const KEY='dustoff.demo',COLORS=['#C2703D','#5B7FC7','#8A5BC7','#2C8A6A','#C79A3D','#C75B6E','#4E9AA8','#7A8C3D'];
// seeded：素材箱样例已经复制过来了。游客删掉样例不会再冒出来；「清空我的操作」后重新复制。
const fresh=()=>({reads:{},pageReads:{},topics:[],materials:[],choices:{},next:1,seeded:false});
let mine=fresh();
try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved&&typeof saved==='object')mine={...fresh(),...saved};}catch{} // 存储不可用时只在本页有效
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(mine));}catch{}};
export function resetGuest(){mine=fresh();save();}
export const choiceOf=id=>mine.choices[id]||null;

const sec=()=>Math.floor(Date.now()/1000);
const fail=message=>{throw new Error(message);};
const topic=id=>mine.topics.find(t=>t.id===Number(id))||fail('选题不存在');
const material=id=>mine.materials.find(m=>m.id===Number(id))||fail('素材不存在');
const text=(v,label,max)=>{const t=String(v??'').trim();if(t.length>max)fail(`${label}不能超过 ${max} 字`);return t;};
let themes=[];

function saveTopic(data){
  const name=text(data.name,'选题名称',40);if(!name)fail('请填写选题名称');
  if(mine.topics.some(t=>t.name===name&&t.id!==Number(data.id)))fail('已有同名选题');
  const fields={name,description:text(data.description,'选题说明',500),channels:(data.channels||[]).slice(0,6),updated_at:sec()};
  if(data.id){Object.assign(topic(data.id),fields);save();return topic(data.id);}
  const t={id:mine.next++,...fields,color:COLORS[mine.topics.length%COLORS.length],created_at:sec()};mine.topics.push(t);save();return t;
}
function addMaterial(data){
  if(data.kind==='excerpt'&&!text(data.excerpt,'摘录',4000))fail('摘录内容为空，请先选中一段文字');
  const topic_id=data.topic_id==null||data.topic_id===''?null:topic(data.topic_id).id;
  const same=data.kind!=='excerpt'&&mine.materials.find(m=>m.item===data.item&&m.kind===data.kind);
  if(same){if(data.topic_id!==undefined)same.topic_id=topic_id;if(data.memo)same.memo=text(data.memo,'备注',1000);same.updated_at=sec();save();return same;}
  const m={id:mine.next++,item:data.item,kind:data.kind,topic_id,status:'todo',excerpt:text(data.excerpt,'摘录',4000),memo:text(data.memo,'备注',1000),usage:[],created_at:sec(),updated_at:sec()};
  mine.materials.push(m);save();return m;
}
function updateMaterial(data){
  const m=material(data.id);
  if(data.topic_id!==undefined)m.topic_id=data.topic_id===null||data.topic_id===''?null:topic(data.topic_id).id;
  if(data.status!==undefined)m.status=data.status;
  if(data.memo!==undefined)m.memo=text(data.memo,'备注',1000);
  if(data.excerpt!==undefined&&m.kind==='excerpt')m.excerpt=text(data.excerpt,'摘录',4000)||fail('摘录不能为空');
  m.updated_at=sec();save();return m;
}
// 第一次用素材箱时，把演示数据里的样例选题和素材复制到这个浏览器里，之后和游客自己收的一样能改能删。
async function seed(request){
  if(mine.seeded)return;
  const sample=await request('library'),ids=new Map();
  for(const t of sample.topics){const id=mine.next++;ids.set(t.id,id);mine.topics.push({id,name:t.name,description:t.description,channels:t.channels,color:t.color,created_at:t.created_at,updated_at:t.updated_at});}
  for(const m of sample.materials)mine.materials.push({id:mine.next++,item:m.item,kind:m.kind,topic_id:m.topic_id==null?null:ids.get(m.topic_id)??null,status:m.status,excerpt:m.excerpt,memo:m.memo,usage:m.usage,created_at:m.created_at,updated_at:m.updated_at});
  mine.seeded=true;save();
}
// 素材箱：本地的素材配上服务器上的作品摘要（标题、封面、平台）。
async function library(request){
  await seed(request);
  const ids=[...new Set(mine.materials.map(m=>m.item))];
  const found=ids.length?new Map((await request('summaries?ids='+encodeURIComponent(ids.join(',')))).items.map(i=>[i.id,i])):new Map();
  const materials=[...mine.materials].sort((a,b)=>b.updated_at-a.updated_at||b.id-a.id).map(m=>({...m,source:found.get(m.item)||{id:m.item,missing:true,title:'这条作品已不在演示站里'}}));
  const topics=mine.topics.map(t=>({...t,count:materials.filter(m=>m.topic_id===t.id).length,used:materials.filter(m=>m.topic_id===t.id&&m.status==='used').length}));
  return {topics,materials,unsorted:materials.filter(m=>m.topic_id===null).length};
}

/** 替代控制台的 api()：读请求照常发给服务器再叠上本地状态，写请求在本地完成。 */
export async function guestApi(path,data,request){
  const [name]=path.split('?');
  if(data===undefined){
    if(name==='library')return library(request);
    const value=await request(path);
    if(name==='notes-index')for(const n of value.items)n.read_at=mine.reads[n.id]||null;
    if(name==='knowledge'&&value.ready){value.pageReads=mine.pageReads;themes=value.themes;}
    // 收件箱里决定过的不再列出，和真的处理了一样。
    if(name==='items'&&/(^|&)status=review(&|$)/.test(path.split('?')[1]||'')){const before=value.items.length;value.items=value.items.filter(i=>!mine.choices[i.id]);value.total-=before-value.items.length;}
    if(name==='overview')value.review=Math.max(0,value.review-Object.keys(mine.choices).length);
    if(name==='item')value.guest_choice=mine.choices[value.id]||null;
    return value;
  }
  if(/^(topic|material)/.test(name))await seed(request);
  switch(name){
    case 'read':if(data.read)mine.reads[data.id]=sec();else delete mine.reads[data.id];save();return {item:data.id,read:!!data.read};
    case 'page-read':{
      const t=themes.find(x=>x.id===data.id);if(!t?.page_hash)fail('这个主题还没有综述页');
      const key=`${t.domain}｜${t.name}`;if(data.read)mine.pageReads[key]={hash:t.page_hash,read_at:sec()};else delete mine.pageReads[key];save();return {key,read:!!data.read};
    }
    case 'topic':return saveTopic(data);
    case 'topic-delete':topic(data.id);for(const m of mine.materials)if(m.topic_id===Number(data.id))m.topic_id=null;mine.topics=mine.topics.filter(t=>t.id!==Number(data.id));save();return {deleted:true};
    case 'material':return addMaterial(data);
    case 'material-update':return updateMaterial(data);
    case 'material-delete':material(data.id);mine.materials=mine.materials.filter(m=>m.id!==Number(data.id));save();return {deleted:true};
    // 收件箱的决定：记下来，演示站不会真的去下载或转写。
    case 'purpose':mine.choices[data.id]=data.purpose;save();return {guest:true};
    case 'discard':mine.choices[data.id]='discard';save();return {guest:true};
    case 'video-prepare':return request(path,data);
    default:fail('演示站只能看，这个操作会改动真实数据，这里不能做。');
  }
}
