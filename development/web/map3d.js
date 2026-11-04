import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {visitorPosition} from './spatial.mjs?v=queue-2';
import {floorTiles,FLOOR_Y,personDimensions} from './geometry.mjs';

function textLabel(text,color='#dcefeb',size=2){
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  ctx.font='600 28px "Malgun Gothic",sans-serif';
  canvas.width=Math.ceil(ctx.measureText(text).width)+28;canvas.height=48;
  ctx.fillStyle='#0b2435e8';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.font='600 28px "Malgun Gothic",sans-serif';ctx.fillStyle=color;ctx.fillText(text,14,33);
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(canvas),depthTest:false}));
  sprite.scale.set(canvas.width/canvas.height*size,size,1);sprite.renderOrder=4;return sprite;
}
export class AquariumMap{
  constructor(host,map,personas,onSelect){
    if(map.geometry_status.status!=='synthetic_design'||map.geometry_status.length_unit!=='m')throw Error('미터 단위 가상 설계 지도가 필요합니다.');
    this.host=host;this.map=map;this.nodes=Object.fromEntries(map.nodes.map(n=>[n.id,n]));
    this.rooms=Object.fromEntries(map.geometry.rooms.map(r=>[r.id,r]));this.pickables=[];this.wallMeshes=[];this.roomMeshes={};this.signLabels=[];
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#e9eeee');
    this.renderer=new THREE.WebGLRenderer({antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.append(this.renderer.domElement);
    this.camera=new THREE.OrthographicCamera(-55,55,45,-45,.1,500);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;
    this.controls.minZoom=.6;this.controls.maxZoom=8;this.controls.maxPolarAngle=Math.PI*.48;
    this.scene.add(new THREE.HemisphereLight(0xe5f9ff,0x25343c,2.7));
    const light=new THREE.DirectionalLight(0xffffff,2.3);light.position.set(20,70,60);this.scene.add(light);
    this.build();
    // 반지름 .23m + 원통부 1.24m = 전체 높이 1.70m. 사람만 확대하지 않는다.
    this.personSize=personDimensions(map.geometry);
    this.people=new THREE.InstancedMesh(new THREE.CapsuleGeometry(this.personSize.radius,this.personSize.cylinderLength,4,6),new THREE.MeshStandardMaterial({roughness:.8}),20000);
    this.people.count=0;this.people.frustumCulled=false;this.people.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.scene.add(this.people);
    this.personaColors=personas.map(p=>new THREE.Color(p.color));this.dummy=new THREE.Object3D();this.ray=new THREE.Raycaster();
    let down;this.renderer.domElement.addEventListener('pointerdown',e=>down=[e.clientX,e.clientY]);
    this.renderer.domElement.addEventListener('pointerup',e=>{
      if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
      const r=host.getBoundingClientRect();this.ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),this.camera);
      const hit=this.ray.intersectObjects(this.pickables,false)[0];if(hit)onSelect(hit.object.userData.node);
    });
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);this.home();this.resize();
    this.renderer.setAnimationLoop(()=>{this.controls.update();this.renderer.render(this.scene,this.camera);});
  }
  box(x,y,z,w,h,d,color,opacity=1){
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,transparent:opacity<1,opacity,roughness:.65}));
    mesh.position.set(x,y,z);this.scene.add(mesh);return mesh;
  }
  label(text,x,y,z,color,size=2){const s=textLabel(text,color,size);s.position.set(x,y,z);this.scene.add(s);return s;}
  band(a,b,width,color,y=.04){
    const length=Math.hypot(b.x-a.x,b.z-a.z),m=this.box((a.x+b.x)/2,y,(a.z+b.z)/2,length,.05,width,color);
    m.rotation.y=-Math.atan2(b.z-a.z,b.x-a.x);return m;
  }
  arrow(a,b,color,size=2.2){
    const delta=new THREE.Vector3(b.x-a.x,0,b.z-a.z),length=delta.length();
    if(length<2)return;
    const start=new THREE.Vector3(a.x,.23,a.z).lerp(new THREE.Vector3(b.x,.23,b.z),.4);
    this.scene.add(new THREE.ArrowHelper(delta.normalize(),start,Math.min(length*.45,size),color,.6,.5));
  }
  polygon(points,color,height=.08,y=0,opacity=1){
    const shape=new THREE.Shape();points.forEach(([x,z],i)=>i?shape.lineTo(x,-z):shape.moveTo(x,-z));shape.closePath();
    const geometry=new THREE.ExtrudeGeometry(shape,{depth:height,bevelEnabled:false});geometry.rotateX(-Math.PI/2);
    const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color,roughness:.55,transparent:opacity<1,opacity}));
    mesh.position.y=y;this.scene.add(mesh);return mesh;
  }
  route(a,b,color){
    const geometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x,.2,a.z),new THREE.Vector3(b.x,.2,b.z)]);
    const line=new THREE.Line(geometry,new THREE.LineDashedMaterial({color,dashSize:.9,gapSize:.65,transparent:true,opacity:.6}));
    line.computeLineDistances();this.scene.add(line);
  }
  feature(feature,room){
    const [x,z,w,d]=feature.bounds,height=feature.height??(feature.kind==='stage'?.65:2.6);
    const polygon=feature.polygon??[[x,z],[x+w,z],[x+w,z+d],[x,z+d]];
    if(feature.kind==='stage'){
      this.polygon(polygon,'#aa8258',height,.1);
      this.label('해양 공연 공간',x+w/2,height+1.3,z+d/2,'#ffe3b2',1.35);
      return;
    }
    if(feature.style==='jelly'){
      const alongX=w>d,length=Math.max(w,d),breadth=Math.min(w,d);
      const count=Math.max(1,Math.floor(length/3.2)),radius=Math.min(1.2,breadth*.42);
      for(let i=0;i<count;i++){
        const cx=alongX?x+w*(i+.5)/count:x+w/2,cz=alongX?z+d/2:z+d*(i+.5)/count;
        const tank=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,height,32),new THREE.MeshStandardMaterial({color:'#9274bf',roughness:.25,transparent:true,opacity:.85}));
        tank.position.set(cx,height/2+.12,cz);this.scene.add(tank);
        for(let j=0;j<3;j++){
          const jelly=new THREE.Mesh(new THREE.SphereGeometry(radius*.2,10,8),new THREE.MeshBasicMaterial({color:'#e6d9ff'}));
          jelly.position.set(cx+(j-1)*radius*.4,.45+j*height*.26,cz);this.scene.add(jelly);
        }
      }
      return;
    }
    const palettes={reef:['#227d99','#4abbd0'],coast:['#318f91','#6acdc3'],wall:['#245470','#519cc3'],fresh:['#327b71','#7ab7a2']};
    const [side,water]=palettes[feature.style]??palettes.wall;
    this.polygon(polygon,'#304f59',.22,.02);
    this.polygon(polygon,side,height,.24,.92);
    this.polygon(polygon,water,.05,height+.25,.95);
    const outline=new THREE.BufferGeometry().setFromPoints([...polygon,polygon[0]].map(([px,pz])=>new THREE.Vector3(px,height+.32,pz)));
    this.scene.add(new THREE.Line(outline,new THREE.LineBasicMaterial({color:'#a2d5d5'})));
    for(let i=0;i<Math.min(8,Math.ceil(w*d/12));i++){
      const fish=new THREE.Mesh(new THREE.SphereGeometry(.18,8,6),new THREE.MeshStandardMaterial({color:feature.style==='reef'?'#efcc8d':'#c8eee9'}));
      const [fx,fz,fw,fd]=(feature.collision_bounds??[feature.bounds])[i%(feature.collision_bounds?.length??1)];
      fish.scale.set(1.8,.7,.55);fish.position.set(fx+fw*(.22+.56*((i*.37)%1)),height*.65,fz+fd*(.3+.4*((i*.61)%1)));this.scene.add(fish);
    }
    if(feature.style==='reef')this.label('메인 산호 수조',x+w/2,height+1.8,z+d/2,'#d2f3fa',1.6);
  }
  build(){
    const geometry=this.map.geometry;
    // 어두운 면은 비관람 공간이다. 밝은 면만 실제 연결된 관람길을 나타낸다.
    this.polygon(geometry.footprint,'#20343e',.3,-.3);
    const positions=[],colors=[];
    for(const area of floorTiles(geometry.building_floor_areas??geometry.walkable_areas??[])){
      const [x,z,w,d]=area.bounds;
      const color=new THREE.Color(area.kind==='tank_floor'?'#9cacae':area.kind==='show'?'#d3cab8':area.kind==='lobby'?'#dce3de':'#c4d2d2');
      // 같은 높이의 면이 겹치지 않도록 위를 향하는 삼각형을 한 메시로 묶는다.
      for(const [px,pz] of [[x,z],[x,z+d],[x+w,z],[x+w,z],[x,z+d],[x+w,z+d]]){
        positions.push(px,FLOOR_Y,pz);colors.push(color.r,color.g,color.b);
      }
    }
    const floorGeometry=new THREE.BufferGeometry();
    floorGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    floorGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));floorGeometry.computeVertexNormals();
    this.scene.add(new THREE.Mesh(floorGeometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.8})));
    for(const r of geometry.rooms){
      // 구역 전체에 색을 칠하지 않는다. 투명 면은 클릭 판정용이다.
      const pick=this.polygon(r.polygon,r.color,.015,.11,0);
      pick.material.depthWrite=false;pick.userData.node=r.id;
      this.pickables.push(pick);this.roomMeshes[r.id]=pick;
      for(const feature of r.features??[r.feature])if(feature)this.feature(feature,r);
      const v=r.view_area,p=r.label_position??[v[0]+v[2]/2,v[1]+v[3]/2];
      const name=this.label(r.name,p[0],3.6,p[1],r.color,2.15);name.userData.node=r.id;this.pickables.push(name);
      if(r.id==='F'){
        for(const [a,b] of r.queue_rows??[])this.band({x:a[0],z:a[1]},{x:b[0],z:b[1]},.035,'#baa981',FLOOR_Y+.02);
        const q=r.queue_area;
        this.label('공연 대기',q[0]+q[2]/2,2.2,q[1]+q[3]/2,'#ffe6b6',1.3);
      }
    }
    let promenadeIndex=0;
    for(const e of this.map.edges){
      const a=this.nodes[e.a],b=this.nodes[e.b];
      if(e.kind==='promenade'&&promenadeIndex++%2===0)this.arrow(a,b,0x607985,1.9);
      if(e.kind==='shortcut')this.arrow(a,b,0x268d78,2.1);
      if(['admission','exit_path'].includes(e.kind))this.arrow(a,b,e.kind==='exit_path'?0xb77c3f:0x358e7a,1.5);
    }
    for(const wall of geometry.walls){
      const [a,b]=[wall.a,wall.b],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const isRail=wall.kind==='queue_rail';
      if(isRail){
        const count=Math.ceil(length/2.5);
        for(let i=0;i<=count;i++){
          const x=a[0]+(b[0]-a[0])*i/count,z=a[1]+(b[1]-a[1])*i/count;
          const base=new THREE.Mesh(new THREE.CylinderGeometry(.19,.22,.06,20),new THREE.MeshStandardMaterial({color:'#343d43',metalness:.65,roughness:.3}));
          base.position.set(x,FLOOR_Y+.03,z);this.scene.add(base);
          const post=new THREE.Mesh(new THREE.CylinderGeometry(.045,.045,wall.height,12),new THREE.MeshStandardMaterial({color:'#9ba9af',metalness:.75,roughness:.25}));
          post.position.set(x,FLOOR_Y+wall.height/2,z);this.scene.add(post);
          this.box(x,FLOOR_Y+wall.height,z,.13,.11,.13,'#28373e');
        }
        const belt=this.box((a[0]+b[0])/2,FLOOR_Y+wall.height-.08,(a[1]+b[1])/2,length,.075,.025,'#254b67');
        belt.rotation.y=-Math.atan2(b[1]-a[1],b[0]-a[0]);
        continue;
      }
      // 전면을 가리는 벽은 절개 표시한다. 충돌 판정은 원본 geometry를 사용한다.
      const displayHeight=isRail?wall.height:Math.min(wall.height,Math.max(a[1],b[1])>35?1.15:1.8);
      const color=isRail?'#b49a6a':wall.kind==='show_wall'?'#52594f':'#425764';
      const mesh=this.box((a[0]+b[0])/2,displayHeight/2+.1,(a[1]+b[1])/2,length,displayHeight,wall.thickness,color);
      mesh.rotation.y=-Math.atan2(b[1]-a[1],b[0]-a[0]);this.wallMeshes.push(mesh);
      const cap=this.box((a[0]+b[0])/2,displayHeight+.12,(a[1]+b[1])/2,length,.055,wall.thickness+.12,isRail?'#c9b68c':'#354a56');
      cap.rotation.y=mesh.rotation.y;
    }
    for(const door of geometry.doors??[]){
      const color=door.role==='exit'?'#c9965b':'#58aa94';
      this.box(door.x,.16,door.z,door.axis==='x'?door.width:.25,.045,door.axis==='z'?door.width:.25,color);
      this.label(door.role==='exit'?'출구':'입구',door.x,1.8,door.z+2,'#ecf1e8',1.15);
    }
    for(const s of this.map.signs){
      const n=this.nodes[s.node],x=s.x??n.x,z=s.z??n.z;
      this.box(x,1.1,z,.12,2.2,.12,'#6c838e');
      this.box(x,2.3,z,1.5,.65,.15,'#1d5263');this.label(s.id,x,3.3,z,'#a3eed7',1.1);
    }
    for(const item of geometry.labels??[])this.label(item.text,item.x,item.y??1.6,item.z,item.color??'#d8e8ec',item.size??1.35);
    for(const id of ['entry','exit']){
      const n=this.nodes[id];
      if(n)this.label(id==='entry'?'입구':'출구',n.x,2,n.z,id==='entry'?'#9ce5c9':'#ffcd91',1.45);
    }
    const [bx,bz,bw,bd]=geometry.bounds;
    const scaleX=bx+bw-15,scaleZ=bz+bd+1;
    const scale=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(scaleX,.1,scaleZ),new THREE.Vector3(scaleX+10,.1,scaleZ)]),new THREE.LineBasicMaterial({color:0xbcd1db}));this.scene.add(scale);
    this.label('10m',scaleX+5,.1,scaleZ+1.5,'#cde3e7',1.1);
  }
  home(){
    const [x,z,w,d]=this.map.geometry.bounds,cx=x+w/2,cz=z+d/2;
    this.camera.position.set(cx,85,cz+65);this.controls.target.set(cx,0,cz);this.camera.zoom=1;this.camera.updateProjectionMatrix();this.controls.update();
  }
  resize(){
    const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;
    const bounds=this.map.geometry.bounds,half=Math.max(bounds[3]/2+5,(bounds[2]/2+5)*h/w);
    this.camera.left=-half*w/h;this.camera.right=half*w/h;this.camera.top=half;this.camera.bottom=-half;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);
  }
  select(id){for(const [key,m] of Object.entries(this.roomMeshes))m.material.opacity=key===id?.12:0;}
  update(state){
    this.people.count=state.visitors.length;
    state.visitors.forEach((v,i)=>{const [x,z]=v.display_position??visitorPosition(v,this.nodes,this.rooms);this.dummy.position.set(x,this.personSize.centerY,z);this.dummy.updateMatrix();this.people.setMatrixAt(i,this.dummy.matrix);this.people.setColorAt(i,this.personaColors[v.persona]);});
    this.people.instanceMatrix.needsUpdate=true;if(this.people.instanceColor)this.people.instanceColor.needsUpdate=true;
  }
}
