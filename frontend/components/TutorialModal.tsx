'use client';

import { useState } from 'react';

interface TutorialModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    title: 'Welcome to the operations desk',
    content: (
      <>
        GridEvac AI is a <strong>street-aware emergency planning workspace</strong> built on the real downtown Houston street network from OpenStreetMap. Use it to compare flood exposure, utility interruptions, and passable evacuation corridors before dispatching a response.
      </>
    ),
  },
  {
    title: 'Load a scenario',
    content: (
      <>
        In the route planning desk, start with <strong>Clear, Bayou rise, Feeder loss, or Heat peak</strong>. Presets change the modeled conditions and automatically recalculate the recommended route. You can fine-tune the water surface with the slider afterward.
      </>
    ),
  },
  {
    title: 'Select a real street origin',
    content: (
      <>
        Choose an intersection from the origin list, locate a node, or <strong>click any dry intersection on the map</strong>. Flooded origins are disabled so the planner never starts a response from an already submerged point.
      </>
    ),
  },
  {
    title: 'Read the route on the ground',
    content: (
      <>
        Routes follow real street centerlines and curves, clamped to the ground. The planner reports <strong>street distance, estimated travel time, road segments, and grouped driving instructions</strong> while actual OpenStreetMap building footprints keep blocks visibly separate from the corridor.
      </>
    ),
  },
  {
    title: 'Switch travel modes',
    content: (
      <>
        The <strong>Vehicle / On foot / EMS</strong> switch re-solves the corridor for different behavior: cars favor arterials, pedestrians take any street at walking pace, and EMS runs get priority routing. Distances stay the same - times change with the mode.
      </>
    ),
  },
  {
    title: 'Compare every exit',
    content: (
      <>
        The <strong>Exit corridors</strong> panel ranks all four perimeter exits by travel time for the current mode and scenario. Click a corridor to fly to that exit. <strong>Reachability rings</strong> show which intersections fall within a few minutes of the origin - the &ldquo;who can get out&rdquo; view.
      </>
    ),
  },
  {
    title: 'Share and export',
    content: (
      <>
        The <strong>⇗</strong> button copies a scenario link that opens the exact same operating picture for another responder. The <strong>⇩</strong> button exports a plain-text operator briefing with the route, steps, and alternates - ready for an incident log.
      </>
    ),
  },
  {
    title: 'Inspect what changed',
    content: (
      <>
        Toggle building footprints, road labels, intersections, substations, and utility links from the map layers section. The route audit shows closures, anomaly score, field notes, and the live operator event stream behind the recommendation.
      </>
    ),
  },
];

export default function TutorialModal({ isOpen, onClose }: TutorialModalProps) {
  const [currentStep, setCurrentStep] = useState(0);
  if (!isOpen) return null;

  const step = STEPS[currentStep];
  const handleNext = () => currentStep < STEPS.length - 1 ? setCurrentStep(currentStep + 1) : onClose();
  const handlePrev = () => { if (currentStep > 0) setCurrentStep(currentStep - 1); };

  return (
    <div className="tutorial-overlay" onClick={onClose}>
      <div className="tutorial-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={step.title}>
        <div className="tutorial-header">
          <h2>{step.title}</h2>
          <span className="tutorial-step-indicator">{currentStep + 1} / {STEPS.length}</span>
        </div>
        <div className="tutorial-body" key={currentStep}><p>{step.content}</p></div>
        <div className="tutorial-progress" aria-hidden="true"><i style={{ width: `${((currentStep + 1) / STEPS.length) * 100}%` }} /></div>
        <div className="tutorial-footer">
          <button className="tutorial-btn-skip" onClick={onClose}>Close guide</button>
          <div className="tutorial-nav-btns">
            {currentStep > 0 && <button className="tutorial-btn" onClick={handlePrev}>Back</button>}
            <button className="tutorial-btn tutorial-btn--primary" onClick={handleNext}>{currentStep === STEPS.length - 1 ? 'Finish' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
