/** 포장 광장 전체를 사용하는 정적 안내 경로. 사람 생성·충돌 회피 엔진은 별도다. */
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const polygonRowSize=10;
function segmentDistance(p,a,b) {
  const dx=b[0]-a[0],dz=b[1]-a[1],length2=dx*dx+dz*dz;
  const t=length2?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/length2)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);
}

function boundsOf(points,margin=0) {
  const xs=points.map(p=>p[0]),zs=points.map(p=>p[1]);
  return {minX:Math.min(...xs)-margin,maxX:Math.max(...xs)+margin,
    minZ:Math.min(...zs)-margin,maxZ:Math.max(...zs)+margin};
}

function segmentBounds(a,b,margin=0) {
  return {minX:Math.min(a[0],b[0])-margin,maxX:Math.max(a[0],b[0])+margin,
    minZ:Math.min(a[1],b[1])-margin,maxZ:Math.max(a[1],b[1])+margin};
}

function overlaps(a,b) {
  return a.minX<=b.maxX&&a.maxX>=b.minX&&a.minZ<=b.maxZ&&a.maxZ>=b.minZ;
}

function contains({minX,maxX,minZ,maxZ},x,z) {
  return x>=minX&&x<=maxX&&z>=minZ&&z<=maxZ;
}

function ringSegments(points,margin) {
  return points.map((a,i)=>{
    const b=points[(i+1)%points.length];
    return {a,b,...segmentBounds(a,b,margin)};
  });
}

