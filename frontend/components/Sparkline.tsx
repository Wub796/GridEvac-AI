interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  tone?: 'safe' | 'watch' | 'critical';
  label: string;
}

/** Minimal trend line: area wash, stroke, and a marker on the latest reading. */
export default function Sparkline({ data, width = 132, height = 30, tone = 'safe', label }: SparklineProps) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 3;
  const points = data.map((value, index) => [
    (index / (data.length - 1)) * width,
    height - pad - ((value - min) / range) * (height - pad * 2),
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg className={`spark spark--${tone}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <polygon className="spark-area" points={`0,${height} ${line} ${width},${height}`} />
      <polyline className="spark-line" points={line} pathLength={100} />
      <circle className="spark-dot" cx={lastX} cy={lastY} r={2.6} />
    </svg>
  );
}
