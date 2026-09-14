'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Counts from the previous value to the new one on the compositor-free text
 * node, so a changing ETA reads as a change. React renders the initial text
 * once; the tween writes later values directly and never re-renders.
 */
export default function TweenNumber({ value, decimals = 1, className }: { value: number; decimals?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const [initial] = useState(() => value.toFixed(decimals));

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const from = shown.current;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(value - from) < 10 ** -decimals / 2) {
      shown.current = value;
      element.textContent = value.toFixed(decimals);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 560);
      const eased = 1 - (1 - progress) ** 4;
      shown.current = from + (value - from) * eased;
      element.textContent = shown.current.toFixed(decimals);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, decimals]);

  return <span ref={ref} className={className}>{initial}</span>;
}
