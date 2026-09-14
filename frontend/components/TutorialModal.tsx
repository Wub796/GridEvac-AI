'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Icon from '@/components/Icon';

const STEPS: Array<{ title: string; body: ReactNode }> = [
  {
    title: 'Start from a scenario',
    body: <>Load a preset or drag the <strong>water surface</strong>. Levels map to real elevations in metres NAVD88 on USGS terrain, so water fills the bayou corridors first. <strong>Use live reading</strong> sets the water to today&rsquo;s Buffalo Bayou gage.</>,
  },
  {
    title: 'Set where people start',
    body: <>Choose <strong>Use my location</strong> to start from the nearest passable street to you, or click a dry junction on the map. Vehicle routes obey one-way streets; on-foot routes use sidewalks in both directions. Your location stays in the browser.</>,
  },
  {
    title: 'Close streets you know are blocked',
    body: <>Turn on <strong>Close streets</strong> (or press <kbd>C</kbd>) and click any street segment: a stalled truck, downed line, or police barricade. The route re-solves around it. Click again to reopen.</>,
  },
  {
    title: 'Read the recommendation',
    body: <>The corridor is the safest one, not only the fastest. Penalties for flooded approaches and blackout districts decide the order; the minutes you see are real travel time. The audit lists every turn and every exit.</>,
  },
  {
    title: 'Know when a route will be cut off',
    body: <><strong>Trigger points</strong> show the water surface at which each exit and shelter stops being reachable, and which street floods first. The gap to today&rsquo;s water is your decision window.</>,
  },
  {
    title: 'Plan for everyone leaving',
    body: <>Set <strong>evacuation demand</strong> to see congested travel times, the time to clear the district, and whether reachable shelters can hold everyone.</>,
  },
  {
    title: 'Hand it off',
    body: <><strong>Share</strong> copies a link to this exact scenario. <strong>Export</strong> produces a situation report, a GeoJSON package for GIS, or the event log. Coordinates include U.S. National Grid references. Press <kbd>?</kbd> to reopen this guide, <kbd>1</kbd>&ndash;<kbd>3</kbd> to jump between sections.</>,
  },
];

export default function TutorialModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setStep(0);
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>('.guide-primary')?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      } else if (event.key === 'ArrowRight') {
        setStep((value) => Math.min(STEPS.length - 1, value + 1));
      } else if (event.key === 'ArrowLeft') {
        setStep((value) => Math.max(0, value - 1));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnFocus.current?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="guide-overlay" onClick={onClose}>
      <div ref={dialogRef} className="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title" onClick={(event) => event.stopPropagation()}>
        <header className="guide-head">
          <span className="guide-count">{step + 1} of {STEPS.length}</span>
          <button className="icon-button" onClick={onClose} aria-label="Close guide"><Icon name="close" size={16} /></button>
        </header>
        <div className="guide-body" key={step}>
          <h2 id="guide-title">{current.title}</h2>
          <p>{current.body}</p>
        </div>
        <div className="guide-dots" aria-hidden="true">
          {STEPS.map((_, index) => <i key={index} className={index === step ? 'is-active' : index < step ? 'is-done' : ''} />)}
        </div>
        <footer className="guide-foot">
          <button className="button button-ghost" onClick={() => setStep(step - 1)} disabled={step === 0}>Back</button>
          <button className="button button-primary guide-primary" onClick={() => (last ? onClose() : setStep(step + 1))}>{last ? 'Start planning' : 'Next'}</button>
        </footer>
      </div>
    </div>
  );
}
