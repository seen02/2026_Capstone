(function (root) {
  'use strict';

  const EDGES = Object.freeze({
    e1: { from: 'J', to: 'L', length: 10, area: 40 },
    e2: { from: 'J', to: 'R', length: 12, area: 48 },
    e3: { from: 'L', to: 'EL', length: 10, area: 20 },
    e4: { from: 'R', to: 'ER', length: 12, area: 24 },
    e5: { from: 'L', to: 'R', length: 12, area: 24 }
  });
  const CROWD_TTL = 5000;
  const RISK_TTL = 3000;
  const CANDIDATE_TIME = 5000;
  const MINIMUM_HOLD = 5000;
  const IMPROVEMENT = 0.15;

  function create(options = {}) {
    const clock = options.now || (() => root.performance.now());
    let time = Number(clock());
    if (!Number.isFinite(time)) throw new TypeError('now() must return milliseconds.');
    const startedAt = time;
    let crowd = 0;
    let gatewayDown = false;
    let gatewayLostAt = 0;
    let lastDeliveredCrowd = 0;
    let s3Down = false;
    let s3LostAt = 0;
    let lastDeliveredRisk4 = 'CLEAR';
    let stale = false;
    let risks = { e1: 'CLEAR', e2: 'CLEAR', e3: 'CLEAR', e4: 'CLEAR', e5: 'CLEAR' };
    const riskInputs = { e1: false, e3: false, e4: false };
    const events = [];
    const signs = {
      S1: initialSign('J', ['e1', 'e3']),
      S2: initialSign('L', ['e3']),
      S3: initialSign('R', ['e4'])
    };

    function initialSign(node, path) {
      return { node, path, status: 'route', lastSwitch: time, pending: null };
    }

    function readTime() {
      const next = Number(clock());
      if (!Number.isFinite(next)) throw new TypeError('now() must return milliseconds.');
      // An injected wall clock moving backwards must not reverse expiry timers.
      time = Math.max(time, next);
      return time;
    }

    function log(kind, message) {
      events.push({ at: Math.round(time - startedAt), kind, message });
      if (events.length > 100) events.shift();
    }

    function direction(path) {
      if (!path.length) return 'none';
      return path[0] === 'e1' || path[0] === 'e3' ? 'left' : 'right';
    }

    function routeText(sign, path) {
      return [sign.node, ...path.map(id => EDGES[id].to)].join(' → ');
    }

    function effectiveRisk4() {
      if (!s3Down) return riskInputs.e4 ? 'BLOCKED' : 'CLEAR';
      if (lastDeliveredRisk4 === 'BLOCKED') return 'BLOCKED';
      return time - s3LostAt >= RISK_TTL ? 'UNKNOWN' : lastDeliveredRisk4;
    }

    function edgeCost(id) {
      const edge = EDGES[id];
      const appliedCrowd = gatewayDown ? lastDeliveredCrowd : crowd;
      const density = id === 'e3' ? appliedCrowd / edge.area : 0;
      return edge.length * (1 + (stale ? 0 : 2) * Math.min(density, 3));
    }

    function pathCost(path) {
      return path.reduce((total, id) => total + edgeCost(id), 0);
    }

    // Exhaustive shortest-path search is sufficient for this five-edge DAG.
    // Fixed enumeration order also makes equal-cost choices deterministic.
    function bestPath(node, allowUnknown = false) {
      if (node === 'EL' || node === 'ER') return { path: [], cost: 0 };
      let best = null;
      for (const [id, edge] of Object.entries(EDGES)) {
        if (edge.from !== node || risks[id] === 'BLOCKED') continue;
        if (!allowUnknown && risks[id] === 'UNKNOWN') continue;
        const tail = bestPath(edge.to, allowUnknown);
        if (!tail) continue;
        const cost = edgeCost(id) + tail.cost;
        if (!best || cost < best.cost - 1e-9) best = { path: [id, ...tail.path], cost };
      }
      return best;
    }

    function assignRoute(id, best, reason) {
      const sign = signs[id];
      const previous = sign.status + ':' + sign.path.join(',');
      const previousDirection = sign.status + ':' + sign.path[0];
      sign.path = best ? best.path.slice() : [];
      sign.status = best ? 'route' : bestPath(sign.node, true) ? 'unknown' : 'stop';
      sign.pending = null;
      if (previousDirection !== sign.status + ':' + sign.path[0]) sign.lastSwitch = time;
      if (previous !== sign.status + ':' + sign.path.join(',')) {
        const output = best ? routeText(sign, sign.path) : sign.status === 'unknown' ? '? 상태 미확인' : 'X 안전 경로 없음';
        log('route', id + ' · ' + output + ' · ' + reason);
      }
    }

    function evaluateSign(id) {
      const sign = signs[id];
      if (id === 'S3' && s3Down) {
        if (sign.status !== 'offline') {
          sign.status = 'offline';
          sign.path = [];
          sign.pending = null;
          log('offline', 'S3 · 전원·통신 단절 시험 · 출력 꺼짐');
        }
        return;
      }

      const best = bestPath(sign.node);
      if (!best) {
        const status = bestPath(sign.node, true) ? 'unknown' : 'stop';
        if (sign.status !== status || sign.path.length) assignRoute(id, null, '안전 경로 없음');
        return;
      }

      // Safety overrides inspect the complete stored route, not only its next edge.
      if (sign.status !== 'route' || !sign.path.length || sign.path.some(id => risks[id] !== 'CLEAR')) {
        assignRoute(id, best, '위험 경로 즉시 제외 / 안내 복구');
        return;
      }

      // A changed downstream continuation does not change the local direction.
      if (best.path[0] === sign.path[0]) {
        if (best.path.join(',') !== sign.path.join(',')) {
          sign.path = best.path.slice();
          log('continuation', id + ' · 후속 경로 갱신 · 현재 방향과 전환 시계 유지');
        }
        sign.pending = null;
        return;
      }

      const currentCost = pathCost(sign.path);
      const improvement = (currentCost - best.cost) / currentCost;
      if (improvement + 1e-9 < IMPROVEMENT) {
        sign.pending = null;
        return;
      }

      // Candidate identity is the next edge. Tail-only changes preserve persistence.
      if (!sign.pending || sign.pending.path[0] !== best.path[0]) {
        sign.pending = { path: best.path.slice(), since: time };
        log('candidate', id + ' · ' + routeText(sign, best.path) + ' · 개선 후보 5초 확인');
      } else {
        sign.pending.path = best.path.slice();
      }
      if (time - sign.pending.since >= CANDIDATE_TIME && time - sign.lastSwitch >= MINIMUM_HOLD) {
        assignRoute(id, best, '15% 개선·후보 5초·방향 유지 5초 충족');
      }
    }

    function advance() {
      readTime();
      const previousRisk4 = risks.e4;
      risks = {
        e1: riskInputs.e1 ? 'BLOCKED' : 'CLEAR',
        e2: 'CLEAR',
        e3: riskInputs.e3 ? 'BLOCKED' : 'CLEAR',
        e4: effectiveRisk4(),
        e5: 'CLEAR'
      };
      if (previousRisk4 !== risks.e4) log('risk', 'e4 · ' + risks.e4);

      const wasStale = stale;
      stale = gatewayDown && time - gatewayLostAt >= CROWD_TTL;
      if (wasStale !== stale) log('data', stale ? '혼잡 정보 5초 만료 · 거리 기준 즉시 적용' : '현재 혼잡 입력 재동기화');
      if (stale && !wasStale) {
        for (const id of Object.keys(signs)) {
          if (id === 'S3' && s3Down) continue;
          assignRoute(id, bestPath(signs[id].node), '혼잡 정보 만료 · 거리 기준 즉시 적용');
        }
      }
      for (const id of Object.keys(signs)) evaluateSign(id);
    }

    function copySnapshot() {
      const outputSigns = {};
      for (const [id, sign] of Object.entries(signs)) {
        const pending = sign.pending;
        outputSigns[id] = {
          status: sign.status,
          direction: sign.status === 'route' ? direction(sign.path) : 'none',
          path: sign.path.slice(),
          cost: sign.status === 'route' ? pathCost(sign.path) : null,
          pendingSeconds: pending ? Math.max(0, CANDIDATE_TIME - time + pending.since, MINIMUM_HOLD - time + sign.lastSwitch) / 1000 : 0,
          pendingDirection: pending ? direction(pending.path) : null
        };
      }
      return {
        crowd,
        waiting: 60 - crowd,
        gatewayDown,
        s3Down,
        stale,
        risks: { ...risks },
        signs: outputSigns,
        events: events.map(event => ({ ...event }))
      };
    }

    function tick() {
      advance();
      return copySnapshot();
    }

    function setCrowd(value) {
      if (!Number.isFinite(Number(value))) throw new TypeError('Crowd must be a number.');
      readTime();
      const next = Math.max(0, Math.min(40, Math.round(Number(value))));
      if (next !== crowd) {
        crowd = next;
        log('people', 'e3 ' + crowd + '명 · WAIT_J ' + (60 - crowd) + '명');
      }
      return tick();
    }

    function setRisk(edge, blocked) {
      if (!Object.prototype.hasOwnProperty.call(riskInputs, edge)) {
        throw new RangeError('Only e1, e3, and e4 have mutable risk owners.');
      }
      readTime();
      if (riskInputs[edge] !== Boolean(blocked)) {
        riskInputs[edge] = Boolean(blocked);
        log('input', edge + ' 위험 입력 ' + (blocked ? 'BLOCKED' : 'CLEAR') + (edge === 'e4' && s3Down ? ' · S3 재연결 후 공유' : ''));
      }
      return tick();
    }

    function setGateway(down) {
      readTime();
      const next = Boolean(down);
      if (next !== gatewayDown) {
        gatewayDown = next;
        if (next) {
          gatewayLostAt = time;
          lastDeliveredCrowd = crowd;
        }
        log('connection', 'G ' + (next ? '단절 · 마지막 인원값 유지 후 5초 만료' : '복구 · 현재 인원값 재동기화'));
      }
      return tick();
    }

    function setS3(down) {
      readTime();
      const next = Boolean(down);
      if (next !== s3Down) {
        if (next) {
          lastDeliveredRisk4 = effectiveRisk4();
          s3LostAt = time;
        }
        s3Down = next;
        log('connection', 'S3 ' + (next ? '단절 · 마지막 위험 상태 ' + lastDeliveredRisk4 : '복구 · 현재 위험 입력 재동기화'));
      }
      return tick();
    }

    function resetPeople() {
      readTime();
      crowd = 0;
      for (const sign of Object.values(signs)) {
        sign.pending = null;
        sign.lastSwitch = -Infinity;
      }
      log('reset', '인원 입력·후보·유지 이력 초기화 · 위험·연결 유지' + (gatewayDown ? ' · G 복구 전 마지막 수신값/만료 정책 유지' : ''));
      return tick();
    }

    function restore() {
      readTime();
      riskInputs.e1 = false;
      riskInputs.e3 = false;
      riskInputs.e4 = false;
      gatewayDown = false;
      s3Down = false;
      log('restore', '위험 해제·G/S3 연결 복구 · 인원 입력 유지');
      return tick();
    }

    log('ready', '소프트웨어 계산 모델 · 가상 인원 60명 · 실제 장치 미연결');
    return Object.freeze({ setCrowd, setRisk, setGateway, setS3, resetPeople, restore, tick, snapshot: tick });
  }

  root.EvacEngine = Object.freeze({ create });
})(typeof window === 'undefined' ? globalThis : window);
