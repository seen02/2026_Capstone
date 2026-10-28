
const fs=require('fs'),path=require('path');
const {marked}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/marked');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'대피_건물_구조도'),base=path.join(root,'스마트_대피_안내_시스템_프로젝트_계획서_v6'),backup=path.join(__dirname,'cinema-v6-originals');
const map=JSON.parse(fs.readFileSync(path.join(dir,'building-map-v6.json'),'utf8'));
let svg=fs.readFileSync(path.join(backup,'건물_평면도.svg'),'utf8');
const rect=(x,y,w,h,cls,rx=0)=>'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" class="'+cls+'"/>';
const txt=(x,y,s,cls='detail')=>'<text x="'+x+'" y="'+y+'" text-anchor="middle" class="'+cls+'">'+s+'</text>';
let i=0;
svg=svg.replace(/<g class="room">([\s\S]*?)<\/g>/g,(_,old)=>{
 const r=map.rooms[i++],[mx,my,mw,mh]=r.bounds_m,x=100+mx*25,y=130+my*25,w=mw*25,h=mh*25,cx=x+w/2,small=h<100,aud=Number(r.id)<104;
 let b=rect(x,y,w,h,aud?'auditorium':'room-fill')+txt(cx,y+(r.id==='111'?40:small?26:30),r.name,'room-label')+txt(cx,y+(r.id==='111'?57:small?43:48),r.id==='111'?'WAIT_J · 관람객 60명':r.id,'room-id');
 if(aud){
  b+=rect(x+40,y+59,w-80,10,'screen',3)+txt(cx,y+82,'SCREEN','screen-label');
  for(let row=0;row<5;row++)for(let col=0;col<6;col++){const sx=x+43+col*29+(col>=3?12:0),sy=y+90+row*15;b+=rect(sx,sy,19,12,'seat',3)+'<path d="M'+(sx+3)+' '+(sy+9)+'h13" class="seat-line"/>';}
 }else if(r.id==='106'){
  b+=rect(x+18,y+64,w-36,33,'counter',4)+txt(cx,y+85,'POPCORN / DRINK');
  for(let j=0;j<3;j++)b+=rect(x+24+j*40,y+112,24,31,'display',3);b+=txt(cx,y+165,'주문 · 픽업');
 }else if(r.id==='107'){
  b+=rect(x+24,y+67,w-48,18,'counter',3);
  for(let row=0;row<2;row++)for(let col=0;col<2;col++){const tx=x+46+col*70,ty=y+111+row*39;b+='<circle cx="'+tx+'" cy="'+ty+'" r="11" class="table"/>'+rect(tx-22,ty-7,6,14,'chair',2)+rect(tx+16,ty-7,6,14,'chair',2);}
 }else if(r.id==='108'){
  for(let j=0;j<3;j++)b+=rect(x+21+j*41,y+75,30,30,'furniture',2)+'<circle cx="'+(x+36+j*41)+'" cy="'+(y+89)+'" r="7" class="fixture"/>';
 }else if(r.id==='104')b+=rect(x+26,y+73,76,24,'counter',3)+rect(x+108,y+70,25,30,'furniture',2);
 else if(r.id==='105'||r.id==='109'){for(let j=0;j<3;j++)b+=rect(x+24+j*40,y+66,25,42,'furniture',2);}
 else if(r.id==='110'){b+=rect(x+20,y+57,95,19,'counter',3)+txt(x+67,y+71,'TICKETS','tiny');for(let j=0;j<3;j++)b+=rect(x+131+j*27,y+56,16,22,'display',2);}
 else if(r.id==='111')b+=txt(cx,y+77,'상영 전 입장 대기 · 공통 출발');
 else if(r.id==='112'){b+=rect(x+23,y+58,106,17,'sofa',4);for(let j=0;j<2;j++)b+=rect(x+152+j*28,y+54,18,25,'poster',2);}
 b+=(old.match(/<path[^>]*class="door(?:-gap)?"[^>]*\/>/g)||[]).join('');
 return '<g class="room" id="room-'+r.id+'">'+b+'</g>';
});
svg=svg.replace(/<title id="plan-title">[\s\S]*?<\/title>/,'<title id="plan-title">영화관 1층 개념 평면도 · 갈림길 3개와 출구 2개</title>')
.replace(/<desc id="plan-desc">[\s\S]*?<\/desc>/,'<desc id="plan-desc">32×24미터 가상 영화관. 상영관 1관·2관·3관의 스크린과 좌석 열, 매점, 카페, 매표소, 로비, 라운지를 배치했습니다. 로비 WAIT_J에서 출발해 J·L·R 세 갈림길과 서측 EL·동측 ER 두 외부 출구를 사용합니다. P1 계산은 기존 5개 방향 간선이며 R에서 L로 돌아가는 안내는 포함하지 않습니다.</desc>')
.replace(/<g class="windows"[\s\S]*?<\/g>/,'')
.replace('교육·연구동 1층 평면도','영화관 1층 개념 평면도')
.replace('표지판 3개 · 출구 2개 · 우회 연결 복도 1개','갈림길 3개 · 출구 2개 · 상영관 3개 · 표지판 3대')
.replace('SMART EVACUATION / SPATIAL PROTOTYPE','SMART EVACUATION / CINEMA')
.replace('A–01 / CONCEPT','C–01 / CONCEPT')
.replace('J · 첫 갈림길','J · 갈림길 1')
.replace('<text x="300" y="393" class="room-id" text-anchor="middle">L</text>','<text x="300" y="403" class="junction-label" text-anchor="middle">L · 갈림길 2</text>')
.replace('<text x="700" y="393" class="room-id" text-anchor="middle">R</text>','<text x="700" y="403" class="junction-label" text-anchor="middle">R · 갈림길 3</text>')
.replace('<text x="86" y="402" class="room-id" text-anchor="end">외부</text>','<text x="86" y="402" class="room-id" text-anchor="end">외부 출구</text>')
.replace('<text x="914" y="402" class="room-id" >외부</text>','<text x="914" y="402" class="room-id" >외부 출구</text>')
.replace('S3 / R   출구 확인','S3 / R   출구 확인')
.replace('공간은 순환형으로 만들고, 시연 계산은 J → L → R 방향의 5개 간선으로 단순화.','로비 관람객 60명 → J → L/R → 출구 EL/ER. 세 갈림길과 두 출구 유지.')
.replace('실내 문·가구는 공간 표현이며, 기본 60명은 다목적 홀에서 WAIT_J로 공통 시작.','스크린·좌석은 공간 표현. P1은 로비 WAIT_J 공통 출발, e1–e5 단방향 계산.')
.replace('2026.10.06','2026.10.07').replace('EDU-32x24-v1','CINEMA-32x24-v6');
svg=svg.replace('</style>','.junction-label{font-size:11px;fill:#6b7e80;paint-order:stroke;stroke:#f0f6f0;stroke-width:4}.auditorium{fill:#f0eef8;stroke:#4a425d;stroke-width:3}.room-fill{fill:#faf7f0}.screen{fill:#62567b}.screen-label{font-size:8px;fill:#827396;letter-spacing:2px}.seat{fill:#b0a2c7;stroke:#867498;stroke-width:.8}.seat-line{fill:none;stroke:#ece6f7;stroke-width:1}.detail{font-size:10px;fill:#6f7580}.tiny{font-size:9px;fill:#785c37;font-weight:700}.counter{fill:#eed5a6;stroke:#b59564;stroke-width:1}.display{fill:#ede5d4;stroke:#ae9c81;stroke-width:1}.chair,.sofa{fill:#cec8b8;stroke:#aaa28e;stroke-width:1}.poster{fill:#d4cfdf;stroke:#a59ab8;stroke-width:1}.table{fill:#e8e0d0;stroke:#b7aa92;stroke-width:1}.fixture{fill:#fff;stroke:#b5c4c5;stroke-width:1}</style>');
fs.writeFileSync(path.join(dir,'건물_평면도.svg'),svg);
const oldHtml=fs.readFileSync(path.join(backup,path.basename(base)+'.html'),'utf8'),md=fs.readFileSync(base+'.md','utf8');
const diagrams=[...oldHtml.matchAll(/<div class="diagram">[\s\S]*?<\/div>/g)].map(m=>m[0].replaceAll('서측 계단 진입','서측 외부 출구').replaceAll('동측 계단 진입','동측 외부 출구'));
let di=0,htmlMd=md.replace(/\x60\x60\x60mermaid\r?\n[\s\S]*?\x60\x60\x60/g,()=>diagrams[di++]);if(di!==diagrams.length)throw Error('Diagrams');
htmlMd=htmlMd.replaceAll('<!-- PAGEBREAK -->','<div class="pagebreak"></div>');
let body=marked.parse(htmlMd);
body=body.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g,(all,a,src,b)=>decodeURIComponent(src)==='대피_건물_구조도/건물_평면도.svg'?'<img class="floorplan"'+a+'src="data:image/svg+xml;base64,'+Buffer.from(svg,'utf8').toString('base64')+'"'+b+'>':all);
body=body.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
body=body.replace(/<table>[\s\S]*?<\/table>/g,t=>/<th>ID<\/th>|<th>시험 ID<\/th>/.test(t)?t.replace('<table>','<table class="id-table">'):t);
const nav=[];let hi=0;body=body.replace(/<h([123])>(.*?)<\/h\1>/g,(_,l,t)=>{const id='sec-'+(++hi);if(l!=='3')nav.push({id,l,t});return '<h'+l+' id="'+id+'">'+t+'</h'+l+'>';});if(hi!==68)throw Error('Headings '+hi);
const css=oldHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
const html='<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>스마트 대피 안내 시스템 계획서 v6 · 영화관</title><style>'+css+'</style></head><body><nav><b>계획서 v6 · 영화관 · 4인 팀</b>'+nav.map(n=>'<a class="'+(n.l==='1'?'major':'')+'" href="#'+n.id+'">'+n.t+'</a>').join('')+'</nav><main><div class="artifact-links"><span>PROJECT PLAN · VERSION 6.0 · CINEMA EVACUATION</span><a href="'+path.basename(base)+'.md">Markdown 원문</a></div>'+body+'</main><button class="print" onclick="window.print()">인쇄 및 PDF 저장</button></body></html>\n';
fs.writeFileSync(base+'.html',html);
console.log(JSON.stringify({rooms:i,seatSymbols:(svg.match(/class="seat"/g)||[]).length,headings:hi,diagrams:di}));

