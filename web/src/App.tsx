import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { GoogleMap, useJsApiLoader, OverlayViewF, OverlayView } from '@react-google-maps/api';
import { subscribeToUpcomingEvents, voteOnEvent, markInterested, signInWithGoogle, signOut, onAuthChange, User, createReport, subscribeToReports, confirmReport, addComment, subscribeToComments, deleteEvent, deleteReport, getUserProfile, isDisplayNameTaken, setUserProfile, deleteAccount, flagContent } from './firebase';
import { getAllVotes, setVote, getInterestedEvents, setInterested as setInterestedLocal, getConfirmedReports, setConfirmed as setConfirmedLocal, getHiddenContent, setHidden, VoteType } from './votes';
import { CATEGORIES, ADMIN_EMAIL } from './categories';
import { MAP_STYLE } from './mapStyle';
import { AppEvent, EventCategory, Comment, Report, ReportCategory, FlagReason } from './types';

const REPORT_CATEGORIES: Record<ReportCategory, { emoji: string; label: string; color: string }> = {
  live_music: { emoji: '🎵', label: 'Live Music', color: '#9b59b6' },
  free_stuff: { emoji: '🎁', label: 'Free Stuff', color: '#2ecc71' },
  popup: { emoji: '✨', label: 'Pop-up', color: '#e67e22' },
  long_line: { emoji: '🚶', label: 'Long Line', color: '#e74c3c' },
  street_performance: { emoji: '🎭', label: 'Street Performance', color: '#3498db' },
  other: { emoji: '📍', label: 'Other', color: '#95a5a6' },
};

const NYC_CENTER = { lat: 40.7128, lng: -74.006 };
const WELCOME_KEY = 'pulse_welcomed';
const HOUR_MS = 60 * 60 * 1000;
const MAIN_TIMELINE_HOURS = 24;
const UPCOMING_BROWSER_HOURS = 72;

