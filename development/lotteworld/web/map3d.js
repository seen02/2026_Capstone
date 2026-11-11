import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {box, cylinder, rod, polygon, rectPoints, band, material} from './geometry.mjs';
import {buildRide, buildCastle} from './rides.mjs';
import {walkingRoute} from './route.mjs';

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
    this.controls.addEventListener('start',()=>{this.isHome=false;});
    this.scene.add(new THREE.HemisphereLight('#f3f7f6','#819279',2.4));
    const sun=new THREE.DirectionalLight('#fff6e4',3);
    sun.position.set(-100,350,180);sun.castShadow=true;
    Object.assign(sun.shadow.camera,{left:-300,right:300,top:300,bottom:-300,near:1,far:800});
    sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.0005;sun.shadow.normalBias=.3;this.scene.add(sun);
    this.labels=[];this.pickables=[];this.rideGroups={};this.cutaway=false;this.routes=[];
    this.scenery=new THREE.Group();this.scenery.name='가림 조절 배경';this.scene.add(this.scenery);
    this.routeGroup=new THREE.Group();this.routeGroup.name='선택 보행 경로';this.scene.add(this.routeGroup);
    this.build();
    this.ray=new THREE.Raycaster();let down=null;
    this.renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
    this.renderer.domElement.addEventListener('pointerup',e=>{
      if(!down || Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
      const bounds=this.host.getBoundingClientRect();
      this.ray.setFromCamera(new THREE.Vector2((e.clientX-bounds.left)/bounds.width*2-1,1-(e.clientY-bounds.top)/bounds.height*2),this.camera);
      const hits=this.ray.intersectObjects(this.pickables,false);
      if(hits.length)this.onSelect(hits[0].object.userData.facilityId);
    });
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);
    this.resize();this.home();
    this.renderer.domElement.addEventListener('webglcontextlost',e=>{
      e.preventDefault();this.host.dispatchEvent(new CustomEvent('map-error',{detail:'3D 그래픽 연결이 끊겼습니다. 페이지를 새로고침하세요.'}));
    });
  }

  label(name,position,facility=null,extra='') {
    const element=document.createElement(facility?'button':'span');
    element.className='map-label'+(facility?' facility-label':' landmark-label');
    element.textContent=name;
    if(extra){const small=document.createElement('small');small.textContent=extra;element.append(small);}
    if(facility){element.dataset.facility=facility;element.setAttribute('aria-label',name+' 동선 보기');element.onclick=()=>this.onSelect(facility);}
    this.host.querySelector('.labels').append(element);
    this.labels.push({element,position:new THREE.Vector3(...position)});
  }

  build() {
    const g=this.map.geometry;
    polygon(this.scene,g.island_outline,'#b7aa8f',2.8,-2.8);
    polygon(this.scene,g.island_outline,'#d9c9aa',.08,0);
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
      const surface=band(this.scene,a,b,e.width,bridge?'#c7ab83':'#e1d1b2',.18,.28);
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
    polygon(this.scene,rectPoints(g.plaza),'#f0e2c4',.3,0);
    const castle=buildCastle(this.scenery,g.castle,g.castle_height_m,g.castle_forward,g.castle_model_scale_xz);
    castle.userData.obstacle='castle';
    const gate=castle.getObjectByName('castle-gate').getWorldPosition(new THREE.Vector3());
    band(this.scene,[gate.x,gate.z],this.points['bridge-island'],g.forecourt_width_m,'#e1d1b2',.12,.08);
    this.label('매직캐슬',[180,51,152]);
    for(const f of this.map.facilities) {
      polygon(this.scene,rectPoints(f.queue),'#dec99e',.2,0);
      const [x,z,w,d]=f.queue;
      // 외곽만 표현한다. 실제 접힌 줄·자리·대기 정원은 후속 단계다.
      for(const [a,b] of [[[x,z],[x+w,z]],[[x,z+d],[x+w,z+d]]])rod(this.scene,[a[0],.8,a[1]],[b[0],.8,b[1]],.12,'#a68e60');
      polygon(this.scene,rectPoints(f.exit_area),'#dfc6b3',.22,0);
      const group=buildRide(this.scene,f);this.rideGroups[f.id]=group;
      group.traverse(object=>{if(object.isMesh)this.pickables.push(object);});
      const [cx,cz]=f.label_anchor;
      this.label(f.name,[cx,f.model_height_m+8,cz],f.id);
      for(const [key,color] of [['entrance','#287e63'],['exit','#b65f48']]) {
        const [px,pz]=this.points[f[key]];
        cylinder(this.scene,px,.6,pz,1.3,.6,color,1.3,12);
      }
    }
    const bridgeStart=this.points['bridge-island'],bridgeEnd=this.points[g.boundary];
    this.label('양방향 진입 다리',[(bridgeStart[0]+bridgeEnd[0])/2,2,(bridgeStart[1]+bridgeEnd[1])/2]);
    this.landscape();
  }

  landscape() {
    const g=this.map.geometry;
    const obstacles=[g.castle,g.plaza,...this.map.facilities.flatMap(f=>[f.bounds,f.queue,f.exit_area])];
    // 재현 가능한 위치에만 식재하고, 반경 3m를 보행로·시설에서 비운다.
    let seed=20261111;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const trees=[];
    for(const bed of g.landscape_beds)polygon(this.scene,rectPoints(bed),'#aabb93',.12,.08);
    for(const [bx,bz,bw,bd] of g.landscape_beds)for(let x=bx+3;x<bx+bw-2.6;x+=7)for(let z=bz+3;z<bz+bd-2.6;z+=7) {
      const px=x+(random()-.5)*.6,pz=z+(random()-.5)*.6;
      if(!inside([px,pz],g.island_outline))continue;
      if(obstacles.some(([a,b,w,d])=>px>a-6&&px<a+w+6&&pz>b-6&&pz<b+d+6))continue;
      if(g.edges.some(e=>segmentDistance([px,pz],this.points[e.source],this.points[e.target])<e.width/2+5))continue;
      if(g.island_outline.some((a,i)=>segmentDistance([px,pz],a,g.island_outline[(i+1)%g.island_outline.length])<4))continue;
      const height=5+random()*4;
      trees.push({x:px,z:pz,height,color:random()>.5?'#79987b':'#8aa77b'});
    }
    const trunks=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),material('#8c8160'),trees.length);
    const crowns=new THREE.InstancedMesh(new THREE.CylinderGeometry(.25/2.6,1,1,8),material('#ffffff'),trees.length);
    const dummy=new THREE.Object3D();
    trees.forEach((tree,i)=>{
      dummy.position.set(tree.x,tree.height*.27,tree.z);dummy.scale.set(.45,tree.height*.54,.45);dummy.updateMatrix();trunks.setMatrixAt(i,dummy.matrix);
      dummy.position.y=tree.height*.67;dummy.scale.set(2.6,tree.height*.7,2.6);dummy.updateMatrix();crowns.setMatrixAt(i,dummy.matrix);crowns.setColorAt(i,new THREE.Color(tree.color));
    });
    trunks.castShadow=true;crowns.castShadow=true;crowns.receiveShadow=true;this.scenery.add(trunks,crowns);
    // 안내도에서 성 뒤쪽의 지붕 군집을 참고한 배경 건물. 추가 대상 시설이 아니다.
    for(const [x,z,w,d] of g.scenery_buildings) {
      box(this.scenery,x+w/2,3,z+d/2,w,6,d,'#d5c7b0');
      box(this.scenery,x+w/2,7,z+d/2,w,2,d,'#597387');
    }
  }

  select(id) {
    while(this.routeGroup.children.length) {
      const object=this.routeGroup.children[0];this.routeGroup.remove(object);
      object.geometry?.dispose();object.material?.dispose();
    }
    const f=this.map.facilities.find(f=>f.id===id);
    this.routes=[walkingRoute(this.map,this.map.geometry.boundary,f.entrance),walkingRoute(this.map,f.exit,this.map.geometry.boundary)];
    this.routes.forEach((route,index)=>{
      const positions=route.nodes.map(key=>new THREE.Vector3(this.points[key][0],.8,this.points[key][1]));
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(positions),index?
        new THREE.LineDashedMaterial({color:'#b45036',dashSize:3,gapSize:1.5,depthTest:false}):
        new THREE.LineBasicMaterial({color:'#147755',depthTest:false}));
      if(index)line.computeLineDistances();line.renderOrder=10;this.routeGroup.add(line);
    });
    for(const label of this.labels)if(label.element.dataset.facility)label.element.setAttribute('aria-pressed',String(label.element.dataset.facility===id));
    this.render();return this.routes;
  }

  setCutaway(value) {
    this.cutaway=value;
    this.scenery.traverse(object=>{
      if(!object.isMesh)return;
      object.material.transparent=value;object.material.opacity=value?.14:1;
      object.material.depthWrite=!value;object.castShadow=!value;
    });
    this.render();
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
    this.isHome=false;
    const facility=this.map.facilities.find(f=>f.id===id);
    const target=new THREE.Vector3(facility.label_anchor[0],5,facility.label_anchor[1]);
    const delta=target.clone().sub(this.controls.target);
    this.camera.position.add(delta);this.controls.target.copy(target);
    this.camera.zoom=this.homeZoom*3;
    this.camera.updateProjectionMatrix();this.controls.update();this.render();
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
      renderer:'three-webgl',cutaway:this.cutaway,
      publicSpace:this.map.geometry.public_space,
      landscapeBeds:this.map.geometry.landscape_beds,
      castleOpacity:this.scenery.getObjectByName('magic-castle').children[0].material.opacity,
      castleGate:this.scenery.getObjectByName('castle-gate').getWorldPosition(new THREE.Vector3()).toArray(),
      castleBounds:(()=>{const b=new THREE.Box3().setFromObject(this.scenery.getObjectByName('magic-castle'));return {min:b.min.toArray(),max:b.max.toArray()};})(),
      outline:this.map.geometry.island_outline,
      routes:this.routes.map(r=>({nodes:[...r.nodes],distance_m:r.distance_m})),
      facilities:Object.fromEntries(Object.entries(this.rideGroups).map(([id,group])=>{
        const bounds=new THREE.Box3().setFromObject(group);
        return [id,{features:group.userData.features,min:bounds.min.toArray(),max:bounds.max.toArray()}];
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
