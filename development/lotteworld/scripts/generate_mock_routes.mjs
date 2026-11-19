import { readFileSync, writeFileSync } from 'node:fs';
import { createNavigator } from '../web/navigation.mjs';

const [metadataPath, mockPath = 'configs/recommendation-mock.json', option] = process.argv.slice(2);
if (!metadataPath || (option !== undefined && option !== '--check')) {
  throw new Error('사용법: node scripts/generate_mock_routes.mjs <메타데이터 JSON> [모의 데이터 JSON] [--check]');
}

const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const original = readFileSync(mockPath, 'utf8');
const mock = JSON.parse(original);
const { map, hashes } = metadata;
if (metadata.scenario_id !== 'magic-island' || !/^[0-9a-f]{64}$/.test(hashes?.map)) {
  throw new Error('매직아일랜드의 지도 메타데이터가 필요합니다.');
}

const navigator = createNavigator(map);
const nodes = new Map(map.geometry.nodes.map(({ id, point }) => [id, point]));
const routes = Object.entries(mock.node_routes).map(([nodeId]) => {
  const point = nodes.get(nodeId);
  if (!point || !navigator.walkable(point)) {
    throw new Error(`공공 보행 구역의 출발 노드가 필요합니다. ${nodeId}`);
  }
  return [nodeId, Object.fromEntries(map.facilities.map(({ id, entrance }) => [
    id, navigator.route(nodeId, entrance).points,
  ]))];
});

const generated = Object.fromEntries(routes);
if (option === '--check') {
  if (mock.map_hash !== hashes.map || JSON.stringify(mock.node_routes) !== JSON.stringify(generated)) {
    throw new Error('모의 경로와 현재 지도가 일치하지 않습니다. 모의 경로를 다시 생성하세요.');
  }
} else {
  const lines = ['{'];
  const { facilities, node_routes: _oldRoutes, ...header } = mock;
  for (const [key, value] of Object.entries({ ...header, map_hash: hashes.map })) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "facilities": [');
  lines.push(facilities.map(row => `    ${JSON.stringify(row)}`).join(',\n'));
  lines.push('  ],', '  "node_routes": {');
  lines.push(routes.map(([nodeId, paths]) => {
    const entries = Object.entries(paths).map(([id, points]) => `      ${JSON.stringify(id)}: ${JSON.stringify(points)}`);
    return `    ${JSON.stringify(nodeId)}: {\n${entries.join(',\n')}\n    }`;
  }).join(',\n'));
  lines.push('  }', '}', '');
  writeFileSync(mockPath, lines.join('\n'));
}
