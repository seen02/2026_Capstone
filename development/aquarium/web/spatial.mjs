// 미터 단위 가상 도면의 표시 좌표. 엔진의 경로와 같은 출입문을 통과한다.
export function visitorPosition(visitor,nodes,rooms){
  if(visitor.position)return visitor.position;
  const point=id=>{
    const n=nodes[id],room=rooms[n.zone];
    if(!room || !["queue","exhibit"].includes(n.kind))return [n.x,n.z];
    if(n.kind==='queue'&&room.queue_slots){
      // 배정된 자리를 유지하며 대기 인원에 따라 간격을 압축하지 않는다.
      const index=visitor.queue_slot??visitor.queue_rank??0;
      return room.queue_slots[Math.min(room.queue_slots.length-1,Math.max(0,index))];
    }
    const area=n.kind==='queue'?room.queue_area:room.view_area;
    const [x,z,w,d]=area;
    const u=((visitor.id*73)%997)/997,v=((visitor.id*137)%991)/991;
    return [x+.35+u*(w-.7),z+.35+v*(d-.7)];
  };
  const a=point(visitor.node);
  if(!visitor.next_node)return a;
  const b=point(visitor.next_node),p=visitor.progress;
  return [a[0]+(b[0]-a[0])*p,a[1]+(b[1]-a[1])*p];
}
