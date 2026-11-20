import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {box, cylinder, rod, polygon, rectPoints, band, material} from './geometry.mjs';
import {buildRide, buildCastle} from './rides.mjs';
import {createNavigator} from './navigation.mjs';
import {queueLayout} from './queue.mjs';
import {CrowdMovement, VisitorTimeline} from './live-state.mjs';

const walkerColors = ['#26496b', '#245c65', '#36496f'].map(color => new THREE.Color(color));
const queueColor = new THREE.Color('#753e06');
const queuedStates = new Set(['joining_queue', 'advancing_queue', 'queued']);
const personScale = 1.95;
const queuePostHeightScale = 1.85;
const torsoGeometry = new THREE.CylinderGeometry(.23, .18, .83, 8).scale(1, 1, .72).translate(0, 1.285, 0);
// 목과 머리를 한 메시로 그려 배경 방문객의 인스턴스 묶음을 유지한다.
const headGeometry = new THREE.LatheGeometry([
  [.065, 1.66], [.065, 1.78], [.128, 1.82], [.163, 1.90],
  [.169, 1.96], [.142, 2.05], [.072, 2.10], [0, 2.11],
].map(([radius, y]) => new THREE.Vector2(radius, y)), 8);
const limbGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, -.5, 0);
const skin = new THREE.MeshBasicMaterial({color: '#efc39b'});
const clothing = new THREE.MeshBasicMaterial();
const qrClothing = new THREE.MeshBasicMaterial({color: '#653caa'});
const qrRing = new THREE.MeshBasicMaterial({color: '#653caa', depthTest: false, depthWrite: false});
const qrRingGeometry = new THREE.RingGeometry(1.25, 2.5, 24).rotateX(-Math.PI / 2);
const joints = [
  [-.12, .9, .17, .87, .19, 1], [.12, .9, .17, .87, .19, -1],
  [-.25, 1.57, .13, .67, .15, -1], [.25, 1.57, .13, .67, .15, 1],
];

function inside([x,z], outline) {
  let result=false;
  for(let i=0,j=outline.length-1;i<outline.length;j=i++) {
    const [ax,az]=outline[i],[bx,bz]=outline[j];
    if((az>z)!==(bz>z) && x<(bx-ax)*(z-az)/(bz-az)+ax)result=!result;
  }
  return result;
}

function segmentDistance([x,z],a,b) {
  const dx=b[0]-a[0],dz=b[1]-a[1];
  const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));
  return Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz);
}

