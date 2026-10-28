const fs=require('fs');
const path=require('path');
const {marked}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/marked');
const base='스마트_대피_안내_시스템_프로젝트_계획서';
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const box=(x,y,w,h,title,sub='',fill='#eff5fa')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="#7691a7"/><text x="${x+w/2}" y="${y+(sub?31:h/2+7)}" text-anchor="middle" class="title">${title}</text>${sub?`<text x="${x+w/2}" y="${y+56}" text-anchor="middle" class="sub">${sub}</text>`:''}`;
const txt=(x,y,t)=>`<text x="${x}" y="${y}" text-anchor="middle" class="label">${t}</text>`;
const arrow=(d,t='',x=0,y=0,both=false)=>`<path d="${d}" fill="none" stroke="#375b76" stroke-width="2" marker-end="url(#arr)" ${both?'marker-start="url(#back)"':''}/>${t?txt(x,y,t):''}`;
const svg=(w,h,b,label)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}"><defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0L0 6L7 3Z" fill="#375b76"/></marker><marker id="back" markerWidth="8" markerHeight="8" refX="0" refY="3" orient="auto"><path d="M7 0L7 6L0 3Z" fill="#375b76"/></marker></defs><style>.title{font:600 21px 'Malgun Gothic',sans-serif;fill:#183449}.sub{font:16px 'Malgun Gothic',sans-serif;fill:#40576a}.label{font:16px 'Malgun Gothic',sans-serif;fill:#23465e;paint-order:stroke;stroke:white;stroke-width:6px;stroke-linejoin:round}</style>${b}</svg>`;
const diagrams=[];
diagrams.push(svg(960,750,
 box(270,15,420,80,'대형 화면 웹 UI','지도 · 가상 인원 · 실제 장치 보고')+
 arrow('M480 95V145','HTTP / WebSocket',620,125,true)+
 box(270,145,420,80,'노트북 로컬 서버','가상 ID 집계 · 시나리오 · SQLite 기록')+
 arrow('M480 225V275','USB 시리얼',570,257,true)+
 box(320,275,320,80,'ESP32 게이트웨이 G','혼잡 전달 · 장치 보고 수집')+
 arrow('M480 355V415','상황 데이터 · 응답',602,390,true)+
 box(270,415,420,80,'ESP-NOW · 고정 채널 단일 홉','화살표 명령이 아닌 상황을 공유','#e5f1ee')+
 box(15,275,240,95,'무선 조작기 R','위험 · 시나리오 요청')+
 arrow('M135 370V455H270','위험 직접 공유',139,438,true)+
 arrow('M340 495V540H160V585','',0,0,true)+arrow('M480 495V585','',0,0,true)+arrow('M620 495V540H800V585','',0,0,true)+
 box(20,585,280,105,'S1 · 위치 J','상태 관리 → 경로 계산 → LED')+
 box(340,585,280,105,'S2 · 위치 L','로컬 위험 버튼 + 계산·LED')+
 box(660,585,280,105,'S3 · 위치 R','상태 관리 → 경로 계산 → LED')+
 txt(480,732,'S2의 로컬 위험도 다른 표지판에 직접 공유 · 장치별 외부 전원'), '전체 시스템 구조도'));
diagrams.push(svg(960,440,
 box(20,165,150,80,'J · S1','출발 분기')+box(330,35,180,80,'L · S2','왼쪽 분기')+box(330,305,180,80,'R · S3','오른쪽 분기')+
 box(740,35,190,80,'출구 EL','왼쪽 출구','#e5f1ee')+box(740,305,190,80,'출구 ER','오른쪽 출구','#e5f1ee')+
 arrow('M170 190H250V75H330','e1 · 10m / 40㎡',238,49)+arrow('M170 220H250V345H330','e2 · 12m / 48㎡',211,394)+
 arrow('M510 75H740','e3 · 10m / 20㎡',625,56)+arrow('M510 345H740','e4 · 12m / 24㎡',625,324)+
 arrow('M420 115V305','e5 · 12m / 24㎡',513,215)+txt(660,257,'단방향 실험 그래프 · 실제 도면 아님'), '실험용 공간 및 표지판 배치'));
diagrams.push(svg(960,490,
 box(70,20,820,100,'대형 모니터 / 프로젝터','지도 65% · 실제 장치 보고와 변경 이유 35%','#e5f1ee')+
 arrow('M480 120V165')+
 box(70,165,240,90,'S1 · J','왼쪽 / 오른쪽')+box(360,165,240,90,'S2 · L','왼쪽 / 오른쪽')+box(650,165,240,90,'S3 · R','오른쪽 / X / ?')+
 box(285,315,390,85,'관람객 상황 조작기','정상 → 혼잡 → 위험 → 초기화')+
 arrow('M480 315V255')+box(30,315,225,85,'측면 운영 장비','노트북 · G · 전원')+
 txt(480,450,'지도와 같은 장치 라벨 · 실물 촬영 확대 · 케이블 고정'), '부스 전시 배치도'));
