import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNavigator} from '../web/navigation.mjs';
import {walkingRoute} from '../web/route.mjs';
import {queueLayout} from '../web/queue.mjs';

const map=JSON.parse(readFileSync(new URL('../configs/map.json',import.meta.url),'utf8'));
const nodes=Object.fromEntries(map.geometry.nodes.map(n=>[n.id,n.point]));
const nav=createNavigator(map);
let shorter=0;
for(const facility of map.facilities) {
  const queue=queueLayout(facility.queue,nodes[facility.entrance],map.geometry.queue_rules,facility.boarding_capacity,facility.bounds);
  const [x,z,w,d]=facility.queue;
  assert.deepEqual(queue.points[0],nodes[facility.entrance]);
  assert.ok(queue.capacity>=Math.ceil(facility.boarding_capacity*2.5));
  assert.equal(queue.capacity,queue.slots.length);
  const rideDistance=([a,b])=>Math.hypot(Math.max(facility.bounds[0]-a,0,a-facility.bounds[0]-facility.bounds[2]),Math.max(facility.bounds[1]-b,0,b-facility.bounds[1]-facility.bounds[3]));
  assert.ok(rideDistance(queue.boarding_exit)<rideDistance(nodes[facility.entrance]),facility.id+' 탑승 진입이 시설에 더 가까워야 합니다.');
  assert.deepEqual(queue.points.at(-1),queue.boarding_exit);
  assert.equal(rideDistance(queue.boarding_target),0);
  assert.equal(queue.railPaths.length,2);
  for(const path of queue.railPaths) {
    assert.ok(path.length>50);
    assert.ok(path.every(p=>p.every(Number.isFinite)));
    // 반원 회전부가 세분된 연속 경계이며 서로 떨어진 직선 칸막이가 아니다.
    assert.ok(path.slice(1).filter((p,i)=>Math.hypot(p[0]-path[i][0],p[1]-path[i][1])<.6).length>40);
  }
  for(const p of [...queue.points,...queue.rails.flat()])assert.ok(p[0]>=x&&p[0]<=x+w&&p[1]>=z&&p[1]<=z+d);
  for(const [source,target] of [[map.geometry.boundary,facility.entrance],[facility.exit,map.geometry.boundary]]) {
    const result=nav.route(source,target);
    assert.equal(result.mode,'open-plaza');
    assert.deepEqual(result.points[0],nodes[source]);
    assert.deepEqual(result.points.at(-1),nodes[target]);
    for(let i=1;i<result.points.length-2;i++)assert.ok(nav.visible(result.points[i],result.points[i+1]),facility.id+' 보행 영역');
    if(result.distance_m<walkingRoute(map,source,target).distance_m-2)shorter++;
    assert.equal(nav.route(source,target),result);
  }
}
assert.ok(shorter>=3,'좁은 연결 그래프를 벗어나 넓은 광장을 활용해야 합니다.');
const free=nav.between([137,130],[135,140]);
assert.equal(free.length,2);
const obstacleMap={facilities:[],geometry:{bounds:[0,0,40,40],island_outline:[[0,0],[40,0],[40,40],[0,40]],castle:[18,0,4,28],scenery_buildings:[],landscape_beds:[],edges:[],nodes:[{id:'a',point:[10,10]},{id:'b',point:[30,10]}]}};
const obstacleNav=createNavigator(obstacleMap);
const detour=obstacleNav.route('a','b');
assert.ok(detour.points.some(p=>p[1]>28));
for(let i=1;i<detour.points.length;i++)assert.ok(obstacleNav.visible(detour.points[i-1],detour.points[i]));
assert.throws(()=>nav.route('missing',map.geometry.boundary),/노드가 없습니다/);
console.log('6개 접힌 대기줄·광장 경로·장애물 우회·거리 단축·경로 재사용 검사 통과');