function formatTime(millis: number) {
  const d = new Date(millis);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const h = d.getHours();
  const hour = h % 12 || 12;
  const ampm = h < 12 ? 'AM' : 'PM';
  const min = d.getMinutes().toString().padStart(2, '0');
  const time = `${hour}:${min} ${ampm}`;

  if (eventDay.getTime() === today.getTime()) return `Today, ${time}`;
  if (eventDay.getTime() === tomorrow.getTime()) return `Tomorrow, ${time}`;

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${time}`;
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
  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [showNameModal, setShowNameModal] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameChecking, setNameChecking] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthChange(async (u) => {
      setUser(u);
      if (u) {
        const profile = await getUserProfile(u.uid);
        if (profile) {
          setDisplayName(profile.displayName);
        } else {
          setShowNameModal(true);
          setNameInput(u.displayName || '');
        }
      } else {
        setDisplayName(null);
        setShowNameModal(false);
      }
    });
    return unsubscribe;
  }, []);

  const handleSetName = async () => {
    const name = nameInput.trim();
    if (!name || name.length < 2) {
      setNameError('Name must be at least 2 characters');
      return;
    }
    if (name.length > 20) {
      setNameError('Name must be 20 characters or less');
      return;
    }
    setNameChecking(true);
    setNameError(null);
    try {
      const taken = await isDisplayNameTaken(name);
      if (taken) {
        setNameError('That name is already taken');
        setNameChecking(false);
        return;
      }
      await setUserProfile(user!.uid, name, user!.photoURL || undefined);
      setDisplayName(name);
      setShowNameModal(false);
    } catch (err: any) {
      setNameError(err.message || 'Something went wrong');
    } finally {
      setNameChecking(false);
    }
  };

  return (
    <>
      {showNameModal && (
        <div style={styles.welcomeBackdrop}>
          <div style={styles.welcomeModal}>
            <div style={styles.welcomeHeader}>
              <div style={styles.welcomeDot} />
              <span style={styles.welcomeTitle}>Pulse</span>
            </div>
            <p style={styles.authSubtitle}>Choose a display name</p>
            <input
              style={styles.nameInput}
              placeholder="Display name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={20}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSetName(); }}
              autoFocus
            />
            {nameError && <p style={styles.nameError}>{nameError}</p>}
            <button
              style={{ ...styles.welcomeButton, opacity: nameChecking ? 0.6 : 1, marginTop: 12 }}
              disabled={nameChecking}
              onClick={handleSetName}
            >
              {nameChecking ? 'Checking...' : 'Continue'}
            </button>
          </div>
        </div>
      )}
      <AppContent user={user} displayName={displayName} />
    </>
  );
}

function AppContent({ user, displayName }: { user: User | null; displayName: string | null }) {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
  });

  const [allEvents, setAllEvents] = useState<AppEvent[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AppEvent | null>(null);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [listTimelineIndex, setListTimelineIndex] = useState(0);
  const [votes, setVotes] = useState<Record<string, VoteType>>({});
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(WELCOME_KEY));
  const [interestedMap, setInterestedMap] = useState<Record<string, boolean>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeCategories, setActiveCategories] = useState<Set<EventCategory>>(
    new Set(Object.keys(CATEGORIES) as EventCategory[])
  );
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showListView, setShowListView] = useState(false);
  const [reports, setReports] = useState<Report[]>([]);
  const [pinDropMode, setPinDropMode] = useState(false);
  const [pendingPin, setPendingPin] = useState<{ lat: number; lng: number } | null>(null);
  const [reportText, setReportText] = useState('');
  const [reportCategory, setReportCategory] = useState<ReportCategory>('other');
  const [submittingReport, setSubmittingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [confirmedMap, setConfirmedMap] = useState<Record<string, boolean>>({});
  const [flagMenuTarget, setFlagMenuTarget] = useState<{ type: 'comment' | 'report'; id: string; eventId?: string } | null>(null);
  const [hiddenMap, setHiddenMap] = useState<Record<string, boolean>>({});
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);

  // Load votes and interested from localStorage
  useEffect(() => {
    setVotes(getAllVotes());
    setInterestedMap(getInterestedEvents());
    setConfirmedMap(getConfirmedReports());
    setHiddenMap(getHiddenContent());
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
    const applyVoteUpdate = (e: AppEvent): AppEvent => {
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
    };
    setAllEvents((prev) => prev.map(applyVoteUpdate));
    setEvents((prev) => prev.map(applyVoteUpdate));

    setVotes((prev) => ({ ...prev, [event.id]: newVote }));
    setVote(event.id, newVote);

    setSelectedEvent((prev) => {
      if (!prev || prev.id !== event.id) return prev;
      const updated = { ...prev };
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
    });

    voteOnEvent(event.id, voteType, previousVote).catch(console.warn);
  }, [votes]);

  const handleFlag = async (reason: FlagReason) => {
    if (!flagMenuTarget) return;
    if (user) {
      await flagContent({
        contentType: flagMenuTarget.type,
        contentId: flagMenuTarget.id,
        eventId: flagMenuTarget.eventId,
        reason,
        reporterId: user.uid,
      });
    }
    setHidden(flagMenuTarget.id);
    setHiddenMap((prev) => ({ ...prev, [flagMenuTarget.id]: true }));
    if (flagMenuTarget.type === 'report') setSelectedReport(null);
    setFlagMenuTarget(null);
    alert('Thanks for helping keep Pulse safe.');
  };

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

  const eventsForMap = useMemo(() => {
    if (!selectedEvent || events.some((event) => event.id === selectedEvent.id)) return events;
    return [...events, selectedEvent];
  }, [events, selectedEvent]);

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

  // Main-screen timeline snaps — every 2 hours for the next 24 hours
  const timelineSnaps = useMemo(() => {
    const snaps: { label: string; time: Date }[] = [];
    const now = new Date();
    const endTime = new Date(now.getTime() + MAIN_TIMELINE_HOURS * HOUR_MS);
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

  const listTimelineSnaps = useMemo(() => {
    const snaps: { label: string; time: Date }[] = [];
    const now = new Date();
    const endTime = new Date(now.getTime() + UPCOMING_BROWSER_HOURS * HOUR_MS);
    snaps.push({ label: 'Now', time: now });

    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const firstSnap = new Date(now);
    firstSnap.setMinutes(0, 0, 0);
    firstSnap.setHours(firstSnap.getHours() + (2 - (firstSnap.getHours() % 2)));

    for (let d = new Date(firstSnap); d <= endTime; d = new Date(d.getTime() + 2 * HOUR_MS)) {
      const daysFromToday = Math.floor((d.getTime() - todayStart.getTime()) / (24 * HOUR_MS));
      const dayLabel = daysFromToday === 0 ? 'Today' : dayNames[d.getDay()];
      const h = d.getHours();
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const ampm = h < 12 ? 'AM' : 'PM';
      snaps.push({ label: `${dayLabel} ${hour12}${ampm}`, time: d });
    }
    return snaps;
  }, []);

  const listEvents = useMemo(() => {
    const selectedTime = listTimelineSnaps[listTimelineIndex]?.time.getTime() ?? Date.now();
    const filtered = allEvents.filter((event) =>
      event.startTime.toMillis() <= selectedTime &&
      event.endTime.toMillis() > selectedTime &&
      activeCategories.has(event.category)
    );
    if (!userLocation) {
      return filtered.sort((a, b) => a.startTime.toMillis() - b.startTime.toMillis());
    }
    return filtered.sort((a, b) =>
      getDistanceMiles(userLocation.lat, userLocation.lng, a.latitude, a.longitude) -
      getDistanceMiles(userLocation.lat, userLocation.lng, b.latitude, b.longitude)
    );
  }, [allEvents, activeCategories, listTimelineIndex, listTimelineSnaps, userLocation]);

  // Subscribe to Firestore
  useEffect(() => {
    const unsubscribe = subscribeToUpcomingEvents(setAllEvents);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToReports(setReports);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!selectedEvent) {
      setComments([]);
      return;
    }
    const unsubscribe = subscribeToComments(selectedEvent.id, setComments);
    return () => unsubscribe();
  }, [selectedEvent?.id]);

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
        onLoad={(map) => { mapInstanceRef.current = map; }}
        onClick={(e) => {
          if (pinDropMode && e.latLng) {
            setPendingPin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
            setPinDropMode(false);
            return;
          }
          setSelectedEvent(null);
          setSelectedReport(null);
          setTimelineOpen(false);
          setFiltersOpen(false);
          setShowProfileMenu(false);
          setShowListView(false);
        }}
        options={{
          styles: MAP_STYLE,
          disableDefaultUI: true,
          zoomControl: false,
          draggableCursor: pinDropMode ? 'crosshair' : undefined,
        }}
      >
        {eventsForMap.map((event) => {
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
                  setSelectedReport(null);
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
        {/* Report pins */}
        {reports.filter((r) => !hiddenMap[r.id]).map((report) => {
          const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.other;
          return (
            <OverlayViewF
              key={`report-${report.id}`}
              position={{ lat: report.latitude, lng: report.longitude }}
              mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
            >
              <div
                style={styles.markerWrapper}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedReport(report);
                  setSelectedEvent(null);
                }}
              >
                <div style={{ ...styles.reportMarker, borderColor: cat.color }}>
                  <span style={styles.markerEmoji}>{cat.emoji}</span>
                </div>
                <div style={{ ...styles.markerArrow, borderTopColor: cat.color }} />
              </div>
            </OverlayViewF>
          );
        })}
        {/* Pending pin preview */}
        {pendingPin && (
          <OverlayViewF
            position={pendingPin}
            mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
          >
            <div style={styles.markerWrapper}>
              <div style={styles.pendingMarker}>
                <span style={styles.markerEmoji}>📍</span>
              </div>
              <div style={{ ...styles.markerArrow, borderTopColor: '#ff5252' }} />
            </div>
          </OverlayViewF>
        )}
      </GoogleMap>

      {/* Logo + user */}
      <div style={styles.logo}>
        <div style={styles.logoDot} />
        <span style={styles.logoText}>Pulse</span>
        {user ? (
          <div style={styles.profileWrapper}>
            <div
              style={styles.userAvatar}
              onClick={() => setShowProfileMenu((v) => !v)}
              title={user.email || 'Account'}
            >
              {user.photoURL ? (
                <img src={user.photoURL} style={styles.userAvatarImg} referrerPolicy="no-referrer" />
              ) : (
                <span style={styles.userAvatarText}>
                  {(user.displayName || user.email || '?')[0].toUpperCase()}
                </span>
              )}
            </div>
            {showProfileMenu && (
              <div style={styles.profileMenu}>
                <a href="/privacy" style={styles.profileMenuItem}>Privacy Policy</a>
                <div
                  style={styles.profileMenuItem}
                  onClick={() => { setShowProfileMenu(false); signOut(); }}
                >
                  Sign out
                </div>
                <div
                  style={{ ...styles.profileMenuItem, color: '#ff4444', borderBottom: 'none' }}
                  onClick={() => {
                    if (confirm('Delete your account? This will permanently remove all your data and cannot be undone.')) {
                      setShowProfileMenu(false);
                      deleteAccount().catch((e) => alert(e.message || 'Failed to delete account'));
                    }
                  }}
                >
                  Delete Account
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            style={styles.signInButton}
            onClick={async () => {
              try { await signInWithGoogle(); } catch {}
            }}
          >
            Sign in
          </div>
        )}
      </div>

      {/* Privacy link (bottom corner, always visible) */}
      <a href="/privacy" style={styles.privacyCorner}>Privacy</a>

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
          {user?.email === ADMIN_EMAIL && !selectedEvent.sourceUrl && !(selectedEvent.sourceUrls?.length) && (
            <div
              style={styles.adminDelete}
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete "${selectedEvent.title}"?`)) {
                  deleteEvent(selectedEvent.id);
                  setSelectedEvent(null);
                }
              }}
            >✕</div>
          )}
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
          {(() => {
            const urls = selectedEvent.sourceUrls?.length
              ? selectedEvent.sourceUrls
              : selectedEvent.sourceUrl
                ? [selectedEvent.sourceUrl]
                : [];
            return urls.length > 0 ? (
              <div style={styles.sourceLinks}>
                {urls.map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.sourceLink}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {(() => {
                      try { return new URL(url).hostname.replace('www.', ''); }
                      catch { return url; }
                    })()}
                    {' '}→
                  </a>
                ))}
              </div>
            ) : null;
          })()}
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
          {/* Comments section */}
          <div style={styles.commentsSection}>
            {comments.length > 0 && (
              <div style={styles.commentsList}>
                {comments.filter((c) => !hiddenMap[c.id]).map((c) => (
                  <div key={c.id} style={styles.commentItem}>
                    <div style={styles.commentAvatar}>
                      {c.userPhoto ? (
                        <img src={c.userPhoto} style={styles.commentAvatarImg} referrerPolicy="no-referrer" />
                      ) : (
                        <span style={styles.commentAvatarText}>
                          {(c.userName || '?')[0].toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div style={styles.commentBody}>
                      <span style={styles.commentAuthor}>{c.userName}</span>
                      <span style={styles.commentText}>{c.text}</span>
                    </div>
                    <div style={styles.commentActions}>
                      <span style={styles.commentTime}>
                        {(() => {
                          const mins = Math.floor((Date.now() - c.createdAt.toMillis()) / 60000);
                          if (mins < 1) return 'now';
                          if (mins < 60) return `${mins}m`;
                          return `${Math.floor(mins / 60)}h`;
                        })()}
                      </span>
                      {(!user || c.userId !== user.uid) && (
                        <span
                          style={styles.flagButton}
                          onClick={(e) => { e.stopPropagation(); setFlagMenuTarget({ type: 'comment', id: c.id, eventId: selectedEvent?.id }); }}
                        >⚑</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {user ? (
              <div style={styles.commentInputRow}>
                <input
                  style={styles.commentInput}
                  placeholder="Add a comment..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  maxLength={280}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && commentText.trim()) {
                      e.preventDefault();
                      const text = commentText.trim();
                      setCommentText('');
                      setSubmittingComment(true);
                      addComment(selectedEvent.id, {
                        text,
                        userId: user.uid,
                        userName: displayName || user.displayName || 'Anonymous',
                        ...(user.photoURL ? { userPhoto: user.photoURL } : {}),
                      }).finally(() => setSubmittingComment(false));
                    }
                  }}
                />
                <button
                  style={{
                    ...styles.commentSend,
                    opacity: commentText.trim() && !submittingComment ? 1 : 0.4,
                  }}
                  disabled={!commentText.trim() || submittingComment}
                  onClick={() => {
                    if (!commentText.trim()) return;
                    const text = commentText.trim();
                    setCommentText('');
                    setSubmittingComment(true);
                    addComment(selectedEvent.id, {
                      text,
                      userId: user.uid,
                      userName: displayName || user.displayName || 'Anonymous',
                      ...(user.photoURL ? { userPhoto: user.photoURL } : {}),
                    }).finally(() => setSubmittingComment(false));
                  }}
                >
                  ↑
                </button>
              </div>
            ) : (
              <div
                style={styles.commentSignIn}
                onClick={() => signInWithGoogle().catch(() => {})}
              >
                Sign in to comment
              </div>
            )}
          </div>
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
        onClick={() => {
          if (!showListView) {
            const mapTime = timelineSnaps[timelineIndex]?.time.getTime() ?? Date.now();
            const closestIndex = listTimelineSnaps.reduce((bestIndex, snap, index) =>
              Math.abs(snap.time.getTime() - mapTime) <
              Math.abs(listTimelineSnaps[bestIndex].time.getTime() - mapTime)
                ? index
                : bestIndex
            , 0);
            setListTimelineIndex(closestIndex);
            setSelectedEvent(null);
          }
          setShowListView((visible) => !visible);
        }}
      >
        <span style={styles.listToggleText}>{showListView ? '✕' : '☰'}</span>
      </div>

      {/* Pin drop mode banner */}
      {pinDropMode && (
        <div style={styles.pinDropBanner}>
          Tap the map to drop a pin
        </div>
      )}

      {/* Report form */}
      {pendingPin && (
        <div style={styles.reportForm} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <div style={styles.reportFormHeader}>
            <span style={styles.reportFormTitle}>What's happening here?</span>
            <span
              style={styles.reportFormClose}
              onClick={() => { setPendingPin(null); setReportText(''); setReportCategory('other'); }}
            >✕</span>
          </div>
          <div style={styles.reportCategoryRow}>
            {(Object.keys(REPORT_CATEGORIES) as ReportCategory[]).map((key) => {
              const cat = REPORT_CATEGORIES[key];
              const active = reportCategory === key;
              return (
                <div
                  key={key}
                  style={{
                    ...styles.reportCategoryPill,
                    backgroundColor: active ? cat.color : '#f0f0f0',
                    color: active ? '#fff' : '#333',
                  }}
                  onClick={() => setReportCategory(key)}
                >
                  <span>{cat.emoji}</span>
                  <span style={{ fontSize: 12 }}>{cat.label}</span>
                </div>
              );
            })}
          </div>
          <input
            style={styles.reportInput}
            placeholder="Add a note (optional)"
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            maxLength={140}
          />
          {reportError && <p style={{ color: '#e74c3c', fontSize: 13, margin: '0 0 8px' }}>{reportError}</p>}
          <button
            style={{
              ...styles.reportSubmit,
              opacity: submittingReport ? 0.6 : 1,
            }}
            disabled={submittingReport}
            onClick={async (e) => {
              e.stopPropagation();
              if (!user || !pendingPin) return;
              setSubmittingReport(true);
              setReportError(null);
              try {
                await createReport({
                  text: reportText || REPORT_CATEGORIES[reportCategory].label,
                  category: reportCategory,
                  latitude: pendingPin.lat,
                  longitude: pendingPin.lng,
                  userId: user.uid,
                  userName: displayName || user.displayName || 'Anonymous',
                  ...(user.photoURL ? { userPhoto: user.photoURL } : {}),
                });
                setPendingPin(null);
                setReportText('');
                setReportCategory('other');
              } catch (err: any) {
                console.error('Failed to create report:', err);
                setReportError(err.message || 'Failed to drop pin');
              } finally {
                setSubmittingReport(false);
              }
            }}
          >
            {submittingReport ? 'Posting...' : 'Drop Pin'}
          </button>
        </div>
      )}

      {/* Selected report card */}
      {selectedReport && (
        <div style={styles.previewCard}>
          {user?.email === ADMIN_EMAIL && (
            <div
              style={styles.adminDelete}
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete this report?`)) {
                  deleteReport(selectedReport.id);
                  setSelectedReport(null);
                }
              }}
            >✕</div>
          )}
          <div style={styles.previewContent}>
            <span style={styles.previewEmoji}>
              {REPORT_CATEGORIES[selectedReport.category]?.emoji || '📍'}
            </span>
            <div style={styles.previewText}>
              <div style={styles.previewTitle}>{selectedReport.text}</div>
              <div style={styles.previewMeta}>
                <span>
                  {selectedReport.userName} · {(() => {
                    const mins = Math.floor((Date.now() - selectedReport.createdAt.toMillis()) / 60000);
                    if (mins < 1) return 'just now';
                    if (mins < 60) return `${mins}m ago`;
                    return `${Math.floor(mins / 60)}h ago`;
                  })()}
                </span>
              </div>
            </div>
          </div>
          <div style={styles.cardActions}>
            <button
              style={{
                ...styles.confirmButton,
                ...(confirmedMap[selectedReport.id] ? styles.confirmButtonActive : {}),
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (confirmedMap[selectedReport.id]) {
                  confirmReport(selectedReport.id, -1);
                  setSelectedReport({ ...selectedReport, confirmations: Math.max(0, selectedReport.confirmations - 1) });
                  setConfirmedMap((prev) => { const next = { ...prev }; delete next[selectedReport.id]; return next; });
                  setConfirmedLocal(selectedReport.id, false);
                } else {
                  confirmReport(selectedReport.id);
                  setSelectedReport({ ...selectedReport, confirmations: selectedReport.confirmations + 1 });
                  setConfirmedMap((prev) => ({ ...prev, [selectedReport.id]: true }));
                  setConfirmedLocal(selectedReport.id, true);
                }
              }}
            >
              <span>👍</span>
              <span style={{
                ...styles.confirmText,
                ...(confirmedMap[selectedReport.id] ? styles.confirmTextActive : {}),
              }}>
                {selectedReport.confirmations > 0
                  ? `${selectedReport.confirmations} confirmed`
                  : 'Still happening'}
              </span>
            </button>
            {(!user || selectedReport.userId !== user.uid) && (
              <span
                style={styles.flagButton}
                onClick={(e) => { e.stopPropagation(); setFlagMenuTarget({ type: 'report', id: selectedReport.id }); }}
              >⚑</span>
            )}
          </div>
        </div>
      )}

      {/* Point-in-time event list with a 72-hour time picker */}
      {showListView && (
        <div style={styles.listPanel}>
          <div style={styles.listHeader}>
            <span style={styles.listTitle}>
              {listTimelineIndex === 0 ? 'Happening now' : `Happening ${listTimelineSnaps[listTimelineIndex]?.label}`}
            </span>
            <span style={styles.listSubtitle}>Choose any time in the next 3 days</span>
          </div>
          <div style={styles.listTimeScroll}>
            {listTimelineSnaps.map((snap, index) => (
              <div
                key={index}
                style={{
                  ...styles.listTimePill,
                  ...(index === listTimelineIndex ? styles.listTimePillActive : {}),
                }}
                onClick={() => setListTimelineIndex(index)}
              >
                <span style={{
                  ...styles.listTimePillText,
                  ...(index === listTimelineIndex ? styles.listTimePillTextActive : {}),
                }}>
                  {snap.label}
                </span>
              </div>
            ))}
          </div>
          <div style={styles.listScroll}>
            {listEvents.length === 0 ? (
              <div style={styles.listEmpty}>No events are happening at this time.</div>
            ) : listEvents.map((event) => {
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
      {flagMenuTarget && (
        <div style={styles.flagOverlay} onClick={() => setFlagMenuTarget(null)}>
          <div style={styles.flagMenu} onClick={(e) => e.stopPropagation()}>
            <div style={styles.flagMenuTitle}>Why are you reporting this?</div>
            {([
              { value: 'spam' as FlagReason, label: 'Spam' },
              { value: 'inappropriate' as FlagReason, label: 'Inappropriate' },
              { value: 'harassment' as FlagReason, label: 'Harassment' },
              { value: 'misleading' as FlagReason, label: 'Misleading' },
            ]).map((r) => (
              <button key={r.value} style={styles.flagMenuItem} onClick={() => handleFlag(r.value)}>
                {r.label}
              </button>
            ))}
            <button style={styles.flagMenuCancel} onClick={() => setFlagMenuTarget(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  authScreen: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  authSpinner: {
    width: 32,
    height: 32,
    border: '3px solid rgba(255,255,255,0.2)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  authContent: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 32,
  },
  authHeader: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  authDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ff5252',
    animation: 'pulse-dot 2s ease-in-out infinite',
  },
  authTitle: {
    color: '#fff',
    fontSize: 48,
    fontWeight: 700,
    letterSpacing: -1,
  },
  authSubtitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 18,
    marginBottom: 40,
  },
  authError: {
    color: '#ff6b6b',
    fontSize: 14,
    marginBottom: 16,
  },
  nameInput: {
    width: '100%',
    backgroundColor: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 16,
    color: '#fff',
    outline: 'none',
    fontFamily: 'inherit',
    textAlign: 'center' as any,
  },
  nameError: {
    color: '#ff6b6b',
    fontSize: 13,
    marginTop: 8,
    marginBottom: 0,
  },
  authGoogleButton: {
    backgroundColor: '#fff',
    color: '#333',
    border: 'none',
    borderRadius: 12,
    padding: '14px 32px',
    fontSize: 17,
    fontWeight: 600,
    cursor: 'pointer',
    minWidth: 240,
  },
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
  adminDelete: {
    position: 'absolute' as any,
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ff4444',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    zIndex: 1,
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
  sourceLinks: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 16px 12px',
  },
  sourceLink: {
    display: 'block',
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
    top: 62,
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
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
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
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderRadius: 20,
    padding: '8px 14px 8px 10px',
    pointerEvents: 'auto' as any,
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
  profileWrapper: {
    position: 'relative' as const,
    marginLeft: 4,
  },
  profileMenu: {
    position: 'absolute' as const,
    top: 34,
    right: 0,
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    overflow: 'hidden',
    minWidth: 140,
    zIndex: 100,
  },
  profileMenuItem: {
    display: 'block',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 500,
    color: '#fff',
    cursor: 'pointer',
    textDecoration: 'none',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },
  privacyCorner: {
    position: 'absolute' as const,
    bottom: 8,
    right: 8,
    color: 'rgba(255,255,255,0.3)',
    fontSize: 11,
    textDecoration: 'none',
    zIndex: 1,
  },
  signInButton: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    marginLeft: 4,
    opacity: 0.8,
  },
  userAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    overflow: 'hidden',
    cursor: 'pointer',
    marginLeft: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  userAvatarImg: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  userAvatarText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
  },
  reportMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a1a',
    border: '2px solid',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
  },
  pendingMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ff5252',
    border: '2px solid #fff',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    animation: 'pulse-dot 1.5s ease-in-out infinite',
  },
  dropPinButton: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    zIndex: 2,
  },
  dropPinButtonActive: {
    backgroundColor: '#ff5252',
  },
  dropPinText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 300,
    lineHeight: '1',
  },
  pinDropBanner: {
    position: 'absolute',
    top: 60,
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    color: '#fff',
    padding: '10px 20px',
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 600,
    zIndex: 10,
  },
  reportForm: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 320,
    backgroundColor: '#fff',
    borderRadius: 16,
    boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
    padding: 16,
    zIndex: 10,
  },
  reportFormHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  reportFormTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: '#1a1a1a',
  },
  reportFormClose: {
    cursor: 'pointer',
    fontSize: 16,
    color: '#999',
    padding: '0 4px',
  },
  reportCategoryRow: {
    display: 'flex',
    flexWrap: 'wrap' as any,
    gap: 6,
    marginBottom: 12,
  },
  reportCategoryPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 10px',
    borderRadius: 16,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  reportInput: {
    width: '100%',
    border: '1px solid #e0e0e0',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 14,
    marginBottom: 12,
    outline: 'none',
    fontFamily: 'inherit',
  },
  reportSubmit: {
    width: '100%',
    backgroundColor: '#1a1a1a',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '12px 0',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  confirmButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    borderRadius: 20,
    padding: '6px 14px',
    backgroundColor: '#f0f0f0',
    cursor: 'pointer',
    fontSize: 14,
  },
  confirmButtonActive: {
    backgroundColor: '#2a7cff',
  },
  confirmText: {
    fontSize: 13,
    fontWeight: 600,
    color: '#666',
  },
  confirmTextActive: {
    color: '#fff',
  },
  commentsSection: {
    borderTop: '1px solid #eee',
  },
  commentsList: {
    maxHeight: 180,
    overflowY: 'auto' as any,
    padding: '8px 16px',
  },
  commentItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '6px 0',
  },
  commentAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    overflow: 'hidden',
    flexShrink: 0,
    backgroundColor: '#e0e0e0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentAvatarImg: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  commentAvatarText: {
    fontSize: 11,
    fontWeight: 700,
    color: '#666',
  },
  commentBody: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: '18px',
  },
  commentAuthor: {
    fontWeight: 600,
    color: '#1a1a1a',
    marginRight: 6,
  },
  commentText: {
    color: '#444',
  },
  commentActions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 2,
    flexShrink: 0,
  },
  commentTime: {
    fontSize: 11,
    color: '#aaa',
    marginTop: 2,
  },
  commentInputRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 12px',
    gap: 8,
  },
  commentInput: {
    flex: 1,
    border: '1px solid #e0e0e0',
    borderRadius: 20,
    padding: '8px 14px',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  commentSend: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1a1a1a',
    color: '#fff',
    border: 'none',
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  commentSignIn: {
    padding: '10px 16px',
    fontSize: 13,
    color: '#2a7cff',
    cursor: 'pointer',
    fontWeight: 500,
    textAlign: 'center' as any,
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
    display: 'flex',
    flexDirection: 'column',
  },
  listTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: '#1a1a1a',
  },
  listSubtitle: {
    fontSize: 12,
    color: '#777',
    marginTop: 3,
  },
  listTimeScroll: {
    display: 'flex',
    flexDirection: 'row',
    gap: 8,
    padding: '10px 14px',
    overflowX: 'auto' as any,
    flexShrink: 0,
    borderBottom: '1px solid #eee',
  },
  listTimePill: {
    padding: '8px 12px',
    borderRadius: 16,
    backgroundColor: '#f0f0f0',
    color: '#555',
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  listTimePillActive: {
    backgroundColor: '#1a1a1a',
  },
  listTimePillText: {
    fontSize: 12,
    fontWeight: 600,
    color: '#555',
  },
  listTimePillTextActive: {
    color: '#fff',
  },
  listEmpty: {
    padding: '42px 28px',
    color: '#777',
    fontSize: 14,
    textAlign: 'center' as const,
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
  flagButton: {
    cursor: 'pointer',
    fontSize: 15,
    color: '#999',
    userSelect: 'none',
  },
  flagOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  flagMenu: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 8,
    minWidth: 240,
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
  flagMenuTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#1a1a1a',
    padding: '12px 16px 8px',
    textAlign: 'center',
  },
  flagMenuItem: {
    display: 'block',
    width: '100%',
    padding: '12px 16px',
    border: 'none',
    background: 'none',
    fontSize: 14,
    color: '#333',
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: 8,
  },
  flagMenuCancel: {
    display: 'block',
    width: '100%',
    padding: '12px 16px',
    border: 'none',
    background: 'none',
    fontSize: 14,
    color: '#999',
    cursor: 'pointer',
    textAlign: 'center',
    borderTop: '1px solid #eee',
    marginTop: 4,
  },
};