diagrams.push(svg(960,480,
 box(20,20,300,80,'웹 시뮬레이션','가상 ID · 구역')+box(380,20,300,80,'노트북','집계 · 기록')+
 arrow('M320 60H380')+box(380,160,300,80,'게이트웨이 G','USB ↔ ESP-NOW')+arrow('M530 100V160','USB',572,138,true)+
 box(20,300,280,95,'위험 원천 R · S2','버튼 · 차단 상태')+box(380,300,550,95,'실물 표지판 3대','각자 상태 관리 → 경로 계산 → LED')+
 arrow('M530 240V300','상황 · 실제 보고',674,278,true)+arrow('M300 347H380')+
 txt(480,455,'무선으로 공유하는 것은 상황 데이터 · 최종 방향은 각 표지판이 결정'), '별첨 과제 계획서 시스템 구조도'));
diagrams.push(svg(960,500,
 box(20,180,225,90,'BOOT_SYNC','현재 상태 확인')+box(365,180,225,90,'GUIDE','유효 경로 안내')+
 box(685,20,255,90,'GUIDE_DEGRADED','혼잡 미확인 · 거리 기준')+
 box(685,205,255,90,'NO_ROUTE · X','차단으로 경로 없음')+box(685,390,255,90,'DATA_UNKNOWN · ?','위험 정보 부족')+
 arrow('M245 225H365','동기화 완료',305,207)+
 arrow('M530 180V65H685','혼잡 만료',597,46)+arrow('M685 92H565V180','복구 · 안정화',643,147)+
 arrow('M590 225H685','차단',636,211)+arrow('M685 278H558V270','해제 확인',622,316)+
 arrow('M478 270V435H685','필수 정보 만료',565,423)+arrow('M685 465H400V270','현재 상태 확인',527,486), '표시 상태 전이도'));
let md=fs.readFileSync(base+'.md','utf8');let di=0;
md=md.replace(/```mermaid\n[\s\S]*?```/g,()=>`\n<div class="diagram">${diagrams[di++]}</div>\n`);
if(di!==diagrams.length)throw new Error('diagram count mismatch');
let body=marked.parse(md.replaceAll('<!-- PAGEBREAK -->','<div class="pagebreak"></div>'));
body=body.replace(/<table>[\s\S]*?<\/table>/g,t=>{if(/<th>ID<\/th>|<th>시험 ID<\/th>/.test(t)){const widths=t.includes('<th>시험 ID</th>')?[11,64,25]:t.includes('<th>수용 기준 또는 제약</th>')?[11,24,65]:[11,43,46];return t.replace('<table>',`<table class="id-table"><colgroup>${widths.map(w=>`<col style="width:${w}%">`).join('')}</colgroup>`);}return t;});
const nav=[];let hi=0;
body=body.replace(/<h([12])>(.*?)<\/h\1>/g,(m,l,t)=>{const id='sec-'+(++hi);nav.push({id,l,t});return `<h${l} id="${id}">${t}</h${l}>`;});
const ref=fs.readFileSync('착석_습관_휴식_코칭_프로젝트_계획서.html','utf8');
let css=ref.match(/<style>([\s\S]*?)<\/style>/)[1];
css+='\nmain{max-width:1200px}h1{font-size:30px}h2{color:#183f59}strong{color:#153d56}thead{background:#eaf1f6}.diagram{padding:12px 0}.diagram svg{max-height:none}td:first-child{font-weight:500}.id-table td:first-child{white-space:nowrap}nav a.major{color:#165a70}a{overflow-wrap:anywhere}@media print{.diagram svg{max-height:195mm}.diagram{padding:0}h1{font-size:20pt}h2{color:#000}.id-table td,.id-table th{padding:5pt 6pt}}';
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>분산형 스마트 대피 안내 시스템 계획서</title><style>${css}</style></head><body><nav><b>계획서 · 제출용 별첨</b>${nav.map(n=>`<a class="${n.l==='1'?'major':''}" href="#${n.id}">${n.t}</a>`).join('')}</nav><main>${body}</main><button class="print" onclick="window.print()">인쇄 및 PDF 저장</button></body></html>`;
fs.writeFileSync(base+'.html',html);
console.log(JSON.stringify({diagrams:di,headings:hi,mdChars:md.length,htmlChars:html.length}));
