import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { GoogleMap, OverlayViewF, OverlayView } from '@react-google-maps/api';
import { subscribeToUpcomingEvents, voteOnEvent, markInterested, signInWithGoogle, signOut, onAuthChange, User, createReport, subscribeToReports, confirmReport, addComment, subscribeToComments, deleteEvent, deleteReport, getUserProfile, isDisplayNameTaken, setUserProfile, deleteAccount, flagContent } from './firebase';
import { getAllVotes, setVote, getInterestedEvents, setInterested as setInterestedLocal, getConfirmedReports, setConfirmed as setConfirmedLocal, getHiddenContent, setHidden, VoteType } from './votes';
import { CATEGORIES, ADMIN_EMAIL } from './categories';
import { MAP_STYLE } from './mapStyle';
import { AppEvent, EventCategory, Comment, Report, ReportCategory, FlagReason } from './types';
import { browseDays, dateKey, eventTimeLabel, hourOptions, matchesTime, timeLabel } from './browseTime';
import { MapSurface } from './MapSurface';
import { PanelDialog } from './PanelDialog';
import './app.css';

const REPORT_CATEGORIES: Record<ReportCategory, { emoji: string; label: string; color: string }> = {
  live_music: { emoji: '🎵', label: 'Live Music', color: '#9b59b6' },
  free_stuff: { emoji: '🎁', label: 'Free Stuff', color: '#2ecc71' },
  popup: { emoji: '✨', label: 'Pop-up', color: '#e67e22' },
  long_line: { emoji: '🚶', label: 'Long Line', color: '#e74c3c' },
  street_performance: { emoji: '🎭', label: 'Street Performance', color: '#3498db' },
  other: { emoji: '📍', label: 'Other', color: '#95a5a6' },
};

const NYC_CENTER = { lat: 40.7128, lng: -74.006 };
const CATEGORY_KEYS = Object.keys(CATEGORIES) as EventCategory[];

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
    if (!user || nameChecking) return;
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
      await setUserProfile(user.uid, name, user.photoURL || undefined);
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
        <PanelDialog titleId="profile-name-title" className="profile-dialog" close={() => setShowNameModal(false)}>
          <div style={styles.welcomeModal}>
            <div style={styles.welcomeHeader}>
              <div style={styles.welcomeDot} />
              <span style={styles.welcomeTitle}>Pulse</span>
            </div>
            <h2 id="profile-name-title" style={styles.authSubtitle}>Choose a display name</h2>
            <input
              style={styles.nameInput}
              placeholder="Display name"
              aria-label="Display name"
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
            <button className="text-button" onClick={() => setShowNameModal(false)}>Not now</button>
          </div>
        </PanelDialog>
      )}
      <AppContent user={user} displayName={displayName} />
    </>
  );
}

