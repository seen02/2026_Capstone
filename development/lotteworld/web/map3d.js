import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {box, cylinder, rod, polygon, band, material, mesh} from './geometry.mjs';
import {buildRide, buildCastle, rideFloorOutline} from './rides.mjs';
import {createNavigator} from './navigation.mjs';
import {queueLayout} from './queue.mjs';
import {CrowdMovement, VisitorTimeline} from './live-state.mjs';

const walkerColor = new THREE.Color('#26496b');
const queueColor = new THREE.Color('#753e06');
const queuedStates = new Set(['joining_queue', 'advancing_queue', 'queued']);
const personScale = 1.95;
const queuePostHeightScale = 1.85;
const pavementY = .08;
const bridgeDeckY = .32;
// 위에서 보기의 오른쪽은 +X, 아래쪽은 +Z다.
const signDirections = {
  'magic-island-west': {
    'gyro-drop': [0, -1],
    'comet-express': [-2, -1],
    'gyro-spin': [0, 1],
  },
};
const legY = .9, legLength = .87, legDepth = .19;
const personHeadTop = 2.11;
const visitorModelHeight = personScale*(personHeadTop-legY+legLength);
const torsoGeometry = new THREE.CylinderGeometry(.23, .18, .83, 8).scale(1, 1, .72).translate(0, 1.285, 0);
// 목과 머리를 한 메시로 그려 배경 방문객의 인스턴스 묶음을 유지한다.
const headGeometry = new THREE.LatheGeometry([
  [.065, 1.66], [.065, 1.78], [.128, 1.82], [.163, 1.90],
  [.169, 1.96], [.142, 2.05], [.072, 2.10], [0, personHeadTop],
].map(([radius, y]) => new THREE.Vector2(radius, y)), 8);
const limbGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, -.5, 0);
const skin = new THREE.MeshBasicMaterial({color: '#efc39b'});
const clothing = new THREE.MeshBasicMaterial();
const qrClothing = new THREE.MeshBasicMaterial({color: '#653caa'});
const qrRing = new THREE.MeshBasicMaterial({color: '#f3cb79', depthWrite: false, toneMapped: false});
const qrRingGeometry = new THREE.RingGeometry(1.85, 2.5, 24).rotateX(-Math.PI / 2);
const joints = [
  [-.12, legY, .17, legLength, legDepth, 1], [.12, legY, .17, legLength, legDepth, -1],
  [-.25, 1.57, .13, .67, .15, -1], [.25, 1.57, .13, .67, .15, 1],
];

function signBoardOutline(width, height, tipWidth) {
  const left = -width / 2, right = width / 2, top = height / 2;
  return new THREE.Shape([
    [left, -top], [right - tipWidth, -top], [right, 0],
    [right - tipWidth, top], [left, top],
  ].map(([x, y]) => new THREE.Vector2(x, y)));
}

