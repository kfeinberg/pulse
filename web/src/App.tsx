import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { GoogleMap, useJsApiLoader, OverlayViewF, OverlayView } from '@react-google-maps/api';
import { subscribeToUpcomingEvents, voteOnEvent, markInterested } from './firebase';
import { getAllVotes, setVote, getInterestedEvents, setInterested as setInterestedLocal, VoteType } from './votes';
import { CATEGORIES } from './categories';
import { MAP_STYLE } from './mapStyle';
import { AppEvent, EventCategory } from './types';

const NYC_CENTER = { lat: 40.7128, lng: -74.006 };
const WELCOME_KEY = 'pulse_welcomed';

function formatTime(millis: number) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(millis);
  const h = d.getHours();
  const hour = h % 12 || 12;
  const ampm = h < 12 ? 'AM' : 'PM';
  const min = d.getMinutes().toString().padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()}, ${hour}:${min} ${ampm}`;
}

function getDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function App() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
  });

  const [allEvents, setAllEvents] = useState<AppEvent[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AppEvent | null>(null);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [votes, setVotes] = useState<Record<string, VoteType>>({});
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(WELCOME_KEY));
  const [interestedMap, setInterestedMap] = useState<Record<string, boolean>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeCategories, setActiveCategories] = useState<Set<EventCategory>>(
    new Set(Object.keys(CATEGORIES) as EventCategory[])
  );
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showListView, setShowListView] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);

  // Load votes and interested from localStorage
  useEffect(() => {
    setVotes(getAllVotes());
    setInterestedMap(getInterestedEvents());
  }, []);

  // Get user location
  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
    );
  }, []);

  const handleVote = useCallback((event: AppEvent, voteType: 'up' | 'down') => {
    const previousVote = votes[event.id] ?? null;
    const newVote: VoteType = previousVote === voteType ? null : voteType;

    // Optimistic local update
    setEvents((prev) => prev.map((e) => {
      if (e.id !== event.id) return e;
      const updated = { ...e };
      if (previousVote === voteType) {
        if (voteType === 'up') updated.thumbsUp = (updated.thumbsUp ?? 0) - 1;
        else updated.thumbsDown = (updated.thumbsDown ?? 0) - 1;
      } else {
        if (voteType === 'up') updated.thumbsUp = (updated.thumbsUp ?? 0) + 1;
        else updated.thumbsDown = (updated.thumbsDown ?? 0) + 1;
        if (previousVote === 'up') updated.thumbsUp = (updated.thumbsUp ?? 0) - 1;
        if (previousVote === 'down') updated.thumbsDown = (updated.thumbsDown ?? 0) - 1;
      }
      return updated;
    }));

    setVotes((prev) => ({ ...prev, [event.id]: newVote }));
    setVote(event.id, newVote);

    setSelectedEvent((prev) => {
      if (!prev || prev.id !== event.id) return prev;
      return events.find((e) => e.id === event.id) ?? prev;
    });

    voteOnEvent(event.id, voteType, previousVote).catch(console.warn);
  }, [votes, events]);

  const handleInterested = useCallback((event: AppEvent) => {
    const wasInterested = !!interestedMap[event.id];
    const delta = wasInterested ? -1 : 1;

    setAllEvents((prev) => prev.map((e) =>
      e.id === event.id ? { ...e, interested: (e.interested ?? 0) + delta } : e
    ));
    setEvents((prev) => prev.map((e) =>
      e.id === event.id ? { ...e, interested: (e.interested ?? 0) + delta } : e
    ));
    setSelectedEvent((prev) => {
      if (!prev || prev.id !== event.id) return prev;
      return { ...prev, interested: (prev.interested ?? 0) + delta };
    });

    setInterestedMap((prev) => {
      const next = { ...prev };
      if (wasInterested) delete next[event.id];
      else next[event.id] = true;
      return next;
    });
    setInterestedLocal(event.id, !wasInterested);
    markInterested(event.id, wasInterested).catch(console.warn);
  }, [interestedMap]);

  const eventsSortedByDistance = useMemo(() => {
    if (!userLocation) return events;
    return [...events].sort((a, b) => {
      const distA = getDistanceMiles(userLocation.lat, userLocation.lng, a.latitude, a.longitude);
      const distB = getDistanceMiles(userLocation.lat, userLocation.lng, b.latitude, b.longitude);
      return distA - distB;
    });
  }, [events, userLocation]);

  const toggleCategory = useCallback((cat: EventCategory) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        if (next.size > 1) next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }, []);

  // Timeline snaps — every 2 hours for 72 hours
  const timelineSnaps = useMemo(() => {
    const snaps: { label: string; time: Date }[] = [];
    const now = new Date();
    const endTime = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    snaps.push({ label: 'Now', time: now });

    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const firstSnap = new Date(now);
    firstSnap.setMinutes(0, 0, 0);
    firstSnap.setHours(firstSnap.getHours() + (2 - (firstSnap.getHours() % 2)));

    for (let d = new Date(firstSnap); d <= endTime; d = new Date(d.getTime() + 2 * 60 * 60 * 1000)) {
      const daysFromToday = Math.floor((d.getTime() - todayStart.getTime()) / 86400000);
      const dayLabel = daysFromToday === 0 ? 'Today' : dayNames[d.getDay()];
      const h = d.getHours();
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const ampm = h < 12 ? 'AM' : 'PM';
      snaps.push({ label: `${dayLabel} ${hour12}${ampm}`, time: d });
    }
    return snaps;
  }, []);

  // Subscribe to Firestore
  useEffect(() => {
    const unsubscribe = subscribeToUpcomingEvents(setAllEvents);
    return () => unsubscribe();
  }, []);

  // Filter by timeline and category
  useEffect(() => {
    const selectedTime = timelineSnaps[timelineIndex].time.getTime();
    const filtered = allEvents.filter((event: any) => {
      const started = event.startTime.toMillis() <= selectedTime;
      const notEnded = event.endTime.toMillis() > selectedTime;
      return started && notEnded && activeCategories.has(event.category);
    });
    setEvents(filtered);
    setSelectedEvent((prev) => {
      if (!prev) return null;
      return filtered.find((e) => e.id === prev.id) ? prev : null;
    });
  }, [allEvents, timelineIndex, timelineSnaps, activeCategories]);

  const handleTimelineDrag = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const rawIndex = fraction * (timelineSnaps.length - 1);
    // Snap to "Now" (index 0) more easily to prevent flickering
    const index = rawIndex < 0.8 ? 0 : Math.round(rawIndex);
    setTimelineIndex(index);
  }, [timelineSnaps.length]);

  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    handleTimelineDrag(e);
    const onMove = (ev: MouseEvent) => handleTimelineDrag(ev as any);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [handleTimelineDrag]);

  const handleTrackTouchStart = useCallback((e: React.TouchEvent) => {
    handleTimelineDrag(e);
  }, [handleTimelineDrag]);

  if (!isLoaded) {
    return <div style={styles.loading}>Loading map...</div>;
  }

  return (
    <div style={styles.container}>
      <GoogleMap
        mapContainerStyle={styles.map}
        center={NYC_CENTER}
        zoom={13}
        options={{
          styles: MAP_STYLE,
          disableDefaultUI: true,
          zoomControl: true,
        }}
        onLoad={(map) => { mapInstanceRef.current = map; }}
        onClick={() => {
          setSelectedEvent(null);
          setTimelineOpen(false);
          setFiltersOpen(false);
          setShowListView(false);
        }}
      >
        {events.map((event) => {
          const category = CATEGORIES[event.category];
          return (
            <OverlayViewF
              key={event.id}
              position={{ lat: event.latitude, lng: event.longitude }}
              mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
            >
              <div
                style={styles.markerWrapper}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedEvent(event);
                  const bounds = mapInstanceRef.current?.getBounds();
                  if (bounds) {
                    const ne = bounds.getNorthEast();
                    const sw = bounds.getSouthWest();
                    const latSpan = ne.lat() - sw.lat();
                    const lngSpan = ne.lng() - sw.lng();
                    const margin = 0.25;
                    const isInner = event.latitude < ne.lat() - latSpan * margin &&
                      event.latitude > sw.lat() + latSpan * margin &&
                      event.longitude < ne.lng() - lngSpan * margin &&
                      event.longitude > sw.lng() + lngSpan * margin;
                    if (!isInner) {
                      mapInstanceRef.current?.panTo({ lat: event.latitude, lng: event.longitude });
                    }
                  }
                }}
              >
                <div style={{ ...styles.marker, backgroundColor: category.color }}>
                  <span style={styles.markerEmoji}>{category.emoji}</span>
                </div>
                <div style={{ ...styles.markerArrow, borderTopColor: category.color }} />
              </div>
            </OverlayViewF>
          );
        })}
      </GoogleMap>

      {/* Logo */}
      <div style={styles.logo}>
        <div style={styles.logoDot} />
        <span style={styles.logoText}>Pulse</span>
      </div>

      {/* Category filter toggle + pills */}
      <div style={styles.filterContainer}>
        <div
          style={styles.filterToggle}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          {filtersOpen ? (
            <span style={styles.filterToggleIcon}>✕</span>
          ) : (
            <div style={styles.layersIcon}>
              <div style={styles.layersDiamond} />
              <div style={{ ...styles.layersDiamond, ...styles.layersDiamondMid }} />
              <div style={{ ...styles.layersDiamond, ...styles.layersDiamondBack }} />
            </div>
          )}
        </div>
        {filtersOpen && (
          <div style={styles.filterColumn}>
            {(Object.keys(CATEGORIES) as EventCategory[]).map((key, i) => {
              const cat = CATEGORIES[key];
              const active = activeCategories.has(key);
              return (
                <div
                  key={key}
                  style={{
                    ...styles.filterPill,
                    backgroundColor: active ? cat.color : 'rgba(30, 30, 30, 0.5)',
                    opacity: active ? 1 : 0.5,
                    animation: `filter-in 0.2s ease-out ${i * 0.03}s both`,
                  }}
                  onClick={() => toggleCategory(key)}
                >
                  <span style={styles.filterEmoji}>{cat.emoji}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Event preview card */}
      {selectedEvent && (
        <div style={styles.previewCard}>
          <div style={styles.previewContent}>
            <span style={styles.previewEmoji}>
              {CATEGORIES[selectedEvent.category]?.emoji}
            </span>
            <div style={styles.previewText}>
              <div style={styles.previewTitle}>{selectedEvent.title}</div>
              {selectedEvent.location && (
                <div style={styles.previewLocation}>{selectedEvent.location}</div>
              )}
              <div style={styles.previewMeta}>
                <span>
                  {formatTime(selectedEvent.startTime.toMillis())} — {formatTime(selectedEvent.endTime.toMillis())}
                </span>
                {userLocation && (() => {
                  const miles = getDistanceMiles(userLocation.lat, userLocation.lng, selectedEvent.latitude, selectedEvent.longitude);
                  const label = miles < 0.1 ? '< 0.1 mi' : miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
                  return <span style={styles.previewDistance}> · {label}</span>;
                })()}
              </div>
            </div>
          </div>
          {selectedEvent.description && (
            <div style={styles.previewDescription}>{selectedEvent.description}</div>
          )}
          {selectedEvent.sourceUrl && (
            <a
              href={selectedEvent.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.sourceLink}
              onClick={(e) => e.stopPropagation()}
            >
              View details →
            </a>
          )}
          {selectedEvent.startTime.toMillis() > Date.now() ? (
            <div style={styles.cardActions}>
              <button
                style={{
                  ...styles.interestedButton,
                  ...(interestedMap[selectedEvent.id] ? styles.interestedButtonActive : {}),
                }}
                onClick={(e) => { e.stopPropagation(); handleInterested(selectedEvent); }}
              >
                <span>{interestedMap[selectedEvent.id] ? '⭐' : '☆'}</span>
                <span style={{
                  ...styles.interestedCount,
                  ...(interestedMap[selectedEvent.id] ? styles.interestedCountActive : {}),
                }}>
                  {(selectedEvent.interested ?? 0) > 0
                    ? `${selectedEvent.interested} interested`
                    : 'Interested'}
                </span>
              </button>
            </div>
          ) : (
            <div style={styles.voteRow}>
              <button
                style={{
                  ...styles.voteButton,
                  ...(votes[selectedEvent.id] === 'up' ? styles.voteButtonUp : {}),
                }}
                onClick={(e) => { e.stopPropagation(); handleVote(selectedEvent, 'up'); }}
              >
                <span>👍</span>
                <span style={{
                  ...styles.voteCount,
                  ...(votes[selectedEvent.id] === 'up' ? styles.voteCountActive : {}),
                }}>{selectedEvent.thumbsUp ?? 0}</span>
              </button>
              <button
                style={{
                  ...styles.voteButton,
                  ...(votes[selectedEvent.id] === 'down' ? styles.voteButtonDown : {}),
                }}
                onClick={(e) => { e.stopPropagation(); handleVote(selectedEvent, 'down'); }}
              >
                <span>👎</span>
                <span style={{
                  ...styles.voteCount,
                  ...(votes[selectedEvent.id] === 'down' ? styles.voteCountActive : {}),
                }}>{selectedEvent.thumbsDown ?? 0}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Timeline bar */}
      <div style={{
        ...styles.timelineBar,
        ...(timelineOpen ? {} : { right: 'auto' }),
      }}>
        <div
          style={styles.timelinePill}
          onClick={() => setTimelineOpen((v) => !v)}
        >
          <div style={styles.timelinePillDot} />
          <span style={{ ...styles.timelinePillText, ...(timelineOpen ? { minWidth: 72 } : {}) }}>
            {timelineIndex === 0 ? 'Now' : timelineSnaps[timelineIndex].label}
          </span>
        </div>
        {timelineOpen && (
          <div
            ref={trackRef}
            style={styles.timelineTrack}
            onMouseDown={handleTrackMouseDown}
            onTouchStart={handleTrackTouchStart}
            onTouchMove={handleTimelineDrag}
          >
            <div style={styles.trackLine} />
            {timelineSnaps.map((snap, i) => {
              const isActive = i === timelineIndex;
              const pct = (i / (timelineSnaps.length - 1)) * 100;
              return (
                <div key={i} style={{ ...styles.dotWrapper, left: `${pct}%` }}>
                  <div
                    style={{
                      ...styles.dot,
                      ...(isActive ? styles.dotActive : {}),
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* List toggle button */}
      <div
        style={styles.listToggleButton}
        onClick={() => { setShowListView((v) => !v); setSelectedEvent(null); }}
      >
        <span style={styles.listToggleText}>{showListView ? '✕' : '☰'}</span>
      </div>

      {/* List view panel */}
      {showListView && (
        <div style={styles.listPanel}>
          <div style={styles.listHeader}>
            <span style={styles.listTitle}>Nearby</span>
          </div>
          <div style={styles.listScroll}>
            {eventsSortedByDistance.map((event) => {
              const category = CATEGORIES[event.category];
              if (!category) return null;
              const dist = userLocation
                ? getDistanceMiles(userLocation.lat, userLocation.lng, event.latitude, event.longitude)
                : null;
              const distLabel = dist !== null
                ? dist < 0.1 ? '< 0.1 mi' : dist < 10 ? `${dist.toFixed(1)} mi` : `${Math.round(dist)} mi`
                : null;
              return (
                <div
                  key={event.id}
                  style={styles.listItem}
                  onClick={() => {
                    setSelectedEvent(event);
                    setShowListView(false);
                    setTimeout(() => {
                      mapInstanceRef.current?.panTo({ lat: event.latitude, lng: event.longitude });
                      mapInstanceRef.current?.setZoom(15);
                    }, 50);
                  }}
                >
                  <div style={{ ...styles.listItemDot, backgroundColor: category.color }}>
                    <span style={styles.listItemEmoji}>{category.emoji}</span>
                  </div>
                  <div style={styles.listItemContent}>
                    <div style={styles.listItemTitle}>{event.title}</div>
                    {event.location && (
                      <div style={styles.listItemLocation}>{event.location}</div>
                    )}
                    <div style={styles.listItemMeta}>
                      {formatTime(event.startTime.toMillis())}
                      {distLabel && (
                        <span style={styles.listItemDistance}> · {distLabel}</span>
                      )}
                    </div>
                  </div>
                  {(event.interested ?? 0) > 0 && (
                    <span style={styles.listItemInterested}>⭐ {event.interested}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Welcome modal */}
      {showWelcome && (
        <div style={styles.welcomeBackdrop}>
          <div style={styles.welcomeModal}>
            <div style={styles.welcomeHeader}>
              <div style={styles.welcomeDot} />
              <span style={styles.welcomeTitle}>Pulse</span>
            </div>
            <p style={styles.welcomeSubtitle}>
              What's happening in NYC right now
            </p>
            <div style={styles.welcomeCategories}>
              {(Object.keys(CATEGORIES) as EventCategory[]).map((key) => {
                const cat = CATEGORIES[key];
                return (
                  <div key={key} style={styles.welcomeRow}>
                    <div style={{ ...styles.welcomeSwatch, backgroundColor: cat.color }}>
                      <span style={styles.welcomeSwatchEmoji}>{cat.emoji}</span>
                    </div>
                    <span style={styles.welcomeLabel}>{cat.label}</span>
                  </div>
                );
              })}
            </div>
            <button
              style={styles.welcomeButton}
              onClick={() => {
                localStorage.setItem(WELCOME_KEY, '1');
                setShowWelcome(false);
              }}
            >
              Explore
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    position: 'relative',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: 18,
    color: '#999',
  },
  map: {
    width: '100%',
    height: '100%',
  },
  markerWrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    cursor: 'pointer',
    transform: 'translate(-50%, -100%)',
  },
  marker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid #fff',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
  },
  markerEmoji: {
    fontSize: 20,
  },
  markerArrow: {
    width: 0,
    height: 0,
    borderLeft: '8px solid transparent',
    borderRight: '8px solid transparent',
    borderTop: '8px solid',
    marginTop: -2,
  },
  previewCard: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 16,
    boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
    overflow: 'hidden',
  },
  previewContent: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  previewEmoji: {
    fontSize: 32,
    marginRight: 12,
  },
  previewText: {
    flex: 1,
    minWidth: 0,
  },
  previewTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: '#1a1a1a',
    marginBottom: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  previewLocation: {
    fontSize: 14,
    color: '#666',
    marginBottom: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  previewMeta: {
    fontSize: 13,
    color: '#999',
  },
  previewDistance: {
    color: '#2a7cff',
    fontWeight: 600,
  },
  sourceLink: {
    display: 'block',
    padding: '0 16px 12px',
    fontSize: 13,
    fontWeight: 600,
    color: '#2a7cff',
    textDecoration: 'none',
  },
  cardActions: {
    padding: '0 12px 12px',
  },
  interestedButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    borderRadius: 20,
    padding: '6px 14px',
    backgroundColor: '#f0f0f0',
    cursor: 'pointer',
    fontSize: 14,
    transition: 'background-color 0.2s',
  },
  interestedButtonActive: {
    backgroundColor: '#fff3cd',
  },
  interestedCount: {
    fontSize: 13,
    fontWeight: 600,
    color: '#666',
  },
  interestedCountActive: {
    color: '#b8860b',
  },
  voteRow: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '0 12px 12px',
  },
  voteButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    border: 'none',
    borderRadius: 20,
    padding: '6px 12px',
    backgroundColor: '#f0f0f0',
    cursor: 'pointer',
    fontSize: 14,
  },
  voteButtonUp: {
    backgroundColor: '#2a7cff',
  },
  voteButtonDown: {
    backgroundColor: '#ff4444',
  },
  voteCount: {
    fontSize: 12,
    fontWeight: 600,
    color: '#666',
  },
  voteCountActive: {
    color: '#fff',
  },
  previewDescription: {
    padding: '0 16px 16px',
    fontSize: 14,
    lineHeight: '20px',
    color: '#444',
  },
  timelineBar: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: '30%',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderRadius: 22,
    padding: '0 6px 0 0',
    gap: 0,
    userSelect: 'none',
  },
  timelinePill: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    padding: '10px 16px',
    gap: 8,
    cursor: 'pointer',
    flexShrink: 0,
  },
  timelinePillDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#fff',
  },
  timelinePillText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  timelineTrack: {
    position: 'relative',
    height: 20,
    flex: 1,
    cursor: 'pointer',
    marginRight: 10,
    display: 'flex',
    alignItems: 'center',
  },
  trackLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 1,
  },
  dotWrapper: {
    position: 'absolute',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  dotActive: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
    boxShadow: '0 0 8px rgba(255,255,255,0.5)',
  },
  filterContainer: {
    position: 'absolute',
    top: 52,
    right: 16,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    zIndex: 1,
  },
  filterToggle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.75)',
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
  },
  filterToggleActive: {
    backgroundColor: 'rgba(42, 124, 255, 0.85)',
  },
  filterToggleIcon: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
  },
  layersIcon: {
    width: 18,
    height: 18,
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  layersDiamond: {
    position: 'absolute' as const,
    width: 10,
    height: 10,
    transform: 'rotate(45deg)',
    border: '1.5px solid rgba(255, 255, 255, 0.9)',
    borderRadius: 1,
    top: 1,
  },
  layersDiamondMid: {
    top: 4,
    opacity: 0.7,
  },
  layersDiamondBack: {
    top: 7,
    opacity: 0.4,
  },
  filterColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  filterPill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    border: '2px solid #fff',
    boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
    transition: 'opacity 0.2s',
  },
  filterEmoji: {
    fontSize: 16,
  },
  logo: {
    position: 'absolute',
    top: 16,
    right: 16,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(30, 30, 30, 0.75)',
    borderRadius: 20,
    padding: '8px 14px 8px 10px',
    pointerEvents: 'none' as any,
  },
  logoDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ff5252',
    animation: 'pulse-dot 2s ease-in-out infinite',
  },
  logoText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 0.5,
  },
  listToggleButton: {
    position: 'absolute',
    bottom: 60,
    left: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    zIndex: 2,
  },
  listToggleText: {
    color: '#fff',
    fontSize: 18,
  },
  listPanel: {
    position: 'absolute',
    bottom: 108,
    left: 16,
    width: 340,
    maxHeight: 'calc(100% - 140px)',
    backgroundColor: '#fff',
    borderRadius: 16,
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
    overflow: 'hidden',
  },
  listHeader: {
    padding: '20px 20px 16px',
    borderBottom: '1px solid #eee',
  },
  listTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: '#1a1a1a',
  },
  listScroll: {
    flex: 1,
    overflowY: 'auto' as any,
  },
  listItem: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    padding: '14px 20px',
    borderBottom: '1px solid #f0f0f0',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  },
  listItemDot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    flexShrink: 0,
  },
  listItemEmoji: {
    fontSize: 18,
  },
  listItemContent: {
    flex: 1,
    minWidth: 0,
  },
  listItemTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#1a1a1a',
    marginBottom: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  listItemLocation: {
    fontSize: 13,
    color: '#666',
    marginBottom: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  listItemMeta: {
    fontSize: 12,
    color: '#999',
  },
  listItemDistance: {
    color: '#2a7cff',
    fontWeight: 600,
  },
  listItemInterested: {
    fontSize: 12,
    color: '#b8860b',
    fontWeight: 600,
    marginLeft: 8,
    flexShrink: 0,
  },
  welcomeBackdrop: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  welcomeModal: {
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    padding: '32px 36px',
    maxWidth: 320,
    width: '90%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  welcomeHeader: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  welcomeDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#ff5252',
    animation: 'pulse-dot 2s ease-in-out infinite',
  },
  welcomeTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: 0.5,
  },
  welcomeSubtitle: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 14,
    marginBottom: 24,
  },
  welcomeCategories: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    width: '100%',
    marginBottom: 28,
  },
  welcomeRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  welcomeSwatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeSwatchEmoji: {
    fontSize: 16,
  },
  welcomeLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 500,
  },
  welcomeButton: {
    backgroundColor: '#fff',
    color: '#1a1a1a',
    border: 'none',
    borderRadius: 12,
    padding: '12px 36px',
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: 0.3,
  },
};
