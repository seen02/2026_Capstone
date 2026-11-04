import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CapsuleGeometry} from '../web/vendor/three/three.module.js';
import {floorTiles,FLOOR_Y,personDimensions} from '../web/geometry.mjs';
const map=JSON.parse(readFileSync(new URL('../configs/aquarium_map.json',import.meta.url),'utf8'));
const areas=map.geometry.building_floor_areas,tiles=floorTiles(areas);
const overlap=(a,b)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
assert.ok(areas.some((a,i)=>areas.slice(i+1).some(b=>overlap(a.bounds,b.bounds)>0)),'회귀 검사를 위한 원본 겹침');
for(let i=0;i<tiles.length;i++)for(let j=i+1;j<tiles.length;j++)assert.equal(overlap(tiles[i].bounds,tiles[j].bounds),0,'바닥 중복 면');
// 현재 정수 좌표 도면의 합집합 면적을 독립적인 1m 셀 집계와 비교한다.
const cells=new Set();
for(const {bounds:[x,z,w,d]} of areas)for(let i=x;i<x+w;i++)for(let j=z;j<z+d;j++)cells.add(`${i},${j}`);
assert.equal(tiles.reduce((sum,t)=>sum+t.bounds[2]*t.bounds[3],0),cells.size,'바닥 누락/추가');
for(const room of map.geometry.rooms)for(const feature of room.features){
  for(const [x,z,w,d] of feature.collision_bounds??[feature.bounds]){
    for(let i=x;i<x+w;i++)for(let j=z;j<z+d;j++)assert.ok(cells.has(`${i},${j}`),'수조·무대 아래 건물 바닥 누락');
  }
}
const deep=map.geometry.rooms.find(r=>r.id==='C');
assert.equal(deep.features.length,1,'심해 수조는 하나');
assert.equal(deep.features[0].polygon.length,6,'ㄱ자 외곽');
assert.ok(map.geometry.walls.some(w=>w.a[0]===71&&w.b[0]===71&&w.a[1]<=30&&w.b[1]>=41),'해파리 수조 외측 벽');
assert.ok(!map.geometry.labels.some(l=>l.text==='공연 대기'),'공연 대기 추가 라벨 없음');
const dimensions=personDimensions(map.geometry);
const human=new CapsuleGeometry(dimensions.radius,dimensions.cylinderLength,4,6);human.computeBoundingBox();
const box=human.boundingBox;
assert.ok(Math.abs(box.max.y-box.min.y-1.7)<1e-6);
assert.ok(Math.abs(box.max.x-box.min.x-.46)<1e-6);
assert.ok(Math.abs(dimensions.centerY+box.min.y-FLOOR_Y)<1e-6,'발이 바닥 높이에 놓임');
for(const door of map.geometry.doors){
  assert.equal(door.width,4);
  const sides=map.geometry.walls.filter(w=>w.a[1]===door.z&&w.b[1]===door.z);
  assert.ok(sides.some(w=>w.b[0]===door.x-door.width/2));
  assert.ok(sides.some(w=>w.a[0]===door.x+door.width/2));
}
console.log(`통과: 바닥 ${cells.size}㎡ 중복 면 없음 / 사람 높이 1.7m·폭 0.46m / 공연 출입구 실제 틈 4m`);
