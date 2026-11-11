/** 안내도의 시설별 특징을 추상화한 정적 입체 모형. 운행 상태를 재현하지 않는다. */
import * as THREE from 'three';
import {box, cylinder, rod, polygon, rectPoints, tube} from './geometry.mjs';

function coaster(group, bounds, height) {
  const [x, z, w, d] = bounds;
  box(group, x + w / 2, .3, z + d / 2, w, .6, d, '#a9d7dd');
  const route = [
    [x+w*.15, 2, z+d*.78], [x+w*.07, 5, z+d*.35], [x+w*.28, height*.9, z+d*.13],
    [x+w*.69, height, z+d*.18], [x+w*.89, 5, z+d*.48], [x+w*.72, 2, z+d*.78],
    [x+w*.47, 5, z+d*.58], [x+w*.23, 3, z+d*.75]
  ];
  tube(group, route, 1.7, '#258fa6', true);
  tube(group, route.map(p => [p[0], p[1]+.5, p[2]]), .28, '#e8d49b', true);
  for (const p of route) rod(group, [p[0], .5, p[2]], p, .45, '#789b92');
  const station = box(group, x+w*.7, 3, z+d*.85, w*.33, 5, d*.18, '#d9c3a0');
  box(group, station.position.x, 6, station.position.z, w*.38, 1, d*.23, '#687b84');
  for (let i=0; i<3; i++) box(group, x+w*.42+i*2, height*.97+1.2, z+d*.18, 1.6, 1, 2.3, '#c46d50');
  group.userData.features = ['water-channel', 'elevated-track', 'station'];
}

function drop(group, bounds, height) {
  const [x,z,w,d] = bounds, cx=x+w/2, cz=z+d/2;
  cylinder(group,cx,1,cz,10,2,'#d6c79f');
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
  cylinder(group,cx,.5,cz,Math.min(w,d)*.46,1,'#ded2ac');
  for (const side of [-1,1]) {
    rod(group,[cx-w*.35,0,cz+side*d*.3],[cx,height,cz+side*2],.8,'#c27e55');
    rod(group,[cx+w*.35,0,cz+side*d*.3],[cx,height,cz+side*2],.8,'#c27e55');
  }
  rod(group,[cx,height,cz-3],[cx,height,cz+3],1,'#647f79');
  const end=[cx+w*.17,7,cz+d*.1];
  rod(group,[cx,height,cz],end,.7,'#d1b16a');
  const disk=cylinder(group,...end,7,1.5,'#607e9b');
  disk.rotation.z=.3;
  for(let i=0;i<16;i++) {
    const a=i*Math.PI/8;
    cylinder(group,end[0]+Math.cos(a)*6,8,end[2]+Math.sin(a)*6,.6,1,'#cba266',.6,8);
  }
  group.userData.features = ['a-frame', 'pendulum', 'seat-disk'];
}

function spin(group,bounds,height) {
  const [x,z,w,d]=bounds,cx=x+w/2,cz=z+d/2;
  const route=[[x+3,height*.8,cz],[x+w*.25,3,cz],[cx,2,cz],[x+w*.75,3,cz],[x+w-3,height*.8,cz]];
  for(const dz of [-2,2])tube(group,route.map(p=>[p[0],p[1],p[2]+dz]),.4,'#827ca3');
  for(const p of route)rod(group,[p[0],0,cz],p,.45,'#b3a083');
  const disk=cylinder(group,cx,5,cz,7,1.6,'#b096c9');
  disk.rotation.z=.12;
  cylinder(group,cx,6.8,cz,2,2,'#81739c');
  for(let i=0;i<16;i++) {
    const a=i*Math.PI/8;
    box(group,cx+Math.cos(a)*6,6.7,cz+Math.sin(a)*6,1,1.5,1,'#e2ce83');
  }
  group.userData.features = ['u-rail', 'rotating-disk'];
}