function ringLocation(point,ring,margin) {
  const [x,z]=point;
  if(!contains(ring,x,z))return -1;
  let inside=false;
  for(const edge of ring.rows.get(Math.floor(z/polygonRowSize))??[]) {
    const {a,b}=edge;
    if(contains(edge,x,z)&&segmentDistance(point,a,b)<=margin)return 0;
    if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside?1:-1;
}

function segmentGap(a,b,c,d) {
  const side=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  if(side(a,b,c)*side(a,b,d)<=0&&side(c,d,a)*side(c,d,b)<=0&&
    overlaps(segmentBounds(a,b),segmentBounds(c,d)))return 0;
  return Math.min(segmentDistance(a,c,d),segmentDistance(b,c,d),
    segmentDistance(c,a,b),segmentDistance(d,a,b));
}

class Heap {
  values=[];
  push(value) {
    let i=this.values.length;this.values.push(value);
    while(i){const p=(i-1)>>1;if(this.values[p].score<=value.score)break;this.values[i]=this.values[p];i=p;}this.values[i]=value;
  }
  pop() {
    const first=this.values[0],last=this.values.pop();
    if(this.values.length){let i=0;while(i*2+1<this.values.length){let c=i*2+1;if(c+1<this.values.length&&this.values[c+1].score<this.values[c].score)c++;if(this.values[c].score>=last.score)break;this.values[i]=this.values[c];i=c;}this.values[i]=last;}
    return first;
  }
}

export function createNavigator(map,{step=2,radius=.25}={}) {
  const g=map.geometry,nodes=Object.fromEntries(g.nodes.map(n=>[n.id,n.point]));
  const shoreMargin=Math.max(radius,1e-8);
  const shore=ringSegments(g.island_outline,shoreMargin);
  function withinShore(p) {
    const [x,z]=p;
    let inside=false;
    for(const {a,b,minX,maxX,minZ,maxZ} of shore) {
      // 굽은 해안의 세분점이 많아도 가까운 선분에서만 거리 계산이 필요하다.
      if(x>=minX&&x<=maxX&&z>=minZ&&z<=maxZ&&segmentDistance(p,a,b)<shoreMargin)return radius<=0;
      if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  }
  const rectangles=[...(g.castle_footprint?[]:[g.castle]),...g.scenery_buildings,
    ...(g.landscape_areas?[]:g.landscape_beds),...map.facilities.flatMap(f=>[f.bounds,f.queue,f.exit_area])];
  const polygons=[...(g.castle_footprint?[{outline:g.castle_footprint}]:[]),
    ...(g.landscape_areas??[]),...(g.ride_access_areas??[])];
  for (const {point: [x, z], clearance_radius_m: r} of Object.values(g.signposts ?? {})) {
    polygons.push({outline:[[x-r,z-r],[x+r,z-r],[x+r,z+r],[x-r,z+r]]});
  }
  function prepareRing(points) {
    const segments=ringSegments(points,shoreMargin),rows=new Map();
    // 한 걸음이나 한 점은 가까운 z 범위의 선분만 검사한다.
    for(const edge of segments) {
      const first=Math.floor(edge.minZ/polygonRowSize),last=Math.floor(edge.maxZ/polygonRowSize);
      for(let row=first;row<=last;row++) {
        if(!rows.has(row))rows.set(row,[]);
        rows.get(row).push(edge);
      }
    }
    return {...boundsOf(points,shoreMargin),segments,rows};
  }
  const polygonReservations=polygons.map(({outline,holes=[],facility_id:facility})=>{
    const outer=prepareRing(outline);
    const inner=holes.map(prepareRing);
    return {outer,inner,rings:[outer,...inner],facility};
  });
  function blockedByPolygon(p,allowedFacility) {
    return polygonReservations.some(({outer,inner,facility})=>{
      if(allowedFacility!=null&&facility===allowedFacility)return false;
      const location=ringLocation(p,outer,shoreMargin);
      return location===0||(location===1&&!inner.some(hole=>ringLocation(p,hole,shoreMargin)===1));
    });
  }
  function crossesPolygon(a,b,allowedFacility) {
    if(!polygonReservations.length)return false;
    const bounds=segmentBounds(a,b);
    const first=Math.floor(bounds.minZ/polygonRowSize),last=Math.floor(bounds.maxZ/polygonRowSize);
    const crossesEdge=edge=>overlaps(bounds,edge)&&segmentGap(a,b,edge.a,edge.b)<=shoreMargin;
    return polygonReservations.some(({rings,facility})=>{
      if(allowedFacility!=null&&facility===allowedFacility)return false;
      return rings.some(ring=>{
        if(!overlaps(bounds,ring))return false;
        if(last-first>2)return ring.segments.some(crossesEdge);
        for(let row=first;row<=last;row++)if(ring.rows.get(row)?.some(crossesEdge))return true;
        return false;
      });
    });
  }
  function clearOfPolygons(a,b,allowedFacility) {
    return !blockedByPolygon(a,allowedFacility)&&(!b||
      !blockedByPolygon(b,allowedFacility)&&!crossesPolygon(a,b,allowedFacility));
  }
  const bridges=g.edges.filter(e=>e.kind==='bridge').map(e=>({...e,a:nodes[e.source],b:nodes[e.target]}));
  const exitBridge = bridges.find(edge => edge.source === g.boundary || edge.target === g.boundary);
  function bridgeExit(x, z, clearance) {
    if (!exitBridge) return null;
    const [endX, endZ] = nodes[g.boundary];
    const [startX, startZ] = exitBridge.source === g.boundary ? exitBridge.b : exitBridge.a;
    const length = Math.hypot(endX - startX, endZ - startZ);
    const dx = (endX - startX) / length, dz = (endZ - startZ) / length;
    const back = (endX - x) * dx + (endZ - z) * dz;
    const side = (x - endX) * -dz + (z - endZ) * dx;
    if (back < -1e-6 || back > Math.min(length, 8) || Math.abs(side) > exitBridge.width / 2) return null;
    const usable = Math.max(0, exitBridge.width / 2 - clearance);
    const lane = Math.max(-usable, Math.min(usable, side));
    return {x: endX - dz * lane, z: endZ + dx * lane};
  }
  function walkable(p) {
    if(!p.every(Number.isFinite))return false;
    if(!withinShore(p)&&!bridges.some(e=>{
      const length=distance(e.a,e.b),t=((p[0]-e.a[0])*(e.b[0]-e.a[0])+(p[1]-e.a[1])*(e.b[1]-e.a[1]))/length**2;
      return radius/length<=t&&t<=1-radius/length&&segmentDistance(p,e.a,e.b)<=e.width/2-radius;
    }))return false;
    return !rectangles.some(([x,z,w,d])=>p[0]>=x-radius&&p[0]<=x+w+radius&&p[1]>=z-radius&&p[1]<=z+d+radius)&&
      !blockedByPolygon(p);
  }
  function visible(a,b) {
    // 점 간격보다 좁은 녹지와 가장자리를 스치는 구간도 연속적으로 판정한다.
    if(crossesPolygon(a,b))return false;
    const count=Math.max(1,Math.ceil(distance(a,b)/.5));
    for(let i=0;i<=count;i++)if(!walkable([a[0]+(b[0]-a[0])*i/count,a[1]+(b[1]-a[1])*i/count]))return false;
    return true;
  }
  const columns=Math.ceil(g.bounds[2]/step)+1,rows=Math.ceil(g.bounds[3]/step)+1;
  const grid=new Uint8Array(columns*rows);
  const point=id=>[id%columns*step,Math.floor(id/columns)*step];
  for(let id=0;id<grid.length;id++)grid[id]=walkable(point(id))?1:0;

  const accessFacilities=new Set((g.ride_access_areas??[]).map(area=>area.facility_id));
  const accessPortals=new Map();
  for(const facility of map.facilities) {
    if(!accessFacilities.has(facility.id))continue;
    accessPortals.set(facility.entrance,{facility:facility.id,kind:'branch'});
    accessPortals.set(facility.exit,{facility:facility.id,kind:'exit'});
  }

  function accessAnchor(id,{facility,kind}) {
    const seen=new Set([id]),pending=[{id,passage:[nodes[id]]}];
    // 출입구의 전용 간선만 따라가며 처음 만나는 공용 보행면과 연결한다.
    for(const {id:from,passage} of pending) {
      const a=nodes[from];
      for(const edge of g.edges) {
        if(edge.kind!==kind||edge.source!==from&&edge.target!==from)continue;
        const neighbor=edge.source===from?edge.target:edge.source;
        if(seen.has(neighbor))continue;
        const b=nodes[neighbor],steps=Math.ceil(distance(a,b)/.5);
        for(let i=1;i<=steps;i++) {
          const t=i/steps;
          const candidate=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
          if(walkable(candidate)&&clearOfPolygons(a,candidate,facility))return {point:candidate,passage};
        }
        if(clearOfPolygons(a,b,facility)) {
          seen.add(neighbor);
          pending.push({id:neighbor,passage:[...passage,b]});
        }
      }
    }
    throw new Error('시설 전용 입출구와 포장 광장의 연결을 찾지 못했습니다.');
  }

  function anchor(id) {
    const p=nodes[id];if(!p)throw new Error('경로의 시작·도착 노드가 없습니다.');
    if(walkable(p))return {point:p,passage:[p]};
    const portal=accessPortals.get(id);
    if(portal)return accessAnchor(id,portal);
    const blocked=blockedByPolygon(p);
    for(const edge of g.edges.filter(e=>e.source===id||e.target===id)) {
      const q=nodes[edge.source===id?edge.target:edge.source],length=distance(p,q);
      for(let offset=.5;offset<=length;offset+=.5) {
        const candidate=[p[0]+(q[0]-p[0])*offset/length,p[1]+(q[1]-p[1])*offset/length];
        if(walkable(candidate)&&(blocked||!crossesPolygon(p,candidate)))return {point:candidate,passage:blocked?[]:[p]};
      }
    }
    throw new Error('입출구와 포장 광장의 연결을 찾지 못했습니다.');
  }
  function nearest(p) {
    const cx=Math.round(p[0]/step),cz=Math.round(p[1]/step),candidates=[];
    for(let dz=-3;dz<=3;dz++)for(let dx=-3;dx<=3;dx++) {
      const x=cx+dx,z=cz+dz;if(x<0||z<0||x>=columns||z>=rows)continue;
      const id=z*columns+x;if(grid[id])candidates.push({id,length:distance(p,point(id))});
    }
    candidates.sort((a,b)=>a.length-b.length);
    const found=candidates.find(c=>visible(p,point(c.id)));
    if(!found)throw new Error('광장 경로의 연결점을 찾지 못했습니다.');
    return found.id;
  }
  function between(start,end) {
    if(visible(start,end))return [start,end];
    const from=nearest(start),to=nearest(end),pending=new Heap();
    const cost=new Float64Array(grid.length).fill(Infinity),parent=new Int32Array(grid.length).fill(-1),closed=new Uint8Array(grid.length);
    cost[from]=0;pending.push({id:from,score:distance(point(from),point(to))});
    while(pending.values.length) {
      const {id}=pending.pop();if(closed[id])continue;closed[id]=1;
      if(id===to)break;
      const x=id%columns,z=Math.floor(id/columns);
      for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++) {
        if(!dx&&!dz)continue;
        const nx=x+dx,nz=z+dz;if(nx<0||nz<0||nx>=columns||nz>=rows)continue;
        const next=nz*columns+nx;
        if(!grid[next]||closed[next]||(dx&&dz&&(!grid[z*columns+nx]||!grid[nz*columns+x])))continue;
        const length=cost[id]+Math.hypot(dx,dz)*step;
        if(length>=cost[next]||!visible(point(id),point(next)))continue;
        cost[next]=length;parent[next]=id;pending.push({id:next,score:length+distance(point(next),point(to))});
      }
    }
    if(!closed[to])throw new Error('포장 광장에서 연결되는 경로가 없습니다.');
    const path=[];for(let at=to;at>=0;at=parent[at])path.push(point(at));path.reverse();
    const raw=[start,...path,end],result=[start];
    for(let i=0;i<raw.length-1;) {
      let next=raw.length-1;while(next>i+1&&!visible(raw[i],raw[next]))next--;
      result.push(raw[next]);i=next;
    }
    return result;
  }
  const cache=new Map();
  function route(source,target) {
    const key=source+'>'+target;if(cache.has(key))return cache.get(key);
    const start=anchor(source),end=anchor(target),publicPath=between(start.point,end.point);
    const points=[...start.passage,...publicPath,...end.passage.toReversed()]
      .filter((p,i,all)=>!i||distance(p,all[i-1])>1e-8);
    const result={nodes:[source,target],points,distance_m:points.slice(1).reduce((sum,p,i)=>sum+distance(p,points[i]),0),mode:'open-plaza',radius_m:radius};
    cache.set(key,result);return result;
  }
  return {route,walkable,visible,between,bridgeExit,clearOfPolygons,step,radius};
}
