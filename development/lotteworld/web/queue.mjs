/** 반원 회전부와 첫 줄의 이탈 게이트를 가진 접힌 대기줄. */
export function queueLayout(bounds, entrance, rules, boardingCapacity, rideBounds=null, queueCapacity=null) {
  const [x,z,w,d]=bounds;
  const side=entrance[0]===x?'left':entrance[0]===x+w?'right':entrance[1]===z?'top':'bottom';
  const horizontal=side==='left'||side==='right';
  const length=horizontal?w:d,breadth=horizontal?d:w;
  const baseTransform=([u,v])=>(side==='left'?[x+u,z+v]:side==='right'?[x+w-u,z+v]:side==='top'?[x+v,z+u]:[x+v,z+d-u]).map(n=>Math.round(n*1e6)/1e6);
  const rows=[];
  for(let v=1.2;v<=breadth-1.2+1e-8;v+=2.4)rows.push(v);
  const near=3.6,far=length-2.4;
  const distance=p=>rideBounds?Math.hypot(Math.max(rideBounds[0]-p[0],0,p[0]-rideBounds[0]-rideBounds[2]),Math.max(rideBounds[1]-p[1],0,p[1]-rideBounds[1]-rideBounds[3])):0;
  const endU=rows.length%2?far:near;
  const reverseRows=!!rideBounds&&distance(baseTransform([endU,0]))<distance(baseTransform([endU,breadth]));
  const transform=([u,v])=>baseTransform([u,reverseRows?breadth-v:v]);
  const rawEntryV=horizontal?entrance[1]-z:entrance[0]-x;
  const entryV=reverseRows?breadth-rawEntryV:rawEntryV;
  const points=[],arrows=[],slots=[];
  const add=p=>{if(!points.length||Math.hypot(p[0]-points.at(-1)[0],p[1]-points.at(-1)[1])>1e-8)points.push(p);};
  add([0,entryV]);add([.9,entryV]);
  if(Math.abs(entryV-rows[0])>=1.2)add([.9,rows[0]]);
  add([near-.65,rows[0]]);add([near,rows[0]]);
  const shoulderStart=points.length-1;
  const usable=Math.abs(far-near)-2*rules.end_clearance_m;
  const maxPerRow=Math.max(0,Math.floor(usable/rules.spacing_m+1e-8)+1);
  const capacity=queueCapacity??maxPerRow*rows.length;
  const perRow=Math.floor(capacity/rows.length),extra=capacity%rows.length;
  const slotIndices=[];
  rows.forEach((v,i)=>{
    const start=[i%2?far:near,v],end=[i%2?near:far,v];
    arrows.push([transform(start),transform(end)]);
    const count=perRow+Number(i<extra),direction=end[0]>start[0]?1:-1;
    for(let j=0;j<count;j++) {
      const slot=[start[0]+direction*(rules.end_clearance_m+j*rules.spacing_m),v];
      slots.push(transform(slot));add(slot);slotIndices.push(points.length-1);
    }
    if(rideBounds&&i===rows.length-1) {
      const bevel=Math.min(.45,rules.end_clearance_m*.8,(breadth-v)*.5);
      add([end[0]-direction*bevel,v]);add([end[0],v+bevel]);
    } else add(end);
    if(i<rows.length-1)for(let k=1;k<=12;k++) {
      const theta=-Math.PI/2+k*Math.PI/12;
      add([end[0]+(i%2?-1:1)*1.2*Math.cos(theta),v+1.2+1.2*Math.sin(theta)]);
    }
  });
  if(rideBounds)add([endU,breadth]);
  const boardingExit=rideBounds?transform(points.at(-1)):null;
  const boardingTarget=rideBounds?[Math.max(rideBounds[0],Math.min(boardingExit[0],rideBounds[0]+rideBounds[2])),Math.max(rideBounds[1],Math.min(boardingExit[1],rideBounds[1]+rideBounds[3]))]:null;
  const normals=points.slice(1).map((p,i)=>{const dx=p[0]-points[i][0],dz=p[1]-points[i][1],l=Math.hypot(dx,dz);return [-dz/l,dx/l];});
  const offset=(i,width)=>{
    const p=points[i];
    const a=normals[Math.max(0,i-1)],b=normals[Math.min(i,normals.length-1)];
    const nx=a[0]+b[0],nz=a[1]+b[1],den=nx*b[0]+nz*b[1];
    return transform([i?p[0]+width*nx/den:0,p[1]+width*nz/den]);
  };
  const shoulderWidth=1.18;
  const railPaths=[
    points.map((_,i)=>offset(i,.6)),
    points.slice(0,shoulderStart).map((_,i)=>offset(i,-.6)),
    [transform([near+.65,rows[0]-shoulderWidth]),...points.flatMap(([u,v],i)=>
      i>shoulderStart&&(v!==rows[0]||u>near+.65)?[offset(i,-shoulderWidth)]:[])],
  ];
  if(rideBounds&&rows.length%2===0) {
    railPaths[2].splice(-3,2,transform([endU+shoulderWidth,rows.at(-1)+shoulderWidth]));
  }
  const withdrawalEnd=slotIndices.length?slotIndices.at(-1)+1:points.length;
  const withdrawal=[transform([near,0]),...points.slice(shoulderStart,withdrawalEnd).map((_,i)=>offset(i+shoulderStart,-.64))];
  const rails=railPaths.flatMap(path=>path.slice(1).map((p,i)=>[path[i],p]));
  const minimum=Math.ceil(boardingCapacity*rules.minimum_boarding_multiple);
  return {bounds:[...bounds],entrance:[...entrance],points:points.map(transform),boarding_exit:boardingExit,boarding_target:boardingTarget,reverse_rows:reverseRows,railPaths,rails,arrows,rowPitch_m:2.4,turnClearance_m:1.2,capacity:slots.length,slots,
    boarding_capacity:boardingCapacity,minimum_capacity:minimum,meets_minimum:slots.length>=minimum,
    slot_indices:slotIndices,withdrawal,withdrawal_slot_indices:slotIndices.map(i=>i-shoulderStart+1)};
}
