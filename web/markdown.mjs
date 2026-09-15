// 保守的 Markdown 阅读渲染：不执行原始 HTML、不加载外部图片；所有文本先转义。
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function safeLink(value){try{if(value.startsWith('#'))return value;const u=new URL(value);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)return u.href;}catch{}return null;}
function inline(source){
  const stash=[];const keep=html=>{stash.push(html);return `\u0001${stash.length-1}\u0002`;};
  let s=String(source).replace(/[\u0001\u0002]/g,'');
  s=s.replace(/\\([\\`*_{}\[\]()#+.!>|~-])/g,(_,c)=>keep(escapeHtml(c)));
  s=s.replace(/`([^`\n]+)`/g,(_,t)=>keep(`<code>${escapeHtml(t)}</code>`));
  s=s.replace(/!\[([^\]]*)\]\([^)]*\)/g,(_,alt)=>keep(escapeHtml(alt||'图片')));
  s=s.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g,(_,label,url)=>{const href=safeLink(url);return keep(href?`<a href="${escapeHtml(href)}" ${href.startsWith('#')?'':'target="_blank" rel="noopener noreferrer"'}>${escapeHtml(label)}</a>`:escapeHtml(label));});
  s=escapeHtml(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
  return s.replace(/\u0001(\d+)\u0002/g,(_,n)=>stash[Number(n)]||'');
}
export function renderMarkdown(source,{headingOffset=0}={}){
  let text=String(source).replace(/^\uFEFF/,'');
  if(text.startsWith('---\n')||text.startsWith('---\r\n'))text=text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
  const lines=text.replace(/\r\n/g,'\n').split('\n'),out=[];let paragraph=[],list=null,code=null,quoted=[];
  const flush=()=>{if(paragraph.length){out.push('<p>'+inline(paragraph.join('\n')).replace(/ {2}\n/g,'<br>')+'</p>');paragraph=[];}if(list){out.push(`</${list}>`);list=null;}if(quoted.length){out.push('<blockquote>'+quoted.map(inline).join('<br>')+'</blockquote>');quoted=[];}};
  const cell=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(v=>v.trim());
  for(let n=0;n<lines.length;n++){
    const line=lines[n];
    if(code){if(new RegExp('^\\s*'+code.marker+'{'+code.length+',}\\s*$').test(line)){out.push('<pre><code>'+escapeHtml(code.lines.join('\n'))+'</code></pre>');code=null;}else code.lines.push(line);continue;}
    const fence=line.match(/^\s*(`{3,}|~{3,})/);if(fence){flush();code={marker:fence[1][0],length:fence[1].length,lines:[]};continue;}
    if(!line.trim()){flush();continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){flush();const level=Math.min(6,heading[1].length+headingOffset);out.push(`<h${level} id="${escapeHtml(heading[2])}">${inline(heading[2])}</h${level}>`);continue;}
    if(/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)){flush();out.push('<hr>');continue;}
    if(line.includes('|')&&n+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[n+1])){flush();out.push('<table><thead><tr>'+cell(line).map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>');n++;while(n+1<lines.length&&lines[n+1].includes('|'))out.push('<tr>'+cell(lines[++n]).map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>');out.push('</tbody></table>');continue;}
    const bullet=line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);if(bullet){const tag=bullet[1]?'ul':'ol';if(list!==tag){flush();list=tag;out.push('<'+tag+'>');}out.push('<li>'+inline(bullet[2])+'</li>');continue;}
    if(line.startsWith('>')){if(!quoted.length)flush();quoted.push(line.replace(/^>\s?/,''));continue;}
    if(list||quoted.length)flush();paragraph.push(line);
  }
  if(code)out.push('<pre><code>'+escapeHtml(code.lines.join('\n'))+'</code></pre>');flush();return out.join('\n');
}
