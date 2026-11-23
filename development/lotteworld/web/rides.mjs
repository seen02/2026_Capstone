/** 안내도의 시설별 특징을 추상화한 정적 입체 모형. 운행 상태를 재현하지 않는다. */
import * as THREE from 'three';
import {box, cylinder, polygon, rod, tube} from './geometry.mjs';

const rideFloors={
  'water-coaster':{height:.6,color:'#a9d7dd'},
  drop:{height:2,color:'#d6c79f'},
  swing:{height:1,color:'#ded2ac'},
  disk:{height:.16,color:'#d5c8b7'},
  'comet-coaster':{height:.5,color:'#c8bed5'},
  speedway:{height:.6,color:'#d9c9aa'},
};

export function rideFloorOutline({shape,bounds},padding=0) {
  const [x,z,w,d]=bounds;
  if(shape==='drop'||shape==='swing') {
    const radius=(shape==='drop'?10:Math.min(w,d)*.46)+padding;
    return Array.from({length:48},(_,i)=>{
      const angle=i*Math.PI/24;
      return [x+w/2+Math.cos(angle)*radius,z+d/2+Math.sin(angle)*radius];
    });
  }
  const corner=Math.min(w,d)*.23;
  const centers=[[x+corner,z+corner],[x+w-corner,z+corner],
                 [x+w-corner,z+d-corner],[x+corner,z+d-corner]];
  return centers.flatMap(([cx,cz],i)=>Array.from({length:11},(_,j)=>{
    const angle=Math.PI*(1+i/2+j/20);
    return [cx+Math.cos(angle)*(corner+padding),cz+Math.sin(angle)*(corner+padding)];
  }));
}

function coaster(group, bounds, height) {
  const [x, z, w, d] = bounds;
  const route = [
    [x+w*.15, 2, z+d*.78], [x+w*.07, 5, z+d*.35], [x+w*.28, height*.9, z+d*.13],
    [x+w*.69, height, z+d*.18], [x+w*.89, 5, z+d*.48], [x+w*.72, 2, z+d*.78],
    [x+w*.47, 5, z+d*.58], [x+w*.23, 3, z+d*.75]
  ];
  const track = tube(group, route, 1.7, '#258fa6', true);
  track.name = 'atlantis-track';
  tube(group, route.map(p => [p[0], p[1]+.5, p[2]]), .28, '#e8d49b', true);
  for (const p of route) rod(group, [p[0], .5, p[2]], p, .45, '#789b92');
  const station = box(group, x+w*.7, 3, z+d*.85, w*.33, 5, d*.18, '#d9c3a0');
  box(group, station.position.x, 6, station.position.z, w*.38, 1, d*.23, '#687b84');
  const curve = track.geometry.parameters.path;
  for (let i=0; i<3; i++) {
    const progress = .34 + (i-1)*2.8/curve.getLength();
    const point = curve.getPointAt(progress), tangent = curve.getTangentAt(progress);
    const car = box(group, point.x, point.y, point.z, 1.6, 1, 2.3, '#c46d50');
    car.name = 'atlantis-car';
    car.rotation.set(-Math.asin(tangent.y), Math.atan2(tangent.x, tangent.z), 0, 'YXZ');
    car.translateY(1.9);
  }
  group.userData.features = ['water-channel', 'elevated-track', 'station'];
}

