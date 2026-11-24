import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useJsApiLoader } from '@react-google-maps/api';

const mapKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

function MapMessage({ loading, showList }: { loading?: boolean; showList: () => void }) {
  return (
    <div className="map-message">
      <p role="status">{loading ? 'Loading the map…' : 'The map is currently unavailable.'}</p>
      <button type="button" className="secondary-button" onClick={showList}>Browse events in List</button>
    </div>
  );
}

function MapLoader({ children, showList }: { children: ReactNode; showList: () => void }) {
  const [authFailed, setAuthFailed] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const target = window as Window & { gm_authFailure?: () => void };

  useLayoutEffect(() => {
    const previous = target.gm_authFailure;
    const onFailure = () => {
      setAuthFailed(true);
      previous?.();
    };
    target.gm_authFailure = onFailure;
    return () => {
      if (target.gm_authFailure === onFailure) target.gm_authFailure = previous;
    };
  }, [target]);

  const { isLoaded, loadError } = useJsApiLoader({ googleMapsApiKey: mapKey });
  useEffect(() => {
    if (isLoaded || loadError) return;
    const timeout = window.setTimeout(() => setTimedOut(true), 12_000);
    return () => window.clearTimeout(timeout);
  }, [isLoaded, loadError]);

  if (loadError || authFailed || (!isLoaded && timedOut)) return <MapMessage showList={showList} />;
  return isLoaded ? children : <MapMessage loading showList={showList} />;
}

export function MapSurface({ children, showList }: { children: ReactNode; showList: () => void }) {
  // A missing Maps key must never prevent people from browsing the event feed.
  return mapKey ? <MapLoader showList={showList}>{children}</MapLoader> : <MapMessage showList={showList} />;
}
