// Small SVG charts, one scale per chart, colors from the theme tokens.
type Series = { label: string; color: string; values: (number | null)[] };

export function Bars({ labels, series, unit, height = 150, flags = [] }: { labels: string[]; series: Series[]; unit: (v: number) => string; height?: number; flags?: boolean[] }) {
  const W = 600, H = height, L = 52, B = 22, T = 8;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const bw = (W - L - 4) / Math.max(1, labels.length);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={series.map((s) => s.label).join(', ')}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W} y1={y(max * f)} y2={y(max * f)} className="grid" />
          <text x={L - 6} y={y(max * f) + 3} textAnchor="end">{unit(max * f)}</text>
        </g>
      ))}
      {labels.map((lab, i) => {
        let acc = 0;
        return (
          <g key={lab}>
            {series.map((s) => {
              const v = s.values[i] || 0;
              const r = <rect key={s.label} x={L + i * bw + 1} width={Math.max(1, bw - 2)} y={y(acc + v)} height={y(acc) - y(acc + v)} fill={s.color}><title>{`${lab} ${s.label}: ${unit(v)}`}</title></rect>;
              acc += v;
              return r;
            })}
            {flags[i] && <rect x={L + i * bw + 1} width={Math.max(2, bw - 2)} y={y(0) + 2} height={4} fill="var(--bad)"><title>{`${lab}: a run failed`}</title></rect>}
          </g>
        );
      })}
      {labels.length > 0 && <text x={L} y={H - 6}>{labels[0]}</text>}
      {labels.length > 1 && <text x={W} y={H - 6} textAnchor="end">{labels[labels.length - 1]}</text>}
    </svg>
  );
}

export function Line({ labels, values, unit, height = 120 }: { labels: string[]; values: number[]; unit: (v: number) => string; height?: number }) {
  const W = 600, H = height, L = 52, B = 22, T = 10;
  if (values.length === 0) return <p className="muted">No data yet.</p>;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = hi === lo ? Math.max(1, hi * 0.05) : (hi - lo) * 0.1;
  const min = Math.max(0, lo - pad), max = hi + pad;
  const x = (i: number) => L + ((W - L - 8) * i) / Math.max(1, values.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="trend">
      <line x1={L} x2={W} y1={y(max)} y2={y(max)} className="grid" />
      <line x1={L} x2={W} y1={y(min)} y2={y(min)} className="grid" />
      <text x={L - 6} y={y(max) + 3} textAnchor="end">{unit(max)}</text>
      <text x={L - 6} y={y(min) + 3} textAnchor="end">{unit(min)}</text>
      <polygon points={`${x(0)},${y(min)} ${pts} ${x(values.length - 1)},${y(min)}`} className="area" />
      <polyline points={pts} className="stroke" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3.5} className="dot"><title>{`${labels[labels.length - 1]}: ${unit(values[values.length - 1])}`}</title></circle>
      <text x={L} y={H - 6}>{labels[0]}</text>
      <text x={W} y={H - 6} textAnchor="end">{labels[labels.length - 1]}</text>
    </svg>
  );
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
