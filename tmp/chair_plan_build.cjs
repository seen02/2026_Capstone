const fs = require('fs');
const path = require('path');
const deps='C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const {marked}=require(path.join(deps,'marked'));
const root=process.cwd();
const input=path.join(root,'착석_습관_휴식_코칭_프로젝트_계획서.md');
const out=path.join(root,'착석_습관_휴식_코칭_프로젝트_계획서.html');
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const node=(x,y,w,h,title,sub='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="#f2f6fa" stroke="#687c90"/><text x="${x+w/2}" y="${y+(sub?28:36)}" text-anchor="middle" class="nt">${title}</text>${sub?`<text x="${x+w/2}" y="${y+52}" text-anchor="middle" class="ns">${sub}</text>`:''}`;
const arrow=(d,label,x,y)=>`<path d="${d}" fill="none" stroke="#425c76" stroke-width="2" marker-end="url(#arr)"/>${label?`<text x="${x}" y="${y}" text-anchor="middle" class="el" style="paint-order:stroke;stroke:white;stroke-width:5px;stroke-linejoin:round">${label}</text>`:''}`;
const svg=(w,h,body,label)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}"><defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3z" fill="#425c76"/></marker></defs><style>text{font-family:'Malgun Gothic',sans-serif;fill:#1c2b39}.nt{font-size:19px;font-weight:600}.ns{font-size:15px}.el{font-size:14px}</style>${body}</svg>`;
const diagrams=[];
diagrams.push(svg(940,670,
 node(280,15,380,75,'좌판 센서 4개와 등받이 센서 2개','분압 회로를 통한 6채널 입력')+
 node(335,145,270,75,'Arduino UNO R3','ADC 수집 · 출력 제한 · 명령 응답')+
 node(310,295,320,75,'노트북 로컬 서버','연결 관리 · 설정 적용 · 이벤트 처리')+
 node(30,450,270,75,'판정 및 휴식 규칙','개인 보정 · 상태와 시간 계산')+
 node(335,450,270,75,'SQLite 기록','보정 · 세션 · 샘플 · 이벤트')+
 node(640,450,270,75,'모바일 또는 PC 웹앱','상태 확인 · 미루기 · 진동 ON/OFF')+
 node(30,145,230,75,'노트북 USB 전원')+
 node(685,145,230,75,'진동 모듈 2개','DFR0440 · 좌우 피드백')+
 node(685,295,230,75,'별도 5V 2A 어댑터')+
 arrow('M470 90 V145','아날로그 A0~A5',551,123)+
 arrow('M260 182 H335','전원',297,171)+
 arrow('M605 182 H685','D5·D6',645,168)+
 arrow('M800 295 V220','모터 전원',845,261)+
 arrow('M432 220 V295','USB 센서값·ACK',338,266)+
 arrow('M511 295 V220','설정·진동·생존 신호',604,266)+
 arrow('M360 370 V405 H165 V450','',0,0)+
 arrow('M205 450 V425 H395 V370','',0,0)+
 arrow('M470 370 V450','저장',495,414)+
 arrow('M560 370 V405 H755 V450','HTTP · WebSocket',730,396)+
 arrow('M795 450 V425 H596 V370','',0,0)+
 '<text x="470" y="575" text-anchor="middle" class="ns">스마트폰과 노트북은 동일 네트워크에서 연결</text>'+
 '<text x="470" y="607" text-anchor="middle" class="ns">모터 전원과 UNO는 GND만 공통 연결 · 두 전원의 +5V는 합치지 않음</text>',
 '센서에서 UNO와 노트북 서버를 거쳐 웹앱과 기록으로 연결되고 UNO가 진동 모듈을 제어하는 시스템 구조'));
diagrams.push(svg(940,330,
 node(15,35,220,75,'압력센서 6개')+node(305,35,250,75,'Arduino UNO R3')+
 node(645,35,275,75,'노트북 서버와 저장')+node(645,220,275,75,'모바일 웹앱')+
 node(305,220,250,75,'진동 모듈 2개')+
 arrow('M235 72 H305','6채널',271,60)+arrow('M555 55 H645','USB',600,40)+arrow('M645 90 H555','',0,0)+
 arrow('M430 110 V220','제어 신호',480,177)+arrow('M750 110 V220','같은 네트워크',850,173)+arrow('M790 220 V110','',0,0),
 '과제 제출용 시스템 구조'));
diagrams.push(svg(940,650,
 node(365,20,210,65,'Ready 준비')+node(365,155,210,65,'Seated 착석')+
 node(70,315,230,65,'Away 짧은 자리 비움')+node(640,315,230,65,'Rested 유효 휴식')+
 node(355,515,230,65,'Unknown 측정 공백')+
 arrow('M470 85 V155','보정 완료와 착석 확정',595,130)+
 arrow('M365 52 H40 V348 H70','빈 의자 시작',118,100)+
 arrow('M365 185 H185 V315','빈 의자 확정',180,239)+
 arrow('M300 340 H350 V225 H425 V220','기준 미만 복귀',373,284)+
 arrow('M300 368 H640','자리 비움 기준 도달',470,402)+
 arrow('M755 315 V185 H575','다시 착석',770,245)+
 arrow('M470 220 V515','데이터 공백',524,456)+
 arrow('M185 380 V550 H355','데이터 공백',209,535)+
 arrow('M755 380 V550 H585','데이터 공백',732,535)+
 arrow('M585 565 H920 V52 H575','복구 후 새 상태 확인',787,32),
 '착석과 짧은 자리 비움 및 유효 휴식과 측정 공백의 상태 전이'));
let md=fs.readFileSync(input,'utf8').replace(/\r\n/g,'\n');
let idx=0;
md=md.replace(/```mermaid\n[\s\S]*?```/g,()=>`\n<div class="diagram">${diagrams[idx++]}</div>\n`);
md=md.replaceAll('<!-- PAGEBREAK -->','<div class="pagebreak"></div>');
let body=marked.parse(md);
body=body.replace(/<table>[\s\S]*?<\/table>/g,t=>{
 if(/<th>ID<\/th>/.test(t)) return t.replace('<table>','<table><colgroup><col style="width:11%"><col style="width:42%"><col style="width:47%"></colgroup>');
 if(/<th>테이블<\/th>/.test(t)) return t.replace('<table>','<table><colgroup><col style="width:18%"><col style="width:62%"><col style="width:20%"></colgroup>');
 if(/<th>모듈<\/th>/.test(t)) return t.replace('<table>','<table><colgroup><col style="width:20%"><col style="width:30%"><col style="width:50%"></colgroup>');
 return t;
});
body=body.replace('<h1>작업 흐름을 고려한 착석 습관 및 휴식 코칭 시스템 계획서</h1>','<h1>작업 흐름을 고려한<br>착석 습관 및 휴식 코칭 시스템 계획서</h1>');
let hidx=0;
const toc=[];
body=body.replace(/<h([12])>(.*?)<\/h\1>/g,(m,l,t)=>{const id=`sec-${++hidx}`;toc.push({id,l,t:t.replace(/<[^>]+>/g,'')});return `<h${l} id="${id}">${t}</h${l}>`;});
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>착석 습관 및 휴식 코칭 시스템 계획서</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#eef1f4;color:#1d2530;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;font-size:15px;line-height:1.85}nav{position:fixed;inset:0 auto 0 0;width:260px;background:#fff;padding:28px 18px;overflow:auto;border-right:1px solid #d9dfe6}nav b{display:block;margin-bottom:16px;color:#000}nav a{display:block;text-decoration:none;font-size:12px;line-height:1.55;padding:5px 8px;color:#46576a}nav a.major{font-weight:bold;margin-top:12px;color:#000}main{max-width:1080px;margin:32px 32px 64px 292px;padding:52px 60px;background:white}h1,h2,h3{color:#000;line-height:1.45;break-after:avoid;scroll-margin-top:20px}h1{font-size:29px;margin:10px 0 26px}h2{font-size:23px;margin:42px 0 18px}h3{font-size:18px;margin:29px 0 12px}p{margin:12px 0}table{border-collapse:collapse;width:100%;margin:20px 0 26px;font-size:13px;line-height:1.7;table-layout:auto}th,td{border:1px solid #d9d9d9;padding:10px 12px;vertical-align:middle;word-break:normal;overflow-wrap:anywhere}th{background:#e6edf4;color:#000;text-align:left;font-weight:700}tr{break-inside:avoid}thead{display:table-header-group}tbody tr:nth-child(even){background:#fafbfd}ul,ol{padding-left:24px}li{margin:5px 0}a{color:#185c96;text-underline-offset:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f8;padding:18px;border:1px solid #d9d9d9;font:12px/1.8 Consolas,'Malgun Gothic',monospace;break-inside:avoid}code{font-family:Consolas,'Malgun Gothic',monospace}.diagram{margin:24px 0;break-inside:avoid}.diagram svg{display:block;width:100%;height:auto}.pagebreak{margin-top:80px;padding-top:10px;border-top:1px solid #ddd}.print{position:fixed;right:24px;bottom:22px;background:#254863;color:white;border:0;border-radius:7px;padding:12px 20px;cursor:pointer;font:14px 'Malgun Gothic'}
@media(max-width:1100px){nav{display:none}main{margin:16px auto;padding:30px;max-width:960px}}@media(max-width:600px){main{padding:22px 16px;margin:0}body{font-size:14px}h1{font-size:24px}h2{font-size:20px}table{font-size:11px}td,th{padding:7px}pre{font-size:10px}}
@page{size:A4;margin:17mm 16mm 18mm}@media print{body{background:white;font-size:9.5pt;line-height:1.65}nav,.print{display:none}main{margin:0;padding:0;max-width:none}h1{font-size:20pt;margin-top:0}h2{font-size:15pt;margin-top:22pt}h3{font-size:12pt;margin-top:15pt}p{margin:7pt 0}table{font-size:8.3pt;line-height:1.5;margin:12pt 0 16pt}td,th{padding:6pt 7pt}a{color:#164e75;text-decoration:none}pre{font-size:8pt;padding:10pt;line-height:1.6}.pagebreak{break-before:page;border:0;margin:0;padding:0}.diagram{max-height:220mm}.diagram svg{max-height:220mm}h1,h2,h3{break-after:avoid}p{orphans:3;widows:3}}
</style></head><body><nav><b>문서 탐색</b>${toc.map(t=>`<a class="${t.l==='1'?'major':''}" href="#${t.id}">${t.t}</a>`).join('')}</nav><main>${body}</main><button class="print" onclick="window.print()">인쇄 및 PDF 저장</button></body></html>`;
fs.writeFileSync(out,html,'utf8');
console.log(JSON.stringify({output:out,diagrams:idx,headings:toc.length,chars:md.length}));
