import {AquariumMap} from './map3d.js?v=viewing-2';
import {Playback,decodeMotionFrames} from './playback.mjs?v=viewing-2';
import {activePrograms} from './programs.mjs';
const $=id=>document.getElementById(id);
let meta,state,map,playback,running=false,busy=false,selected=null,mutating=false,scrubbing=false,batchPromise=null;
let checkpoints=[],serverDone=false;
const zoneRows=new Map();let programKey='',eventKey='',selectionKey='';
const setText=(id,value)=>{if($(id).textContent!==String(value))$(id).textContent=value;};
function controls(){for(const id of ['reset','play','day-progress'])$(id).disabled=mutating||!state;}
const fmt=n=>n.toLocaleString('ko-KR');
async function request(path,data){
  const r=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const body=await r.json();if(!r.ok)throw new Error(body.error||'서버 요청에 실패했습니다.');return body;
}
function message(error){$('error').textContent=error;$('error').hidden=!error;}
function setRunning(value){running=value;controls();$('play').textContent=running?'❚❚':'▶';$('play').setAttribute('aria-label',running?'일시정지':'재생');$('play').title=running?'일시정지':'재생';}
async function mutate(path,data,resume=false){
  if(mutating)return;mutating=true;setRunning(false);message('');
  try{
    // 진행 중인 재생 요청이 끝난 뒤 변경하여 과거 응답이 선택 시각을 덮지 않게 한다.
    await batchPromise;playback?.clear();checkpoints=[];serverDone=false;
    state=await request(path,data);serverDone=state.done;scrubbing=false;render();setRunning(resume&&!state.done);
  }catch(e){scrubbing=false;message(e.message);if(state)render();setRunning(false);}
  finally{mutating=false;controls();}
}
function showTime(time){
  const seconds=Math.floor(time),clock=`${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  setText('clock',clock);$('day-progress').setAttribute('aria-valuetext',clock);
}
function render(updateMap=true){
  for(const id of ['planned','pending','entered','inside','exited'])setText(id,fmt(state.metrics[id]));
  controls();
  $('day-progress').max=state.horizon-state.opening;if(!scrubbing&&updateMap){showTime(state.time);$('day-progress').value=state.time-state.opening;}setText('peak',`최대 체류 ${fmt(state.metrics.peak)}명`);
  setText('queued-total',`대기 ${fmt(state.metrics.queueing)}명`);
  if(updateMap)map?.update(state);renderZones();renderSelection();drawChart();drawArrivals();if(updateMap)renderPrograms(state.time);
  setText('arrival-note','가상 실험 분포 · 실제 시설 통계 아님');
  const nextEventKey=JSON.stringify(state.recent);
  if(nextEventKey===eventKey)return;eventKey=nextEventKey;
  $('events').replaceChildren(...state.recent.slice(0,6).map(item=>{
    const row=document.createElement('div'),t=document.createElement('time'),s=document.createElement('span');t.textContent=item.time;s.textContent=item.text;row.append(t,s);return row;
  }));
}
function select(id){selected=selected===id?null:id;map?.select(selected);$('selection').hidden=!selected;renderSelection();renderZones();const row=zoneRows.get(selected);if(row){row.button.after($('selection'));$('selection').scrollIntoView({block:'nearest'});}}
function renderPrograms(time=state.time){
  const programs=activePrograms(meta.map.reference_programs,time);
  const key=JSON.stringify(programs);if(key===programKey)return;programKey=key;
  $('program-list').replaceChildren(...programs.map(p=>{
    const d=document.createElement('div'),t=document.createElement('strong'),name=document.createElement('span'),duration=document.createElement('span');
    d.className='program-row';name.className='program-name';duration.className='program-duration';
    t.textContent=p.start;name.textContent=`${p.node} · ${p.name}`;duration.textContent=`${p.duration_minutes}분간`;
    d.append(t,name,duration);return d;
  }));
  if(!programs.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='진행 중인 공연이 없습니다.';$('program-list').append(empty);}
}
function renderSelection(){
  const key=JSON.stringify([selected,state.zones.find(z=>z.id===selected)]);if(key===selectionKey)return;selectionKey=key;
  if(!selected)return;const n=meta.map.nodes.find(n=>n.id===selected),z=state.zones.find(z=>z.id===selected);if(!n)return;
  $('selected-name').textContent=n.name;
  const duration=n.access_mode==='controlled_show'?`공연 ${meta.map.reference_programs.find(p=>p.node===n.id)?.duration_minutes??20}분`:`관람 ${n.dwell_minutes.join('~')}분`;
  $('selected-description').textContent=`1층 · ${Math.round(n.area_m2)}㎡(구역) · ${duration}(가정) · 관람 상한 ${fmt(n.capacity)}명(가정)`;
  $('selection-data').replaceChildren();
  for(const [name,value] of [['입장·관람',z?.inside||0],['대기 중',z?.queue||0]]){
    const div=document.createElement('div'),span=document.createElement('small'),strong=document.createElement('strong');span.textContent=name;strong.textContent=`${value}명`;div.append(span,strong);$('selection-data').append(div);
  }
}
function renderZones(){
  for(const z of state.zones){
    let row=zoneRows.get(z.id);
    if(!row){
      const button=document.createElement('button');button.className='zone-row';
      const top=document.createElement('div');top.className='zone-top';
      const name=document.createElement('span'),count=document.createElement('span');name.textContent=meta.map.nodes.find(n=>n.id===z.id).name;
      const bar=document.createElement('div'),fill=document.createElement('i');bar.className='bar';bar.append(fill);top.append(name,count);button.append(top,bar);button.onclick=()=>select(z.id);
      $('zone-list').append(button);row={button,count,fill};zoneRows.set(z.id,row);
    }
    const label=`${z.inside}명${z.queue?' · 대기 '+z.queue:''}`;
    if(row.count.textContent!==label)row.count.textContent=label;
    row.fill.style.width=`${Math.min(100,z.inside/z.capacity*100)}%`;
    row.button.classList.toggle('selected',selected===z.id);row.button.setAttribute('aria-pressed',String(selected===z.id));
  }
}
function canvasContext(c,r,dpr){
  const w=Math.round(r.width*dpr),h=Math.round(r.height*dpr);
  if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
  const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,r.width,r.height);return ctx;
}
function drawChart(){
  const c=$('chart'),r=c.getBoundingClientRect(),dpr=devicePixelRatio||1;const ctx=canvasContext(c,r,dpr);const w=r.width,h=r.height;
  const rows=[...state.history,{time:state.time,inside:state.metrics.inside}],max=Math.max(100,...rows.map(x=>x.inside));
  ctx.font='13px sans-serif';ctx.fillStyle='#7893a3';ctx.strokeStyle='#233d49';
  for(let i=0;i<=2;i++){const y=12+i*(h-24)/2;ctx.beginPath();ctx.moveTo(32,y);ctx.lineTo(w,y);ctx.stroke();ctx.fillText(Math.round(max*(1-i/2)),0,y+3);}
  const x=t=>32+(t-state.opening)/(state.horizon-state.opening)*(w-36),y=n=>h-12-n/max*(h-24);
  if(rows.length){ctx.beginPath();rows.forEach((v,i)=>i?ctx.lineTo(x(v.time),y(v.inside)):ctx.moveTo(x(v.time),y(v.inside)));ctx.strokeStyle='#72ddc8';ctx.lineWidth=2;ctx.stroke();ctx.lineTo(x(rows.at(-1).time),h-12);ctx.lineTo(32,h-12);ctx.closePath();ctx.fillStyle='#63d6c018';ctx.fill();}
}
function drawArrivals(){
  const c=$('arrival-chart'),r=c.getBoundingClientRect(),dpr=devicePixelRatio||1;
  const ctx=canvasContext(c,r,dpr);const w=r.width,h=r.height,rows=state.arrival_series;
  const max=Math.max(15,...rows.map(x=>Math.max(x.expected,x.actual||0)))*1.1;
  const x=i=>32+i/rows.length*(w-38),y=n=>h-24-n/max*(h-40);
  ctx.font='13px sans-serif';ctx.fillStyle='#91a8b4';ctx.strokeStyle='#29424e';
  for(let i=0;i<=2;i++){const n=max*i/2;ctx.fillText(Math.round(n),2,y(n)+3);ctx.beginPath();ctx.moveTo(30,y(n));ctx.lineTo(w,y(n));ctx.stroke();}
  ctx.beginPath();let connected=false;rows.forEach((row,i)=>{if(row.actual===null){connected=false;return;}if(connected)ctx.lineTo(x(i),y(row.actual));else ctx.moveTo(x(i),y(row.actual));connected=true;});ctx.strokeStyle='#739bb2';ctx.lineWidth=1.5;ctx.stroke();
  ctx.beginPath();rows.forEach((row,i)=>i?ctx.lineTo(x(i),y(row.expected)):ctx.moveTo(x(i),y(row.expected)));ctx.strokeStyle='#f3bd70';ctx.lineWidth=2;ctx.stroke();
  ctx.fillStyle='#91a8b4';for(const hour of [10,12,14,16]){const i=(hour*3600-state.opening)/60;ctx.fillText(hour+'시',x(i)-10,h-5);}
}
async function init(){
  try{
    [meta,state]=await Promise.all([request('/api/meta'),request('/api/state')]);serverDone=state.done;
    try{
      map=new AquariumMap($('scene'),meta.map,meta.personas,select);
      playback=new Playback(map.nodes,map.rooms);
      $('map-loading').hidden=true;
    }catch(e){$('map-loading').textContent='3D 화면을 열지 못했습니다. WebGL 지원을 확인해 주세요. 구역 현황과 입퇴장 계산은 사용할 수 있습니다.';console.error(e);}
    $('legend').replaceChildren(...meta.personas.map(p=>{const s=document.createElement('span'),dot=document.createElement('i');dot.className='dot';dot.style.background=p.color;s.append(dot,document.createTextNode(p.name));return s;}));
    $('visitor-count').value=meta.config.daily_visitors;$('seed').value=meta.config.seed;
    $('arrival-profile').replaceChildren(...Object.entries(meta.arrival_profiles).map(([id,p])=>{const o=document.createElement('option');o.value=id;o.textContent=p.label;o.selected=p.label===state.arrival_model.label;return o;}));
    if(!Object.values(meta.arrival_profiles).some(p=>p.label===state.arrival_model.label)){
      const o=document.createElement('option');o.value='';o.textContent='설정 파일의 입장 분포';o.selected=true;$('arrival-profile').prepend(o);
    }
    $('all-programs').replaceChildren(...meta.map.reference_programs.map(p=>{
      const row=document.createElement('p');row.textContent=`${p.start} · ${p.node} ${p.name} · ${p.duration_minutes}분`;return row;
    }));
    render();
  }catch(e){message('초기화 실패: '+e.message);if($('map-loading'))$('map-loading').textContent='시뮬레이션 서버와 자료 파일을 확인해 주세요.';}
}
$('play').onclick=()=>{if(!state||mutating)return;if(state.done&&!playback?.active){message('하루 관람이 완료되었습니다. 재시작하거나 진행바를 이전 시각으로 옮겨주세요.');return;}setRunning(!running);};
$('reset').onclick=()=>mutate('/api/reset',{daily_visitors:Number($('visitor-count').value),seed:Number($('seed').value),arrival_profile:$('arrival-profile').value},true);
$('day-progress').onpointerdown=()=>{if(state&&!mutating)setRunning(false);};
$('day-progress').oninput=()=>{if(!state||mutating)return;scrubbing=true;setRunning(false);showTime(state.opening+Number($('day-progress').value));};
$('day-progress').onchange=()=>{if(state)mutate('/api/seek',{target:state.opening+Number($('day-progress').value)});};
$('day-progress').onpointercancel=()=>{scrubbing=false;if(state)render();};
$('sources').onclick=()=>$('source-dialog').showModal();$('close-dialog').onclick=()=>$('source-dialog').close();
window.addEventListener('resize',()=>{if(state){drawChart();drawArrivals();}});
async function fetchBatch(){
  if(busy||mutating||scrubbing||!running||serverDone)return;
  busy=true;
  try{
    // 현재 구간을 표시하는 동안 다음 구간을 계산한다. 전송에는 표시용 필드만 담는다.
    const next=await request('/api/advance',{seconds:Math.min(60,Number($('speed').value)*1.2),motion:true,motion_format:'compact-v1'});
    if(mutating)return;
    serverDone=next.done;
    if(playback){
      playback.append(decodeMotionFrames(next.motion_frames,next.motion_format));
      delete next.motion_frames;delete next.motion_format;checkpoints.push(next);
    }else{state=next;if(!scrubbing)render();if(state.done)setRunning(false);}
  }catch(e){message(e.message);setRunning(false);}
  finally{busy=false;}
}
let lastFrame=performance.now();
function animate(now){
  const dt=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;
  if(running&&!mutating&&!scrubbing){
    const speed=Number($('speed').value);
    if(playback?.active){
      playback.speed=speed;
      const frame=playback.tick(dt);map?.update(frame);
      showTime(frame.time);$('day-progress').value=frame.time-state.opening;renderPrograms(frame.time);
      let changed=false;
      while(checkpoints.length&&checkpoints[0].time<=frame.time+1e-8){state=checkpoints.shift();changed=true;}
      if(changed)render(false);
      if(!playback.active&&serverDone)setRunning(false);
    }
    // 군중 충돌 계산이 집중되는 구간에 대비해 실제 재생 3초분을 선읽기한다.
    if(running&&!busy&&!serverDone&&(playback?.remaining??0)<=Math.max(60,speed*3))batchPromise=fetchBatch();
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
await init();
