import assert from 'node:assert/strict';
import {motionPosition,Playback,decodeMotionFrames} from '../web/playback.mjs';
const nodes={a:{x:0,z:0},b:{x:1,z:0},c:{x:1,z:1}};
const before={id:1,node:'a',next_node:'b',progress:.9,state:'walking'};
const after={id:1,node:'b',next_node:'c',progress:.1,state:'walking'};
assert.ok(Math.hypot(...motionPosition(before,after,.5,nodes,{}).map((v,i)=>v-[1,0][i]))<1e-9);
for(let i=0;i<=20;i++){
  const [x,z]=motionPosition(before,after,i/20,nodes,{});
  assert.ok(Math.abs(z)<1e-9||Math.abs(x-1)<1e-9,'모퉁이를 대각선으로 가로지르지 않음');
}
const playback=new Playback(nodes,{});
playback.load([{time:100,visitors:[before]},{time:100.25,visitors:[after]}],1);
assert.equal(playback.tick(.125).time,100.125);
assert.ok(playback.active);
assert.deepEqual(playback.tick(.125).visitors[0].display_position,[1,.1]);
assert.ok(!playback.active);
playback.clear();assert.equal(playback.tick(1),null);
console.log('통과: 프레임 사이 연속 이동·모퉁이 경유·재생 종료');

// 60초 구간 경계와 배속 변경에서 시각이 되돌거나 한 프레임 멈추지 않는다.
const makeFrames=(start,end)=>Array.from({length:Math.round((end-start)*4)+1},(_,i)=>({time:start+i/4,visitors:[{...before,progress:.5}]}));
for(const speed of [10,30,50,100]){
  const player=new Playback(nodes,{});player.load(makeFrames(0,60),speed);
  let boundary=60;
  for(let i=1;i<=360;i++){
    if(player.remaining<=60){player.append(makeFrames(boundary,boundary+60));boundary+=60;}
    const frame=player.tick(1/60);
    assert.ok(Math.abs(frame.time-i*speed/60)<1e-7,`${speed}배에서 구간 경계 연속성`);
    assert.ok(player.frames.length<610,'이미 재생한 샘플 메모리 제한');
  }
  const previous=player.time;player.speed=10;assert.ok(Math.abs(player.tick(.02).time-previous-.2)<1e-7);
  player.clear();player.load(makeFrames(0,1),50);assert.equal(player.tick(1).time,1);
}
const packed=[{time:1,visitors:[[1,0,'walking','a','b',.5,null,0]]}];
assert.deepEqual(decodeMotionFrames(packed,'compact-v1')[0].visitors[0],{id:1,persona:0,state:'walking',node:'a',next_node:'b',progress:.5,queue_rank:null,queue_count:0,queue_slot:null,position:null,motion_status:'still'});
console.log('통과: 10·30·50·100배 구간 연결, 즉시 배속 변경, 메모리 제한, 경량 전송 해석');

// 서버 좌표는 논리 노드가 바뀌어도 재배치하지 않는다.
const physicalA={...before,position:[4,5]},physicalB={...after,position:[4.2,5.1]};
assert.deepEqual(motionPosition(physicalA,physicalB,.5,nodes,{}),[4.1,5.05]);
const motion=decodeMotionFrames([{time:1,visitors:[[7,0,'walking','a','b',.2,null,0,null,[3,4],'waiting']]}],'compact-v1');
assert.deepEqual(motion[0].visitors[0].position,[3,4]);
assert.equal(motion[0].visitors[0].motion_status,'waiting');
const departing=new Playback(nodes,{});
departing.load([{time:0,visitors:[physicalA]},{time:.25,visitors:[]}],1);
assert.deepEqual(departing.tick(.1).visitors,[],'퇴장자의 이전 위치를 붙잡아 두지 않음');
