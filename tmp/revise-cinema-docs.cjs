
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'대피_건물_구조도'),base=path.join(root,'스마트_대피_안내_시스템_프로젝트_계획서_v6'),backup=path.join(__dirname,'cinema-v6-originals');
fs.mkdirSync(backup,{recursive:true});
for(const f of[base+'.md',base+'.html',path.join(dir,'건물_평면도.svg'),path.join(dir,'건물_평면도.png'),path.join(dir,'building-map-v6.json')]){const to=path.join(backup,path.basename(f));if(!fs.existsSync(to))fs.copyFileSync(f,to);}
let md=fs.readFileSync(path.join(backup,path.basename(base)+'.md'),'utf8');
const section=(start,end,body)=>{const a=md.indexOf(start),b=md.indexOf(end,a);if(a<0||b<0)throw Error(start);md=md.slice(0,a)+body.join('\n')+'\n\n'+md.slice(b);};
section('## 0 v6 개정 요약','## 1 과제 목표와 구현 범위',[
'## 0 v6 개정 요약','','| 항목 | 영화관 적용 설정 |','|---|---|',
'| 기본 상황 | 상영 전 로비에 관람객 60명이 모인 영화관에서 상영관 화재 발생 |',
'| 공간 구성 | 상영관 3개·스크린·좌석, 매점·카페, 매표소·로비·라운지, 운영·공용시설 |',
'| 대피 목적지 | 서측·동측 외부 비상 출구 EL/ER 통과 경계 |',
'| 화재 사건 | 1관/3관 영사 장비 화재로 각각 e3/e4 출구 접근로 차단 |',
'| 평면도 | 건물_평면도.svg를 영화관으로 재구성하고 본문에 삽입 |',
'| 유지 조건 | 공간상 갈림길 J/L/R 3개·출구 EL/ER 2개·복도 치수·단방향 e1–e5 |',
'| 구현 방식 | 4인·3단계 시뮬레이션·A*·ESP32·ESP-NOW 유지. 2·3단계는 영화관 모형과 연동 |','',
'본문은 실행 계획, 별첨 A는 제출용 과제 계획서, 별첨 B는 요구사항명세서, 별첨 C는 상세설계서다. v6의 장치·통신·계산 설계를 계승하고 환경·도면·화재 사건·대피 완료 경계를 영화관으로 개정한다. 시험 기록에는 사용한 지도와 문서 버전을 함께 남긴다.'
]);
section('### 2.1 공간 기준과 제공 자료','### 2.2 공간 표현과 계산 그래프의 구분',[
'### 2.1 공간 기준과 제공 자료','',
'기본 환경은 **지상 1층 영화관의 일부 구역, 가로 32m·세로 24m·명목 면적 768㎡**다. 기존 평면도의 외곽·복도 치수·갈림길 J/L/R 3개·출구 EL/ER 2개를 활용한 가상 영화관이다. 상영관 3개와 부대시설을 포함한 12개 구역을 배치하며 특정 실제 시설을 복제한 도면은 아니다.','',
'| 구역 ID | 영화관 공간 | 시연에서의 역할 |','|---|---|---|',
'| 101 | 1관 · 스크린·좌석 | 서측 영사 장비 화재 발생 구역 |',
'| 102 | 2관 · 스크린·좌석 | 상영관 공간 배경 |',
'| 103 | 3관 · 스크린·좌석 | 동측 영사 장비 화재 발생 구역 |',
'| 104 / 105 | 운영실 / 비품창고 | 운영·지원시설 |',
'| 106 / 107 | 매점 / 카페 | 팝콘·음료 판매와 휴게 공간 |',
'| 108 / 109 | 공용 화장실 / 설비실 | 공용·지원시설 |',
'| 110 | 매표소 | 발권 창구·키오스크 공간 배경 |',
'| 111 | 로비 · 입장 대기 | WAIT_J, 관람객 60명의 공통 출발 구역 |',
'| 112 | 관람객 라운지 | 소파·영화 포스터가 있는 대기 공간 |','',
'- [영화관 평면도 SVG](대피_건물_구조도/건물_평면도.svg) · [PNG 미리보기](대피_건물_구조도/건물_평면도.png)',
'- [v6 설계용 지도 설정](대피_건물_구조도/building-map-v6.json): 영화관 구역·출구 경계·화재 사건·입력 담당·알고리즘 설정',
'- [기존 지도 JSON](대피_건물_구조도/building-map.json) · [기존 구조도 HTML](대피_건물_구조도/건물_구조도_시연.html): 교육·연구동 설정의 과거 참고 자료. 영화관 적용 지도는 위 v6 설정이다.','',
'![영화관 1층 개념 평면도: 갈림길 3개와 출구 2개](대피_건물_구조도/건물_평면도.svg)','',
'그림 1. 상영관 내부의 스크린·좌석 열, 매점·카페, 매표소·로비·라운지를 표현하고 세 갈림길과 두 출구를 유지한 영화관 개념 평면도. 표지판 화살표는 정적 예시이며 실제 장치의 현재 출력이 아니다. 기존 구조도 HTML은 과거 참고 자료로 남기며 완성 시뮬레이터 제작은 별도 구현 범위다.','',
'**EL/ER는 영화관 외곽의 서측·동측 비상 출구 통과 경계를 뜻한다.** P1은 단층 복도의 수평 이동과 출구 앞 대기·통과를 계산한다. 화면·결과표에는 ‘출구 통과 완료/미도달’로 표시한다. 외부 집결지까지의 이동은 계산하지 않으며 실제 시설의 피난 성능을 뜻하지 않는다.'
]);
for(const[a,b]of[
['작성일: 2026년 10월 6일','작성일: 2026년 10월 7일'],['지하상가','영화관'],['이용객','관람객'],
['영화관 행사·휴게광장','영화관 로비'],['행사·휴게광장','로비'],
['서측 음식점(101)','서측 1관(101)의 영사 장비'],['동측 생활잡화점(103)','동측 3관(103)의 영사 장비'],
['양쪽 지상 연결 계단','양쪽 외부 비상 출구'],['지상 연결 계단','외부 비상 출구'],
['계단 접근로','출구 접근로'],['계단 접근 지점','출구 접근 지점'],['계단 진입 완료','출구 통과 완료'],['계단 진입 처리','출구 통과 처리'],['계단 경계','출구 경계'],['한쪽 계단에','한쪽 출구에'],
['점포별','상영관별'],['점포 앞','상영관 앞'],['점포 화재','상영관 화재'],['점포 사건','상영관 사건'],['점포명','영화관 구역명'],['점포 면적','상영관 면적'],['각 점포','각 상영관'],['점포 안','상영관 안'],['점포에','상영관에'],
['점포·공용시설','상영관·부대시설'],['점포·관리시설·로비','상영관·매점·매표소·로비'],
['상가 구역','영화관 구역'],['상가 전체','영화관 전체'],['낯선 상가','낯선 영화관'],['상가 운영자','영화관 운영자'],
['영화관 지하 1층','지상 1층 영화관'],['지하 1층·계단 진입 경계','지상 1층·외부 출구 통과 경계'],['지하층 출구 통과 완료','EL/ER 출구 통과 완료']
])md=md.replaceAll(a,b);
md=md.replace('본 시연은 영화관 로비에 관람객이 모인 시간대에 상영관 화재가 발생하는 상황을 가정한다.','본 시연은 상영 전 영화관 로비에 관람객 60명이 입장을 기다리는 동안 상영관의 영사 장비에서 화재가 발생하는 상황을 가정한다.');
md=md.replace('노드는 J(초기 분기), L(왼쪽 출구·연결 복도 분기), R(오른쪽 출구 접근 지점), EL/ER(출구)다. 세 표지판을 모두 ‘갈림길 3개’로 설명하지 않는다.','공간상 갈림길은 J(로비 앞 좌우 분기), L(서측 출구·연결 복도 분기), R(동측 출구·연결 복도 분기)의 **3개**이고 출구는 EL/ER **2개**다. 각 갈림길에 S1/S2/S3를 설치한다. 기존 단방향 계산 규칙을 유지하므로 R에서의 P1 출력은 오른쪽 출구 확인으로 제한한다.');
md=md.replace('기본 60개 가상 ID는 상가 행사에 참여하거나 휴식 중인 관람객으로 설정하고 로비의 WAIT_J에서 시작한다.','기본 60개 가상 ID는 상영 전 입장을 기다리는 관람객으로 설정하고 로비의 WAIT_J에서 시작한다.');
md=md.replace('점포 출입구·진열대·좌석은 공간 표현이고 상영관별 분산 출발과 점원·관람객의 행동 차이는 P1에 포함하지 않는다.','상영관 출입구·스크린·좌석과 매점 진열대는 공간 표현이다. 상영관별 좌석 출발·직원과 관람객의 행동 차이는 P1에 포함하지 않는다.');
md=md.replace('양쪽 경계에는 외부 비상 출구를 상징하는 부품을 붙이고, 계단 형상은 경계 표시용임을 명시한다.','양쪽 외벽에는 비상 출구 문과 EL/ER 라벨을 붙이고 출구 통과 경계를 표시한다. 상영관에는 스크린·좌석 열을, 로비 주변에는 매표소·매점 라벨을 넣는다.');
md=md.replace('행사 시간대 영화관의 점포에서 화재가 발생하여','상영 전 로비에 관람객이 모인 영화관의 상영관에서 영사 장비 화재가 발생하여');
md=md.replace('EL/ER는 양쪽 외부 비상 출구 진입부이며 계단 상승·지상 도착은 P1 계산 범위 밖이다.','EL/ER는 서측·동측 비상 출구 통과 경계이며 외부 집결지까지의 이동은 P1 계산 범위 밖이다. 공간상 세 갈림길과 두 출구를 유지한다.');
md=md.replace('시연용 사건 정의이며 연기 확산을 계산한 결과가 아니다.','시연용 사건 정의이며 연기 확산을 계산한 결과가 아니다. 상영관 내부 좌석에서 로비까지의 이동은 P1에 포함하지 않는다.');
md=md.replace('복도 치수·연결관계·표지판 위치의 원본. v6에서는 영화관 용도로 재구성.','복도 치수·연결관계·표지판 위치를 참고했다. 이번 개정에서는 영화관 SVG/PNG와 v6 지도 설정을 갱신하고 기존 JSON·구조도 HTML은 과거 참고 자료로 유지한다.');