function AppContent({ user, displayName }: { user: User | null; displayName: string | null }) {
  const [allEvents, setAllEvents] = useState<AppEvent[]>([]);
  const [feedStatus, setFeedStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [feedAttempt, setFeedAttempt] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<number | 'all' | 'now'>('all');
  const [now, setNow] = useState(Date.now);
  const [votes, setVotes] = useState<Record<string, VoteType>>({});
  const [interestedMap, setInterestedMap] = useState<Record<string, boolean>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeCategories, setActiveCategories] = useState<Set<EventCategory>>(
    new Set(CATEGORY_KEYS)
  );
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [showListView, setShowListView] = useState(true);
  const [mapVisited, setMapVisited] = useState(false);
  const [signInError, setSignInError] = useState(false);
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
  const mapInstanceRef = useRef<google.maps.Map | null>(null);

  // Load votes and interested from localStorage
  useEffect(() => {
    setVotes(getAllVotes());
    setInterestedMap(getInterestedEvents());
    setConfirmedMap(getConfirmedReports());
    setHiddenMap(getHiddenContent());
  }, []);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  const toggleNearby = () => {
    if (userLocation) { setUserLocation(null); return; }
    if (!navigator.geolocation) { setLocationStatus('error'); return; }
    setLocationStatus('loading');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setUserLocation({ lat: coords.latitude, lng: coords.longitude });
        setLocationStatus('idle');
      },
      () => setLocationStatus('error'),
      { timeout: 10_000 },
    );
  };

  const handleSignIn = async () => {
    setSignInError(false);
    try { await signInWithGoogle(); } catch { setSignInError(true); }
  };

  const selectView = (list: boolean) => {
    setShowListView(list);
    if (!list) setMapVisited(true);
    setSelectedEventId(null);
    setSelectedReport(null);
    setShowProfileMenu(false);
  };

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

    setVotes((prev) => ({ ...prev, [event.id]: newVote }));
    setVote(event.id, newVote);

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
    setInterestedMap((prev) => {
      const next = { ...prev };
      if (wasInterested) delete next[event.id];
      else next[event.id] = true;
      return next;
    });
    setInterestedLocal(event.id, !wasInterested);
    markInterested(event.id, wasInterested).catch(console.warn);
  }, [interestedMap]);

  const toggleCategory = useCallback((cat: EventCategory) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }, []);

  const dayOptions = useMemo(() => browseDays(now), [now]);
  const selectedDay = dayOptions.find((option) => option.key === day) ?? dayOptions[0];
  const isToday = selectedDay.key === dayOptions[0].key;
  const timeChoice = time === 'now' && isToday ? 'now'
    : typeof time === 'number' && selectedDay.hours.includes(time) ? time : 'all';
  const selectedTime = timeChoice === 'now' ? now : timeChoice;
  const timeOptions = hourOptions(selectedDay.hours);
  const selectedEvent = allEvents.find((event) => event.id === selectedEventId);
  const dayHeading = ['Today', 'Tomorrow'].includes(selectedDay.label) ? selectedDay.label.toLowerCase() : `on ${selectedDay.label}`;
  const title = timeChoice === 'now' ? 'Happening now'
    : `Events ${dayHeading}${selectedTime === 'all' ? '' : ` at ${timeLabel(selectedTime)}`}`;
  const events = useMemo(() => allEvents.filter((event) =>
    activeCategories.has(event.category) && matchesTime(event.startTime.toMillis(), event.endTime.toMillis(), selectedDay.key, selectedTime, now)
  ).sort((a, b) => {
    if (userLocation) {
      const distance = (event: AppEvent) => getDistanceMiles(userLocation.lat, userLocation.lng, event.latitude, event.longitude);
      const difference = distance(a) - distance(b);
      if (difference) return difference;
    }
    return Math.max(a.startTime.toMillis(), now) - Math.max(b.startTime.toMillis(), now)
      || a.endTime.toMillis() - b.endTime.toMillis();
  }), [allEvents, activeCategories, selectedDay.key, selectedTime, now, userLocation]);

  const retryFeed = () => { setFeedStatus('loading'); setFeedAttempt((attempt) => attempt + 1); };
  const resetFilters = () => { setDay(null); setTime('all'); setActiveCategories(new Set(CATEGORY_KEYS)); };
  useEffect(() => subscribeToUpcomingEvents((data) => {
    setAllEvents(data);
    setFeedStatus('ready');
  }, () => setFeedStatus('error')), [feedAttempt]);

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

  return (
    <div className="pulse-app">
      <header className="site-header">
        <div className="header-inner">
          <div className="wordmark"><span className="pulse-dot" aria-hidden="true" />Pulse</div>
          <div className="view-switch" role="group" aria-label="Event view">
            <button aria-pressed={showListView} onClick={() => selectView(true)}>List</button>
            <button aria-pressed={!showListView} onClick={() => selectView(false)}>Map</button>
          </div>
          <div className="account">
            {user ? (
              <>
                <button className="account-button account-avatar" aria-label="Account" aria-expanded={showProfileMenu} onClick={() => setShowProfileMenu((value) => !value)}>
                  {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : (user.displayName || user.email || '?')[0].toUpperCase()}
                </button>
                {showProfileMenu && (
                  <div className="account-menu" onKeyDown={(event) => { if (event.key === 'Escape') {
                    event.currentTarget.parentElement?.querySelector('button')?.focus();
                    setShowProfileMenu(false);
                  } }}>
                    <a href="/privacy">Privacy policy</a>
                    <button onClick={() => { setShowProfileMenu(false); signOut().catch(() => alert('Could not sign out. Please try again.')); }}>Sign out</button>
                    <button className="danger" onClick={() => {
                      if (confirm('Delete your account? This will permanently remove all your data and cannot be undone.')) {
                        setShowProfileMenu(false);
                        deleteAccount().catch((error) => alert(error.message || 'Failed to delete account'));
                      }
                    }}>Delete account</button>
                  </div>
                )}
              </>
            ) : <button className="account-button" onClick={handleSignIn}>Sign in</button>}
          </div>
        </div>
      </header>
      {signInError && !selectedEvent && <p className="notice" role="alert">Could not sign in with Google. Allow pop-ups and try again.</p>}
      <main className="browse-main">
        <section className="browse-intro" aria-labelledby="browse-title">
          <p className="eyebrow">NEW YORK CITY</p>
          <h1 id="browse-title">{title}</h1>
          <div className="browse-toolbar">
            <label className="field">Day<select value={selectedDay.key} onChange={(event) => { setDay(event.target.value); setTime('all'); }}>
              {dayOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select></label>
            <label className="field">Time (NYC)<select value={timeChoice} onChange={(event) => {
              const value = event.target.value;
              setTime(value === 'all' || value === 'now' ? value : Number(value));
            }}>
              <option value="all">{selectedDay === dayOptions[0] ? 'Rest of today' : 'All day'}</option>
              {selectedDay === dayOptions[0] && <option value="now">Now</option>}
              {timeOptions.map((option) => <option key={option.hour} value={option.hour}>{option.label}</option>)}
            </select></label>
            <button className="secondary-button filter-toggle" aria-expanded={filtersOpen} aria-controls="event-filters" onClick={() => setFiltersOpen((value) => !value)}>
              Filters{activeCategories.size !== CATEGORY_KEYS.length && <span className="filter-count">{activeCategories.size}</span>}
            </button>
          </div>
          <div id="event-filters" className="filter-panel" hidden={!filtersOpen}>
            <div className="filter-options" role="group" aria-label="Event categories">
              {CATEGORY_KEYS.map((key) => <button className="category-filter" key={key} aria-pressed={activeCategories.has(key)} onClick={() => toggleCategory(key)}>
                <span aria-hidden="true">{CATEGORIES[key].emoji}</span>{CATEGORIES[key].label}
              </button>)}
            </div>
            <div className="filter-actions">
              <button className="text-button" onClick={() => setActiveCategories(new Set(CATEGORY_KEYS))}>Select all</button>
              <button className="text-button" onClick={() => setActiveCategories(new Set())}>Clear categories</button>
              <button className="text-button" aria-pressed={!!userLocation} disabled={locationStatus === 'loading'} onClick={toggleNearby}>
                {locationStatus === 'loading' ? 'Finding location…' : userLocation ? 'Stop sorting by distance' : 'Sort by distance'}
              </button>
              {locationStatus === 'error' && <p role="status">Location unavailable. Events are sorted by time.</p>}
            </div>
          </div>
        </section>
        {mapVisited && <section aria-label="Event map" className="map-frame" hidden={showListView}>
          <MapSurface showList={() => selectView(true)}>
      <GoogleMap
        mapContainerStyle={styles.map}
        mapContainerClassName="google-map"
        center={NYC_CENTER}
        zoom={13}
        onLoad={(map) => { mapInstanceRef.current = map; }}
        onUnmount={() => { mapInstanceRef.current = null; }}
        onClick={(e) => {
          if (pinDropMode && e.latLng) {
            setPendingPin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
            setPinDropMode(false);
            return;
          }
          setSelectedEventId(null);
          setSelectedReport(null);
          setShowProfileMenu(false);
        }}
        options={{
          styles: MAP_STYLE,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'cooperative',
          draggableCursor: pinDropMode ? 'crosshair' : undefined,
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
              <button type="button" className="marker-button" style={styles.markerWrapper} aria-label={event.title}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedEventId(event.id);
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
              </button>
            </OverlayViewF>
          );
        })}
        {/* Report pins */}
        {reports.filter((r) => !hiddenMap[r.id] && r.expiresAt.toMillis() > now).map((report) => {
          const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.other;
          return (
            <OverlayViewF
              key={`report-${report.id}`}
              position={{ lat: report.latitude, lng: report.longitude }}
              mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
            >
              <button type="button" className="marker-button" style={styles.markerWrapper} aria-label={report.text}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedReport(report);
                  setSelectedEventId(null);
                }}
              >
                <div style={{ ...styles.reportMarker, borderColor: cat.color }}>
                  <span style={styles.markerEmoji}>{cat.emoji}</span>
                </div>
                <div style={{ ...styles.markerArrow, borderTopColor: cat.color }} />
              </button>
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

          </MapSurface>
        </section>}
        {feedStatus !== 'ready' ? (
          <div className="empty-state">
            <p role="status">{feedStatus === 'loading' ? 'Loading NYC events…' : 'Could not load events.'}</p>
            {feedStatus === 'error' && <button className="secondary-button" onClick={retryFeed}>Try again</button>}
          </div>
        ) : <>
          <p className="result-count" role="status">{events.length} {events.length === 1 ? 'event' : 'events'}{userLocation ? ' · sorted by distance' : ''}</p>
          {events.length === 0 ? (
            <div className="empty-state">
              <strong>No matching events</strong>
              <p>Try another day or time, or reset your filters.</p>
              <button className="secondary-button" onClick={resetFilters}>Reset filters</button>
            </div>
          ) : showListView && <ul className="event-list">
            {events.map((event) => {
              const category = CATEGORIES[event.category];
              const started = event.startTime.toMillis() <= now;
              const currentDay = selectedDay.key === dateKey(now);
              const startsOnDay = selectedDay.key === dateKey(event.startTime.toMillis());
              const endsOnDay = selectedDay.key === dateKey(event.endTime.toMillis());
              const when = started && currentDay ? 'Happening now'
                : startsOnDay ? `Starts ${timeLabel(event.startTime.toMillis())}`
                : endsOnDay ? `Ends ${timeLabel(event.endTime.toMillis())}` : 'Ongoing';
              const miles = userLocation && getDistanceMiles(userLocation.lat, userLocation.lng, event.latitude, event.longitude);
              return <li key={event.id}>
                <button className="event-row" onClick={() => { setSignInError(false); setSelectedEventId(event.id); }}>
                  <span className="event-icon" style={{ backgroundColor: category.backgroundColor }} aria-hidden="true">{category.emoji}</span>
                  <span className="event-summary">
                    <span className="event-kicker">{category.label} · {when}</span>
                    <span className="event-title">{event.title}</span>
                    {event.location && <span className="event-location">{event.location}</span>}
                    {miles !== null && Number.isFinite(miles) && <span className="event-location">{miles < 0.1 ? '< 0.1' : miles.toFixed(1)} mi</span>}
                  </span>
                  <span className="event-chevron" aria-hidden="true">›</span>
                </button>
              </li>;
            })}
          </ul>}
        </>}
      </main>
      <footer className="site-footer"><a href="/privacy">Privacy policy</a></footer>

      {/* Event preview card */}
      {selectedEvent && (
        <PanelDialog titleId="event-detail-title" close={() => setSelectedEventId(null)}>
          <div className="detail-toolbar">
            <span>{CATEGORIES[selectedEvent.category].label}</span>
            <button type="button" aria-label="Close details" className="close-button" autoFocus onClick={() => setSelectedEventId(null)}>×</button>
          </div>
          {user?.email === ADMIN_EMAIL && !selectedEvent.sourceUrl && !(selectedEvent.sourceUrls?.length) && (
            <button type="button"
              className="admin-delete"
              aria-label="Delete this listing"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete "${selectedEvent.title}"?`)) {
                  deleteEvent(selectedEvent.id);
                  setSelectedEventId(null);
                }
              }}
            >Delete</button>
          )}
          <div style={styles.previewContent}>
            <span style={styles.previewEmoji}>
              {CATEGORIES[selectedEvent.category]?.emoji}
            </span>
            <div style={styles.previewText}>
              <h2 id="event-detail-title" className="detail-title">{selectedEvent.title}</h2>
              {selectedEvent.location && (
                <div className="detail-location">{selectedEvent.location}</div>
              )}
              <div style={styles.previewMeta}>
                <span>
                  {eventTimeLabel(selectedEvent.startTime.toMillis(), now)} — {eventTimeLabel(selectedEvent.endTime.toMillis(), now)} NYC
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
            <div className="detail-description">{selectedEvent.description}</div>
          )}
          {(() => {
            const urls = [...new Set([selectedEvent.sourceUrl, ...(selectedEvent.sourceUrls ?? [])])].flatMap((url) => {
              if (!url) return [];
              try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? [parsed] : []; }
              catch { return []; }
            });
            return urls.length > 0 ? (
              <div style={styles.sourceLinks}>
                {urls.map((url) => (
                  <a
                    key={url.href}
                    href={url.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.sourceLink}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {url.hostname.replace(/^www\./, '')}
                    {' '}→
                  </a>
                ))}
              </div>
            ) : null;
          })()}
          {selectedEvent.startTime.toMillis() > now ? (
            <div style={styles.cardActions}>
              <button
                style={{
                  ...styles.interestedButton,
                  ...(interestedMap[selectedEvent.id] ? styles.interestedButtonActive : {}),
                }}
                aria-pressed={!!interestedMap[selectedEvent.id]}
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
                aria-label={`Thumbs up: ${selectedEvent.thumbsUp ?? 0}`}
                aria-pressed={votes[selectedEvent.id] === 'up'}
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
                aria-label={`Thumbs down: ${selectedEvent.thumbsDown ?? 0}`}
                aria-pressed={votes[selectedEvent.id] === 'down'}
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
                        <button className="flag-button" aria-label="Report comment" onClick={() => setFlagMenuTarget({ type: 'comment', id: c.id, eventId: selectedEvent.id })}>⚑</button>
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
                  placeholder="Add a comment…"
                  aria-label="Add a comment"
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
                  aria-label="Post comment"
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
              <button className="text-button comment-sign-in" onClick={handleSignIn}>Sign in to comment</button>
            )}
          </div>
          {signInError && <p className="notice" role="alert">Could not sign in with Google. Allow pop-ups and try again.</p>}
        </PanelDialog>
      )}

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
        <PanelDialog titleId="report-detail-title" close={() => setSelectedReport(null)}>
          <div className="detail-toolbar">
            <span>Community report</span>
            <button aria-label="Close report" className="close-button" autoFocus onClick={() => setSelectedReport(null)}>×</button>
          </div>
          {user?.email === ADMIN_EMAIL && (
            <button type="button"
              className="admin-delete"
              aria-label="Delete this listing"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete this report?`)) {
                  deleteReport(selectedReport.id);
                  setSelectedReport(null);
                }
              }}
            >Delete</button>
          )}
          <div style={styles.previewContent}>
            <span style={styles.previewEmoji}>
              {REPORT_CATEGORIES[selectedReport.category]?.emoji || '📍'}
            </span>
            <div style={styles.previewText}>
              <h2 id="report-detail-title" className="detail-title">{selectedReport.text}</h2>
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
              <button className="flag-button" aria-label="Report this pin" onClick={() => setFlagMenuTarget({ type: 'report', id: selectedReport.id })}>⚑</button>
            )}
          </div>
        </PanelDialog>
      )}

      {flagMenuTarget && (
        <PanelDialog titleId="flag-dialog-title" close={() => setFlagMenuTarget(null)} className="flag-dialog">
          <div style={styles.flagMenu}>
            <h2 id="flag-dialog-title" style={styles.flagMenuTitle}>Why are you reporting this?</h2>
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
        </PanelDialog>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  authSubtitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 18,
    marginBottom: 40,
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
    textAlign: 'center',
  },
  nameError: {
    color: '#ff6b6b',
    fontSize: 13,
    marginTop: 8,
    marginBottom: 0,
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