function comet(group,bounds,height) {
  const [x,z,w,d]=bounds;
  box(group,x+w/2,.25,z+d/2,w,.5,d,'#c8bed5');
  const route=[[x+4,2,z+d*.7],[x+w*.2,3,z+4],[x+w*.5,height*.6,z+5],
    [x+w*.8,3,z+3],[x+w-4,2,z+d*.65],[x+w*.65,4,z+d-4],[x+w*.4,2,z+d*.6]];
  tube(group,route,.4,'#817299',true);
  for(const point of route)rod(group,[point[0],.5,point[2]],point,.25,'#a79bb6');
  for(let i=0;i<3;i++) {
    const train=box(group,x+w*.3+i*2.3,3.2,z+d*.7,1.8,1.3,2.5,'#db9a62');
    cylinder(group,train.position.x,4,train.position.z,.6,.3,'#e5d8ad',.6,8);
  }
  box(group,x+w*.5,1.2,z+1.2,w*.42,2.4,2,'#a491b8');
  group.userData.features = ['ground-platform', 'winding-track', 'train'];
}

function arcana(group,bounds,height) {
  const [x,z,w,d]=bounds,cx=x+w/2,cz=z+d/2;
  cylinder(group,cx,.5,cz,1,1,'#c4a984');
  box(group,cx,.3,cz,w,.6,d,'#cdd5aa');
  const route=[];
  for(let i=0;i<12;i++) {
    const a=i*Math.PI/6;
    route.push([cx+Math.cos(a)*w*.39,1.2,cz+Math.sin(a)*d*.32]);
  }
  tube(group,route,.55,'#bc9c55',true);
  for(let i=0;i<6;i++) {
    const a=i*Math.PI/3,px=cx+Math.cos(a)*w*.39,pz=cz+Math.sin(a)*d*.32;
    const car=box(group,px,2.4,pz,3,1.7,2,i%2?'#b7a4c3':'#dfad70');car.rotation.y=-a;
  }
  box(group,cx,2.8,cz,8,5,5,'#dfcfa9');
  cylinder(group,cx,height-1,cz,5.5,3,'#648e78',0,4);
  group.userData.features = ['oval-track', 'small-cars', 'maple-pavilion'];
}

export function buildRide(parent,facility) {
  const group=new THREE.Group();
  group.name=facility.id;
  group.userData.facilityId=facility.id;
  parent.add(group);
  const builders={'water-coaster':coaster,drop,swing,disk:spin,'comet-coaster':comet,speedway:arcana};
  builders[facility.shape](group,facility.bounds,facility.model_height_m);
  group.traverse(object=>{if(object.isMesh)object.userData.facilityId=facility.id;});
  return group;
}

export function buildCastle(parent,bounds,height,forward,scale) {
  const group=new THREE.Group();group.name='magic-castle';parent.add(group);
  const [x,z,w,d]=bounds,cx=x+w/2,cz=z+d/2;
  box(group,cx,.3,cz,w,.6,d,'#d6cbb4');
  box(group,cx,8,cz,w*.55,16,d*.7,'#eee5db');
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
  box(group,cx,5,z+d*.86,8,10,4,'#b4a4a0');
  const gate=box(group,cx,3.7,z+d*.9,4,7.4,.5,'#5f6b79');gate.name='castle-gate';
  const towers=[[x+7,z+7,23,4],[x+w-7,z+7,26,4.5],[x+7,z+d-8,21,4.2],[x+w-7,z+d-8,24,4.2],[cx,cz-3,height-8,5]];
  for(const [tx,tz,h,r] of towers) {
    cylinder(group,tx,h/2,tz,r,h,'#f2e8df');
    cylinder(group,tx,h,tz,r+1,1.4,'#b3acb0');
    cylinder(group,tx,h+4,tz,r+1.7,8,'#3b7996',0);
    rod(group,[tx,h+8,tz],[tx,h+11,tz],.1,'#b89b5a');
    polygon(group,[[tx,tz],[tx+2.2,tz],[tx,tz+2.2]],'#dbb46e',.2,h+10);
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
