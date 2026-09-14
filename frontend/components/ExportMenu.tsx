'use client';

import { useEffect, useRef, useState } from 'react';
import Icon, { type IconName } from '@/components/Icon';

export type ExportKind = 'report' | 'geojson' | 'csv' | 'print';

const ITEMS: Array<{ kind: ExportKind; icon: IconName; title: string; detail: string }> = [
  { kind: 'report', icon: 'file', title: 'Situation report', detail: 'Plain text for the incident log' },
  { kind: 'geojson', icon: 'layers', title: 'GIS package', detail: 'GeoJSON for ArcGIS or QGIS' },
  { kind: 'csv', icon: 'clock', title: 'Event log', detail: 'CSV for after-action review' },
  { kind: 'print', icon: 'printer', title: 'Print briefing', detail: 'Briefing and audit pages' },
];

export default function ExportMenu({ onExport }: { onExport: (kind: ExportKind) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
      } else if (event.key === 'Tab') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="xm" ref={rootRef}>
      <button ref={buttonRef} className="tool-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="download" size={17} />
        <span>Export</span>
      </button>
      {open && (
        <div className="xm-menu" role="menu" aria-label="Export">
          {ITEMS.map((item) => (
            <button key={item.kind} role="menuitem" className="xm-item" onClick={() => { setOpen(false); onExport(item.kind); }}>
              <Icon name={item.icon} size={18} />
              <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
