/** Three.js 형상 도우미. 모든 x/z·폭·높이는 지도와 같은 미터 단위다. */
import * as THREE from 'three';

export function material(color, extra = {}) {
  return new THREE.MeshStandardMaterial({color, roughness: .78, ...extra});
}

export function mesh(parent, geometry, color, position, extra = {}) {
  const object = new THREE.Mesh(geometry, material(color, extra));
  object.position.set(...position);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

export function box(parent, x, y, z, width, height, depth, color, extra) {
  return mesh(parent, new THREE.BoxGeometry(width, height, depth), color, [x, y, z], extra);
}

export function cylinder(parent, x, y, z, radius, height, color, topRadius = radius, segments = 16) {
  return mesh(parent, new THREE.CylinderGeometry(topRadius, radius, height, segments), color, [x, y, z]);
}

export function rod(parent, a, b, radius, color) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const object = cylinder(parent, ...start.clone().add(end).multiplyScalar(.5).toArray(), radius, start.distanceTo(end), color);
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
  return object;
}

export function polygon(parent, points, color, height, bottom = 0, holes = []) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const contour of holes) {
    shape.holes.push(new THREE.Path(contour.map(([x, z]) => new THREE.Vector2(x, -z))));
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {depth: height, bevelEnabled: false});
  geometry.rotateX(-Math.PI / 2);
  return mesh(parent, geometry, color, [0, bottom, 0]);
}

export function rectPoints([x, z, width, depth]) {
  return [[x, z], [x + width, z], [x + width, z + depth], [x, z + depth]];
}

export function tube(parent, points, radius, color, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)), closed, 'centripetal');
  return mesh(parent, new THREE.TubeGeometry(curve, Math.max(32, points.length * 10), radius, 6, closed), color, [0, 0, 0]);
}

export function band(parent, a, b, width, color, y = .15, height = .18) {
  const object = box(parent, (a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2, Math.hypot(b[0] - a[0], b[1] - a[1]), height, width, color);
  object.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  return object;
}
