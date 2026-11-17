import {MagicIslandMap} from './map3d.js';
let view;
const buttons=document.querySelector('#facilities');
const error=document.querySelector('#error');
const host=document.querySelector('#scene');

function select(id) {
  const facility=view.map.facilities.find(f=>f.id===id);
  const [entry,exit]=view.select(id);
  for(const button of buttons.children)button.setAttribute('aria-pressed',String(button.dataset.facility===id));
  const detail=document.querySelector('#detail');detail.replaceChildren();
  const heading=document.createElement('h2');heading.textContent=facility.name;
  const lengths=document.createElement('p');lengths.textContent=`다리 → 입구 ${entry.distance_m.toFixed(1)}m · 출구 → 다리 ${exit.distance_m.toFixed(1)}m`;
  lengths.title='포장 광장의 장애물을 피하는 표시 경로 기준 거리';
  const info=document.createElement('p');info.textContent=facility.id==='comet-express'?'지상 표시 모형 · 열차와 굽은 코스':'정적 시설 모형 · 대기·운행 미집계';
  const focus=document.createElement('button');focus.textContent='시설 가까이 보기';focus.dataset.action='focus';focus.onclick=()=>view.focus(id);
  const flow=document.createElement('p');flow.textContent='초록 대기 입구 → 줄 진행 → 황금색 탑승 진입 · 빨간 점은 이용 후 퇴장';
  detail.append(heading,lengths,info,flow,focus);
}

host.addEventListener('map-error',e=>{error.textContent=e.detail;});
host.addEventListener('view-change',e=>{document.querySelector('#scale').textContent=Math.round(e.detail.zoom*100)+'%';});
document.querySelector('#zoom-in').onclick=()=>view?.zoom(1.25);
document.querySelector('#zoom-out').onclick=()=>view?.zoom(.8);
document.querySelector('#reset').onclick=()=>view?.home(false);
document.querySelector('#top-view').onclick=()=>view?.home(true);
document.querySelector('#cutaway').onclick=e=>{
  if(!view)return;
  view.setCutaway(!view.cutaway);
  e.currentTarget.setAttribute('aria-pressed',String(view.cutaway));
};

async function initialize() {
  try {
    const response=await fetch('/api/meta');
    if(!response.ok)throw new Error('지도 설정을 가져오지 못했습니다.');
    const metadata=await response.json();
    view=new MagicIslandMap(host,metadata.map,select);
    for(const facility of metadata.map.facilities) {
      const button=document.createElement('button');button.dataset.facility=facility.id;
      button.setAttribute('aria-pressed','false');button.textContent=facility.name;
      const small=document.createElement('small');small.textContent='지상';button.append(small);
      button.onclick=()=>select(facility.id);buttons.append(button);
    }
    document.querySelector('#loading').remove();
    // 디버깅·장면 검증을 위한 읽기 전용 스냅샷. 실제 운영 API가 아니다.
    window.inspectMagicMap=()=>view.inspect();
  }catch(exception) {
    error.textContent='3D 지도를 불러오지 못했습니다. WebGL을 지원하는 브라우저와 서버 연결을 확인하세요.';
    document.querySelector('#loading').textContent='3D 지도를 표시할 수 없습니다.';
    console.error(exception);
  }
}
initialize();
