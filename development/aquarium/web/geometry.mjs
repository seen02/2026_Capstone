// 사각 보행 영역의 합집합을 겹치지 않는 타일로 분할한다.
export function floorTiles(areas){
  const xs=[...new Set(areas.flatMap(a=>[a.bounds[0],a.bounds[0]+a.bounds[2]]))].sort((a,b)=>a-b);
  const zs=[...new Set(areas.flatMap(a=>[a.bounds[1],a.bounds[1]+a.bounds[3]]))].sort((a,b)=>a-b);
  const tiles=[];
  for(let i=0;i<xs.length-1;i++)for(let j=0;j<zs.length-1;j++){
    const x=xs[i],z=zs[j],w=xs[i+1]-x,d=zs[j+1]-z;
    const area=areas.findLast(a=>{const [ax,az,aw,ad]=a.bounds;return x+w/2>ax&&x+w/2<ax+aw&&z+d/2>az&&z+d/2<az+ad;});
    if(area)tiles.push({bounds:[x,z,w,d],kind:area.kind});
  }
  return tiles;
}
export const FLOOR_Y=.09;
export function personDimensions(geometry){
  const radius=geometry.human_radius_m,height=geometry.human_height_m;
  return {radius,height,cylinderLength:height-2*radius,centerY:FLOOR_Y+height/2};
}