function drop(group, bounds, height) {
  const [x,z,w,d] = bounds, cx=x+w/2, cz=z+d/2;
  cylinder(group,cx,height/2+1,cz,1.3,height,'#e8ece6',1,12);
  for (let i=0;i<4;i++) {
    const a=i*Math.PI/2;
    rod(group,[cx+Math.cos(a)*1.8,1,cz+Math.sin(a)*1.8],[cx+Math.cos(a)*1.8,height-2,cz+Math.sin(a)*1.8],.17,'#6e8583');
  }
  cylinder(group,cx,13,cz,7,2,'#be9a45');
  for (let i=0;i<16;i++) {
    const a=i*Math.PI/8;
    const seat=box(group,cx+Math.cos(a)*6.7,14.4,cz+Math.sin(a)*6.7,1.2,2,1.3,'#315d6c');
    seat.rotation.y=-a;
  }
  cylinder(group,cx,height-3,cz,4.8,6,'#d8bd68',4.8,8);
  cylinder(group,cx,height+.5,cz,5.8,1,'#5e887a',.5,8);
  group.userData.features = ['vertical-tower', 'gondola-ring'];
}

function swing(group, bounds, height) {
  const [x,z,w,d]=bounds, cx=x+w/2, cz=z+d/2;
  for (const side of [-1,1]) {
    rod(group,[cx-w*.35,0,cz+side*d*.4],[cx,height,cz+side*2],.8,'#c27e55');
    rod(group,[cx+w*.35,0,cz+side*d*.4],[cx,height,cz+side*2],.8,'#c27e55');
  }
  rod(group,[cx,height,cz-3],[cx,height,cz+3],1,'#647f79');
  const pendulumLength=height-7,offset=w*.17;
  const end=[cx+offset,height-Math.sqrt(pendulumLength**2-offset**2),cz];
  rod(group,[cx,height,cz],end,.7,'#d1b16a');
  // 원판과 좌석을 같은 로컬 좌표계에 두어 함께 기울인다.
  const gondola=new THREE.Group();gondola.name='swing-gondola';
  gondola.position.set(...end);gondola.rotation.z=Math.asin(offset/pendulumLength);group.add(gondola);
  cylinder(gondola,0,0,0,7,1.5,'#607e9b').name='swing-disk';
  for(let i=0;i<16;i++) {
    const a=i*Math.PI/8;
    cylinder(gondola,Math.cos(a)*6,1.25,Math.sin(a)*6,.6,1,'#cba266',.6,8).name='swing-seat';
  }
  group.userData.features = ['a-frame', 'pendulum', 'seat-disk'];
}

function spin(group,bounds,height) {
  const [x,z,w,d]=bounds,cx=x+w/2,cz=z+d/2;
  const route=[[x+3,height*.8,cz],[x+w*.25,3,cz],[cx,2,cz],[x+w*.75,3,cz],[x+w-3,height*.8,cz]];
  const railOffset=2;
  const rails=[-railOffset,railOffset].map(offset=>{
    const rail=tube(group,route.map(([px,y,pz])=>[px,y,pz+offset]),.4,'#827ca3');
    rail.name='spin-rail';
    return rail;
  });
  for(const [px,y] of route) {
    rod(group,[px,0,cz],[px,y,cz],.45,'#b3a083').name='spin-rail-support';
    rod(group,[px,y,cz-railOffset],[px,y,cz+railOffset],.3,'#b3a083').name='spin-rail-crossbeam';
  }
  const curve=rails[0].geometry.parameters.path;
  const point=curve.getPointAt(.66), tangent=curve.getTangentAt(.66);
  const platform=new THREE.Group();platform.name='spin-platform';
  platform.position.set(point.x,point.y,cz);
  platform.rotation.z=Math.atan2(tangent.y,tangent.x);
  group.add(platform);
  for(const wheelX of [-1.15,1.15])for(const wheelZ of [-railOffset,railOffset]) {
    const wheel=cylinder(platform,wheelX,.73,wheelZ,.56,.45,'#6e6984',.56,12);
    wheel.rotation.x=Math.PI/2;
    wheel.name='spin-wheel';
  }
  box(platform,0,1.12,0,3.5,.62,4.35,'#81739c').name='spin-carriage';
  cylinder(platform,0,2.02,0,1.35,1.25,'#81739c').name='spin-bearing';
  const diskY=3.4;
  cylinder(platform,0,diskY,0,7,1.6,'#b096c9').name='spin-disk';
  cylinder(platform,0,diskY+1.78,0,2,2,'#81739c');
  for(let i=0;i<16;i++) {
    const a=i*Math.PI/8;
    box(platform,Math.cos(a)*6,diskY+1.52,Math.sin(a)*6,1,1.5,1,'#e2ce83').name='spin-seat';
  }
  group.userData.features = ['u-rail', 'rotating-disk'];
}

