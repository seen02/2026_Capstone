/** 포장 광장 전체를 사용하는 정적 안내 경로. 사람 생성·충돌 회피 엔진은 별도다. */
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function segmentDistance(p,a,b) {
  const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz)));
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);
}
function inside(p,outline) {
  let result=false;
  for(let i=0;i<outline.length;i++) {
    const a=outline[i],b=outline[(i+1)%outline.length];
    if(segmentDistance(p,a,b)<1e-8)return true;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
  }
  return result;
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
  const reservations=[g.castle,...g.scenery_buildings,...g.landscape_beds,...map.facilities.flatMap(f=>[f.bounds,f.queue,f.exit_area])];
  const bridges=g.edges.filter(e=>e.kind==='bridge').map(e=>({...e,a:nodes[e.source],b:nodes[e.target]}));
  function walkable(p) {
    if(!p.every(Number.isFinite))return false;
    let land=inside(p,g.island_outline);
    if(land&&radius)land=g.island_outline.every((a,i)=>segmentDistance(p,a,g.island_outline[(i+1)%g.island_outline.length])>=radius);
    if(!land&&!bridges.some(e=>{
      const length=distance(e.a,e.b),t=((p[0]-e.a[0])*(e.b[0]-e.a[0])+(p[1]-e.a[1])*(e.b[1]-e.a[1]))/length**2;
      return radius/length<=t&&t<=1-radius/length&&segmentDistance(p,e.a,e.b)<=e.width/2-radius;
    }))return false;
    return !reservations.some(([x,z,w,d])=>p[0]>=x-radius&&p[0]<=x+w+radius&&p[1]>=z-radius&&p[1]<=z+d+radius);
  }
  function visible(a,b) {
    const count=Math.max(1,Math.ceil(distance(a,b)/.5));
    for(let i=0;i<=count;i++)if(!walkable([a[0]+(b[0]-a[0])*i/count,a[1]+(b[1]-a[1])*i/count]))return false;
    return true;
  }
  const columns=Math.ceil(g.bounds[2]/step)+1,rows=Math.ceil(g.bounds[3]/step)+1;
  const grid=new Uint8Array(columns*rows);
  const point=id=>[id%columns*step,Math.floor(id/columns)*step];
  for(let id=0;id<grid.length;id++)grid[id]=walkable(point(id))?1:0;

  function anchor(id) {
    const p=nodes[id];if(!p)throw new Error('경로의 시작·도착 노드가 없습니다.');
    if(walkable(p))return p;
    for(const edge of g.edges.filter(e=>e.source===id||e.target===id)) {
      const q=nodes[edge.source===id?edge.target:edge.source],length=distance(p,q);
      for(let offset=.5;offset<=length;offset+=.5) {
        const candidate=[p[0]+(q[0]-p[0])*offset/length,p[1]+(q[1]-p[1])*offset/length];
        if(walkable(candidate))return candidate;
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
    const start=anchor(source),end=anchor(target),publicPath=between(start,end);
    const points=[nodes[source],...publicPath,nodes[target]].filter((p,i,all)=>!i||distance(p,all[i-1])>1e-8);
    const result={nodes:[source,target],points,distance_m:points.slice(1).reduce((sum,p,i)=>sum+distance(p,points[i]),0),mode:'open-plaza',radius_m:radius};
    cache.set(key,result);return result;
  }
  return {route,walkable,visible,between,step,radius};
}
