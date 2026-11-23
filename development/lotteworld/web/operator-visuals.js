function prepareCanvas(canvas, context) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height || !context) return null;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * pixelRatio);
  const pixelHeight = Math.round(height * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
  context.clearRect(0, 0, width, height);
  return {width, height};
}

const trafficSeries = [
  {field: 'entered_total', color: '--traffic-entered', dash: []},
  {field: 'exited_total', color: '--traffic-exited', dash: [7, 4]},
  {field: 'present_people', color: '--traffic-present', dash: [2, 4]},
];

function formatElapsedTime(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

export function createVisitorFlowChart(canvas, empty) {
  const context = canvas.getContext('2d');
  let history = [];
  let runId;

  function draw() {
    const size = prepareCanvas(canvas, context);
    if (!size || !history.length) return;
    const {width, height} = size;
    const styles = getComputedStyle(canvas);
    context.font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
    const people = history.flatMap(point => trafficSeries.map(series => point[series.field]));
    const maximum = Math.max(1, ...people);
    const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
    const step = Math.max(1, magnitude * [1, 2, 5, 10].find(value => value * magnitude >= maximum / 4));
    const limit = Math.ceil(maximum / step) * step;
    const left = context.measureText(limit.toLocaleString('ko-KR')).width + 14;
    const right = width - 26;
    const top = 14;
    const bottom = height - 23;
    const first = history[0].sim_time_s / 60;
    const last = Math.max(first + 1, history.at(-1).sim_time_s / 60);
    const xAt = minute => left + (minute - first) / (last - first) * (right - left);
    const yAt = count => bottom - count / limit * (bottom - top);
    context.fillStyle = styles.getPropertyValue('--muted').trim();
    context.strokeStyle = styles.getPropertyValue('--border').trim();
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let count = 0; count <= limit; count += step) {
      const y = yAt(count);
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(right, y);
      context.stroke();
      context.fillText(count.toLocaleString('ko-KR'), left - 7, y);
    }
    const tickCount = Math.max(2, Math.floor((right - left) / 75));
    const tick = [1, 2, 5, 10, 15, 30, 60].find(value => (last - first) / value <= tickCount) ?? 60;
    context.textAlign = 'center';
    for (let minute = Math.ceil(first / tick) * tick; minute <= last; minute += tick) {
      context.fillText(formatElapsedTime(minute), xAt(minute), bottom + 14);
    }

    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.lineWidth = 2.4;
    for (const {field, color, dash} of trafficSeries) {
      const stroke = styles.getPropertyValue(color).trim();
      context.strokeStyle = context.fillStyle = stroke;
      context.setLineDash(dash);
      context.beginPath();
      history.forEach((point, index) => {
        const x = xAt(point.sim_time_s / 60);
        const y = yAt(point[field]);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      if (history.length === 1) {
        context.beginPath();
        context.arc(left, yAt(history[0][field]), 3, 0, 2 * Math.PI);
        context.fill();
      }
    }
    context.setLineDash([]);
  }

  new ResizeObserver(draw).observe(canvas);
  return (samples, nextRunId) => {
    const latest = samples.at(-1);
    if (nextRunId === runId && latest?.sim_time_s === history.at(-1)?.sim_time_s) return;
    history = samples;
    runId = nextRunId;
    empty.hidden = Boolean(latest);
    canvas.setAttribute('aria-label', latest
      ? `방문객 흐름 그래프. 기록 ${samples.length}개. 마지막 기록은 경과 시간 ${formatElapsedTime(latest.sim_time_s / 60)} 기준 누적 입장 ${latest.entered_total}명, 누적 퇴장 ${latest.exited_total}명, 현재 체류 ${latest.present_people}명.`
      : '방문객 흐름 그래프');
    draw();
  };
}
