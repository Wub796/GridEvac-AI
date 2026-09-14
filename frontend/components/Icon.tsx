import type { SVGProps } from 'react';

/** Stroke icons drawn on a 20px grid, 1.6px stroke, inheriting currentColor. */
const PATHS = {
  share: 'M8 11.5l4-3M8 8.5l4 3M5.5 12a2 2 0 100-4 2 2 0 000 4zm9-4.5a2 2 0 100-4 2 2 0 000 4zm0 9a2 2 0 100-4 2 2 0 000 4z',
  download: 'M10 3v9m0 0l-3.5-3.5M10 12l3.5-3.5M4 14.5V16h12v-1.5',
  help: 'M7.6 7.5a2.5 2.5 0 114 2c-.9.6-1.6 1.1-1.6 2.2M10 14.4v.1M10 17.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15z',
  close: 'M5 5l10 10M15 5L5 15',
  chevronRight: 'M8 5l5 5-5 5',
  chevronLeft: 'M12 5l-5 5 5 5',
  arrowUp: 'M10 16V4m0 0L5.5 8.5M10 4l4.5 4.5',
  water: 'M10 2.8S5 8.4 5 11.9a5 5 0 0010 0C15 8.4 10 2.8 10 2.8zM7.4 12.4a2.6 2.6 0 002.6 2.4',
  bolt: 'M11 2.5L5 11h4.5L8.5 17.5 15 9h-4.5z',
  route: 'M5 16.5a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM15 7.1a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6zM5 12.9V9a3 3 0 013-3h5.2',
  layers: 'M10 3l7 3.8-7 3.8-7-3.8zM3 10.4l7 3.8 7-3.8M3 13.9l7 3.8 7-3.8',
  chart: 'M3.5 16.5h13M6 13.5V9m4 4.5V5.5m4 8V11',
  barrier: 'M3 8h14v4H3zM6 8l-2 4m6-4l-2 4m6-4l-2 4m4-4l-2 4M5 12v4.5M15 12v4.5',
  compass: 'M10 17.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM12.8 7.2l-1.6 4-4 1.6 1.6-4z',
  cube: 'M10 2.8l6 3.4v7.6l-6 3.4-6-3.4V6.2zM4 6.2l6 3.4 6-3.4M10 9.6v7.6',
  expand: 'M3.5 7.5v-4h4m5 0h4v4m0 5v4h-4m-5 0h-4v-4',
  search: 'M9 15a6 6 0 100-12 6 6 0 000 12zm4.3-1.7L17 17',
  pin: 'M10 17.5s5.5-5.2 5.5-9.5a5.5 5.5 0 00-11 0c0 4.3 5.5 9.5 5.5 9.5zM10 10a2 2 0 100-4 2 2 0 000 4z',
  clock: 'M10 17.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM10 6v4.2l2.8 1.8',
  file: 'M6 2.5h5.5L15 6v11.5H6zM11.5 2.5V6H15M8 10h5M8 13h5',
  printer: 'M5.5 7.5V3h9v4.5M5.5 14H3.5V8h13v6h-2M5.5 11.5h9v6h-9z',
  plus: 'M10 4v12M4 10h12',
  minus: 'M4 10h12',
  check: 'M4 10.5l3.5 3.5L16 5.5',
  alert: 'M10 3L2.5 16.5h15zM10 8v4M10 14.2v.1',
  people: 'M7.5 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM2.8 16.5a4.8 4.8 0 019.4 0M13.2 9a2.2 2.2 0 000-4.4M14.5 12.2a4.4 4.4 0 012.8 4.3',
  building: 'M4 17.5V3.5h8v14M12 7.5h4v10M6.5 6.5h3M6.5 9.5h3M6.5 12.5h3M2.5 17.5h15',
  depart: 'M10 16.5v-10m0 0L6.5 10M10 6.5l3.5 3.5M6 3.5h8',
  continue: 'M10 17V3.5m0 0L6.5 7M10 3.5L13.5 7',
  'turn-right': 'M6 17v-6.5A3 3 0 019 7.5h6.5m0 0L12.5 4.5m3 3l-3 3',
  'turn-left': 'M14 17v-6.5a3 3 0 00-3-3H4.5m0 0l3-3m-3 3l3 3',
  'slight-right': 'M7 17v-5.5l6.5-6.5m0 0H9m4.5 0v4.5',
  'slight-left': 'M13 17v-5.5L6.5 5m0 0H11M6.5 5v4.5',
  'sharp-right': 'M6 3.5V14a2.5 2.5 0 004.3 1.7L15 11m0 0h-4.5M15 11v4.5',
  'sharp-left': 'M14 3.5V14a2.5 2.5 0 01-4.3 1.7L5 11m0 0h4.5M5 11v4.5',
  uturn: 'M6.5 17V8.5a3.5 3.5 0 017 0V13m0 0l-3-3m3 3l3-3',
  arrive: 'M10 17.5s5-4.7 5-8.6a5 5 0 00-10 0c0 3.9 5 8.6 5 8.6zM8 9l1.5 1.5L12.5 7.5',
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <path d={PATHS[name] ?? PATHS.continue} />
    </svg>
  );
}
