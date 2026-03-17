import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { GoogleMap, useJsApiLoader, OverlayViewF, OverlayView } from '@react-google-maps/api';
import { subscribeToUpcomingEvents, voteOnEvent } from './firebase';
import { getAllVotes, setVote, VoteType } from './votes';
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
  const trackRef = useRef<HTMLDivElement>(null);

  // Load votes from localStorage
  useEffect(() => {
    setVotes(getAllVotes());
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

  // Filter by timeline
  useEffect(() => {
    const selectedTime = timelineSnaps[timelineIndex].time.getTime();
    const filtered = allEvents.filter((event: any) => {
      const started = event.startTime.toMillis() <= selectedTime;
      const notEnded = event.endTime.toMillis() > selectedTime;
      return started && notEnded;
    });
    setEvents(filtered);
    setSelectedEvent((prev) => {
      if (!prev) return null;
      return filtered.find((e) => e.id === prev.id) ? prev : null;
    });
  }, [allEvents, timelineIndex, timelineSnaps]);

  const handleTimelineDrag = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const index = Math.round(fraction * (timelineSnaps.length - 1));
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
        onClick={() => {
          setSelectedEvent(null);
          setTimelineOpen(false);
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
              <div style={styles.previewTime}>
                {formatTime(selectedEvent.startTime.toMillis())} —{' '}
                {formatTime(selectedEvent.endTime.toMillis())}
              </div>
            </div>
          </div>
          {selectedEvent.description && (
            <div style={styles.previewDescription}>{selectedEvent.description}</div>
          )}
          {timelineIndex === 0 && (
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

      {/* Timeline */}
      {!timelineOpen ? (
        <div style={styles.timelinePill} onClick={() => setTimelineOpen(true)}>
          <div style={styles.timelinePillDot} />
          <span style={styles.timelinePillText}>
            {timelineIndex === 0 ? 'Now' : timelineSnaps[timelineIndex].label}
          </span>
        </div>
      ) : (
        <div style={styles.timelineContainer}>
          <div style={styles.timelineHeader}>
            <span style={styles.timelineLabel}>
              {timelineSnaps[timelineIndex].label}
            </span>
            <span
              style={styles.timelineClose}
              onClick={() => setTimelineOpen(false)}
            >
              ✕
            </span>
          </div>
          <div
            ref={trackRef}
            style={styles.timelineTrack}
            onMouseDown={handleTrackMouseDown}
            onTouchStart={handleTrackTouchStart}
            onTouchMove={handleTimelineDrag}
          >
            {timelineSnaps.map((snap, i) => {
              const isActive = i === timelineIndex;
              const isDay = snap.label.includes('12AM') || i === 0;
              const pct = (i / (timelineSnaps.length - 1)) * 100;
              return (
                <div key={i} style={{ ...styles.dotWrapper, left: `${pct}%` }}>
                  <div
                    style={{
                      ...styles.dot,
                      ...(isActive ? styles.dotActive : {}),
                    }}
                  />
                  {isDay && (
                    <span style={styles.tickLabel}>
                      {i === 0 ? 'Now' : snap.label.split(' ')[0]}
                    </span>
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
  previewTime: {
    fontSize: 13,
    color: '#999',
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
  timelinePill: {
    position: 'absolute',
    bottom: 32,
    left: 16,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderRadius: 20,
    padding: '10px 14px',
    gap: 8,
    cursor: 'pointer',
    userSelect: 'none',
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
  },
  timelineContainer: {
    position: 'absolute',
    bottom: 32,
    left: 16,
    right: 16,
    maxWidth: 600,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderRadius: 16,
    padding: '10px 12px 8px',
    userSelect: 'none',
  },
  timelineHeader: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  timelineLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    flex: 1,
    textAlign: 'center',
  },
  timelineClose: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 16,
    paddingLeft: 8,
    cursor: 'pointer',
  },
  timelineTrack: {
    position: 'relative',
    height: 36,
    cursor: 'pointer',
  },
  dotWrapper: {
    position: 'absolute',
    top: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    transform: 'translateX(-50%)',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  dotActive: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
    marginTop: -2,
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
  tickLabel: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 9,
    marginTop: 4,
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
