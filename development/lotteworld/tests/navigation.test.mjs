import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNavigator} from '../web/navigation.mjs';
import {CrowdMovement} from '../web/live-state.mjs';
import {walkingRoute} from '../web/route.mjs';
import {queueLayout} from '../web/queue.mjs';

const map=JSON.parse(readFileSync(new URL('../configs/map.json',import.meta.url),'utf8'));
const nodes=Object.fromEntries(map.geometry.nodes.map(n=>[n.id,n.point]));
const nav=createNavigator(map);
const {layout_scale: scale=1}=map.geometry.queue_rules;
const publicBeforeAccess=createNavigator({...map,geometry:{...map.geometry,ride_access_areas:[]}});
let shorter=0;
for(const facility of map.facilities) {
  const queue=queueLayout(facility.queue,nodes[facility.entrance],map.geometry.queue_rules,
    facility.boarding_capacity,facility.bounds,facility.queue_capacity);
  const [x,z,w,d]=facility.queue;
  assert.deepEqual(queue.points[0],nodes[facility.entrance]);
  assert.ok(queue.capacity>=Math.ceil(facility.boarding_capacity*2.5));
  assert.equal(queue.capacity,queue.slots.length);
  assert.equal(queue.capacity,facility.queue_capacity);
  assert.deepEqual(queue.slot_indices.map(i=>queue.points[i]),queue.slots);
  assert.ok(queue.withdrawal_slot_indices.every((i,j)=>{
    const gap=Math.hypot(...queue.withdrawal[i].map((value,k)=>value-queue.slots[j][k]));
    return gap>=.64*scale-1e-6 && gap<=.65*scale;
  }));
  assert.ok(queue.slot_indices.some(i=>{
    const [[ax,az],[bx,bz],[cx,cz]]=queue.points.slice(i-1,i+2);
    return Math.abs((bx-ax)*(cz-bz)-(bz-az)*(cx-bx))>1e-6;
  }),facility.id+' 반원 회전부에 대기 자리가 있어야 합니다.');
  const rideDistance=([a,b])=>Math.hypot(Math.max(facility.bounds[0]-a,0,a-facility.bounds[0]-facility.bounds[2]),Math.max(facility.bounds[1]-b,0,b-facility.bounds[1]-facility.bounds[3]));
  assert.ok(rideDistance(queue.boarding_exit)<rideDistance(nodes[facility.entrance]),facility.id+' 탑승 진입이 시설에 더 가까워야 합니다.');
  assert.deepEqual(queue.points.at(-1),queue.boarding_exit);
  assert.equal(rideDistance(queue.boarding_target),0);
  assert.equal(queue.railPaths.length,3);
  assert.ok(queue.railPaths[1].length>=2 && queue.railPaths[1].length<=4);
  for(const path of [queue.railPaths[0],queue.railPaths[2]]) {
    assert.ok(path.length>50);
    assert.ok(path.every(p=>p.every(Number.isFinite)));
    // 반원 회전부가 세분된 연속 경계이며 서로 떨어진 직선 칸막이가 아니다.
    assert.ok(path.slice(1).filter((p,i)=>Math.hypot(p[0]-path[i][0],p[1]-path[i][1])<.64*scale).length>40);
  }
  const edgeTolerance=1e-8;
  for(const [px,pz] of [...queue.points,...queue.rails.flat(),...queue.withdrawal]) {
    assert.ok(px>=x-edgeTolerance&&px<=x+w+edgeTolerance&&pz>=z-edgeTolerance&&pz<=z+d+edgeTolerance);
  }
  for(const [source,target] of [[map.geometry.boundary,facility.entrance],[facility.exit,map.geometry.boundary]]) {
    const result=nav.route(source,target);
    assert.equal(result.mode,'open-plaza');
    assert.deepEqual(result.points[0],nodes[source]);
    assert.deepEqual(result.points.at(-1),nodes[target]);
    let publicStarted=false;
    for(let i=1;i<result.points.length-2;i++) {
      const a=result.points[i],b=result.points[i+1];
      if(nav.visible(a,b)) {
        publicStarted=true;
        continue;
      }
      assert.ok(source===facility.exit&&!publicStarted&&!nav.walkable(a)&&
        nav.clearOfPolygons(a,b,facility.id),facility.id+' 전용 하차 동선 또는 공용 보행 영역');
    }
    if(result.distance_m<walkingRoute(map,source,target).distance_m-2)shorter++;
    assert.equal(nav.route(source,target),result);
  }
}
assert.ok(shorter>=3,'좁은 연결 그래프를 벗어나 넓은 광장을 활용해야 합니다.');
assert.equal(map.geometry.ride_access_areas.length,map.facilities.length);
for(const {facility_id:facility,outline} of map.geometry.ride_access_areas) {
  const xValues=outline.map(point=>point[0]),zValues=outline.map(point=>point[1]);
  const minZ=Math.ceil(Math.min(...zValues)),maxZ=Math.floor(Math.max(...zValues));
  let sample;
  for(let x=Math.ceil(Math.min(...xValues));x<=Math.max(...xValues)&&!sample;x++) {
    for(let z=minZ;z<=maxZ;z++) {
      const point=[x,z];
      if(publicBeforeAccess.walkable(point)&&!nav.walkable(point)&&nav.clearOfPolygons(point,undefined,facility)) {
        sample=point;
        break;
      }
    }
  }
  assert.ok(sample,facility+' 주변 포장에 새 전용 구역이 적용되어야 합니다.');
  assert.equal(nav.clearOfPolygons(sample),false);
  const other=map.facilities.find(item=>item.id!==facility).id;
  assert.equal(nav.clearOfPolygons(sample,undefined,other),false);
}
const free=nav.between([137,130],[135,140]);
assert.equal(free.length,2);

