import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {visitorPosition} from '../web/spatial.mjs';

const map=JSON.parse(readFileSync(new URL('../configs/aquarium_map.json',import.meta.url),'utf8'));
const nodes=Object.fromEntries(map.nodes.map(n=>[n.id,n]));
const rooms=Object.fromEntries(map.geometry.rooms.map(r=>[r.id,r]));
const radius=map.geometry.human_radius_m;
const obstacles=map.geometry.walls.map(w=>{
  const pad=w.thickness/2+radius;
  return [Math.min(w.a[0],w.b[0])-pad,Math.min(w.a[1],w.b[1])-pad,
          Math.max(w.a[0],w.b[0])+pad,Math.max(w.a[1],w.b[1])+pad];
});
for(const room of map.geometry.rooms)for(const feature of room.features??[room.feature]){
  for(const [x,z,w,d] of feature.collision_bounds??[feature.bounds])
    obstacles.push([x-radius,z-radius,x+w+radius,z+d+radius]);
}
// 선분 전체가 실제 보행면의 합집합 안에 포함되는지 구간을 합쳐 검사한다.
function onWalkable(a,b){
  const spans=[];
  for(const {bounds:[x,z,w,d]} of map.geometry.walkable_areas){
    const box=[x,z,x+w,z+d];let lo=0,hi=1;
    for(let axis=0;axis<2;axis++){
      const delta=b[axis]-a[axis];
      if(Math.abs(delta)<1e-10){if(a[axis]<box[axis]||a[axis]>box[axis+2])hi=-1;}
      else {const p=(box[axis]-a[axis])/delta,q=(box[axis+2]-a[axis])/delta;lo=Math.max(lo,Math.min(p,q));hi=Math.min(hi,Math.max(p,q));}
    }
    if(lo<=hi)spans.push([lo,hi]);
  }
  spans.sort((a,b)=>a[0]-b[0]);let end=0;
  for(const [lo,hi] of spans){if(lo>end+1e-9)return false;end=Math.max(end,hi);}
  return end>=1-1e-9;
}
// 선분과 사람 반경만큼 확장한 장애물의 정확한 교차 검사.
function intersects(a,b,box){
  let lo=0,hi=1;
  for(let axis=0;axis<2;axis++){
    const delta=b[axis]-a[axis];
    if(Math.abs(delta)<1e-10){if(a[axis]<box[axis]||a[axis]>box[axis+2])return false;}
    else{
      const p=(box[axis]-a[axis])/delta,q=(box[axis+2]-a[axis])/delta;
      lo=Math.max(lo,Math.min(p,q));hi=Math.min(hi,Math.max(p,q));
      if(lo>hi)return false;
    }
  }
  return true;
}
function inFootprint(p){
  const poly=map.geometry.footprint;let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const [x,z]=poly[i],[xx,zz]=poly[j];
    if((z>p[1])!==(zz>p[1]) && p[0]<(xx-x)*(p[1]-z)/(zz-z)+x)inside=!inside;
  }
  return inside;
}
function check(a,b,label){
  assert.ok(inFootprint(a)&&inFootprint(b),`${label}: 바닥 경계 밖`);
  assert.ok(a.every(Number.isFinite)&&b.every(Number.isFinite),label);
  for(const [dx,dz] of [[0,0],[radius,0],[-radius,0],[0,radius],[0,-radius]])
    assert.ok(onWalkable([a[0]+dx,a[1]+dz],[b[0]+dx,b[1]+dz]),`${label}: 보행면 밖으로 이동`);
  for(const obstacle of obstacles)assert.ok(!intersects(a,b,obstacle),`${label}: 벽 또는 전시물 교차`);
}
for(const room of map.geometry.rooms)for(const p of room.polygon)assert.ok(inFootprint(p),`${room.id}: 전시 영역이 바닥 밖`);
for(const wall of map.geometry.walls)assert.ok(inFootprint(wall.a)&&inFootprint(wall.b),'부분 벽이 바닥 밖');
for(const edge of map.edges){
  const a=nodes[edge.a],b=nodes[edge.b];
  check([a.x,a.z],[b.x,b.z],edge.id);
  assert.ok(Math.abs(Math.hypot(a.x-b.x,a.z-b.z)-edge.length_m)<1e-9);
}
// 표시 위치가 흩어지는 대기/관람 노드의 모든 연결을 양끝에서 검사한다.
for(const edge of map.edges){
  if(![nodes[edge.a].kind,nodes[edge.b].kind].some(k=>['queue','exhibit'].includes(k)))continue;
  for(let id=1;id<=3300;id++){
    const v={id,node:edge.a,next_node:edge.b,state:'walking',progress:0};
    const a=visitorPosition(v,nodes,rooms);v.progress=1;
    const b=visitorPosition(v,nodes,rooms);check(a,b,`${edge.id}/${id}`);
  }
}
for(const room of map.geometry.rooms){
  if(room.access_mode==='controlled_show')assert.notEqual(room.entry_door,room.exit_door);
  else assert.equal(room.entry_door,null);
  for(const [node,area] of [[room.id,room.view_area],[room.queue_node,room.queue_area]]){
    for(let id=1;id<=1000;id++){
      const p=visitorPosition({id,node,next_node:null,state:'queueing'},nodes,rooms);
      const [x,z,w,d]=area;
      assert.ok(p[0]>x&&p[0]<x+w&&p[1]>z&&p[1]<z+d);
    }
  }
}
console.log('통과: 공용 관람길·공연 입퇴장 경로에서 3,300명 표시 위치가 벽·전시물을 통과하지 않음');
const show=rooms.F;
assert.equal(show.queue_slots.length,80);
assert.equal(new Set(show.queue_slots.map(p=>p[1])).size,2,'두 줄');
for(let rank=0;rank<80;rank++){
  const p=visitorPosition({id:rank+1,node:show.queue_node,state:'queueing',queue_slot:rank,queue_count:80},nodes,rooms);
  assert.deepEqual(p,show.queue_slots[rank]);
  assert.deepEqual(p,visitorPosition({id:rank+1,node:show.queue_node,state:'queueing',queue_slot:rank,queue_count:1},nodes,rooms),'인원이 줄어도 자리 고정');
  check(p,[nodes.show_lobby.x,nodes.show_lobby.z],'대기 줄 합류·포기');
  check(p,[nodes.show_before.x,nodes.show_before.z],'줄에서 입구로 이동');
  for(let j=0;j<rank;j++)assert.ok(Math.hypot(p[0]-show.queue_slots[j][0],p[1]-show.queue_slots[j][1])>=.8-1e-9,'최소 0.8m 간격');
}
const distance=p=>Math.hypot(Math.max(32-p[0],0,p[0]-66),Math.max(41-p[1],0,p[1]-58));
assert.ok(show.queue_slots.every((p,i)=>i===0||distance(p)>=distance(show.queue_slots[i-1])-1e-9),'공연 구역 가까운 자리 우선');
console.log('통과: 두 줄 80자리, 최소 0.8m 간격, 공연 구역 가까운 순서, 고정 자리');
