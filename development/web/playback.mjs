import {visitorPosition} from './spatial.mjs?v=viewing-2';
// 서버가 충돌을 검사한 연속 좌표를 그대로 보간한다.
export function motionPosition(a,b,t,nodes,rooms){
  const p=visitorPosition(a,nodes,rooms),q=visitorPosition(b,nodes,rooms);
  const lerp=(p,q,u)=>[p[0]+(q[0]-p[0])*u,p[1]+(q[1]-p[1])*u];
  if(a.position&&b.position)return lerp(p,q,t);
  if(a.node===b.node&&a.next_node===b.next_node)return lerp(p,q,t);
  if(a.next_node&&a.next_node===b.node){
    const corner=visitorPosition({...b,next_node:null,progress:0},nodes,rooms);
    const first=Math.hypot(corner[0]-p[0],corner[1]-p[1]),second=Math.hypot(q[0]-corner[0],q[1]-corner[1]);
    const split=first/(first+second||1);
    return t<split?lerp(p,corner,t/split):lerp(corner,q,(t-split)/(1-split||1));
  }
  if(a.node===b.node)return lerp(p,q,t);
  return t<1?p:q;
}
export const MOTION_FIELDS=['id','persona','state','node','next_node','progress','queue_rank','queue_count','queue_slot','position','motion_status'];
export function decodeMotionFrames(frames,format){
  if(format!=='compact-v1')return frames;
  return frames.map(f=>({time:f.time,visitors:f.visitors.map(row=>({id:row[0],persona:row[1],state:row[2],node:row[3],next_node:row[4],progress:row[5],queue_rank:row[6],queue_count:row[7],queue_slot:row[8]??null,position:row[9]??null,motion_status:row[10]??'still'}))}));
}
export class Playback{
  constructor(nodes,rooms){this.nodes=nodes;this.rooms=rooms;this.clear();this.speed=50;}
  load(frames,speed){this.clear();this.speed=speed;this.append(frames);}
  append(frames){
    if(!frames.length)return;
    if(!this.frames.length){this.frames=frames.slice();this.time=frames[0].time;return;}
    const end=this.frames.at(-1).time;
    if(frames[0].time>end+1e-6)throw new Error('재생 구간이 연속되지 않습니다.');
    this.frames.push(...frames.filter(f=>f.time>end));
  }
  get remaining(){return this.frames.length?Math.max(0,this.frames.at(-1).time-this.time):0;}
  get active(){return this.remaining>1e-8;}
  tick(seconds){
    if(!this.frames.length)return null;
    this.time=Math.min(this.time+seconds*this.speed,this.frames.at(-1).time);
    while(this.index<this.frames.length-1&&this.frames[this.index+1].time<=this.time)this.index++;
    const a=this.frames[this.index],b=this.frames[this.index+1]??a,t=a===b?0:(this.time-a.time)/(b.time-a.time);
    if(this.lookupFrame!==b){this.lookupFrame=b;this.lookup=new Map(b.visitors.map(v=>[v.id,v]));}
    // 퇴장한 사람의 이전 위치를 붙잡아 두면 뒤따르는 사람과 겹쳐 보인다.
    const frame={time:this.time,visitors:a.visitors.filter(v=>this.lookup.has(v.id)).map(v=>({...v,display_position:motionPosition(v,this.lookup.get(v.id),t,this.nodes,this.rooms)}))};
    // 이미 표시한 샘플은 버려 장시간 재생의 메모리 사용을 제한한다.
    if(this.index>120){this.frames=this.frames.slice(this.index);this.index=0;}
    return frame;
  }
  clear(){this.frames=[];this.index=0;this.time=0;this.lookupFrame=null;this.lookup=null;}
}
