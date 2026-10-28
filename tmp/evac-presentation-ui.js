(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const scenes = [
    {theme:'평소의 안내',title:'평소에는 가까운 출구 A로.',sub:'사람이 몰리거나 통로가 막히면, 3개의 표지판이 각각 방향을 다시 계산합니다.',next:'혼잡 상황 만들기 →',duration:25000},
    {theme:'혼잡을 피하는 안내',title:'왼쪽 통로에 사람이 몰렸습니다.',sub:'왼쪽 통로에 가상 인원 30명을 배치했습니다. 입구 표지판의 변화를 보세요.',next:'오른쪽 통로 막기 →',duration:20000},
    {theme:'위험을 우선하는 안내',title:'이번에는 오른쪽 통로가 막혔습니다.',sub:'왼쪽의 혼잡은 그대로입니다. 그래도 위험한 오른쪽을 먼저 제외합니다.',next:'왼쪽 통로도 막기 →',duration:20000},
    {theme:'안내할 경로가 없는 상황',title:'두 출구로 가는 통로가 모두 막혔습니다.',sub:'방향을 표시할 수 없는 상황을, 화살표 대신 X로 구분합니다.',next:'시연 핵심 정리 →',duration:25000}
  ];
  let modelNow = 0;
  let engine;
  let lastSnapshot;
  let lastRenderKey = '';
  let lastDirectionKey = '';
  let toastTimer;
  let lastTick = performance.now();
  const ui = {scene:0,auto:false,paused:false,done:false,elapsed:0,total:0,explore:false,custom:false,before:'← 출구 A',risk:{e1:false,e3:false,e4:false},deliveredCrowd:0,history:[]};
  const directions = {left:'← 출구 A',right:'출구 B →',none:'—'};
  const text = (id,value) => { const el=$(id); if(el.textContent!==value) el.textContent=value; };
  const show = (id,on) => $(id).toggleAttribute('hidden',!on);

  function directionText(sign) {
    return sign.status==='route'?directions[sign.direction]:sign.status==='stop'?'× 안내 불가':sign.status==='unknown'?'? 정보 미확인':'— 출력 꺼짐';
  }
  function announce(value) { text('announcement',value); }
  function toast(value) {
    clearTimeout(toastTimer);text('toast',value);$('toast').classList.add('show');
    toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3200);
  }
  function archiveCurrent() {
    if(!engine)return;
    ui.history.push({scene:ui.scene+1,snapshot:engine.snapshot()});
    if(ui.history.length>20)ui.history.shift();
  }
  function enterScene(index,{automatic=false}={}) {
    archiveCurrent();
    if(!automatic){ui.auto=false;ui.total=0;ui.done=false;}
    ui.scene=Math.max(0,Math.min(3,index));ui.elapsed=0;ui.paused=false;ui.custom=false;
    modelNow=0;engine=EvacEngine.create({now:()=>modelNow});
    ui.risk={e1:false,e3:false,e4:false};
    ui.before='← 출구 A';
    // Loading a scene explicitly rebuilds its setup. Normal operation remains
    // entirely in the independent engine, including the real five-second hold.
    if(index===1){engine.setCrowd(30);}
    if(index>=2){
      engine.setCrowd(30);modelNow=6000;engine.tick();
      ui.before=directionText(engine.snapshot().signs.S1);
      ui.risk.e4=true;engine.setRisk('e4',true);
    }
    if(index===3){
      ui.before=directionText(engine.snapshot().signs.S1);
      ui.risk.e3=true;engine.setRisk('e3',true);
    }
    ui.deliveredCrowd=engine.snapshot().crowd;
    lastRenderKey='';syncControls(engine.snapshot());render(engine.snapshot());
    announce(scenes[ui.scene].title);lastTick=performance.now();
  }

  function reasonFor(s) {
    const a=s.signs.S1;
    if(a.status==='stop')return '두 출구로 이어지는 경로가 모두 차단되어, 화살표 대신 X를 표시합니다.';
    if(a.status==='unknown')return '통로 상태를 확인할 수 없어, 안내 방향을 확정하지 않습니다.';
    if(s.stale)return '인원 정보가 5초 동안 갱신되지 않아, 위험을 제외한 뒤 거리 기준으로 안내합니다.';
    if(s.risks.e4==='BLOCKED')return '왼쪽이 붐벼도, 위험한 오른쪽은 선택하지 않습니다. 통행 가능한 출구 A로 안내합니다.';
    if(s.risks.e3==='BLOCKED'||s.risks.e1==='BLOCKED')return '왼쪽 경로가 차단되어, 통행 가능한 오른쪽 출구 B로 안내합니다.';
    if(s.risks.e4==='UNKNOWN')return '오른쪽 통로의 상태를 몰라 제외하고, 확인된 왼쪽 출구로 안내합니다.';
    if(s.gatewayDown)return '인원 연결이 끊겼습니다. 마지막으로 받은 정보를 유지하다 5초 후 거리 기준으로 바꿉니다.';
    if(a.pendingSeconds>0){
      return a.pendingDirection==='right'?'잠깐의 혼잡에 방향이 계속 바뀌지 않도록, 5초간 확인한 뒤 오른쪽으로 전환합니다.':'혼잡이 줄었습니다. 5초간 조건을 확인한 뒤 가까운 왼쪽으로 돌아갑니다.';
    }
    if(s.crowd>0&&a.direction==='right')return '왼쪽 통로의 혼잡이 지속되어, 조금 더 멀어도 덜 붐비는 출구 B로 바뀌었습니다.';
    if(s.crowd>0)return '왼쪽에 사람이 있지만, 방향을 바꿀 만큼의 이점이 없어 현재 안내를 유지합니다.';
    return '위험과 혼잡이 없으므로 더 가까운 왼쪽 출구 A를 안내합니다.';
  }

  function renderPeople(count) {
    $('people').innerHTML=Array.from({length:count},(_,i)=>'<use href="#person" transform="translate('+(224+(i%5)*11)+' '+(157+Math.floor(i/5)*9.5)+') scale(.56)"/>').join('');
    $('crowdZone').classList.toggle('active',count>0);
    show('crowdCallout',count>0);text('crowdLabel','왼쪽 통로 · '+count+'명');
  }
  function renderMap(s) {
    const selected=new Set(Object.values(s.signs).filter(sign=>sign.status==='route').map(sign=>sign.path[0]));
    for(const edge of ['e1','e2','e3','e4','e5']){
      const on=selected.has(edge)&&s.risks[edge]==='CLEAR';
      const primary=on&&s.signs.S1.path[0]===edge;
      $('route-'+edge).setAttribute('class','route'+(on?' on':'')+(primary?' primary':''));
      $('flow-'+edge).setAttribute('class','flow'+(on?' on':''));
    }
    for(const [side,edge] of [['A','e3'],['B','e4']]){
      const risk=s.risks[edge];$('exit'+side).setAttribute('class','exit '+(risk==='BLOCKED'?'blocked':risk==='UNKNOWN'?'unknown':''));
      text('exit'+side+'Label',risk==='BLOCKED'?'접근 통로 차단':risk==='UNKNOWN'?'통로 상태 미확인':'이용 가능');
      show('hazard'+side,risk==='BLOCKED');
      const isCrowded=side==='A'&&s.crowd>0;
      text('status'+side,risk==='BLOCKED'?'통로 차단':risk==='UNKNOWN'?'정보 미확인':side==='B'&&s.s3Down?'정보 갱신 대기':isCrowded?'혼잡 · '+s.crowd+'명':'통로 원활');
      $('status'+side).className='exit-status '+(risk==='BLOCKED'?'blocked':risk==='UNKNOWN'?'unknown':isCrowded?'crowded':'');
    }
    show('hazardEntry',s.risks.e1==='BLOCKED');show('unknownB',s.risks.e4==='UNKNOWN');
    for(const id of ['S2','S3']){
      const sign=s.signs[id];$('mapSign'+id).setAttribute('class','map-sign '+(sign.status==='offline'?'off':sign.status));
      text('map'+id,sign.status==='route'?(sign.direction==='left'?'← A':'B →'):sign.status==='stop'?'×':sign.status==='unknown'?'?':'꺼짐');
    }
    text('waitLabel','입구 대기 인원 '+s.waiting+'명');
    text('mapDescription','입구에서 출발합니다. 현재 입구 안내: '+directionText(s.signs.S1)+'. 왼쪽 통로 인원 '+s.crowd+'명. 출구 A 통로 '+s.risks.e3+', 출구 B 통로 '+s.risks.e4+'.');
  }
  function syncControls(s) {
    $('crowdRange').value=s.crowd;text('crowdReadout',s.crowd+'명');
    $('riskA').checked=ui.risk.e3;$('riskB').checked=ui.risk.e4;$('riskEntry').checked=ui.risk.e1;
    $('gatewayDown').checked=s.gatewayDown;$('s3Down').checked=s.s3Down;
  }
  function renderTech(s) {
    const data=[['e1','입구 → 왼쪽 갈림길',10],['e2','입구 → 오른쪽 갈림길',12],['e3','왼쪽 → 출구 A',10*(1+(s.stale?0:2)*Math.min((s.gatewayDown?ui.deliveredCrowd:s.crowd)/20,3))],['e4','오른쪽 → 출구 B',12],['e5','왼쪽 → 오른쪽 연결',12]];
    $('techRows').innerHTML=data.map(([edge,name,cost])=>'<tr><td>'+edge+'</td><td>'+name+'</td><td>'+s.risks[edge]+'</td><td>'+(s.risks[edge]==='CLEAR'?cost.toFixed(1):'제외')+'</td></tr>').join('');
  }
  function render(s) {
    lastSnapshot=s;
    if(!s.gatewayDown)ui.deliveredCrowd=s.crowd;
    const sign=s.signs.S1;
    const dirKey=sign.status+':'+sign.direction;
    const key=JSON.stringify([ui.scene,ui.custom,ui.before,s.crowd,s.risks,s.stale,s.gatewayDown,s.s3Down,...Object.values(s.signs).map(x=>[x.status,x.direction,x.path[0],!!x.pendingSeconds])]);
    if(key!==lastRenderKey){
      lastRenderKey=key;
      const scene=scenes[ui.scene];
      text('sceneLabel',ui.custom?'LIVE / 직접 체험':'SCENE 0'+(ui.scene+1)+' / 04');
      text('sceneTheme',ui.custom?'조건을 바꾸고 결과를 확인하세요':scene.theme);
      text('headline',ui.custom?'상황을 직접 바꿔보세요.':scene.title);
      text('subhead',ui.custom?'인원·위험·연결을 바꾸면 세 표지판이 각자의 위치에서 다시 판단합니다.':scene.sub);
      text('reasonText',reasonFor(s));$('reason').classList.toggle('hazard',Object.values(s.risks).includes('BLOCKED'));
      $('mainSign').className='main-sign '+sign.status;
      text('mainArrow',sign.status==='route'?(sign.direction==='left'?'←':'→'):sign.status==='stop'?'×':sign.status==='unknown'?'?':'—');
      const dest=sign.status==='route'?(sign.direction==='left'?'출구 A':'출구 B'):sign.status==='stop'?'안내 불가':sign.status==='unknown'?'정보 미확인':'출력 꺼짐';
      const small=sign.status==='route'?(sign.direction==='left'?'왼쪽으로 안내':'오른쪽으로 안내'):sign.status==='stop'?'통행 가능한 경로 없음':sign.status==='unknown'?'확인된 경로가 없음':'모의 연결 단절';
      $('destination').innerHTML=dest+'<small>'+small+'</small>';
      text('beforeLabel','이전 방향 ');const before=document.createElement('strong');before.id='beforeDirection';before.textContent=ui.before;$('beforeLabel').appendChild(before);
      text('currentDirection',directionText(sign));
      for(const id of ['S2','S3']){
        const second=s.signs[id];$('small'+id).className='small-sign '+second.status;text('output'+id,directionText(second));
        text('detail'+id,second.pendingSeconds>0?'방향 전환 확인 중':second.status==='route'?'이 위치에서 별도로 계산':second.status==='offline'?'모의 전원·통신 단절':second.status==='unknown'?'확인된 경로 없음':'출구 경로 차단');
      }
      renderPeople(s.crowd);renderMap(s);renderTech(s);
      document.querySelectorAll('[data-scene]').forEach((button,i)=>button.setAttribute('aria-pressed',String(i===ui.scene&&!ui.custom)));
      text('nextBtn',ui.custom?'발표 장면으로 돌아가기 →':scene.next);$('prevBtn').disabled=ui.scene===0&&!ui.custom;
      const faults=[];
      if(s.gatewayDown)faults.push(s.stale?'인원 정보 만료 → 거리 기준 안내':'인원 정보 단절 → 마지막 값 유지');
      if(s.s3Down)faults.push(s.risks.e4==='BLOCKED'?'오른쪽 차단 정보 유지':s.risks.e4==='UNKNOWN'?'오른쪽 위험 정보 미확인':'오른쪽 정보 만료 대기');
      text('faultExplanation',faults.length?faults.join(' · '):'연결이 정상인 모의 조건입니다.');
      syncControls(s);
    }
    if(dirKey!==lastDirectionKey){
      if(lastDirectionKey){
        $('mainArrow').classList.remove('flip');void $('mainArrow').offsetWidth;$('mainArrow').classList.add('flip');
        announce('입구 표지판: '+directionText(sign)+'. '+reasonFor(s));
      }
      lastDirectionKey=dirKey;
    }
    const pending=sign.pendingSeconds>0;
    const waitForCrowd=ui.scene===1&&!ui.custom&&pending;
    $('nextBtn').disabled=waitForCrowd;
    if(waitForCrowd)text('nextBtn','방향 전환 확인 중 · '+sign.pendingSeconds.toFixed(1)+'초');
    show('pendingTrack',pending);
    text('signState',pending?'현재 방향 유지 · 변경 확인 중':s.stale?'인원 정보 만료 · 거리 기준':sign.status==='route'?'현재 안내 방향':sign.status==='stop'?'안내 가능한 경로 없음':'상태 확인 필요');
    text('pendingText',pending?(sign.pendingDirection==='right'?'B →':'← A')+' · '+sign.pendingSeconds.toFixed(1)+'초':sign.status==='route'?directions[sign.direction]:sign.status==='stop'?'방향 표시 중단':'정보 미확인');
    $('pendingBar').style.width=Math.max(0,Math.min(100,(5-sign.pendingSeconds)/5*100))+'%';
    text('autoLabel',ui.auto?(ui.paused?'이어서 재생':'일시정지'):ui.done?'90초 다시 시연':'90초 자동 시연');
    text('autoClock',ui.auto?formatTime(ui.total)+' / 01:30'+(ui.paused?' · 정지':''):ui.done?'시연 완료 · 01:30':'수동 시연');
    $('autoBtn').querySelector('.play').textContent=ui.auto&&!ui.paused?'Ⅱ':'▶';
    document.body.classList.toggle('paused',ui.paused);
    for(let i=0;i<4;i++)$('time'+i).style.width=(ui.auto||ui.done?(i<ui.scene?100:i===ui.scene?Math.min(100,ui.elapsed/scenes[i].duration*100):0):0)+'%';
  }
  function formatTime(ms){const sec=Math.floor(ms/1000);return String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');}
  function next(){if(ui.scene===1&&!ui.custom&&engine.snapshot().signs.S1.pendingSeconds>0){toast('오른쪽 방향으로 바뀌는 것을 확인한 뒤 다음 장면으로 진행합니다.');return;}if(ui.custom){enterScene(ui.scene);return;}if(ui.scene<3)enterScene(ui.scene+1);else openDialog('endDialog');}
  function autoToggle(){
    if(ui.auto){ui.paused=!ui.paused;lastTick=performance.now();render(engine.snapshot());return;}
    setExplore(false);enterScene(0);ui.auto=true;ui.total=0;ui.elapsed=0;ui.done=false;ui.paused=false;render(engine.snapshot());
  }
  function setExplore(on){
    if(on){ui.auto=false;ui.done=false;ui.paused=false;}
    ui.explore=on;show('exploreControls',on);document.body.classList.toggle('explore',on);
    $('exploreBtn').setAttribute('aria-pressed',String(on));$('exploreBtn').classList.toggle('active',on);text('exploreBtn',on?'체험 조작 닫기':'직접 체험');
    if(engine)render(engine.snapshot());
  }
  function customAction(callback){
    if(!ui.custom)ui.before=directionText(engine.snapshot().signs.S1);
    ui.auto=false;ui.done=false;ui.paused=false;ui.custom=true;
    callback();lastRenderKey='';render(engine.snapshot());
  }
  function openDialog(id){
    if(ui.auto)ui.paused=true;
    else ui.paused=true;
    $(''+id).showModal();render(engine.snapshot());
  }
  function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
  function clean(){document.body.classList.toggle('clean');$('cleanBtn').classList.toggle('active',document.body.classList.contains('clean'));toast(document.body.classList.contains('clean')?'상단 도구를 숨겼습니다 · P 키로 다시 표시':'상단 도구 표시');}
  async function fullscreen(){
    try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
    catch(_){toast('전체 화면을 열 수 없습니다. 브라우저 F11을 사용하세요.');}
  }
  document.addEventListener('fullscreenchange',()=>text('fullscreenBtn',document.fullscreenElement?'⛶ 전체 화면 종료':'⛶ 전체 화면'));
  document.querySelectorAll('[data-scene]').forEach(b=>b.addEventListener('click',()=>enterScene(Number(b.dataset.scene))));
  $('autoBtn').addEventListener('click',autoToggle);$('nextBtn').addEventListener('click',next);
  $('prevBtn').addEventListener('click',()=>enterScene(Math.max(0,ui.scene-1)));
  $('restartBtn').addEventListener('click',()=>{setExplore(false);enterScene(0);toast('발표 조건을 첫 장면으로 불러왔습니다.');});
  $('exploreBtn').addEventListener('click',()=>setExplore(!ui.explore));
  for(const [button,dialog] of [['introBtn','introDialog'],['notesBtn','notesDialog'],['techBtn','techDialog'],['helpBtn','helpDialog']])$(button).addEventListener('click',()=>openDialog(dialog));
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog=>{
    dialog.addEventListener('close',()=>{if(!ui.auto)ui.paused=false;lastTick=performance.now();render(engine.snapshot());});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  });
  $('introStart').addEventListener('click',()=>{closeDialogs();ui.auto=false;autoToggle();});
  $('endRestart').addEventListener('click',()=>{closeDialogs();ui.auto=false;autoToggle();});
  $('endExplore').addEventListener('click',()=>{closeDialogs();enterScene(0);setExplore(true);});
  $('cleanBtn').addEventListener('click',clean);$('fullscreenBtn').addEventListener('click',fullscreen);
  $('crowdRange').addEventListener('input',event=>customAction(()=>engine.setCrowd(Number(event.target.value))));
  for(const [input,edge]of [['riskA','e3'],['riskB','e4'],['riskEntry','e1']])$(input).addEventListener('change',event=>customAction(()=>{ui.risk[edge]=event.target.checked;engine.setRisk(edge,event.target.checked);}));
  $('gatewayDown').addEventListener('change',event=>customAction(()=>engine.setGateway(event.target.checked)));
  $('s3Down').addEventListener('change',event=>customAction(()=>engine.setS3(event.target.checked)));
  $('peopleReset').addEventListener('click',()=>{customAction(()=>engine.resetPeople());toast('인원만 초기화했습니다 · 위험과 연결 상태는 유지됩니다.');});
  $('restoreBtn').addEventListener('click',()=>{customAction(()=>{ui.risk={e1:false,e3:false,e4:false};engine.restore();});toast('위험 해제·연결 복구 · 현재 인원은 유지됩니다.');});
  $('exportBtn').addEventListener('click',()=>{
    const result={version:'presentation-v3',software_mockup:true,hardware_connected:false,exported_at:new Date().toISOString(),scene:ui.scene+1,risk_inputs:{...ui.risk},snapshot:engine.snapshot(),previous_scenes:ui.history};
    const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='스마트대피_발표시연_판단기록.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('모의 입력과 판단 기록을 저장했습니다.');
  });
  document.addEventListener('keydown',event=>{
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    const dialog=document.querySelector('dialog[open]');if(dialog)return;
    if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;
    const key=event.key.toLowerCase();
    if(['arrowleft','arrowright',' ','1','2','3','4','r','f','p','n','e','?'].includes(key))event.preventDefault();
    if(key==='arrowright')next();else if(key==='arrowleft')enterScene(Math.max(0,ui.scene-1));
    else if(key===' ')autoToggle();else if('1234'.includes(key)&&key.length===1)enterScene(Number(key)-1);
    else if(key==='r'){setExplore(false);enterScene(0);}else if(key==='f')fullscreen();else if(key==='p')clean();
    else if(key==='n')openDialog('notesDialog');else if(key==='e')setExplore(!ui.explore);else if(key==='?')openDialog('helpDialog');
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&ui.auto&&!ui.paused){ui.paused=true;render(engine.snapshot());}
    lastTick=performance.now();
  });
  function frame(){
    const now=performance.now();const delta=Math.max(0,Math.min(250,now-lastTick));lastTick=now;
    if(!document.hidden&&!ui.paused){
      modelNow+=delta;
      if(ui.auto){
        ui.elapsed+=delta;ui.total=Math.min(90000,ui.total+delta);
        if(ui.elapsed>=scenes[ui.scene].duration){
          if(ui.scene<3)enterScene(ui.scene+1,{automatic:true});
          else{ui.elapsed=scenes[3].duration;ui.total=90000;ui.auto=false;ui.done=true;openDialog('endDialog');}
        }
      }
    }
    render(engine.tick());
  }
  Object.defineProperty(window,'EVAC_DEMO',{value:Object.freeze({snapshot:()=>({version:'presentation-v3',hardware_connected:false,scene:ui.scene+1,automatic:ui.auto,paused:ui.paused,elapsed:ui.elapsed,total:ui.total,explore:ui.explore,custom:ui.custom,model:engine.snapshot()})}),writable:false});
  enterScene(0);setInterval(frame,100);
})();
