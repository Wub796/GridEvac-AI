'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Scroll-linked motion without re-renders. Registered elements receive CSS
 * custom properties that stylesheets map onto transforms:
 *
 *   --enter     0 -> 1 while the element's top travels from the bottom of the
 *               viewport to 35% of its height (entrance choreography)
 *   --progress  0 -> 1 across the element's full pass through the viewport
 *   --through   0 -> 1 while the viewport centre crosses the element (timelines)
 *
 * One passive scroll listener and one rAF per frame serve every element.
 * Reduced motion pins all values at 1 so the resting layout shows.
 */
type Entry = { element: HTMLElement; last: string };

const entries = new Set<Entry>();
let root: HTMLElement | null = null;
let frame = 0;

const clamp = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function update() {
  frame = 0;
  if (!root) return;
  const bounds = root.getBoundingClientRect();
  const height = bounds.height || window.innerHeight;
  entries.forEach((entry) => {
    const rect = entry.element.getBoundingClientRect();
    const top = rect.top - bounds.top;
    const enter = clamp((height - top) / (height * 0.65));
    const progress = clamp((height - top) / (height + rect.height));
    const through = clamp((height * 0.5 - top) / Math.max(1, rect.height));
    const next = `${enter.toFixed(3)}|${progress.toFixed(3)}|${through.toFixed(3)}`;
    if (next === entry.last) return;
    entry.last = next;
    entry.element.style.setProperty('--enter', enter.toFixed(3));
    entry.element.style.setProperty('--progress', progress.toFixed(3));
    entry.element.style.setProperty('--through', through.toFixed(3));
  });
}

const schedule = () => {
  if (!frame) frame = requestAnimationFrame(update);
};

function attach() {
  if (root) return;
  root = document.querySelector<HTMLElement>('.content-scroll');
  if (!root) return;
  root.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
}

function detach() {
  if (entries.size || !root) return;
  root.removeEventListener('scroll', schedule);
  window.removeEventListener('resize', schedule);
  root = null;
}

export function useScrollProgress(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      ['--enter', '--progress', '--through'].forEach((name) => element.style.setProperty(name, '1'));
      return;
    }
    const entry: Entry = { element, last: '' };
    entries.add(entry);
    attach();
    schedule();
    return () => {
      entries.delete(entry);
      detach();
    };
  }, [ref]);
}
