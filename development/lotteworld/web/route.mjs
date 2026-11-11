/** 미터 좌표 그래프의 양방향 최단 경로. 화면과 검증에서 같은 입력을 사용한다. */
export function walkingRoute(map, source, target) {
  const points = Object.fromEntries(map.geometry.nodes.map(node => [node.id, node.point]));
  if (!points[source] || !points[target]) throw new Error('경로의 시작·도착 노드가 없습니다.');
  const pending = [{distance: 0, key: source, nodes: [source]}];
  const seen = new Set();
  while (pending.length) {
    pending.sort((a, b) => a.distance - b.distance);
    const current = pending.shift();
    if (seen.has(current.key)) continue;
    if (current.key === target) return {nodes: current.nodes, distance_m: current.distance};
    seen.add(current.key);
    for (const edge of map.geometry.edges) {
      const next = edge.source === current.key ? edge.target : edge.target === current.key ? edge.source : null;
      if (!next || seen.has(next)) continue;
      const [x, z] = points[current.key], [nx, nz] = points[next];
      pending.push({distance: current.distance + Math.hypot(nx - x, nz - z), key: next, nodes: [...current.nodes, next]});
    }
  }
  throw new Error('보행 경로가 끊겼습니다.');
}