md=md.replaceAll('영화관로','영화관으로').replaceAll('외부 비상 출구으로','외부 비상 출구로').replaceAll('외부 비상 출구을','외부 비상 출구를').replaceAll('로비으로','로비로');
md=md.replace('양쪽 경계에는 외부 비상 출구를 상징하는 부품을 붙이고, 계단 형상은 경계 표시용임을 명시한다.','양쪽 외벽에는 비상 출구 문과 EL/ER 라벨을 붙이고 출구 통과 경계를 표시한다. 상영관에는 스크린·좌석 열을, 로비 주변에는 매표소·매점 라벨을 넣는다.');
md=md.replace('행사 시간대 영화관의 상영관에서 화재가 발생하여','상영 전 로비에 관람객이 모인 영화관의 상영관에서 영사 장비 화재가 발생하여');
fs.writeFileSync(base+'.md',md);

const map=JSON.parse(fs.readFileSync(path.join(backup,'building-map-v6.json'),'utf8'));
const names={'101':'1관','102':'2관','103':'3관','104':'운영실','105':'비품창고','106':'매점','107':'카페','108':'공용 화장실','109':'설비실','110':'매표소','111':'로비 · 입장 대기','112':'관람객 라운지'};
map.map_id='CINEMA-32x24-v6';map.purpose='v6 설계용 설정 초안 / 영화관 상영관 화재 대피 / 실물 구현·시험 완료 아님';
Object.assign(map.building,{usage:'CINEMA_SECTION',level:'1F',physical_junction_count:3,external_exit_count:2});
for(const r of map.rooms){r.name=names[r.id];if(['101','102','103'].includes(r.id))Object.assign(r,{visual_features:['SCREEN','SEAT_ROWS'],seat_symbols:30,seat_symbols_are_capacity:false});}
for(const n of map.nodes){if(n.is_exit){n.boundary_type='EXTERIOR_EXIT_THRESHOLD';n.label=(n.id==='EL'?'서측':'동측')+' 외부 비상 출구';}else{n.physical_junction=true;n.label={J:'로비 앞 갈림길',L:'서측 갈림길',R:'동측 갈림길'}[n.id];}}
Object.assign(map.simulation,{initial_population_context:'상영 전 로비에서 입장을 기다리는 관람객 60명',completion_boundary:'EXTERIOR_EXIT_THRESHOLD',completion_display:'출구 통과 완료',exterior_assembly_point_modelled:false,auditorium_seat_departure_modelled:false});
delete map.simulation.stair_ascent_modelled;delete map.simulation.ground_arrival_modelled;delete map.physical_model.stair_symbols;
Object.assign(map.physical_model,{exit_symbols:'EXTERIOR_EXIT_DOORS',floorplan_svg:'건물_평면도.svg',physical_junction_count:3,external_exit_count:2});
map.evacuation_scenarios.find(s=>s.id==='F01').name='서측 1관 영사 장비 화재';map.evacuation_scenarios.find(s=>s.id==='F02').name='동측 3관 영사 장비 화재';
map.notes=map.notes.filter(n=>!/[가-힣]/.test(n));
map.notes.push('지상 1층 가상 영화관. 갈림길 J/L/R 3개와 외부 출구 EL/ER 2개. 원본 복도 기하 구조 유지.','EL/ER는 비상 출구 통과 경계. 외부 집결지 이동·실제 피난 성능은 평가하지 않음.','상영 전 로비 60명 공통 출발. 상영관별 좌석 출발과 전체 재실자는 모델링하지 않음.','상영관 좌석 기호 30개는 공간 표현이며 실제 수용인원 기준을 뜻하지 않음.');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
delete map.map_hash;map.map_hash=crypto.createHash('sha256').update(JSON.stringify(stable(map)),'utf8').digest('hex');
fs.writeFileSync(path.join(dir,'building-map-v6.json'),JSON.stringify(map,null,2)+'\n');
console.log(JSON.stringify({map_id:map.map_id,map_hash:map.map_hash,backup}));