function comet(group,bounds,height) {
  const [x,z,w,d]=bounds;
  const route=[[x+4,2,z+d*.7],[x+w*.2,3,z+4],[x+w*.5,height*.6,z+5],
    [x+w*.8,3,z+3],[x+w-4,2,z+d*.65],[x+w*.65,4,z+d-4],[x+w*.4,2,z+d*.6]];
  const track=tube(group,route,.4,'#817299',true);
  const curve=track.geometry.parameters.path;
  for(const point of route)rod(group,[point[0],.5,point[2]],point,.25,'#a79bb6');
  for(let i=0;i<3;i++) {
    const t=(.9+i*2.8/curve.getLength())%1;
    const point=curve.getPointAt(t),tangent=curve.getTangentAt(t);
    const car=new THREE.Group();car.name='comet-car';group.add(car);
    car.position.copy(point);car.position.y+=1.05;
    car.rotation.set(-Math.asin(tangent.y),Math.atan2(tangent.x,tangent.z),0,'YXZ');
    box(car,0,0,0,1.8,1.3,2.5,'#db9a62');
    cylinder(car,0,.8,0,.6,.3,'#e5d8ad',.6,8);
  }
  box(group,x+w*.5,1.2,z+1.2,w*.42,2.4,2,'#a491b8');
  group.userData.features = ['ground-platform', 'winding-track', 'train'];
}

function arcana(group,bounds,height) {
  const [x,z,w,d]=bounds,cx=x+w/2,cz=z+d/2;
  cylinder(group,cx,.5,cz,1,1,'#c4a984');
  const route=[];
  for(let i=0;i<12;i++) {
    const a=i*Math.PI/6;
    route.push([cx+Math.cos(a)*w*.39,1.05,cz+Math.sin(a)*d*.32]);
  }
  tube(group,route,.55,'#bc9c55',true).name='arcana-track';
  for(let i=0;i<6;i++) {
    const a=i*Math.PI/3,px=cx+Math.cos(a)*w*.39,pz=cz+Math.sin(a)*d*.32;
    const car=box(group,px,2.29,pz,3,1.7,2,i%2?'#b7a4c3':'#dfad70');
    car.rotation.y=-a;car.name='arcana-car';
  }
  const wall=box(group,cx,2.8,cz,8,5,5,'#dfcfa9');
  wall.name='arcana-pavilion-walls';
  const roofBase=wall.position.y+wall.geometry.parameters.height/2-.03;
  const roofHeight=height-roofBase;
  const roof=cylinder(group,cx,roofBase+roofHeight/2,cz,Math.SQRT1_2,roofHeight,'#648e78',0,4);
  roof.geometry.rotateY(Math.PI/4);
  roof.scale.set(8.9,1,5.9);
  roof.name='arcana-pavilion-roof';
  group.userData.features = ['oval-track', 'small-cars', 'maple-pavilion'];
}

export function buildRide(parent,facility) {
  const group=new THREE.Group();
  group.name=facility.id;
  group.userData.facilityId=facility.id;
  parent.add(group);
  const floor=rideFloors[facility.shape];
  polygon(group,rideFloorOutline(facility),floor.color,floor.height).name='ride-floor';
  const builders={'water-coaster':coaster,drop,swing,disk:spin,'comet-coaster':comet,speedway:arcana};
  builders[facility.shape](group,facility.bounds,facility.model_height_m);
  group.traverse(object=>{if(object.isMesh)object.userData.facilityId=facility.id;});
  return group;
}

