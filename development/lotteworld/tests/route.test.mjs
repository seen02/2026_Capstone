import assert from 'node:assert/strict';
import {walkingRoute} from '../web/route.mjs';

const map={geometry:{nodes:[
  {id:'a',point:[0,0]},{id:'b',point:[10,30]},{id:'c',point:[10,0]},
  {id:'d',point:[5,0]},{id:'e',point:[7,0]},{id:'f',point:[20,20]}
],edges:[
  ['a','b'],['b','c'],['a','d'],['d','e'],['e','c']
].map(([source,target])=>({source,target}))}};

assert.deepEqual(walkingRoute(map,'a','c'),{nodes:['a','d','e','c'],distance_m:10});
assert.deepEqual(walkingRoute(map,'c','a'),{nodes:['c','e','d','a'],distance_m:10});
assert.deepEqual(walkingRoute(map,'a','a'),{nodes:['a'],distance_m:0});
assert.throws(()=>walkingRoute(map,'a','f'),/끊겼습니다/);
assert.throws(()=>walkingRoute(map,'missing','a'),/노드가 없습니다/);
console.log('양방향 최단 거리·우회·자기 경로·단절·알 수 없는 노드 검사 통과');
