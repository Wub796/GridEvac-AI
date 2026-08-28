'use client';

import { useState } from 'react';

interface TutorialModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    title: "Welcome to GridEvac AI",
    content: (
      <>
        This platform acts as a <strong>3D emergency command center</strong> designed to optimize evacuation routing in downtown Houston, TX. It dynamically responds to flash flooding and electric substation outages.
      </>
    )
  },
  {
    title: "Flood Simulation",
    content: (
      <>
        Drag the <strong>Flood Level Slider</strong> (0–10) in the right sidebar. As the water level rises, low-lying intersections will flood (rendering in translucent blue) and the affected streets will turn <strong>danger red</strong> (impassable).
      </>
    )
  },
  {
    title: "Substation Failures & Overloads",
    content: (
      <>
        Click the <strong>Substation Toggles</strong> to simulate power outages. Active electrical load will be redistributed to nearby substations. Watch out! Drawing more load than capacity triggers <strong>Grid Overloads</strong> and can cause cascading system failures.
      </>
    )
  },
  {
    title: "Elevated Evacuation Routing",
    content: (
      <>
        Pick your <strong>Origin Waypoint</strong> (Nodes 0 to 224) in the sidebar; the system selects the safest exit automatically. Click <strong>Calculate Route</strong>. The engine computes the safest path, avoiding flooded zones and penalizing blackouts, shown as a <strong>pulsing green elevated corridor</strong> on the map.
      </>
    )
  },
  {
    title: "IsolationForest Anomaly HUD",
    content: (
      <>
        Our <strong>Machine Learning Model</strong> continuously evaluates grid stability (monitoring voltages, loads, and hazards) to score current threat severity (Low to Critical). View the scrolling telemetry logs at the bottom for live updates.
      </>
    )
  }
];

export default function TutorialModal({ isOpen, onClose }: TutorialModalProps) {
  const [currentStep, setCurrentStep] = useState(0);

  if (!isOpen) return null;

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onClose();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const step = STEPS[currentStep];

  return (
    <div className="tutorial-overlay" onClick={onClose}>
      <div className="tutorial-card" onClick={(e) => e.stopPropagation()}>
        <div className="tutorial-header">
          <h2>{step.title}</h2>
          <span className="tutorial-step-indicator">
            {currentStep + 1} / {STEPS.length}
          </span>
        </div>
        
        <div className="tutorial-body">
          <div style={{ minHeight: '80px', display: 'flex', alignItems: 'center' }}>
            <p style={{ margin: 0 }}>{step.content}</p>
          </div>
        </div>

        <div className="tutorial-footer">
          <button className="tutorial-btn-skip" onClick={onClose}>
            Skip Guide
          </button>
          
          <div className="tutorial-nav-btns">
            {currentStep > 0 && (
              <button className="tutorial-btn" onClick={handlePrev}>
                Back
              </button>
            )}
            <button className="tutorial-btn tutorial-btn--primary" onClick={handleNext}>
              {currentStep === STEPS.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
