// 定时计划的时间计算；控制台和 launchd 入口共用。
export function parseTime(value) {
  if (typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('时间请用 24 小时制 HH:MM，例如 22:00 或 21:30');
  const [Hour,Minute]=value.split(':').map(Number);return {Hour,Minute};
}
export function parseInterval(value) {
  if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>720)throw new Error('运行间隔须为 1–720 的整数小时');
  return value;
}
export function nextTime(time,now=Date.now()) {
  const {Hour,Minute}=parseTime(time),date=new Date(now);date.setHours(Hour,Minute,0,0);
  if(date.getTime()<=now)date.setDate(date.getDate()+1);
  return date.toISOString();
}
export function makePlan({time='22:00',intervalHours=24,startAt=null}={},now=Date.now()) {
  parseTime(time);parseInterval(intervalHours);
  if(startAt!==null&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/.test(startAt)||!Number.isFinite(Date.parse(startAt))))throw new Error('定时起点记录无效');
  return {time,intervalHours,startAt:startAt||nextTime(time,now)};
}
export function scheduleKey(plan){return `${plan.startAt}/${plan.intervalHours}`;}
export function nextOccurrence(plan,now=Date.now()) {
  if(!plan.startAt)return nextTime(plan.time,now);
  const start=Date.parse(plan.startAt),interval=parseInterval(plan.intervalHours)*3600000;
  return new Date(start+Math.max(0,Math.floor((now-start)/interval)+1)*interval).toISOString();
}
export function dueOccurrence(plan,lastRun,now=Date.now()) {
  const start=Date.parse(plan.startAt),interval=parseInterval(plan.intervalHours)*3600000;
  if(!Number.isFinite(start))throw new Error('定时起点记录无效');
  if(now<start)return null;
  const slot=start+Math.floor((now-start)/interval)*interval;
  if(lastRun?.scheduleKey===scheduleKey(plan)&&Date.parse(lastRun.scheduledFor)>=slot)return null;
  // 上一轮尚在处理时跨过的时刻不在结束后追赶，继续等下一次安排。
  if(lastRun?.scheduleKey===scheduleKey(plan)&&Date.parse(lastRun.finishedAt)>slot)return null;
  return new Date(slot).toISOString();
}
export function calendarSlots(time,intervalHours) {
  const {Hour,Minute}=parseTime(time);parseInterval(intervalHours);
  const gcd=(a,b)=>b?gcd(b,a%b):a,step=gcd(24,intervalHours);
  return Array.from({length:24/step},(_,i)=>({Hour:(Hour+i*step)%24,Minute}));
}
