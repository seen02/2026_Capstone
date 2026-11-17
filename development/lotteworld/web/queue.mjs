/** 반원 회전부와 양쪽 연속 벨트를 가진 접힌 대기줄. */
export function queueLayout(bounds, entrance, rules, boardingCapacity, rideBounds=null) {
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
  [[0,entryV],[.9,entryV],[.9,rows[0]],[near,rows[0]]].forEach(add);
  rows.forEach((v,i)=>{
    const start=[i%2?far:near,v],end=[i%2?near:far,v];
    add(end);arrows.push([transform(start),transform(end)]);
    const usable=Math.abs(end[0]-start[0])-2*rules.end_clearance_m;
    const count=Math.max(0,Math.floor(usable/rules.spacing_m+1e-8)+1),direction=end[0]>start[0]?1:-1;
    for(let j=0;j<count;j++)slots.push(transform([start[0]+direction*(rules.end_clearance_m+j*rules.spacing_m),v]));
    if(i<rows.length-1)for(let k=1;k<=12;k++) {
      const theta=-Math.PI/2+k*Math.PI/12;
      add([end[0]+(i%2?-1:1)*1.2*Math.cos(theta),v+1.2+1.2*Math.sin(theta)]);
    }
  });
  if(rideBounds)add([endU,breadth]);
  const boardingExit=rideBounds?transform(points.at(-1)):null;
  const boardingTarget=rideBounds?[Math.max(rideBounds[0],Math.min(boardingExit[0],rideBounds[0]+rideBounds[2])),Math.max(rideBounds[1],Math.min(boardingExit[1],rideBounds[1]+rideBounds[3]))]:null;
  const normals=points.slice(1).map((p,i)=>{const dx=p[0]-points[i][0],dz=p[1]-points[i][1],l=Math.hypot(dx,dz);return [-dz/l,dx/l];});
  const railPaths=[-1,1].map(side=>points.map((p,i)=>{
    const a=normals[Math.max(0,i-1)],b=normals[Math.min(i,normals.length-1)];
    const nx=a[0]+b[0],nz=a[1]+b[1],den=nx*b[0]+nz*b[1];
    return transform([p[0]+side*.6*nx/den,p[1]+side*.6*nz/den]);
  }));
  const rails=railPaths.flatMap(path=>path.slice(1).map((p,i)=>[path[i],p]));
  const minimum=Math.ceil(boardingCapacity*rules.minimum_boarding_multiple);
  return {bounds:[...bounds],entrance:[...entrance],points:points.map(transform),boarding_exit:boardingExit,boarding_target:boardingTarget,reverse_rows:reverseRows,railPaths,rails,arrows,rowPitch_m:2.4,turnClearance_m:1.2,capacity:slots.length,slots,
    boarding_capacity:boardingCapacity,minimum_capacity:minimum,meets_minimum:slots.length>=minimum};
}