export function buildCastle(parent,bounds,height,forward,scale,footprint) {
  const group=new THREE.Group();group.name='magic-castle';parent.add(group);
  const [x,z,w,d]=bounds,cx=x+w/2,cz=z+d/2;
  if(footprint)polygon(parent,footprint,'#d6cbb4',.12).name='castle-footprint';
  else box(group,cx,.3,cz,w,.6,d,'#d6cbb4');
  box(group,cx,8,cz,w*.55,16,d*.7,'#eee5db').name='castle-wall';
  const roofShape=new THREE.Shape([
    new THREE.Vector2(-w*.31,0),new THREE.Vector2(0,8),new THREE.Vector2(w*.31,0)
  ]);
  const roofGeometry=new THREE.ExtrudeGeometry(roofShape,{depth:d*.73,bevelEnabled:false});
  roofGeometry.translate(cx,16,cz-d*.365);
  const roof=new THREE.Mesh(roofGeometry,new THREE.MeshStandardMaterial({color:'#527b94',roughness:.75}));
  roof.castShadow=true;roof.receiveShadow=true;group.add(roof);
  for(const side of [-1,1])for(let i=0;i<4;i++) {
    box(group,cx+side*w*.28,8,z+d*(.26+i*.15),.6,3,1.1,'#a18e92');
  }
  const portal=box(group,cx,5,z+d*.86,8,10,4,'#b4a4a0');portal.name='castle-portal';
  const gate=box(group,cx,3.7,portal.position.z+2.22,4,7.4,.5,'#5f6b79');gate.name='castle-gate';
  const towers=[[x+8,z+7,23,4],[x+w-8,z+7,26,4.5],[x+7,z+d-8,21,4.2],[x+w-7,z+d-8,24,4.2],[cx,cz-3,height-8,5]];
  for(const [tx,tz,h,r] of towers) {
    cylinder(group,tx,h/2,tz,r,h,'#f2e8df').name='castle-tower';
    cylinder(group,tx,h,tz,r+1,1.4,'#b3acb0');
    cylinder(group,tx,h+4,tz,r+1.7,8,'#3b7996',0);
    rod(group,[tx,h+8,tz],[tx,h+11,tz],.1,'#b89b5a');
    const flagGeometry=new THREE.PlaneGeometry(2.6,1.5,12,2);
    const vertices=flagGeometry.attributes.position;
    for(let i=0;i<vertices.count;i++) {
      const u=(vertices.getX(i)+1.3)/2.6;
      // 깃대에 닿는 왼쪽 가장자리는 고정하고 바깥쪽만 완만하게 굽힌다.
      vertices.setXYZ(i,tx+u*2.6,h+10.15+vertices.getY(i)+Math.sin(u*Math.PI*2)*.08*u,tz+Math.sin(u*Math.PI*2)*.24*u);
    }
    flagGeometry.computeVertexNormals();
    const flag=new THREE.Mesh(flagGeometry,new THREE.MeshStandardMaterial({color:'#dbb46e',roughness:.8,side:THREE.DoubleSide}));
    flag.name='castle-flag';flag.castShadow=true;flag.receiveShadow=true;group.add(flag);
    for(let i=0;i<4;i++) {
      const a=i*Math.PI/2;
      box(group,tx+Math.cos(a)*r,h*.65,tz+Math.sin(a)*r,.7,2,.7,'#608795');
    }
  }
  const transform=new THREE.Matrix4().makeTranslation(cx,0,cz)
    .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(forward[0],forward[1])))
    .multiply(new THREE.Matrix4().makeScale(scale,1,scale))
    .multiply(new THREE.Matrix4().makeTranslation(-cx,0,-cz));
  group.applyMatrix4(transform);
  // 회전 후에도 성의 실제 입체 형상은 선언된 점유 구획 안에 머문다.
  return group;
}
