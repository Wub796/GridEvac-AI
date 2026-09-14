'use client';

import { useEffect, useState } from 'react';
import Icon from '@/components/Icon';
import { useSimulationStore } from '@/hooks/useSimulation';

const DISMISSED_KEY = 'gridevac-location-prompt';

/**
 * Asks for the device location from a dismissible card that says what the
 * location is for, instead of firing the browser prompt on page load. If the
 * browser already granted permission, the start is located quietly.
 */
export default function LocationPrompt() {
  const status = useSimulationStore((state) => state.locationStatus);
  const message = useSimulationStore((state) => state.locationMessage);
  const userLocation = useSimulationStore((state) => state.userLocation);
  const locateUser = useSimulationStore((state) => state.locateUser);
  const dismissLocationMessage = useSimulationStore((state) => state.dismissLocationMessage);
  const [promptVisible, setPromptVisible] = useState(false);

  useEffect(() => {
    if (!('geolocation' in navigator) || !window.isSecureContext) return;
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(DISMISSED_KEY) === 'dismissed'; } catch { /* private mode */ }
    const query = navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (!query) {
      setPromptVisible(!dismissed);
      return;
    }
    query.then((permission) => {
      if (permission.state === 'granted') void locateUser({ quiet: true });
      else setPromptVisible(!dismissed && permission.state === 'prompt');
    }).catch(() => setPromptVisible(!dismissed));
  }, [locateUser]);

  const dismiss = () => {
    setPromptVisible(false);
    try { window.localStorage.setItem(DISMISSED_KEY, 'dismissed'); } catch { /* asks again next visit */ }
  };

  if (status === 'requesting') {
    return (
      <div className="locate-card" role="status">
        <span className="locate-icon is-busy"><Icon name="locate" size={18} /></span>
        <div className="locate-copy">
          <strong>Finding your location…</strong>
          <span>Your browser may ask for permission first.</span>
        </div>
      </div>
    );
  }

  if (message && status !== 'located') {
    const title = status === 'outside' ? 'You are outside the mapped district' : status === 'denied' ? 'Location is blocked' : 'Could not use your location';
    const retry = status === 'error' || status === 'imprecise';
    return (
      <div className="locate-card locate-card--notice" role="status">
        <span className="locate-icon"><Icon name="locate" size={18} /></span>
        <div className="locate-copy">
          <strong>{title}</strong>
          <span>{message}</span>
        </div>
        <div className="locate-actions">
          {retry && <button className="button button-secondary button-small" onClick={() => void locateUser()}>Try again</button>}
          <button className="icon-button" onClick={dismissLocationMessage} aria-label="Dismiss"><Icon name="close" size={14} /></button>
        </div>
      </div>
    );
  }

  if (!promptVisible || userLocation) return null;
  return (
    <div className="locate-card">
      <span className="locate-icon"><Icon name="locate" size={18} /></span>
      <div className="locate-copy">
        <strong>Start from where you are</strong>
        <span>GridEvac snaps your location to the nearest passable street and routes from there. It stays in this browser and is never put in shared links or exports.</span>
      </div>
      <div className="locate-actions">
        <button className="button button-primary button-small" onClick={() => { setPromptVisible(false); void locateUser(); }}>Use my location</button>
        <button className="button button-ghost button-small" onClick={dismiss}>Not now</button>
      </div>
    </div>
  );
}