const [signX, signZ] = map.geometry.signposts['magic-island-west'].point;
const beforeSign = [signX, signZ - 6], afterSign = [signX, signZ + 5];
assert.equal(nav.visible(beforeSign, afterSign), false);
assert.equal(nav.clearOfPolygons([signX, signZ - .8], [signX, signZ + .8]), false);
const aroundSign = nav.between(beforeSign, afterSign);
assert.ok(aroundSign.length > 2);
const signWalker = new CrowdMovement(nav, .345);
const visitor = {id: 1, x: signX, z: beforeSign[1], state: 'walking_to_queue'};
let [previous] = signWalker.update([visitor], [], 0, 1);
for (let now = 40; now <= 12000; now += 40) {
  const [next] = signWalker.update([{...visitor, z: afterSign[1]}], [], now, 1);
  assert.ok(nav.clearOfPolygons([previous.x, previous.z], [next.x, next.z]));
  previous = next;
}
assert.ok(Math.hypot(previous.x - signX, previous.z - afterSign[1]) <= .02);
const [eastX, eastZ] = map.geometry.signposts['magic-island-east'].point;
assert.equal(nav.walkable([eastX, eastZ]), false);
assert.equal(nav.clearOfPolygons([eastX - 1, eastZ], [eastX + 1, eastZ]), false);

const obstacleMap={facilities:[],geometry:{bounds:[0,0,40,40],island_outline:[[0,0],[40,0],[40,40],[0,40]],castle:[18,0,4,28],scenery_buildings:[],landscape_beds:[],edges:[],nodes:[{id:'a',point:[10,10]},{id:'b',point:[30,10]}]}};
const obstacleNav=createNavigator(obstacleMap);
const detour=obstacleNav.route('a','b');
assert.ok(detour.points.some(p=>p[1]>28));
for(let i=1;i<detour.points.length;i++)assert.ok(obstacleNav.visible(detour.points[i-1],detour.points[i]));
assert.throws(()=>nav.route('missing',map.geometry.boundary),/노드가 없습니다/);

const exitBridge = map.geometry.edges.find(edge => edge.kind === 'bridge');
const bridgeExit = nodes[map.geometry.boundary];
const bridgeEntrance = nodes[exitBridge.source === map.geometry.boundary ? exitBridge.target : exitBridge.source];
const bridgeLength = Math.hypot(bridgeExit[0] - bridgeEntrance[0], bridgeExit[1] - bridgeEntrance[1]);
const dx = (bridgeExit[0] - bridgeEntrance[0]) / bridgeLength, dz = (bridgeExit[1] - bridgeEntrance[1]) / bridgeLength;
const bridgePoint = (back, side) => ({
  x: bridgeExit[0] - dx * back - dz * side,
  z: bridgeExit[1] - dz * back + dx * side,
});
const exiting = new CrowdMovement(nav, .345);
const exitPath = [bridgeEntrance, bridgeExit];
const walkers = [-2.5, 2.5].map((lane, id) => ({
  ...bridgePoint(5, lane), id, state: 'walking_to_exit', exitPath,
}));
let visible = exiting.update(walkers, [], 0, 1);
for (let now = 40; now <= 4000 && visible.length; now += 40) {
  const next = exiting.update([], [{id: 'qr', ...bridgePoint(.6, 0)}], now, 1);
  for (const person of visible.filter(person => !next.some(row => row.id === person.id))) {
    const edge = bridgePoint(0, person.id === 0 ? -2.5 : 2.5);
    assert.ok(Math.hypot(person.x - edge.x, person.z - edge.z) <= .55, '걷던 폭에서 다리의 바깥 경계에 도착한다.');
  }
  visible = next;
}
assert.equal(visible.length, 0, '출구 중앙이 막혀도 다리 양쪽에서 퇴장할 수 있다.');
console.log('6개 접힌 대기줄·광장 경로·장애물 우회·거리 단축·경로 재사용 검사 통과');
