import React, { useState, useRef, useCallback } from 'react';
import { GoogleMap, useJsApiLoader, MarkerF } from '@react-google-maps/api';
import { addEvent } from './firebase';
import { EventCategory } from './types';
import { CATEGORIES, CATEGORY_LIST, ADMIN_EMAIL } from './categories';
import { useAuth } from './contexts/AuthContext';
import { MAP_STYLE } from './mapStyle';
import { goBack, navigate } from './router';

const LIBRARIES: ('places')[] = ['places'];
const NYC_CENTER = { lat: 40.7128, lng: -74.006 };

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Admin() {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.email === ADMIN_EMAIL;
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EventCategory>('popup');
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [startTime, setStartTime] = useState(() => new Date());
  const [endTime, setEndTime] = useState(() => new Date(Date.now() + 2 * 60 * 60 * 1000));
  const [submitting, setSubmitting] = useState(false);
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<{ description: string; place_id: string }[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const autocompleteRef = useRef<google.maps.places.AutocompleteService | null>(null);
  const placesRef = useRef<google.maps.places.PlacesService | null>(null);

  const handleMapLoad = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
    autocompleteRef.current = new google.maps.places.AutocompleteService();
    placesRef.current = new google.maps.places.PlacesService(map);
  }, []);

  const handleMapClick = (e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    setLocation({ latitude: e.latLng.lat(), longitude: e.latLng.lng() });
    setAddress('');
    setSuggestions([]);
  };

  const handleAddressChange = (text: string) => {
    setAddress(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      if (!autocompleteRef.current) return;
      autocompleteRef.current.getPlacePredictions(
        {
          input: text.trim(),
          location: new google.maps.LatLng(40.7128, -74.006),
          radius: 50000,
        },
        (predictions) => {
          if (predictions) {
            setSuggestions(predictions.slice(0, 5).map((p) => ({ description: p.description, place_id: p.place_id })));
          }
        }
      );
    }, 300);
  };

  const handleSuggestionSelect = (placeId: string, desc: string) => {
    setAddress(desc);
    setSuggestions([]);
    if (!placesRef.current) return;
    placesRef.current.getDetails({ placeId, fields: ['geometry'] }, (place, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK && place?.geometry?.location) {
        const coord = { latitude: place.geometry.location.lat(), longitude: place.geometry.location.lng() };
        setLocation(coord);
        mapRef.current?.panTo({ lat: coord.latitude, lng: coord.longitude });
        mapRef.current?.setZoom(15);
      } else {
        alert('Failed to get location for that address.');
      }
    });
  };

  const handleSubmit = async () => {
    if (!isAdmin || submitting) return;
    if (!title.trim()) {
      alert('Please enter a title.');
      return;
    }
    if (!location) {
      alert('Please tap the map to set a location.');
      return;
    }
    if (endTime <= startTime) {
      alert('End time must be after start time.');
      return;
    }

    setSubmitting(true);
    try {
      await addEvent({
        title: title.trim(),
        description: description.trim(),
        category,
        latitude: location.latitude,
        longitude: location.longitude,
        startTime,
        endTime,
      });
      alert('Event created!');
      goBack();
    } catch (e: any) {
      alert(e.message || 'Failed to create event.');
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading || !isAdmin) {
    return (
      <div style={{ ...styles.container, padding: 24 }}>
        <p>{authLoading ? 'Loading account...' : 'Only the Pulse administrator can add events.'}</p>
        {!authLoading && !user && (
          <button onClick={() => navigate('/sign-in')}>Sign in</button>
        )}
        <button onClick={() => goBack()}>Back to map</button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.backButton} onClick={() => goBack()}>‹</button>
        <span style={styles.headerTitle}>Admin - Add Event</span>
        <span style={styles.headerSpacer} />
      </div>
      <div style={styles.scroll}>
        <div style={styles.scrollContent}>
          <span style={styles.label}>Title</span>
          <input
            style={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Free Pizza in Washington Sq Park"
          />

          <span style={styles.label}>Description (optional)</span>
          <textarea
            style={{ ...styles.input, ...styles.multiline }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Additional details..."
            rows={3}
          />

          <span style={styles.label}>Category</span>
          <div style={styles.categoryRow}>
            {CATEGORY_LIST.map((cat) => {
              const config = CATEGORIES[cat];
              const selected = category === cat;
              return (
                <button
                  key={cat}
                  style={{
                    ...styles.categoryButton,
                    backgroundColor: selected ? config.color : config.backgroundColor,
                  }}
                  onClick={() => setCategory(cat)}
                >
                  <span style={styles.categoryEmoji}>{config.emoji}</span>
                  <span style={{ ...styles.categoryLabel, color: selected ? '#fff' : config.color }}>
                    {config.label}
                  </span>
                </button>
              );
            })}
          </div>

          <span style={styles.label}>Location</span>
          <div style={styles.autocompleteContainer}>
            <input
              style={styles.input}
              value={address}
              onChange={(e) => handleAddressChange(e.target.value)}
              placeholder="Search for a place"
            />
            {suggestions.length > 0 && (
              <div style={styles.suggestionsContainer}>
                {suggestions.map((s) => (
                  <div
                    key={s.place_id}
                    style={styles.suggestionItem}
                    onClick={() => handleSuggestionSelect(s.place_id, s.description)}
                  >
                    <span style={styles.suggestionText}>{s.description}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <span style={styles.orText}>or tap the map</span>
          <div style={styles.mapContainer}>
            {isLoaded ? (
              <GoogleMap
                mapContainerStyle={styles.miniMap}
                center={NYC_CENTER}
                zoom={13}
                onLoad={handleMapLoad}
                onClick={handleMapClick}
                options={{ styles: MAP_STYLE, disableDefaultUI: true, clickableIcons: false }}
              >
                {location && (
                  <MarkerF
                    position={{ lat: location.latitude, lng: location.longitude }}
                    icon={{
                      path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
                      fillColor: CATEGORIES[category].color,
                      fillOpacity: 1,
                      strokeWeight: 0,
                      scale: 1.6,
                      anchor: new google.maps.Point(12, 22),
                    }}
                  />
                )}
              </GoogleMap>
            ) : (
              <div style={{ ...styles.miniMap, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14 }}>
                Loading map...
              </div>
            )}
            {location && (
              <div style={styles.coords}>
                {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
              </div>
            )}
          </div>

          <span style={styles.label}>Start Time</span>
          <input
            type="datetime-local"
            style={{ ...styles.input, ...styles.picker }}
            value={toLocalInputValue(startTime)}
            onChange={(e) => { const d = new Date(e.target.value); if (!isNaN(d.getTime())) setStartTime(d); }}
          />

          <span style={styles.label}>End Time</span>
          <input
            type="datetime-local"
            style={{ ...styles.input, ...styles.picker }}
            value={toLocalInputValue(endTime)}
            onChange={(e) => { const d = new Date(e.target.value); if (!isNaN(d.getTime())) setEndTime(d); }}
          />

          <button
            style={{ ...styles.submitButton, opacity: submitting ? 0.5 : 1 }}
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Creating...' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: '#fff',
  },
  header: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    padding: '0 12px',
    borderBottom: '1px solid #eee',
    flexShrink: 0,
  },
  backButton: {
    width: 40,
    background: 'none',
    border: 'none',
    fontSize: 28,
    color: '#2a7cff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    padding: 0,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: 600,
    color: '#1a1a1a',
  },
  headerSpacer: {
    width: 40,
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  scrollContent: {
    width: '100%',
    maxWidth: 640,
    padding: '20px 20px 40px',
    display: 'flex',
    flexDirection: 'column',
  },
  label: {
    fontSize: 15,
    fontWeight: 600,
    color: '#333',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    border: '1px solid #ddd',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    letterSpacing: -0.3,
    backgroundColor: '#fafafa',
    outline: 'none',
    fontFamily: 'inherit',
    width: '100%',
  },
  multiline: {
    minHeight: 80,
    resize: 'vertical',
  },
  categoryRow: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  categoryButton: {
    flexBasis: '30%',
    flexGrow: 1,
    padding: '12px 4px',
    border: 'none',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  categoryEmoji: {
    fontSize: 24,
    marginBottom: 4,
  },
  categoryLabel: {
    fontSize: 12,
    fontWeight: 600,
  },
  autocompleteContainer: {
    position: 'relative',
    zIndex: 2,
  },
  suggestionsContainer: {
    backgroundColor: '#fff',
    border: '1px solid #ddd',
    borderTop: 'none',
    borderRadius: '0 0 10px 10px',
    marginTop: -4,
  },
  suggestionItem: {
    padding: '12px',
    borderTop: '1px solid #eee',
    cursor: 'pointer',
  },
  suggestionText: {
    fontSize: 14,
    color: '#333',
    display: 'block',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  orText: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
    margin: '6px 0',
  },
  mapContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    border: '1px solid #ddd',
  },
  miniMap: {
    width: '100%',
    height: 200,
  },
  coords: {
    textAlign: 'center',
    padding: '6px 0',
    fontSize: 12,
    color: '#888',
    backgroundColor: '#f5f5f5',
  },
  picker: {
    alignSelf: 'flex-start',
    width: 'auto',
  },
  submitButton: {
    backgroundColor: '#333',
    color: '#fff',
    border: 'none',
    padding: '16px 0',
    borderRadius: 12,
    fontSize: 17,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 24,
    fontFamily: 'inherit',
  },
};
