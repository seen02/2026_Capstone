const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const file=path.resolve('컴퓨터공학_종합설계_과제지원신청서_과제계획서_작성본.hwp');
const out=path.resolve('tmp/hwp-requirements-work');fs.mkdirSync(out,{recursive:true});
const content=[
 ['1. 서론(개요)   2. 기능   3. 요구사항'],
 [
  '본 명세서는 영화관을 대상으로 한 대피 시뮬레이터와 가변형 안내 표지판의 구현 범위 및 확인 기준을 정한다. 갈림길 3개와 출구 2개가 있는 단층 구조를 사용하며, 로비의 가상 관람객 60명이 대피하는 상황을 기본 조건으로 한다.',
  '시뮬레이터가 센서를 대신하여 통로별 위험·혼잡 정보를 제공하고, 실제 ESP32 표지판이 정보를 공유하여 경로를 판단한다. 표지판의 안내 결과는 화면의 인원 이동에 반영한다. 사용자는 통로 차단과 중앙 연결 상태를 바꾸며 안내 동작과 대피 결과를 확인한다.'
 ],
 [
  '1) 상황 설정: 영화관 평면도에 인원 이동과 출구 앞 대기를 표시하고, 통로 차단·실행·일시정지·초기화를 조작한다.',
  '2) 정보 전달: 통로의 통행 가능 여부와 인원 정보를 담당 표지판에 USB로 전달하고, 표지판끼리 ESP-NOW로 공유한다.',
  '3) 경로 안내: 각 ESP32가 A*로 거리와 혼잡도를 고려한 경로를 계산하고, RGB LED로 방향 또는 안내 불가 상태를 표시한다.',
  '4) 실험·기록: 실제 표지판의 출력을 화면 이동에 연결하고, 안내 유무 및 중앙 연결 상태에 따른 결과를 기록한다.'
 ],
 [
  'R01. 지도 일치: 화면과 모형의 갈림길·출구·표지판 위치 및 통로 연결관계가 같아야 한다. 각 표지판은 설치 지점과 담당 통로가 구분되어야 한다.',
  'R02. 인원 이동: 이동 중인 인원, 대기 인원, 출구 도착 인원의 합은 항상 60명이어야 한다. 차단 통로의 새 진입을 막고, 차단 시 이미 통로 안에 있던 인원은 정지·미대피로 처리한다.',
  'R03. 상황 입력: 시뮬레이터는 각 표지판에 담당 통로의 위험·인원 정보만 전달해야 한다. 입력은 1초마다 갱신하고 위험 변경은 즉시 전송한다. PC가 계산한 경로나 방향 명령을 입력으로 사용하지 않는다.',
  'R04. 정보 공유: 다른 구역의 상태는 담당 표지판이 ESP-NOW로 전달해야 한다. 중앙 관리 장치를 거치지 않고 세 표지판 사이에서 새 위험·혼잡 정보를 공유해야 한다.',
  'R05. 경로 판단: 경로 계산은 실제 ESP32에서 수행하고, 차단되거나 위험 상태를 확인하지 못한 통로는 제외해야 한다. 거리와 혼잡도를 함께 고려하며, 어느 출구에도 도달할 수 없으면 방향을 안내하지 않는다.',
  'R06. 방향 안정화: 혼잡만 변할 때는 새 경로의 비용이 기존보다 15% 이상 낮은 상태가 5초간 유지되고, 직전 변경 후 5초가 지나면 방향을 바꾼다. 현재 경로가 차단되면 이 대기 조건 없이 다시 판단한다.',
  'R07. 표시·이동 연동: LED 화살표, 경로 없음(X), 정보 부족(?)을 구분해야 한다. 화면은 장치가 실제 적용한 안내 결과에 따라 인원을 이동시키고, 유효한 보고를 3초간 받지 못하면 해당 갈림길에서 대기시킨다.',
  'R08. 정보 만료: 통행 가능 정보가 3초간 갱신되지 않으면 미확인 상태로 처리하고, 기존 차단 상태는 유지한다. 혼잡 정보가 5초간 갱신되지 않으면 거리 기준으로 판단하고 정보 부족을 표시한다.',
  'R09. 중앙 단절: 중앙 관리 프로그램과 중앙 수집 장치를 중지해도 표지판의 전원·구역별 입력·무선 공유는 유지되어야 한다. 단절 이후 새로 발생한 위험과 혼잡에도 안내가 갱신되어야 한다.',
  'R10. 비교·기록: 안내 없음·표지판 연동·중앙 단절을 같은 초기 인원, 화재 사건, 이동 규칙으로 비교해야 한다. 출구별 도착 인원·대기 시간·미대피 인원·안내 변경 시각을 저장하고, 180초 안에 전원이 도착하지 못하면 미완료로 표시한다.',
  'R11. 반응 시간: 위험 입력부터 실제 LED 변경까지의 지연은 장치별 30회 중 95%가 1.5초 이내인 것을 목표로 하며 누락 여부도 기록한다. 혼잡에 의한 방향 변경은 R06 조건을 충족하는 입력을 유지했을 때 7초 이내를 목표로 한다.',
  'R12. 실행·반복성: 인터넷 연결 없이 노트북과 모형에서 실행할 수 있어야 한다. 30분 연속 실행과 세 가지 비교 조건의 10회 반복에서 예상하지 않은 재부팅이나 인원 수 오류가 없어야 한다.'
 ]
];
const operations=[];content.forEach((paras,row)=>paras.forEach((text,i)=>operations.push({type:'set_cell_text',section:0,para:24,control:0,row,col:0,cell_para:i+1,text,collapse:i===paras.length-1})));
operations.push({type:'set_table_property',table_index:3,page_split:'cell'});
const payload={path:file,operations};
const backup=path.join(out,'before-requirements.hwp');if(!fs.existsSync(backup))fs.copyFileSync(file,backup);
fs.writeFileSync(path.join(out,'requirements-content.json'),JSON.stringify(content,null,2));
fs.writeFileSync(path.join(out,'edit-requirements.json'),JSON.stringify(payload,null,2));
console.log(execFileSync(process.execPath,['C:/Users/admin/.codex/plugins/cache/claw-hwp/claw-hwp/1.5.58/skills/hwp/scripts/create.js'],{input:JSON.stringify(payload),encoding:'utf8'}));