export class MagicIslandMap {
  constructor(host,map,onSelect) {
    this.host=host;this.map=map;this.onSelect=onSelect;
    this.points=Object.fromEntries(map.geometry.nodes.map(n=>[n.id,n.point]));
    this.navigator=createNavigator(map);this.queueLayouts={};
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#dcebef');
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.12;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label','매직아일랜드 3D 지도. 왼쪽 드래그 회전, 오른쪽 드래그 이동, 휠 확대');
    this.renderer.domElement.setAttribute('role','img');
    host.prepend(this.renderer.domElement);
    this.camera=new THREE.OrthographicCamera(-200,200,200,-200,.1,2200);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=false;
    this.controls.minZoom=.5;this.controls.maxZoom=5;
    this.controls.minPolarAngle=.08;this.controls.maxPolarAngle=Math.PI*.46;
    this.controls.screenSpacePanning=true;
    this.controls.addEventListener('change',()=>this.render());
    this.controls.addEventListener('start',()=>{
      this.isHome=false;
      this.stopFollowing();
      host.dispatchEvent(new Event('map-interaction'));
    });
    this.scene.add(new THREE.HemisphereLight('#f3f7f6','#819279',2.4));
    const sun=new THREE.DirectionalLight('#fff6e4',3);
    sun.position.set(-100,350,180);sun.castShadow=true;
    Object.assign(sun.shadow.camera,{left:-300,right:300,top:300,bottom:-300,near:1,far:800});
    sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.0005;sun.shadow.normalBias=.3;this.scene.add(sun);
    this.labels=[];this.pickables=[];this.rideGroups={};this.routes=[];
    this.scenery=new THREE.Group();this.scenery.name='배경';this.scene.add(this.scenery);
    this.routeGroup=new THREE.Group();this.routeGroup.name='선택 보행 경로';this.scene.add(this.routeGroup);
    this.characterRoutes=new THREE.Group();this.scene.add(this.characterRoutes);
    this.characters=new Map();
    this.characterTimeline=new VisitorTimeline();
    this.visitorTimeline=new VisitorTimeline();
    this.crowd=new CrowdMovement(this.navigator,map.geometry.queue_rules.person_radius_m);
    this.visitorHeadings=new Map();
    this.visitorPose=new THREE.Object3D();
    this.visitorPose.scale.setScalar(personScale);
    this.limbPose=new THREE.Object3D();
    this.limbMatrix=new THREE.Matrix4();
    this.build();
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

  label(name,position,facility=null) {
    const interactive=facility && this.onSelect;
    const element=document.createElement(interactive?'button':'span');
    element.className='map-label'+(facility?' facility-label':' landmark-label');
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

  build() {
    const g=this.map.geometry;
    polygon(this.scene,g.island_outline,'#b7aa8f',2.8,-2.8);
    polygon(this.scene,g.island_outline,'#d9c9aa',.08,0).name='public-pavement';
    const lake=polygon(this.scene,rectPoints([-3000,-3000,6000,6000]),'#97c7d4',.3,-3.8,[g.island_outline]);
    lake.material.roughness=.36;lake.material.metalness=.12;
    lake.name='석촌호수';lake.castShadow=false;
    // 낮은 호안은 통로 외곽의 지형 경계다.
    for(let i=0;i<g.island_outline.length;i++) {
      const a=g.island_outline[i],b=g.island_outline[(i+1)%g.island_outline.length];
      band(this.scene,a,b,1,'#d9d1b5',.03,.3);
    }
    for(const e of g.edges) {
      const a=this.points[e.source],b=this.points[e.target];
      const bridge=e.kind==='bridge';
      if(!bridge)continue; // 연결 그래프를 좁은 길 바닥으로 칠하지 않는다.
      const surface=band(this.scene,a,b,e.width,'#c7ab83',.18,.28);
      surface.name='walk:'+e.id;
      surface.userData={edgeId:e.id,width:e.width,source:e.source,target:e.target};
      if(bridge) {
        const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz),nx=-dz/length,nz=dx/length;
        for(const side of [-1,1]) {
          const offset=e.width/2+.4;
          const aa=[a[0]+nx*offset*side,1.5,a[1]+nz*offset*side];
          const bb=[b[0]+nx*offset*side,1.5,b[1]+nz*offset*side];
          rod(this.scene,aa,bb,.18,'#9b8365');
          for(let t=.1;t<1;t+=.12)rod(this.scene,[aa[0]+dx*t,.2,aa[2]+dz*t],[aa[0]+dx*t,1.5,aa[2]+dz*t],.14,'#a18c6d');
        }
      }
    }
    const castle=buildCastle(this.scenery,g.castle,g.castle_height_m,g.castle_forward,g.castle_model_scale_xz);
    castle.userData.obstacle='castle';
    this.label('매직캐슬',[180,51,152]);
    for(const f of this.map.facilities) {
      this.buildQueue(f);
      const group=buildRide(this.scene,f);this.rideGroups[f.id]=group;
      group.traverse(object=>{if(object.isMesh)this.pickables.push(object);});
      const [cx,cz]=f.label_anchor;
      this.label(f.name,[cx,f.model_height_m+8,cz],f.id);
      for(const [key,color] of [['entrance','#287e63'],['exit','#b65f48']]) {
        const [px,pz]=this.points[f[key]];
        cylinder(this.scene,px,.14,pz,1.3,.02,color,1.3,12).name=key+':'+f.id;
      }
    }
    const bridgeStart=this.points['bridge-island'],bridgeEnd=this.points[g.boundary];
    this.label('양방향 진입 다리',[(bridgeStart[0]+bridgeEnd[0])/2,2,(bridgeStart[1]+bridgeEnd[1])/2]);
    this.landscape();
  }

  buildQueue(facility) {
    const layout=queueLayout(facility.queue,this.points[facility.entrance],this.map.geometry.queue_rules,
      facility.boarding_capacity,facility.bounds,facility.queue_capacity);
    this.queueLayouts[facility.id]=layout;
    const group=new THREE.Group();group.name='queue:'+facility.id;this.scene.add(group);
    const rails=new THREE.Group();rails.scale.y=queuePostHeightScale;group.add(rails);
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
      [new THREE.CylinderGeometry(.19,.22,.06,12),material('#343d43',{metalness:.65,roughness:.3}),.11],
      [new THREE.CylinderGeometry(.045,.045,.95,8),material('#9ba9af',{metalness:.75,roughness:.25}),.08+.95/2],
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
    const obstacles=[g.castle,g.plaza,...this.map.facilities.flatMap(f=>[f.bounds,f.queue,f.exit_area])];
    // 길목의 지정 식재와 기존 녹지의 재현 가능한 분산 식재를 함께 그린다.
    let seed=20261111;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const placedTrees=(g.landscape_trees??[]).map(([x,z],i)=>({
      x,z,height:18+(i%4)*1.2,color:i%2?'#8aa77b':'#79987b'
    }));
    const trees=[...placedTrees];
    for(const bed of g.landscape_beds)polygon(this.scene,rectPoints(bed),'#779963',.12,.08);
    for(const [bx,bz,bw,bd] of g.landscape_beds)for(let x=bx+3;x<bx+bw-2.6;x+=7)for(let z=bz+3;z<bz+bd-2.6;z+=7) {
      const px=x+(random()-.5)*.6,pz=z+(random()-.5)*.6;
      if(placedTrees.some(tree=>Math.hypot(tree.x-px,tree.z-pz)<7))continue;
      if(!inside([px,pz],g.island_outline))continue;
      if(obstacles.some(([a,b,w,d])=>px>a-6&&px<a+w+6&&pz>b-6&&pz<b+d+6))continue;
      if(g.edges.some(e=>segmentDistance([px,pz],this.points[e.source],this.points[e.target])<e.width/2+5))continue;
      if(g.island_outline.some((a,i)=>segmentDistance([px,pz],a,g.island_outline[(i+1)%g.island_outline.length])<4))continue;
      // 약 4.1 높이의 방문객과 중형 가로수의 실제 높이 비율을 유지한다.
      const height=18+random()*6;
      trees.push({x:px,z:pz,height,color:random()>.5?'#79987b':'#8aa77b'});
    }
    const trunks=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),material('#8c8160'),trees.length);
    trunks.name='landscape-trees';
    const crowns=new THREE.InstancedMesh(new THREE.CylinderGeometry(.25/2.6,1,1,8),material('#ffffff'),trees.length);
    const dummy=new THREE.Object3D();
    trees.forEach((tree,i)=>{
      dummy.position.set(tree.x,tree.height*.27,tree.z);dummy.scale.set(.45,tree.height*.54,.45);dummy.updateMatrix();trunks.setMatrixAt(i,dummy.matrix);
      dummy.position.y=tree.height*.67;dummy.scale.set(2.6,tree.height*.7,2.6);dummy.updateMatrix();crowns.setMatrixAt(i,dummy.matrix);crowns.setColorAt(i,new THREE.Color(tree.color));
    });
    trunks.castShadow=true;crowns.castShadow=true;crowns.receiveShadow=true;this.scenery.add(trunks,crowns);
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
    this.hideRoutes();
  }

  hideRoutes() {
    while(this.routeGroup.children.length) {
      const object=this.routeGroup.children[0];this.routeGroup.remove(object);
      object.geometry?.dispose();object.material?.dispose();
    }
    this.routes=[];
    this.render();
  }

  showRoutes(id) {
    const f=this.map.facilities.find(f=>f.id===id);
    this.routes=[this.navigator.route(this.map.geometry.boundary,f.entrance),this.navigator.route(f.exit,this.map.geometry.boundary)];
    this.routes.forEach((route,index)=>{
      const positions=route.points.map(([x,z])=>new THREE.Vector3(x,.3,z));
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(positions),index?
        new THREE.LineDashedMaterial({color:'#b45036',dashSize:3,gapSize:1.5,depthTest:false}):
        new THREE.LineBasicMaterial({color:'#147755',depthTest:false}));
      if(index)line.computeLineDistances();line.renderOrder=10;this.routeGroup.add(line);
    });
    const stops=[
      [this.points[f.entrance],'#287e63'],
      [this.queueLayouts[id].boarding_exit,'#bc8a35'],
      [this.points[f.exit],'#b65f48'],
    ];
    for(const [[x,z],color] of stops) {
      const ring=new THREE.Mesh(new THREE.RingGeometry(1.65,2.25,24),
        new THREE.MeshBasicMaterial({color,depthTest:false,depthWrite:false}));
      ring.rotation.x=-Math.PI/2;
      ring.position.set(x,.35,z);
      ring.renderOrder=11;
      this.routeGroup.add(ring);
    }
    this.render();
    return this.routes;
  }

  resize() {
    const width=this.host.clientWidth,height=this.host.clientHeight;
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
    this.focusArea(new THREE.Vector3(x, 5, z), this.homeZoom * 3);
  }

  stopFollowing() {
    this.trackedCharacter = null;
  }

  followCharacter(id) {
    this.trackedCharacter = id;
    const position = this.characters.get(id)?.position;
    if (position) this.focusPoint([position.x, position.z]);
  }

  focusRoute(points) {
    this.stopFollowing();
    const bounds = new THREE.Box3().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    this.focusArea(bounds.getCenter(new THREE.Vector3()), 1, points);
  }

  focusArea(target, zoom, points) {
    this.isHome=false;
    this.moveCameraTarget(target);
    this.camera.zoom=zoom;
    this.camera.updateProjectionMatrix();
    if (points) {
      this.camera.updateMatrixWorld();
      const extent = Math.max(...points.map(([x, z]) => {
        const point = new THREE.Vector3(x, 0, z).project(this.camera);
        return Math.max(Math.abs(point.x), Math.abs(point.y));
      }));
      this.camera.zoom = THREE.MathUtils.clamp(.75 / extent, this.controls.minZoom, this.controls.maxZoom);
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.render();
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
    if (this.visitorFrame === undefined && (pending || qr.pending)) {
      const animate = timestamp => {
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
      person.position.set(x, .16, z);
      person.rotation.y = heading;
      person.updateMatrix();
      const color = queuedStates.has(state) ? queueColor : walkerColors[id % walkerColors.length];
      torsos.setMatrixAt(index, person.matrix);
      torsos.setColorAt(index, color);
      heads.setMatrixAt(index, person.matrix);
      const swing = moving ? Math.sin(now * .014 + id) * .28 : 0;
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
    figure.position.set(x, .15, z);
    const moving = Math.hypot(dx, dz) > .02;
    if (moving) figure.rotation.y = Math.atan2(dx, dz);
    const swing = moving ? Math.sin(now * .014) * .28 : 0;
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
        marker.position.y = .16 / personScale;
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
      visibleVisitors: this.visitors?.[0].count ?? 0,
      visitorModels: this.visitors ? {heads: this.visitors[1].count, limbs: this.visitors[2].count} : null,
      characters: Object.fromEntries([...this.characters].map(([id, {position}]) => [id, [position.x, position.z]])),
      characterRoute: structuredClone(this.characterRoute ?? null),
      publicSpace:this.map.geometry.public_space,
      landscapeBeds:this.map.geometry.landscape_beds,
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
      routes:this.routes.map(r=>({nodes:[...r.nodes],points:r.points.map(p=>[...p]),mode:r.mode,distance_m:r.distance_m})),
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
      walks:this.scene.children.filter(o=>o.name.startsWith('walk:')).map(o=>({edgeId:o.userData.edgeId,width:o.userData.width,center:[o.position.x,o.position.z]})),
      canvasSize:[this.renderer.domElement.width,this.renderer.domElement.height],
      drawCalls:this.renderer.info.render.calls
    };
  }
}
