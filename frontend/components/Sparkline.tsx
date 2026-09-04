import React, { useId } from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  strokeWidth?: number;
}

export default function Sparkline({
  data,
  width = 120,
  drawDuration = 900,
  height = 36,
  stroke = '#1c8a64',
  strokeWidth = 2,
}: SparklineProps & { drawDuration?: number }) {
  const filterId = useId();
  const gradientId = useId();
  const drawId = useId();

  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} style={{ opacity: 0.2 }}>
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke={stroke} strokeWidth={1} strokeDasharray="3 3" />
      </svg>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min === 0 ? 1 : max - min;

  // Compute points with vertical padding
  const padding = 4;
  const points = data.map((val, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - padding - ((val - min) / range) * (height - 2 * padding);
    return { x, y };
  });

  const polylinePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Create the area path for a gradient fill below the sparkline
  const lastPoint = points[points.length - 1];
  const areaPoints = `0,${height} ${polylinePoints} ${width},${height}`;

  return (
    <svg width={width} height={height} style={{ overflow: 'visible', display: 'block' }} aria-hidden="true">
      <defs>
        {/* Glow filter */}
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Gradient fill */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.2" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.0" />
        </linearGradient>
        <style>{`
          @keyframes sparkline-pulse {
            0% { r: 2px; opacity: 0.6; }
            50% { r: 4px; opacity: 1; }
            100% { r: 2px; opacity: 0.6; }
          }
          .sparkline-pulse-dot {
            animation: sparkline-pulse 1.6s infinite ease-in-out;
          }
          @keyframes sparkline-draw {
            from { stroke-dashoffset: var(--sparkline-length); }
            to { stroke-dashoffset: 0; }
          }
          .sparkline-stroke {
            stroke-dasharray: var(--sparkline-length);
            animation: sparkline-draw ${drawDuration}ms cubic-bezier(.25,.1,.25,1) forwards;
          }
          .sparkline-area {
            animation: sparkline-fade 700ms ease-out ${Math.round(drawDuration * 0.55)}ms both;
          }
          @keyframes sparkline-fade {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @media (prefers-reduced-motion: reduce) {
            .sparkline-stroke { animation: none; stroke-dasharray: none; }
            .sparkline-area { animation: none; }
            .sparkline-pulse-dot { animation: none; }
          }
        `}</style>
      </defs>
      {/* Area path for gradient fill under the line */}
      <polygon points={areaPoints} fill={`url(#${gradientId})`} className="sparkline-area" />
      {/* Sparkline path: dash-drawn on each new data window so the line visibly flows */}
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polylinePoints}
        filter={`url(#${filterId})`}
        className="sparkline-stroke"
        style={{ '--sparkline-length': '420' } as React.CSSProperties}
        pathLength={420}
      />
      {/* Pulse circle at the last point */}
      <circle cx={lastPoint.x} cy={lastPoint.y} r={3} fill={stroke} className="sparkline-pulse-dot" />
    </svg>
  );
}