function addSignBoard(parent, text, y) {
  const width = 1.15, height = .2, depth = .065, tipWidth = .14, border = .014;
  const x = width / 2 - .04;
  const outline = signBoardOutline(width, height, tipWidth);
  const frame = new THREE.ExtrudeGeometry(outline, {depth, bevelEnabled: false});
  frame.translate(0, 0, -depth / 2);
  mesh(parent, frame, '#88613e', [x, y, 0]);

  const inset = signBoardOutline(width - 2 * border, height - 2 * border, tipWidth);
  const panelGeometry = new THREE.ShapeGeometry(inset);
  const panelMaterial = new THREE.MeshBasicMaterial({color: '#f6d58d', side: THREE.DoubleSide, toneMapped: false});
  const textWidth = width - tipWidth - .08, textHeight = height - 2 * border;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(textWidth * 480);
  canvas.height = Math.round(textHeight * 480);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#382547';
  ctx.font = `700 ${Math.round(canvas.height * .76)}px "Malgun Gothic", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 24);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const textGeometry = new THREE.PlaneGeometry(textWidth, textHeight);
  const textMaterial = new THREE.MeshBasicMaterial({map: texture, transparent: true, depthWrite: false, toneMapped: false});
  for (const side of [1, -1]) {
    const panel = new THREE.Mesh(panelGeometry, panelMaterial);
    panel.position.set(x, y, side * (depth / 2 + .002));
    const letters = new THREE.Mesh(textGeometry, textMaterial);
    letters.position.set(x - tipWidth / 2, y, side * (depth / 2 + .004));
    letters.rotation.y = side === 1 ? 0 : Math.PI;
    parent.add(panel, letters);
  }
}

function footHeight(swing) {
  // 회전한 다리의 맨 아래 모서리를 기준으로 발밑 높이를 맞춘다.
  return personScale * (legY - legLength*Math.cos(swing) - legDepth/2*Math.abs(Math.sin(swing)));
}

function inside([x,z], outline) {
  let result=false;
  for(let i=0,j=outline.length-1;i<outline.length;j=i++) {
    const [ax,az]=outline[i],[bx,bz]=outline[j];
    if((az>z)!==(bz>z) && x<(bx-ax)*(z-az)/(bz-az)+ax)result=!result;
  }
  return result;
}

function bridgeShoreContact(start, end, outline) {
  const at = fraction => start.map((coordinate, i) => THREE.MathUtils.lerp(coordinate, end[i], fraction));
  let land = 0, water = 1;
  // 보행 연결의 시작점은 섬 안쪽에 있고 실제 데크는 해안에서 시작한다.
  for (let step = 0; step < 40; step++) {
    const middle = (land + water) / 2;
    if (inside(at(middle), outline)) land = middle;
    else water = middle;
  }
  return at((land + water) / 2);
}

function segmentDistance([x,z],a,b) {
  const dx=b[0]-a[0],dz=b[1]-a[1];
  const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));
  return Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz);
}

function offsetShore(outline, distance) {
  const area = outline.reduce((sum, [x,z], i) => {
    const [nx,nz] = outline[(i+1)%outline.length];
    return sum+x*nz-z*nx;
  }, 0);
  const inward = Math.sign(area);
  function normal(a, b) {
    const dx = b[0]-a[0], dz = b[1]-a[1], length = Math.hypot(dx,dz);
    return [-inward*dz/length, inward*dx/length];
  }
  return outline.map(([x,z], i) => {
    const a = normal(outline.at(i-1), outline[i]);
    const b = normal(outline[i], outline[(i+1)%outline.length]);
    const scale = distance / Math.max(.5, 1+a[0]*b[0]+a[1]*b[1]);
    return [x+(a[0]+b[0])*scale, z+(a[1]+b[1])*scale];
  });
}

// 주석의 안쪽 경계와 해안 호를 미터 좌표로 옮긴 녹지 계획이다.
const gardenPlan=[
  {id:'north-and-east-coast',via:[45.5,24.2],points:[
    [31.8,221.2],[35.4,212],[37,201.5],[42.1,190.6],[53.8,188],[65.4,186.6],
    [74,182],[76.9,171.1],[75.4,164.5],[69.3,157],[62.5,153.7],[34.1,149.9],
    [22.8,139],[19.9,124.7],[26.8,106.5],[48.2,97.9],[53,93.2],[58.1,84.6],
    [62.8,58.1],[72,51.4],[81.1,51.2],[93.1,43],[116.6,41.7],[132.5,41],
    [155.7,41.3],[168.8,43.9],[172.6,52.9],[174.6,64.9],[179.8,74.1],[185,75.5],
    [190,75.3],[194.6,71.9],[196.1,65.4],[196.9,47.6],[198.8,34.4],[205.9,24.3],
    [216.4,18.7],[228.9,18.8],[236.1,22.2],[243,28.3],[246.9,36.6],[249,45.7],
    [253.6,54.6],[252.9,60.6],[252.1,67.9],[251.3,73.9],[248.6,82.7],[245.8,93.1],[244.8,102.7],
    [244.7,112.8],
    [246.8,126.6],[252.3,133.1],[257.3,131.2],[260.4,118.8],[262.1,101.3],[264.7,92.9],
    [267.8,91.2],[307.3,94.4],[314.6,98.4],[324.3,113.8],[321.2,150.5],[317.9,162.3],
    [305.8,179.4],[286,187.4],[275.7,185.4],[259,177.3],[250,170],[247.3,167.1],
    [243.6,164.6],[240.3,164.1],[235,165.7],[232.1,169.7],[230.3,172.8],
  ]},
  {id:'southwest-coast',via:[177.3,306.2],points:[
    [81.2,232.9],[90.6,228.1],[100.7,228.4],[105.2,232.2],[110.6,237.8],[113.8,242.8],
    [114.9,249.6],[117.4,255.2],[119,259.8],[122.4,263.4],[128.4,271.2],[138.4,277.4],
    [151,277.1],[163.8,277.2],[171.5,271.5],[177.9,262.6],[177.2,258.4],[177.8,254.2],
    [180.5,247.7],[184.9,240.4],[189.1,234.9],[193.8,231.4],[198.4,228.6],[202.3,227.6],
  ]},
  {id:'comet-plaza',points:[
    [83.6,140.5],[83.8,125],[86,113.2],[94.5,110],[104.2,108.8],[112.5,108.7],
    [118.4,110.8],[121.5,112.9],[123,118.2],[122.2,125.4],[121,133.7],[118.6,141.2],
    [110.9,147.8],[100,148.9],[90.9,148.6],
  ]},
  {id:'castle-east-plaza',points:[
    [175.7,110.2],[178,104.6],[183.7,99.6],[189.7,96.2],[195.8,95.7],[203.4,97.6],
    [210.8,100.7],[219.4,105.8],[224.4,112.2],[228.1,119.2],[229.1,126.6],[228,134.2],
    [224.8,142.9],[219.4,147.7],[212.9,149.1],[206.5,148.6],[203.2,141.3],[199.5,134.4],
    [194,127.2],[187.7,120.7],[182,116.1],[177.7,113.2],
  ]},
];

// 주석의 녹지 안을 지나는 참조 동선에는 지면색을 이어 그리되 식재를 두지 않는다.
const gardenCrossingEdges=new Set([
  'north-center--swing-approach',
  'swing-approach--gyro-swing-entry',
  'gyro-swing-exit--gyro-swing-return-0',
  'gyro-swing-return-0--gyro-swing-return-1',
  'gyro-swing-return-1--east-north',
  'atlantis-return-1--east-exit',
]);

function smoothGardenBoundary(points,closed) {
  const curve=new THREE.CatmullRomCurve3(points.map(([x,z])=>new THREE.Vector3(x,0,z)),closed);
  return curve.getPoints(points.length*6).slice(0,closed?-1:undefined).map(({x,z})=>[x,z]);
}

function insertShoreContact(outline,point) {
  let edge=0,best=Infinity;
  for(let i=0;i<outline.length;i++) {
    const distance=segmentDistance(point,outline[i],outline[(i+1)%outline.length]);
    if(distance<best) {
      edge=i;
      best=distance;
    }
  }
  const [ax,az]=outline[edge], [bx,bz]=outline[(edge+1)%outline.length];
  const dx=bx-ax,dz=bz-az;
  const t=THREE.MathUtils.clamp(((point[0]-ax)*dx+(point[1]-az)*dz)/(dx*dx+dz*dz),0,1);
  if(t<=1e-6||t>=1-1e-6)return outline;
  return [...outline.slice(0,edge+1),[ax+t*dx,az+t*dz],...outline.slice(edge+1)];
}

function markedGardens(outline) {
  return gardenPlan.map(({id,points,via})=>{
    if(!via)return {id,coastal:false,outline:smoothGardenBoundary(points,true)};
    const coast=insertShoreContact(insertShoreContact(outline,points[0]),points.at(-1));
    // 녹지의 해안 쪽만 바깥까지 칠한다. 섬 지면의 실루엣이 수면 쪽을 잘라낸다.
    const paintedShore=offsetShore(coast,-3.5);
    const count=coast.length;
    const nearestIndex=([x,z])=>coast.reduce((best,[px,pz],i)=>
      Math.hypot(px-x,pz-z)<Math.hypot(coast[best][0]-x,coast[best][1]-z)?i:best,0);
    const distance=(a,b)=>(b-a+count)%count;
    const first=nearestIndex(points[0]),last=nearestIndex(points.at(-1));
    const forward=distance(first,nearestIndex(via))<distance(first,last);
    const length=forward?distance(first,last):distance(last,first);
    const inner=smoothGardenBoundary([paintedShore[first],...points.slice(1,-1),paintedShore[last]],false);
    const shore=Array.from({length:Math.max(0,length-1)},(_,i)=>paintedShore[(last+(forward?-1:1)*(i+1)+count)%count]);
    return {id,coastal:true,outline:[...inner,...shore]};
  });
}

function paintLandscape(parent, g, gardens, clearAreas, clearPaths, rideFloors) {
  const [x,z,width,depth]=g.bounds;
  const resolution=1536;
  const createCanvas=()=>{
    const canvas=document.createElement('canvas');
    canvas.width=canvas.height=resolution;
    return canvas;
  };
  function contour(context, points) {
    context.moveTo(...points[0]);
    for(const point of points.slice(1))context.lineTo(...point);
    context.closePath();
  }
  const mask=createCanvas();
  const grass=mask.getContext('2d');
  const scaleX=resolution/width, scaleZ=resolution/depth;
  grass.setTransform(scaleX,0,0,scaleZ,-x*scaleX,-z*scaleZ);
  grass.fillStyle='#819960';
  for(const {outline,holes=[]} of gardens) {
    grass.beginPath();
    contour(grass,outline);
    for(const hole of holes)contour(grass,hole);
    grass.fill('evenodd');
  }

  grass.globalCompositeOperation='destination-out';
  const clearance=.55;
  for(const [a,b,w,d] of clearAreas) {
    grass.beginPath();
    grass.roundRect(a-clearance,b-clearance,w+2*clearance,d+2*clearance,2.2);
    grass.fill();
  }
  for(const outline of rideFloors) {
    grass.beginPath();
    contour(grass,outline);
    grass.fill();
  }
  grass.lineCap='round';
  for(const [a,b,halfWidth] of clearPaths) {
    grass.beginPath();
    grass.moveTo(...a);
    grass.lineTo(...b);
    grass.lineWidth=2*(halfWidth+clearance);
    grass.stroke();
  }

  // 받침과 통로를 먼저 비운 뒤 최종 녹지 윤곽을 둥글게 다듬는다.
  const blended=createCanvas();
  const paint=blended.getContext('2d',{willReadFrequently:true});
  if(!g.landscape_areas)paint.filter='blur(7px)';
  paint.drawImage(mask,0,0);
  paint.filter='none';
  // 모서리가 둥글게 합쳐진 모양은 살리고, 색 경계는 흐릿해 보이지 않게 정리한다.
  const coverage=paint.getImageData(0,0,resolution,resolution);
  for(let i=3;i<coverage.data.length;i+=4) {
    const opacity=coverage.data[i];
    if(opacity<168&&opacity>112) {
      const edge=THREE.MathUtils.clamp((opacity-116)/45,0,1);
      // 낮은 경계석의 색만 그려, 화단 윤곽을 같은 높이에서 정리한다.
      coverage.data[i-3]=THREE.MathUtils.lerp(190,129,edge);
      coverage.data[i-2]=THREE.MathUtils.lerp(184,153,edge);
      coverage.data[i-1]=THREE.MathUtils.lerp(157,96,edge);
    }
    coverage.data[i]=(opacity-112)*255/41;
  }
  paint.putImageData(coverage,0,0);
  const hasGreenery=(px,pz)=>{
    const col=Math.floor((px-x)*scaleX),row=Math.floor((pz-z)*scaleZ);
    return col>=0&&row>=0&&col<resolution&&row<resolution&&
      coverage.data[(row*resolution+col)*4+3]>245&&inside([px,pz],g.island_outline);
  };
  paint.globalCompositeOperation='destination-over';
  paint.fillStyle='#d9c9aa';
  paint.fillRect(0,0,resolution,resolution);

  const shape=new THREE.Shape(g.island_outline.map(([px,pz])=>new THREE.Vector2(px,-pz)));
  const geometry=new THREE.ShapeGeometry(shape);
  const positions=geometry.attributes.position, uv=geometry.attributes.uv;
  for(let i=0;i<positions.count;i++) {
    uv.setXY(i,(positions.getX(i)-x)/width,1+(positions.getY(i)+z)/depth);
  }
  geometry.rotateX(-Math.PI/2);
  const texture=new THREE.CanvasTexture(blended);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=4;
  const surface=new THREE.Mesh(geometry,material('#ffffff',{map:texture}));
  surface.position.y=pavementY;
  surface.name='public-pavement';
  surface.receiveShadow=true;
  parent.add(surface);
  return {surface,hasGreenery};
}

function scatterPlantings(gardens,geometry,hasGreenery,protectedPaths) {
  // 새로고침하거나 다른 화면에서 볼 때도 같은 위치에 식재한다.
  let seed=20261111;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const plants=[];
  const directions=Array.from({length:8},(_,i)=>[Math.cos(i*Math.PI/4),Math.sin(i*Math.PI/4)]);
  const shore=geometry.island_outline.map((point,i,outline)=>[point,outline[(i+1)%outline.length]]);
  const shrubColors=['#64844e','#75955b','#577a54'];
  function inReservedBed(x,z) {
    return geometry.landscape_beds.some(([a,b,w,d])=>x>=a+.6&&x<=a+w-.6&&z>=b+.6&&z<=b+d-.6);
  }
  function fillGarden({outline,coastal},spacing,shrub) {
    const xs=outline.map(p=>p[0]),zs=outline.map(p=>p[1]);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
    // 구역 전체를 격자로 훑되 각 칸에서는 위치를 무작위로 고른다.
    const startX=minX-random()*spacing,startZ=minZ-random()*spacing;
    for(let x=startX;x<maxX;x+=spacing)for(let z=startZ;z<maxZ;z+=spacing) {
      for(let attempt=0;attempt<18;attempt++) {
        const px=x+random()*spacing,pz=z+random()*spacing,point=[px,pz];
        if(!hasGreenery(px,pz)||!inside(point,outline))continue;
        const radius=shrub?1.05+random()*(coastal?.5:.85):1.8+random()*.8;
        if(!directions.every(([dx,dz])=>hasGreenery(px+dx*radius,pz+dz*radius)))continue;
        if(protectedPaths.some(([a,b,halfWidth,id])=>gardenCrossingEdges.has(id)&&
          segmentDistance(point,a,b)<halfWidth+radius+.55))continue;
        const reserved=inReservedBed(px,pz);
        if(!reserved) {
          // 예약 구획 밖에서는 보행 편차를 감안하고, 나무는 물가 쪽에만 심는다.
          if(!shrub&&(!coastal||!shore.some(([a,b])=>segmentDistance(point,a,b)<23)))continue;
          if(protectedPaths.some(([a,b,halfWidth])=>
            segmentDistance(point,a,b)<Math.max(halfWidth,7.5)+radius+.75))continue;
        }
        if(plants.some(p=>{
          const room=radius+p.radius+.75;
          const minimum=(p.kind==='shrub')===shrub?Math.max(room,spacing*.56):room;
          return Math.hypot(px-p.x,pz-p.z)<minimum;
        }))continue;
        const kind=shrub?'shrub':random()<.55?'rounded':'pointed';
        const color=shrub?shrubColors[Math.floor(random()*shrubColors.length)]:
          kind==='rounded'?'#719c83':'#79987b';
        const height=shrub?visitorModelHeight*(.41+random()*.14):8+random()*6;
        plants.push({x:px,z:pz,height,radius,kind,color});
        break;
      }
    }
  }
  for(const garden of gardens)fillGarden(garden,garden.coastal?17:19,false);
  for(const garden of gardens)fillGarden(garden,garden.coastal?13:6,true);
  return plants;
}

function lakeRipples(outline) {
  const vertices = [];
  for(let row=0;row<12;row++) for(let col=0;col<11;col++) {
    const x = -110+col*57+(col*7+row*11)%31;
    const z = -70+row*40+(col*13+row*5)%25;
    const length = 7+(row*11+col*9)%9;
    const point = [x+length/2,z];
    if(inside(point,outline) || outline.some((a,i)=>segmentDistance(point,a,outline[(i+1)%outline.length])<length/2+5)) continue;
    for(let step=0;step<5;step++) for(const t of [step/5,(step+1)/5]) {
      vertices.push(x+length*t, -3.44, z-Math.sin(Math.PI*t)*1.3);
    }
  }
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertices,3));
  const ripples = new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({
    color:'#e7fcfd',transparent:true,opacity:.48,depthWrite:false
  }));
  ripples.name='lake-ripples';
  return ripples;
}

export class MagicIslandMap {
  constructor(host,map,onSelect,{keepCharacterCentered=false,signs=[]}={}) {
    this.host=host;this.map=map;this.onSelect=onSelect;
    this.keepCharacterCentered=keepCharacterCentered;
    this.points=Object.fromEntries(map.geometry.nodes.map(n=>[n.id,n.point]));
    this.queueLayouts={};
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#badade');
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.12;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', keepCharacterCentered
      ? '내 캐릭터 중심의 매직아일랜드 3D 지도. 드래그로 회전하고 두 손가락이나 휠로 확대'
      : '매직아일랜드 3D 지도. 왼쪽 드래그 회전, 오른쪽 드래그 이동, 휠 확대');
    this.renderer.domElement.setAttribute('role','img');
    host.prepend(this.renderer.domElement);
    this.camera=new THREE.OrthographicCamera(-200,200,200,-200,.1,2200);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=false;
    this.controls.minZoom=.5;this.controls.maxZoom=5;
    this.controls.minPolarAngle=.08;this.controls.maxPolarAngle=Math.PI*.46;
    this.controls.screenSpacePanning=true;
    this.controls.enablePan=!keepCharacterCentered;
    this.controls.addEventListener('change',()=>this.render());
    this.controls.addEventListener('start',()=>{
      this.isHome=false;
      if (!this.keepCharacterCentered) this.stopFollowing();
      host.dispatchEvent(new Event('map-interaction'));
    });
    this.scene.add(new THREE.HemisphereLight('#f3f7f6','#819279',2.4));
    const sun=new THREE.DirectionalLight('#fff6e4',3);
    sun.position.set(-100,350,180);sun.castShadow=true;
    Object.assign(sun.shadow.camera,{left:-300,right:300,top:300,bottom:-300,near:1,far:800});
    sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.0005;sun.shadow.normalBias=.3;this.scene.add(sun);
    this.labels=[];this.pickables=[];this.rideGroups={};
    this.scenery=new THREE.Group();this.scenery.name='배경';this.scene.add(this.scenery);
    this.characterRoutes=new THREE.Group();this.scene.add(this.characterRoutes);
    this.characters=new Map();
    this.characterTimeline=new VisitorTimeline();
    this.visitorTimeline=new VisitorTimeline();
    const personRadius=map.geometry.queue_rules.person_radius_m;
    this.crowd=new CrowdMovement(createNavigator(map,{radius:personRadius}),personRadius);
    this.visitorHeadings=new Map();
    this.visitorPose=new THREE.Object3D();
    this.visitorPose.scale.setScalar(personScale);
    this.limbPose=new THREE.Object3D();
    this.limbMatrix=new THREE.Matrix4();
    this.build();
    for (const sign of signs) this.addSign(sign);
    this.renderer.shadowMap.autoUpdate=false;
    this.renderer.shadowMap.needsUpdate=true;
    this.ray=new THREE.Raycaster();let down=null;
    this.renderer.domElement.addEventListener('pointerdown',e=>{
      down=e.isPrimary&&e.button===0?[e.clientX,e.clientY]:null;
    });
    this.renderer.domElement.addEventListener('pointerup',e=>{
      if(!down || Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
      const bounds=this.host.getBoundingClientRect();
      this.ray.setFromCamera(new THREE.Vector2((e.clientX-bounds.left)/bounds.width*2-1,1-(e.clientY-bounds.top)/bounds.height*2),this.camera);
      const hits=this.ray.intersectObjects(this.pickables,false);
      if(hits.length)this.onSelect?.(hits[0].object.userData.facilityId);
    });
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);
    this.resize();this.home();
    this.renderer.domElement.addEventListener('webglcontextlost',e=>{
      e.preventDefault();this.host.dispatchEvent(new CustomEvent('map-error',{detail:'3D 그래픽 연결이 끊겼습니다. 페이지를 새로고침하세요.'}));
    });
  }

  labelFacility(name,position,facility) {
    const interactive=this.onSelect;
    const element=document.createElement(interactive?'button':'span');
    element.className='map-label facility-label';
    element.textContent=name;
    if(interactive) {
      element.type='button';
      element.dataset.facility=facility;
      element.setAttribute('aria-label',name+' 상세 보기');
      element.setAttribute('aria-pressed','false');
      element.onclick=()=>this.onSelect(facility,element);
    }
    this.host.querySelector('.labels').append(element);
    this.labels.push({element,position:new THREE.Vector3(...position)});
    return element;
  }

  addSign({sign_id: signId, position: {point: [x, z]}, facility_ids: facilityIds = []}) {
    const marker = new THREE.Group();
    marker.name = `signpost:${signId}`;
    marker.position.set(x, pavementY, z);
    // 실물 치수는 성인 키 1.7m를 기준으로 지도 속 방문객과 같은 비율로 환산한다.
    marker.scale.setScalar(visitorModelHeight / 1.7);
    const firstBoardHeight = 2.2, boardSpacing = .28;
    const poleHeight = firstBoardHeight + Math.max(0, facilityIds.length - 1) * boardSpacing + .14;
    cylinder(marker, 0, poleHeight / 2, 0, .06, poleHeight, '#513765');
    for (const [index, facilityId] of facilityIds.entries()) {
      const facility = this.map.facilities.find(item => item.id === facilityId);
      if (!facility) continue;
      const [entryX, entryZ] = this.points[facility.entrance];
      const [dx, dz] = signDirections[signId]?.[facilityId] ?? [entryX - x, entryZ - z];
      const board = new THREE.Group();
      board.name = `sign-board:${facilityId}`;
      board.rotation.y = -Math.atan2(dz, dx);
      addSignBoard(board, facility.name, firstBoardHeight + index * boardSpacing);
      marker.add(board);
    }
    this.scenery.add(marker);
  }

  build() {
    const g=this.map.geometry;
    polygon(this.scene,g.island_outline,'#829991',2.8,-2.8);
    // 카메라에 수면이 잘려도 호수색이 이어지도록 배경에 색을 채우고 수면에는 그림자만 얹는다.
    const lake=new THREE.Mesh(
      new THREE.PlaneGeometry(6000,6000).rotateX(-Math.PI/2),
      new THREE.ShadowMaterial({opacity:.18,depthWrite:false,toneMapped:false})
    );
    lake.name='석촌호수';lake.position.y=-3.5;lake.receiveShadow=true;lake.renderOrder=-1;
    this.scene.add(lake);
    const shallows=polygon(this.scene,offsetShore(g.island_outline,-3.4),'#a9d4d8',.02,-3.49,[g.island_outline]);
    shallows.name='lake-shallows';shallows.castShadow=false;
    this.scene.add(lakeRipples(g.island_outline));
    // 연결 그래프에서는 다리 부분만 독립된 지면으로 표시한다.
    const bridge=g.edges.find(edge=>edge.kind==='bridge');
    const b=this.points[g.boundary];
    const a=bridgeShoreContact(this.points['bridge-island'],b,g.island_outline);
    const deckThickness=.36;
    const surface=band(this.scene,a,b,bridge.width,'#c7ab83',bridgeDeckY-deckThickness/2,deckThickness);
    surface.name='walk:'+bridge.id;
    surface.userData={edgeId:bridge.id,width:bridge.width,start:a,end:b};
    const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz),nx=-dz/length,nz=dx/length;
    this.bridgeFootprint={start:a, direction:[dx/length,dz/length], length, halfWidth:bridge.width/2};
    for(const side of [-1,1]) {
      const offset=bridge.width/2-.22;
      const aa=[a[0]+nx*offset*side,1.5,a[1]+nz*offset*side];
      const bb=[b[0]+nx*offset*side,1.5,b[1]+nz*offset*side];
      rod(this.scene,aa,bb,.18,'#9b8365').name='bridge-handrail';
      for(const t of [.005,.1,.22,.34,.46,.58,.7,.82,.94,.995]) {
        const x=aa[0]+dx*t,z=aa[2]+dz*t;
        rod(this.scene,[x,bridgeDeckY-.05,z],[x,1.5,z],.14,'#a18c6d').name='bridge-rail-post';
      }
    }
    const castle=buildCastle(this.scenery,g.castle,g.castle_height_m,g.castle_forward,g.castle_model_scale_xz,g.castle_footprint);
    castle.userData.obstacle='castle';
    for(const f of this.map.facilities) {
      this.buildQueue(f);
      const group=buildRide(this.scene,f);this.rideGroups[f.id]=group;
      group.traverse(object=>{if(object.isMesh)this.pickables.push(object);});
      const [cx,cz]=f.label_anchor;
      this.labelFacility(f.name,[cx,f.model_height_m+8,cz],f.id);
      for(const [key,color] of [['entrance','#287e63'],['exit','#b65f48']]) {
        const [px,pz]=this.points[f[key]];
        cylinder(this.scene,px,.14,pz,1.3,.02,color,1.3,12).name=key+':'+f.id;
      }
    }
    this.landscape();
  }

  buildQueue(facility) {
    const layout=queueLayout(facility.queue,this.points[facility.entrance],this.map.geometry.queue_rules,
      facility.boarding_capacity,facility.bounds,facility.queue_capacity);
    this.queueLayouts[facility.id]=layout;
    const group=new THREE.Group();group.name='queue:'+facility.id;this.scene.add(group);
    const rails=new THREE.Group();
    rails.scale.y=queuePostHeightScale;
    rails.position.y=pavementY*(1-queuePostHeightScale);
    group.add(rails);
    const scale=this.map.geometry.queue_rules.layout_scale??1;
    const postSpacing=2.5*scale;
    const posts=[];
    for(const path of layout.railPaths) {
      const vertices=[],indices=[];
      path.forEach(([x,z],i)=>{
        vertices.push(x,.9425,z,x,1.0175,z);
        if(i) {const j=2*i;indices.push(j-2,j-1,j,j-1,j+1,j);}
      });
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setIndex(indices);geometry.computeVertexNormals();
      const belt=new THREE.Mesh(geometry,material('#254b67',{side:THREE.DoubleSide}));
      belt.name='queue-belt';rails.add(belt);
      // 곡선 세분점과 독립적으로 일정 간격의 기둥을 배치한다.
      posts.push(path[0]);let remaining=postSpacing;
      for(let i=1;i<path.length;i++) {
        const a=path[i-1],b=path[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
        let distance=remaining;
        for(;distance<=length;distance+=postSpacing)posts.push([a[0]+(b[0]-a[0])*distance/length,a[1]+(b[1]-a[1])*distance/length]);
        remaining=distance-length;
      }
      posts.push(path.at(-1));
    }
    const parts=[
      [new THREE.CylinderGeometry(.19,.22,.06,12),material('#343d43',{metalness:.65,roughness:.3}),pavementY+.03],
      [new THREE.CylinderGeometry(.045,.045,.95,8),material('#9ba9af',{metalness:.75,roughness:.25}),pavementY+.95/2],
      [new THREE.BoxGeometry(.13,.11,.13),material('#28373e'),1.03]
    ];
    const dummy=new THREE.Object3D();dummy.scale.set(scale,1,scale);
    for(const [geometry,mat,y] of parts) {
      const mesh=new THREE.InstancedMesh(geometry,mat,posts.length);
      posts.forEach(([x,z],i)=>{dummy.position.set(x,y,z);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
      mesh.castShadow=true;mesh.receiveShadow=true;rails.add(mesh);
    }
    for(let i=1;i<layout.points.length;i++) {
      const a=layout.points[i-1],b=layout.points[i];
      if(Math.hypot(b[0]-a[0],b[1]-a[1])>1e-8)band(group,a,b,.035,'#baa981',.105,.015);
    }
    for(const [a,b] of layout.arrows) {
      const start=new THREE.Vector3(a[0],.14,a[1]),delta=new THREE.Vector3(b[0]-a[0],0,b[1]-a[1]);
      start.addScaledVector(delta,.42);
      group.add(new THREE.ArrowHelper(delta.normalize(),start,1.1,0x358e7a,.4,.24));
    }
    const boarding=layout.boarding_exit,target=layout.boarding_target;
    cylinder(group,boarding[0],.14,boarding[1],.85,.02,'#bc8a35',.85,12).name='boarding-exit';
    band(group,boarding,target,.12,'#bc8a35',.14,.04).name='boarding-approach';

  }

  landscape() {
    const g=this.map.geometry;
    const protectedPaths=[
      ...g.edges.map(e=>[this.points[e.source],this.points[e.target],e.width/2,e.id]),
      ...Object.values(this.queueLayouts).map(q=>[q.boarding_exit,q.boarding_target,1.25]),
    ];
    const openPaving=[g.plaza,...g.scenery_buildings];
    for(const facility of this.map.facilities) {
      for(const [key,padding] of [['queue',2.5],['exit_area',3]]) {
        const [x,z,w,d]=facility[key];
        openPaving.push([x-padding,z-padding,w+2*padding,d+2*padding]);
      }
    }
    const gardens=g.landscape_areas??markedGardens(g.island_outline);
    const floors=this.map.facilities.map(f=>rideFloorOutline(f,.15));
    const paintedPaths=protectedPaths.filter(([, , , id])=>!gardenCrossingEdges.has(id));
    const {surface,hasGreenery}=g.landscape_areas
      ?paintLandscape(this.scene,g,gardens,[],[],[])
      :paintLandscape(this.scene,g,gardens,openPaving,paintedPaths,floors);
    this.ground=surface;
    const plants=scatterPlantings(gardens,g,hasGreenery,protectedPaths);
    this.ground.userData={gardens,plants};
    const trees=plants.filter(p=>p.kind!=='shrub');
    const shrubs=plants.filter(p=>p.kind==='shrub');
    const trunks=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),material('#8c8160'),trees.length);
    trunks.name='landscape-trees';
    const dummy=new THREE.Object3D();
    if(shrubs.length) {
      const lobes=[[0,0,.69,1],[-.44,-.14,.52,.7],[.39,.23,.51,.79]];
      const hedge=new THREE.InstancedMesh(new THREE.SphereGeometry(1,10,8),material('#ffffff'),shrubs.length*lobes.length);
      hedge.name='landscape-shrubs';
      shrubs.forEach(({x,z,radius:size,height,color},i)=>{
        const angle=x*.73+z*1.27, cos=Math.cos(angle),sin=Math.sin(angle);
        lobes.forEach(([dx,dz,width,top],j)=>{
          const yRadius=height*top/2;
          dummy.position.set(x+(dx*cos-dz*sin)*size,pavementY+yRadius-.04,z+(dx*sin+dz*cos)*size);
          dummy.scale.set(size*width,yRadius,size*width);
          dummy.updateMatrix();
          const index=i*lobes.length+j;
          hedge.setMatrixAt(index,dummy.matrix);
          hedge.setColorAt(index,new THREE.Color(color).multiplyScalar(1-j*.055));
        });
      });
      hedge.castShadow=true;
      hedge.receiveShadow=true;
      this.scenery.add(hedge);
    }
    trees.forEach((tree,i)=>{
      const trunkHeight=tree.height*(tree.kind==='rounded'?.46:.54);
      dummy.position.set(tree.x,trunkHeight/2,tree.z);
      dummy.scale.set(.45,trunkHeight,.45);
      dummy.updateMatrix();
      trunks.setMatrixAt(i,dummy.matrix);
    });
    trunks.castShadow=true;
    this.scenery.add(trunks);
    for(const kind of ['pointed','rounded']) {
      const group=trees.filter(tree=>tree.kind===kind);
      if(!group.length)continue;
      const rounded=kind==='rounded';
      const geometry=rounded?new THREE.SphereGeometry(1,12,8):new THREE.CylinderGeometry(.25/2.6,1,1,8);
      const crowns=new THREE.InstancedMesh(geometry,material('#ffffff'),group.length);
      crowns.name='landscape-'+kind+'-crowns';
      group.forEach((tree,i)=>{
        dummy.position.set(tree.x,tree.height*(rounded?.68:.67),tree.z);
        dummy.scale.set(tree.radius,tree.height*(rounded?.32:.7),tree.radius);
        dummy.updateMatrix();
        crowns.setMatrixAt(i,dummy.matrix);
        crowns.setColorAt(i,new THREE.Color(tree.color));
      });
      crowns.castShadow=true;crowns.receiveShadow=true;this.scenery.add(crowns);
    }
    // 안내도에서 성 뒤쪽의 지붕 군집을 참고한 배경 건물. 추가 대상 시설이 아니다.
    const rearBuilding=new THREE.Group();rearBuilding.name='castle-rear-building';this.scenery.add(rearBuilding);
    for(const [x,z,w,d] of g.scenery_buildings) {
      box(rearBuilding,x+w/2,3,z+d/2,w,6,d,'#d5c7b0');
      box(rearBuilding,x+w/2,7,z+d/2,w,2,d,'#597387');
    }
  }

  select(id) {
    for(const {element} of this.labels) {
      if(element.dataset.facility)element.setAttribute('aria-pressed',String(element.dataset.facility===id));
    }
    this.render();
  }

  resize() {
    const width=this.host.clientWidth,height=this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width,height,false);
    const aspect=width/height,span=215;
    this.camera.left=-span*aspect;this.camera.right=span*aspect;this.camera.top=span;this.camera.bottom=-span;
    this.camera.updateProjectionMatrix();
    if(this.homeZoom && this.isHome && this.lastAspect!==aspect)this.home(this.topView);
    this.lastAspect=aspect;this.render();
  }

  home(top=false) {
    this.topView=top;this.isHome=true;
    const target=new THREE.Vector3(185,8,165);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(top?0:150,top?650:370,top?1:480));
    this.camera.up.set(0,1,0);this.camera.zoom=1;this.camera.lookAt(target);this.camera.updateMatrixWorld();this.camera.updateProjectionMatrix();
    const corners=this.map.geometry.island_outline.map(([x,z])=>new THREE.Vector3(x,0,z));
    const boundary=this.points[this.map.geometry.boundary];
    corners.push(new THREE.Vector3(boundary[0]+4,0,boundary[1]+4));
    for(const group of Object.values(this.rideGroups)) {
      const bounds=new THREE.Box3().setFromObject(group);
      for(const x of [bounds.min.x,bounds.max.x])for(const z of [bounds.min.z,bounds.max.z])for(const y of [bounds.min.y,bounds.max.y])corners.push(new THREE.Vector3(x,y,z));
    }
    corners.push(...this.labels.map(label=>label.position.clone()));
    corners.forEach(point=>point.project(this.camera));
    const extent=Math.max(...corners.flatMap(p=>[Math.abs(p.x),Math.abs(p.y)]));
    this.camera.zoom=.87/extent;this.homeZoom=this.camera.zoom;
    this.controls.minZoom=this.homeZoom*.65;this.controls.maxZoom=this.homeZoom*6;
    this.camera.updateProjectionMatrix();this.controls.update();this.render();
  }

  zoom(factor) {
    this.isHome=false;
    this.camera.zoom=THREE.MathUtils.clamp(this.camera.zoom*factor,this.controls.minZoom,this.controls.maxZoom);
    this.camera.updateProjectionMatrix();this.render();
  }

  focus(id) {
    const facility=this.map.facilities.find(f=>f.id===id);
    this.focusPoint(facility.label_anchor);
  }

  focusPoint([x,z]) {
    this.isHome=false;
    this.moveCameraTarget(new THREE.Vector3(x, 5, z));
    this.camera.zoom = this.homeZoom * 3;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  stopFollowing() {
    this.trackedCharacter = null;
  }

  followCharacter(id) {
    this.trackedCharacter = id;
    const position = this.characters.get(id)?.position;
    if (position) this.focusPoint([position.x, position.z]);
  }

  moveCameraTarget(target) {
    this.camera.position.add(target.clone().sub(this.controls.target));
    this.controls.target.copy(target);
  }

  setVisitors(visitors, clock) {
    const now = performance.now();
    if (clock) this.visitorTimeline.push(visitors, clock, now);
    else {
      this.visitorTimeline.clear();
      this.crowd.clear();
    }
    this.updateVisitors(now);
  }

  updateVisitors(now) {
    const {people, pending} = this.visitorTimeline.sample(now);
    const qr = this.characterTimeline.sample(now);
    for (const {id, x, z, dx, dz, aboard} of qr.people) {
      const character = this.characters.get(id);
      if (character) this.placeCharacter(id, character, x, z, dx, dz, now, aboard);
    }
    if (people.length || this.visitors) {
      const characters = [];
      for (const [id, {position, figure}] of this.characters) {
        if (figure.visible) characters.push({id, x: position.x, z: position.z});
      }
      const scale = this.visitorTimeline.frames.at(-1)?.scale ?? 1;
      this.drawVisitors(this.crowd.update(people, characters, now, scale), now);
    }
    if (this.visitorFrame === undefined && (pending || qr.pending || this.crowd.departuresPending)) {
      const animate = timestamp => {
        if (!this.host.clientWidth) {
          this.visitorFrame = undefined;
          return;
        }
        if (timestamp - now < 30) {
          this.visitorFrame = requestAnimationFrame(animate);
          return;
        }
        this.visitorFrame = undefined;
        this.updateVisitors(timestamp);
        if (this.characterTimeline.frames.length) this.render();
        else this.renderer.render(this.scene, this.camera);
      };
      this.visitorFrame = requestAnimationFrame(animate);
    }
  }

  surfaceHeightAt(x,z) {
    const {start:[ax,az],direction:[dx,dz],length,halfWidth}=this.bridgeFootprint;
    const along=(x-ax)*dx+(z-az)*dz;
    const across=(z-az)*dx-(x-ax)*dz;
    return along>=0 && along<=length && Math.abs(across)<=halfWidth ? bridgeDeckY : pavementY;
  }

  drawVisitors(people, now) {
    if (!this.visitors || this.visitors[0].instanceMatrix.count < people.length) {
      for (const batch of this.visitors ?? []) {
        this.scene.remove(batch);
        batch.dispose();
      }
      const capacity = Math.max(256, people.length * 2);
      this.visitors = [
        new THREE.InstancedMesh(torsoGeometry, clothing, capacity),
        new THREE.InstancedMesh(headGeometry, skin, capacity),
        new THREE.InstancedMesh(limbGeometry, clothing, capacity * joints.length),
      ];
      for (const batch of this.visitors) {
        batch.frustumCulled = false;
        batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(batch);
      }
    }
    const [torsos, heads, limbs] = this.visitors;
    const person = this.visitorPose;
    const limb = this.limbPose;
    const headings = new Map();
    people.forEach(({id, x, z, state, dx, dz}, index) => {
      const moving = Math.hypot(dx, dz) > .015;
      const heading = moving ? Math.atan2(dx, dz) : (this.visitorHeadings.get(id) ?? 0);
      headings.set(id, heading);
      const swing = moving ? Math.sin(now * .014 + id) * .28 : 0;
      person.position.set(x, this.surfaceHeightAt(x,z)-footHeight(swing), z);
      person.rotation.y = heading;
      person.updateMatrix();
      const color = queuedStates.has(state) ? queueColor : walkerColor;
      torsos.setMatrixAt(index, person.matrix);
      torsos.setColorAt(index, color);
      heads.setMatrixAt(index, person.matrix);
      joints.forEach(([side, y, width, length, depth, sign], joint) => {
        limb.position.set(side, y, 0);
        limb.rotation.x = swing * sign;
        limb.scale.set(width, length, depth);
        limb.updateMatrix();
        const slot = index * joints.length + joint;
        limbs.setMatrixAt(slot, this.limbMatrix.multiplyMatrices(person.matrix, limb.matrix));
        limbs.setColorAt(slot, color);
      });
    });
    this.visitorHeadings = headings;
    torsos.count = heads.count = people.length;
    limbs.count = people.length * joints.length;
    for (const batch of this.visitors) {
      batch.instanceMatrix.needsUpdate = true;
      if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
    }
  }

  placeCharacter(id, {position, figure, limbs, element}, x, z, dx, dz, now, aboard = false) {
    position.set(x, 4.7, z);
    figure.visible = !aboard;
    element.toggleAttribute('data-aboard', aboard);
    const moving = Math.hypot(dx, dz) > .02;
    if (moving) figure.rotation.y = Math.atan2(dx, dz);
    const swing = moving ? Math.sin(now * .014) * .28 : 0;
    figure.position.set(x, this.surfaceHeightAt(x,z)-footHeight(swing), z);
    limbs.forEach((limb, index) => { limb.rotation.x = swing * joints[index][5]; });
    if (this.trackedCharacter === id) this.moveCameraTarget(new THREE.Vector3(x, this.controls.target.y, z));
  }

  setCharacters(characters, onSelect, clock) {
    const active = new Set(characters.map(character => character.character_id));
    for (const [id, label] of this.characters) {
      if (active.has(id)) continue;
      label.element.remove();
      this.scene.remove(label.figure);
      this.labels.splice(this.labels.indexOf(label), 1);
      this.characters.delete(id);
    }
    for (const {character_id: id, position: {point}, map_point} of characters) {
      const [x, z] = point ?? map_point;
      if (!this.characters.has(id)) {
        const element = document.createElement(onSelect ? 'button' : 'span');
        element.className = 'map-label character-label';
        element.textContent = onSelect ? 'QR 참여자' : '내 캐릭터';
        if (onSelect) {
          element.type = 'button';
          element.setAttribute('aria-label', `QR 캐릭터 ${id.slice(-6)} 보기`);
          element.onclick = () => onSelect(id, element);
        }
        this.host.querySelector('.labels').append(element);
        const figure = new THREE.Group();
        const marker = new THREE.Mesh(qrRingGeometry, qrRing);
        // 다리 바닥보다 높게 두고, 앞에 있는 캐릭터 모형은 원이 덮지 않도록 한다.
        marker.position.y = .21 / personScale;
        marker.scale.setScalar(1.65 / personScale);
        marker.renderOrder = 14;
        figure.add(marker, new THREE.Mesh(torsoGeometry, qrClothing), new THREE.Mesh(headGeometry, skin));
        const limbs = joints.map(([x, y, width, length, depth]) => {
          const limb = new THREE.Mesh(limbGeometry, qrClothing);
          limb.position.set(x, y, 0);
          limb.scale.set(width, length, depth);
          figure.add(limb);
          return limb;
        });
        figure.scale.setScalar(personScale);
        this.scene.add(figure);
        const label = {element, figure, limbs, position: new THREE.Vector3(x, 4.7, z)};
        this.labels.push(label);
        this.characters.set(id, label);
        this.placeCharacter(id, label, x, z, 0, 0, 0, point === null);
      }
    }
    const timed = characters.some(character => Object.hasOwn(character, 'walk_trail'));
    if (clock && (timed || this.characterTimeline.frames.length)) {
      const key = characters.map(character => `${character.character_id}:${character.revision}`).join(',');
      if (key === this.characterFrameKey) return;
      this.characterFrameKey = key;
      const now = performance.now();
      this.characterTimeline.push(characters.map(character => ({
        visitor_id: character.character_id, point: character.position.point ?? character.map_point,
        state: character.phase, walk_trail: character.walk_trail, aboard: character.position.point === null,
      })), clock, now);
      this.updateVisitors(now);
    } else {
      this.characterTimeline.clear();
      this.characterFrameKey = undefined;
      for (const {character_id: id, position: {point}, map_point} of characters) {
        const [x, z] = point ?? map_point;
        this.placeCharacter(id, this.characters.get(id), x, z, 0, 0, 0, point === null);
      }
    }
  }

  showCharacterRoute(route) {
    if (JSON.stringify(route) === JSON.stringify(this.characterRoute)) return;
    this.characterRoute = route;
    for (const object of [...this.characterRoutes.children]) {
      this.characterRoutes.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    }
    if (!route) return;
    const positions = route.points.map(([x, z]) => new THREE.Vector3(x, .4, z));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(positions),
      new THREE.LineDashedMaterial({color: '#653caa', dashSize: 2.2, gapSize: 1.1, depthTest: false, depthWrite: false}));
    line.computeLineDistances();
    line.renderOrder = 12;
    this.characterRoutes.add(line);
    const target = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.5, 24),
      new THREE.MeshBasicMaterial({color: '#653caa', depthTest: false, depthWrite: false}));
    target.rotation.x = -Math.PI / 2;
    target.position.copy(positions.at(-1));
    target.renderOrder = 13;
    this.characterRoutes.add(target);
  }

  render() {
    if(!this.labels)return;
    this.camera.updateMatrixWorld();this.renderer.render(this.scene,this.camera);
    for(const label of this.labels) {
      const p=label.position.clone().project(this.camera);
      const x=(p.x+1)*this.host.clientWidth/2,y=(1-p.y)*this.host.clientHeight/2;
      label.element.hidden=p.z>1||p.z< -1||x<10||x>this.host.clientWidth-10||y<8||y>this.host.clientHeight-8;
      label.element.style.left=x+'px';label.element.style.top=y+'px';
    }
    this.host.dataset.cameraZoom=this.camera.zoom.toFixed(4);
    this.host.dataset.cameraPosition=this.camera.position.toArray().map(v=>v.toFixed(2)).join(',');
    this.host.dataset.cameraTarget=this.controls.target.toArray().map(v=>v.toFixed(2)).join(',');
    this.host.dataset.rendered='true';
    this.host.dispatchEvent(new CustomEvent('view-change',{detail:{zoom:this.camera.zoom/(this.homeZoom||1)}}));
  }

  // 장면 객체와 설정 좌표의 일치를 검사할 때 사용하는 읽기 전용 상태다.
  inspect() {
    return {
      renderer:'three-webgl',
      visitorModelHeight,
      visibleVisitors: this.visitors?.[0].count ?? 0,
      visitorModels: this.visitors ? {heads: this.visitors[1].count, limbs: this.visitors[2].count} : null,
      characters: Object.fromEntries([...this.characters].map(([id, {position}]) => [id, [position.x, position.z]])),
      signs: Object.fromEntries(this.scenery.children.filter(object => object.name.startsWith('signpost:'))
        .map(({name, position}) => [name.slice('signpost:'.length), [position.x, position.z]])),
      characterRoute: structuredClone(this.characterRoute ?? null),
      publicSpace:this.map.geometry.public_space,
      landscapeBeds:this.map.geometry.landscape_beds,
      landscapeCrowns:{
        pointed:this.scenery.getObjectByName('landscape-pointed-crowns')?.count??0,
        rounded:this.scenery.getObjectByName('landscape-rounded-crowns')?.count??0,
      },
      shorelineRendered:Boolean(this.ground.material.map),
      gardens:structuredClone(this.ground.userData.gardens),
      landscapePlants:this.ground.userData.plants.map(({x,z,kind,radius,height})=>({x,z,kind,radius,height})),
      landscapeShrubs:this.ground.userData.plants.filter(p=>p.kind==='shrub').map(({x,z})=>[x,z]),
      lakeRippleSegments:this.scene.getObjectByName('lake-ripples').geometry.attributes.position.count/2,
      landscapeTrees:(()=>{
        const trees=this.scenery.getObjectByName('landscape-trees'), matrix=new THREE.Matrix4();
        return Array.from({length:trees.count},(_,i)=>{
          trees.getMatrixAt(i,matrix);
          return [matrix.elements[12],matrix.elements[14]];
        });
      })(),
      castleGate:this.scenery.getObjectByName('castle-gate').getWorldPosition(new THREE.Vector3()).toArray(),
      castleBounds:(()=>{const b=new THREE.Box3().setFromObject(this.scenery.getObjectByName('magic-castle'));return {min:b.min.toArray(),max:b.max.toArray()};})(),
      outline:this.map.geometry.island_outline,
      queues:structuredClone(this.queueLayouts),
      plazaOverlayCount:this.scene.children.filter(o=>['plaza-overlay','forecourt-overlay'].includes(o.name)).length,
      surfaceMeshes:this.scene.children.filter(o=>o.name==='public-pavement'||o.name.startsWith('walk:')).map(o=>o.name),
      facilities:Object.fromEntries(Object.entries(this.rideGroups).map(([id,group])=>{
        const bounds=new THREE.Box3().setFromObject(group);
        const exit=this.scene.getObjectByName('exit:'+id).position;
        return [id,{features:group.userData.features,min:bounds.min.toArray(),max:bounds.max.toArray(),
                    exitPoint:[exit.x,exit.z]}];
      })),
      pickPoints:Object.fromEntries(Object.entries(this.rideGroups).map(([id,group])=>{
        const p=new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3()).project(this.camera);
        return [id,[(p.x+1)*this.host.clientWidth/2,(1-p.y)*this.host.clientHeight/2]];
      })),
      walks:this.scene.children.filter(o=>o.name.startsWith('walk:')).map(o=>({...o.userData,center:[o.position.x,o.position.z]})),
      canvasSize:[this.renderer.domElement.width,this.renderer.domElement.height],
      drawCalls:this.renderer.info.render.calls
    };
  }
}
