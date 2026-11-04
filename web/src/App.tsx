import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { GoogleMap, useJsApiLoader, OverlayViewF, OverlayView } from '@react-google-maps/api';
import { subscribeToUpcomingEvents, voteOnEvent, markInterested, signOut, createReport, subscribeToReports, confirmReport, deleteEvent, deleteReport, deleteAccount, flagContent } from './firebase';
import { getAllVotes, setVote, getInterestedEvents, setInterested as setInterestedLocal, getConfirmedReports, setConfirmed as setConfirmedLocal, getHiddenContent, setHidden, VoteType } from './votes';
import { CATEGORIES, CATEGORY_LIST, ADMIN_EMAIL } from './categories';
import { MAP_STYLE } from './mapStyle';
import { AppEvent, EventCategory, Report, ReportCategory, FlagReason } from './types';
import { useAuth } from './contexts/AuthContext';
import { formatTime, getDistance } from './utils';
import { navigate } from './router';

const LIBRARIES: ('places')[] = ['places'];
const WELCOME_KEY = 'pulse_welcomed';
const HOUR_MS = 60 * 60 * 1000;
const UPCOMING_BROWSER_HOURS = 72;
const NYC_CENTER = { lat: 40.7128, lng: -74.006 };

function getDateKey(time: Date): string {
  return `${time.getFullYear()}-${time.getMonth()}-${time.getDate()}`;
}

function formatBrowseDay(time: Date, now: Date): string {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day.getTime() === today.getTime()) return 'Today';
  if (day.getTime() === tomorrow.getTime()) return 'Tomorrow';
  return time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatBrowseTime(time: Date, isNow: boolean): string {
  if (isNow) return 'Now';
  return time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const REPORT_CATEGORIES: Record<ReportCategory, { emoji: string; label: string; color: string }> = {
  live_music: { emoji: '🎵', label: 'Live Music', color: '#9b59b6' },
  free_stuff: { emoji: '🎁', label: 'Free Stuff', color: '#2ecc71' },
  popup: { emoji: '✨', label: 'Pop-up', color: '#e67e22' },
  long_line: { emoji: '🚶', label: 'Long Line', color: '#e74c3c' },
  street_performance: { emoji: '🎭', label: 'Performance', color: '#3498db' },
  other: { emoji: '📍', label: 'Other', color: '#95a5a6' },
};

function MapPin({
  emoji,
  fillColor,
  borderColor = '#fff',
}: {
  emoji: string;
  fillColor: string;
  borderColor?: string;
}) {
  return (
    <div style={styles.markerWrapper}>
      <div style={{ ...styles.markerCircle, backgroundColor: fillColor, borderColor }}>
        <span style={styles.markerEmoji}>{emoji}</span>
      </div>
    </div>
  );
}

export function App() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  });

  const [events, setEvents] = useState<AppEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AppEvent | null>(null);
  const [votes, setVotes] = useState<Record<string, VoteType>>({});
  const [dataLoaded, setDataLoaded] = useState(false);
  const [allEvents, setAllEvents] = useState<AppEvent[]>([]);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(WELCOME_KEY));
  const [splashOpacity, setSplashOpacity] = useState(1);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [showListView, setShowListView] = useState(false);
  const [listTimelineIndex, setListTimelineIndex] = useState(0);
  const [mapTimePickerOpen, setMapTimePickerOpen] = useState(false);
  const [mapPickerStep, setMapPickerStep] = useState<'main' | 'day' | 'time'>('main');
  const [listPickerOpen, setListPickerOpen] = useState<'day' | 'time' | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeCategories, setActiveCategories] = useState<Set<EventCategory>>(
    new Set(CATEGORY_LIST)
  );
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [interestedMap, setInterestedMap] = useState<Record<string, boolean>>({});
  const { user, displayName } = useAuth();
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [confirmedMap, setConfirmedMap] = useState<Record<string, boolean>>({});
  const [hiddenMap, setHiddenMap] = useState<Record<string, boolean>>({});
  const [pinDropMode, setPinDropMode] = useState(false);
  const [pendingPin, setPendingPin] = useState<{ lat: number; lng: number } | null>(null);
  const [reportText, setReportText] = useState('');
  const [reportCategory, setReportCategory] = useState<ReportCategory>('other');
  const [submittingReport, setSubmittingReport] = useState(false);
  const [flagTarget, setFlagTarget] = useState<Report | null>(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const isAdmin = user?.email === ADMIN_EMAIL;

  const handleFlagReport = async (reason: FlagReason) => {
    if (!flagTarget) return;
    const report = flagTarget;
    setFlagTarget(null);
    if (user && report.userId === user.uid) return;
    if (user) {
      await flagContent({
        contentType: 'report' as const,
        contentId: report.id,
        reason,
        reporterId: user.uid,
      });
    }
    setHidden(report.id);
    setHiddenMap((prev) => ({ ...prev, [report.id]: true }));
    setSelectedReport(null);
    alert('Thanks for helping keep Pulse safe.');
  };

  // Keep relative-time labels and future-event affordances current.
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Fade out splash once data arrives
  useEffect(() => {
    if (!dataLoaded) return;
    if (showWelcome) {
      setSplashOpacity(0);
    } else {
      const timer = setTimeout(() => setSplashOpacity(0), 600);
      return () => clearTimeout(timer);
    }
  }, [dataLoaded, showWelcome]);

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

  const handleDismissWelcome = useCallback(() => {
    localStorage.setItem(WELCOME_KEY, '1');
    setShowWelcome(false);
  }, []);

  const listTimelineSnaps = useMemo(() => {
    const snaps: { label: string; time: Date }[] = [];
    const now = new Date();
    const endTime = new Date(now.getTime() + UPCOMING_BROWSER_HOURS * HOUR_MS);
    snaps.push({ label: 'Now', time: now });

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const firstSnap = new Date(now);
    firstSnap.setMinutes(0, 0, 0);
    firstSnap.setHours(firstSnap.getHours() + 1);

    for (let d = new Date(firstSnap); d <= endTime; d = new Date(d.getTime() + HOUR_MS)) {
      const daysFromToday = Math.floor((d.getTime() - todayStart.getTime()) / (24 * HOUR_MS));
      const dayLabel = daysFromToday === 0 ? 'Today' : dayNames[d.getDay()];
      const h = d.getHours();
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const ampm = h < 12 ? 'AM' : 'PM';
      snaps.push({ label: `${dayLabel} ${hour12}${ampm}`, time: d });
    }
    return snaps;
  }, []);

  const listDayOptions = useMemo(() => {
    const seen = new Set<string>();
    const now = listTimelineSnaps[0].time;
    return listTimelineSnaps.reduce<{ key: string; label: string; firstIndex: number }[]>(
      (options, snap, index) => {
        const key = getDateKey(snap.time);
        if (!seen.has(key)) {
          seen.add(key);
          options.push({ key, label: formatBrowseDay(snap.time, now), firstIndex: index });
        }
        return options;
      },
      []
    );
  }, [listTimelineSnaps]);

  const selectedListDayKey = getDateKey(listTimelineSnaps[listTimelineIndex].time);
  const listTimeOptions = useMemo(() =>
    listTimelineSnaps
      .map((snap, index) => ({
        index,
        label: formatBrowseTime(snap.time, index === 0),
        dayKey: getDateKey(snap.time),
      }))
      .filter((option) => option.dayKey === selectedListDayKey),
    [listTimelineSnaps, selectedListDayKey]
  );

  const mapSelectedTime = listTimelineSnaps[listTimelineIndex].time.getTime();

  const applyListTimeIndex = useCallback((index: number) => {
    setListTimelineIndex(index);
    setSelectedEvent(null);
  }, []);

  useEffect(() => {
    setVotes(getAllVotes());
    setInterestedMap(getInterestedEvents());
    setConfirmedMap(getConfirmedReports());
    setHiddenMap(getHiddenContent());
  }, []);

  // Track user location continuously (mirrors onUserLocationChange + showsUserLocation)
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const handleVote = useCallback((event: AppEvent, voteType: 'up' | 'down') => {
    const previousVote = votes[event.id] ?? null;
    const newVote: VoteType = previousVote === voteType ? null : voteType;

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
    setEvents((prev) => prev.map(applyVoteUpdate));
    setVotes((prev) => ({ ...prev, [event.id]: newVote }));
    setSelectedEvent((prev) => (prev && prev.id === event.id ? applyVoteUpdate(prev) : prev));

    setVote(event.id, newVote);
    voteOnEvent(event.id, voteType, previousVote).catch((e) => console.warn('Vote failed:', e));
  }, [votes]);

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
    markInterested(event.id, wasInterested, user?.uid).catch((e) => console.warn('Interested failed:', e));
  }, [interestedMap, user]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = subscribeToUpcomingEvents((upcoming) => {
        setAllEvents(upcoming);
        setDataLoaded(true);
      });
    } catch (e) {
      console.warn('Firebase not configured yet:', e);
    }
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToReports(setReports);
    return () => unsubscribe();
  }, []);

  // Filter events based on selected timeline time and category
  useEffect(() => {
    const selectedTime = mapSelectedTime;
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
  }, [allEvents, mapSelectedTime, activeCategories]);

  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (pinDropMode && e.latLng) {
      setPendingPin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      setPinDropMode(false);
      return;
    }
    setSelectedEvent(null);
    setSelectedReport(null);
    setMapTimePickerOpen(false);
    setFiltersOpen(false);
    setShowListView(false);
  }, [pinDropMode]);

  const handleMarkerPress = useCallback((event: AppEvent) => {
    setSelectedEvent(event);
    setSelectedReport(null);
    setFiltersOpen(false);
    const bounds = mapRef.current?.getBounds();
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
        mapRef.current?.panTo({ lat: event.latitude, lng: event.longitude });
      }
    }
  }, []);

  const handlePreviewPress = useCallback(() => {
    if (!selectedEvent) return;
    const params = new URLSearchParams({
      title: selectedEvent.title,
      category: selectedEvent.category,
      description: selectedEvent.description,
      location: selectedEvent.location ?? '',
      startTime: selectedEvent.startTime.toMillis().toString(),
      endTime: selectedEvent.endTime.toMillis().toString(),
      sourceUrl: selectedEvent.sourceUrl ?? '',
      sourceUrls: JSON.stringify(selectedEvent.sourceUrls ?? (selectedEvent.sourceUrl ? [selectedEvent.sourceUrl] : [])),
    });
    navigate(`/event/${selectedEvent.id}?${params.toString()}`);
  }, [selectedEvent]);

  const listEvents = useMemo(() => {
    const selectedTime = listTimelineSnaps[listTimelineIndex]?.time.getTime() ?? currentTime;
    const filtered = allEvents.filter((event) =>
      event.startTime.toMillis() <= selectedTime &&
      event.endTime.toMillis() > selectedTime &&
      activeCategories.has(event.category)
    );
    if (!userLocation) {
      return filtered.sort((a, b) => a.startTime.toMillis() - b.startTime.toMillis());
    }
    return filtered.sort((a, b) =>
      getDistance(userLocation.lat, userLocation.lng, a.latitude, a.longitude) -
      getDistance(userLocation.lat, userLocation.lng, b.latitude, b.longitude)
    );
  }, [allEvents, activeCategories, listTimelineIndex, listTimelineSnaps, userLocation, currentTime]);

  const eventsForMap = useMemo(() => {
    if (!selectedEvent || events.some((event) => event.id === selectedEvent.id)) return events;
    return [...events, selectedEvent];
  }, [events, selectedEvent]);

  const formatDistance = (event: AppEvent): string | null => {
    if (!userLocation) return null;
    const miles = getDistance(userLocation.lat, userLocation.lng, event.latitude, event.longitude);
    if (miles < 0.1) return '< 0.1 mi';
    if (miles < 10) return `${miles.toFixed(1)} mi`;
    return `${Math.round(miles)} mi`;
  };

  const resetMapTime = () => {
    applyListTimeIndex(0);
    setMapTimePickerOpen(false);
  };

  if (!isLoaded) {
    return (
      <div style={{ ...styles.splash, opacity: 1 }}>
        <div style={styles.splashDot} />
        <span style={styles.splashTitle}>Pulse</span>
        <span style={styles.splashSubtitle}>NYC Events</span>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <GoogleMap
        mapContainerStyle={styles.map}
        center={NYC_CENTER}
        zoom={13}
        onLoad={(map) => { mapRef.current = map; }}
        onClick={handleMapClick}
        options={{
          styles: MAP_STYLE,
          disableDefaultUI: true,
          zoomControl: false,
          clickableIcons: false,
          draggableCursor: pinDropMode ? 'crosshair' : undefined,
        }}
      >
        {eventsForMap.map((event) => {
          const category = CATEGORIES[event.category];
          if (!category) return null;
          return (
            <OverlayViewF
              key={event.id}
              position={{ lat: event.latitude, lng: event.longitude }}
              mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
            >
              <div
                style={styles.markerHitArea}
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkerPress(event);
                }}
              >
                <MapPin emoji={category.emoji} fillColor={category.color} />
              </div>
            </OverlayViewF>
          );
        })}
        {/* Report markers */}
        {reports.filter((r) => !hiddenMap[r.id]).map((report) => {
          const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.other;
          return (
            <OverlayViewF
              key={`report-${report.id}`}
              position={{ lat: report.latitude, lng: report.longitude }}
              mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
            >
              <div
                style={styles.markerHitArea}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedReport(report);
                  setSelectedEvent(null);
                }}
              >
                <MapPin emoji={cat.emoji} fillColor="#202124" borderColor={cat.color} />
              </div>
            </OverlayViewF>
          );
        })}
        {/* Pending pin */}
        {pendingPin && (
          <OverlayViewF
            position={pendingPin}
            mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
          >
            <div style={{ ...styles.markerHitArea, pointerEvents: 'none' }}>
              <MapPin emoji="📍" fillColor="#ff5252" />
            </div>
          </OverlayViewF>
        )}
        {/* User location (mirrors showsUserLocation) */}
        {userLocation && (
          <OverlayViewF
            position={userLocation}
            mapPaneName={OverlayView.OVERLAY_LAYER}
          >
            <div style={styles.userLocationWrapper}>
              <div style={styles.userLocationHalo} />
              <div style={styles.userLocationDot} />
            </div>
          </OverlayViewF>
        )}
      </GoogleMap>

      {/* Category filter toggle + pills */}
      {!selectedEvent && (
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
          {filtersOpen && CATEGORY_LIST.map((key) => {
            const cat = CATEGORIES[key];
            const active = activeCategories.has(key);
            return (
              <div
                key={key}
                style={{
                  ...styles.filterPill,
                  backgroundColor: active ? cat.color : 'rgba(30, 30, 30, 0.5)',
                  opacity: active ? 1 : 0.5,
                  ['--pill-opacity' as any]: active ? 1 : 0.5,
                }}
                onClick={() => toggleCategory(key)}
              >
                <span style={styles.filterEmoji}>{cat.emoji}</span>
              </div>
            );
          })}
        </div>
      )}

      {selectedEvent && (
        <div style={styles.previewWrapper}>
          <div style={styles.previewCard} onClick={handlePreviewPress}>
            <div style={styles.previewContent}>
              <span style={styles.previewEmoji}>
                {CATEGORIES[selectedEvent.category]?.emoji}
              </span>
              <div style={styles.previewText}>
                <div style={styles.previewTitle}>{selectedEvent.title}</div>
                {selectedEvent.location ? (
                  <div style={styles.previewLocation}>{selectedEvent.location}</div>
                ) : null}
                <div style={styles.previewTime}>
                  {formatTime(selectedEvent.startTime.toMillis())} — {formatTime(selectedEvent.endTime.toMillis())}
                  {formatDistance(selectedEvent) && (
                    <span style={styles.previewDistance}> · {formatDistance(selectedEvent)}</span>
                  )}
                </div>
                <div style={styles.previewHint}>Tap for details →</div>
              </div>
            </div>
          </div>
          {selectedEvent.startTime.toMillis() > currentTime ? (
            <div style={styles.interestedRow}>
              <button
                style={{
                  ...styles.interestedButton,
                  ...(interestedMap[selectedEvent.id] ? styles.interestedButtonActive : {}),
                }}
                onClick={() => handleInterested(selectedEvent)}
              >
                <span style={styles.interestedStar}>{interestedMap[selectedEvent.id] ? '⭐' : '☆'}</span>
                <span style={{
                  ...styles.interestedText,
                  ...(interestedMap[selectedEvent.id] ? styles.interestedTextActive : {}),
                }}>
                  {(selectedEvent.interested ?? 0) > 0
                    ? `${selectedEvent.interested} interested`
                    : 'Interested'}
                </span>
              </button>
            </div>
          ) : (
            <div style={styles.floatingVotes}>
              <button
                style={{
                  ...styles.floatingVoteButton,
                  ...(votes[selectedEvent.id] === 'up' ? styles.floatingVoteActive : {}),
                }}
                onClick={() => handleVote(selectedEvent, 'up')}
              >
                <span style={styles.floatingVoteEmoji}>👍</span>
                <span style={{
                  ...styles.floatingVoteCount,
                  ...(votes[selectedEvent.id] === 'up' ? styles.floatingVoteCountActive : {}),
                }}>
                  {selectedEvent.thumbsUp ?? 0}
                </span>
              </button>
              <button
                style={{
                  ...styles.floatingVoteButton,
                  ...(votes[selectedEvent.id] === 'down' ? styles.floatingVoteDown : {}),
                }}
                onClick={() => handleVote(selectedEvent, 'down')}
              >
                <span style={styles.floatingVoteEmoji}>👎</span>
                <span style={{
                  ...styles.floatingVoteCount,
                  ...(votes[selectedEvent.id] === 'down' ? styles.floatingVoteCountActive : {}),
                }}>
                  {selectedEvent.thumbsDown ?? 0}
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      <div
        style={styles.mapTimeButton}
        onClick={() => {
          setShowListView(false);
          setMapPickerStep('main');
          setMapTimePickerOpen(true);
        }}
      >
        <div>
          <div style={styles.mapTimeLabel}>WHEN</div>
          <div style={styles.mapTimeValue}>
            {listTimelineIndex === 0 ? 'Now' : formatTime(mapSelectedTime)}
          </div>
        </div>
        <span style={styles.mapTimeChevron}>⌄</span>
      </div>

      <div
        style={styles.listToggleButton}
        onClick={() => {
          setMapTimePickerOpen(false);
          setShowListView((visible) => !visible);
        }}
      >
        <span style={styles.listToggleText}>{showListView ? '◉' : '☰'}</span>
      </div>

      {showListView && (
        <div style={styles.listOverlay}>
          <div style={styles.listHeader}>
            <div>
              <div style={styles.listTitle}>
                {listTimelineIndex === 0 ? 'Happening now' : `Happening ${listTimelineSnaps[listTimelineIndex]?.label}`}
              </div>
              <div style={styles.listSubtitle}>Choose any time in the next 3 days</div>
            </div>
            <span style={styles.listClose} onClick={() => setShowListView(false)}>
              ✕
            </span>
          </div>
          <div style={styles.listTimeControls}>
            <div style={styles.listSelect} onClick={() => setListPickerOpen('day')}>
              <span style={styles.listSelectLabel}>Day</span>
              <div style={styles.listSelectValueRow}>
                <span style={styles.listSelectValue}>
                  {listDayOptions.find((option) => option.key === selectedListDayKey)?.label}
                </span>
                <span style={styles.listSelectChevron}>⌄</span>
              </div>
            </div>
            <div style={styles.listSelect} onClick={() => setListPickerOpen('time')}>
              <span style={styles.listSelectLabel}>Time</span>
              <div style={styles.listSelectValueRow}>
                <span style={styles.listSelectValue}>
                  {formatBrowseTime(listTimelineSnaps[listTimelineIndex].time, listTimelineIndex === 0)}
                </span>
                <span style={styles.listSelectChevron}>⌄</span>
              </div>
            </div>
          </div>
          <div style={styles.listScroll}>
            {listEvents.length === 0 ? (
              <div style={styles.listEmpty}>No events are happening at this time.</div>
            ) : listEvents.map((event) => {
              const category = CATEGORIES[event.category];
              if (!category) return null;
              return (
                <div
                  key={event.id}
                  style={styles.listItem}
                  onClick={() => {
                    setShowListView(false);
                    setSelectedEvent(event);
                    mapRef.current?.panTo({ lat: event.latitude, lng: event.longitude });
                    mapRef.current?.setZoom(15);
                  }}
                >
                  <div style={{ ...styles.listItemDot, backgroundColor: category.color }}>
                    <span style={styles.listItemEmoji}>{category.emoji}</span>
                  </div>
                  <div style={styles.listItemContent}>
                    <div style={styles.listItemTitle}>{event.title}</div>
                    {event.location ? (
                      <div style={styles.listItemLocation}>{event.location}</div>
                    ) : null}
                    <div style={styles.listItemMeta}>
                      {formatTime(event.startTime.toMillis())}
                      {formatDistance(event) && (
                        <span style={styles.listItemDistance}> · {formatDistance(event)}</span>
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
          <div style={styles.listMapButton} onClick={() => setShowListView(false)}>
            <span style={styles.listMapButtonText}>◉</span>
          </div>
        </div>
      )}

      {mapTimePickerOpen && (
        <div style={styles.listPickerBackdrop}>
          <div
            style={styles.backdropFill}
            onClick={() => {
              setMapPickerStep('main');
              setMapTimePickerOpen(false);
            }}
          />
          <div style={styles.mapPickerCard}>
            {mapPickerStep === 'main' ? (
              <>
                <div style={styles.listPickerTitle}>Choose date and time</div>
                <div style={styles.mapPickerSubtitle}>Show events happening at a specific time.</div>
                <div style={styles.listTimeControls}>
                  <div style={styles.listSelect} onClick={() => setMapPickerStep('day')}>
                    <span style={styles.listSelectLabel}>Day</span>
                    <div style={styles.listSelectValueRow}>
                      <span style={styles.listSelectValue}>
                        {listDayOptions.find((option) => option.key === selectedListDayKey)?.label}
                      </span>
                      <span style={styles.listSelectChevron}>⌄</span>
                    </div>
                  </div>
                  <div style={styles.listSelect} onClick={() => setMapPickerStep('time')}>
                    <span style={styles.listSelectLabel}>Time</span>
                    <div style={styles.listSelectValueRow}>
                      <span style={styles.listSelectValue}>
                        {formatBrowseTime(listTimelineSnaps[listTimelineIndex].time, listTimelineIndex === 0)}
                      </span>
                      <span style={styles.listSelectChevron}>⌄</span>
                    </div>
                  </div>
                </div>
                <div style={styles.mapPickerActions}>
                  {listTimelineIndex !== 0 && (
                    <button style={styles.mapPickerNowButton} onClick={resetMapTime}>
                      Back to now
                    </button>
                  )}
                  <button
                    style={styles.mapPickerDoneButton}
                    onClick={() => setMapTimePickerOpen(false)}
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={styles.mapPickerHeader}>
                  <span style={styles.mapPickerBack} onClick={() => setMapPickerStep('main')}>
                    ‹
                  </span>
                  <span style={styles.mapPickerStepTitle}>
                    {mapPickerStep === 'day' ? 'Choose a day' : 'Choose a time'}
                  </span>
                </div>
                <div style={styles.listPickerOptions}>
                  {(mapPickerStep === 'day'
                    ? listDayOptions.map((option) => ({
                        label: option.label,
                        index: option.firstIndex,
                        selected: option.key === selectedListDayKey,
                      }))
                    : listTimeOptions.map((option) => ({
                        label: option.label,
                        index: option.index,
                        selected: option.index === listTimelineIndex,
                      }))
                  ).map((option) => (
                    <div
                      key={`${mapPickerStep}-${option.index}`}
                      style={{
                        ...styles.listPickerOption,
                        ...(option.selected ? styles.listPickerOptionSelected : {}),
                      }}
                      onClick={() => {
                        applyListTimeIndex(option.index);
                        setMapPickerStep('main');
                      }}
                    >
                      <span style={{
                        ...styles.listPickerOptionText,
                        ...(option.selected ? styles.listPickerOptionTextSelected : {}),
                      }}>
                        {option.label}
                      </span>
                      {option.selected && <span style={styles.listPickerCheck}>✓</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {listPickerOpen !== null && (
        <div style={styles.listPickerBackdrop}>
          <div style={styles.backdropFill} onClick={() => setListPickerOpen(null)} />
          <div style={styles.listPickerCard}>
            <div style={styles.listPickerTitle}>
              {listPickerOpen === 'day' ? 'Choose a day' : 'Choose a time'}
            </div>
            <div style={styles.listPickerOptions}>
              {(listPickerOpen === 'day'
                ? listDayOptions.map((option) => ({
                    label: option.label,
                    index: option.firstIndex,
                    selected: option.key === selectedListDayKey,
                  }))
                : listTimeOptions.map((option) => ({
                    label: option.label,
                    index: option.index,
                    selected: option.index === listTimelineIndex,
                  }))
              ).map((option) => (
                <div
                  key={`${listPickerOpen}-${option.index}`}
                  style={{
                    ...styles.listPickerOption,
                    ...(option.selected ? styles.listPickerOptionSelected : {}),
                  }}
                  onClick={() => {
                    applyListTimeIndex(option.index);
                    setListPickerOpen(null);
                  }}
                >
                  <span style={{
                    ...styles.listPickerOptionText,
                    ...(option.selected ? styles.listPickerOptionTextSelected : {}),
                  }}>
                    {option.label}
                  </span>
                  {option.selected && <span style={styles.listPickerCheck}>✓</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Selected report card */}
      {selectedReport && (
        <div style={styles.previewWrapper}>
          <div style={{ ...styles.previewCard, position: 'relative', cursor: 'default' }}>
            {isAdmin && (
              <div
                style={styles.adminDeleteBtn}
                onClick={() => {
                  if (confirm('Delete this report?')) {
                    deleteReport(selectedReport.id);
                    setSelectedReport(null);
                  }
                }}
              >
                ✕
              </div>
            )}
            <div style={styles.previewContent}>
              <span style={styles.previewEmoji}>
                {REPORT_CATEGORIES[selectedReport.category]?.emoji || '📍'}
              </span>
              <div style={styles.previewText}>
                <div style={{ ...styles.previewTitle, whiteSpace: 'normal' }}>{selectedReport.text}</div>
                <div style={styles.previewTime}>
                  {selectedReport.userName} · {(() => {
                    const mins = Math.floor((currentTime - selectedReport.createdAt.toMillis()) / 60000);
                    if (mins < 1) return 'just now';
                    if (mins < 60) return `${mins}m ago`;
                    return `${Math.floor(mins / 60)}h ago`;
                  })()}
                </div>
              </div>
            </div>
            <button
              style={{
                ...styles.confirmBtn,
                ...(confirmedMap[selectedReport.id] ? styles.confirmBtnActive : {}),
              }}
              onClick={() => {
                const alreadyConfirmed = confirmedMap[selectedReport.id];
                if (alreadyConfirmed) {
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
              <span style={styles.confirmBtnEmoji}>👍</span>
              <span style={{
                ...styles.confirmBtnText,
                ...(confirmedMap[selectedReport.id] ? styles.confirmBtnTextActive : {}),
              }}>
                {selectedReport.confirmations > 0
                  ? `${selectedReport.confirmations} confirmed`
                  : 'Still happening'}
              </span>
            </button>
            {(!user || selectedReport.userId !== user.uid) && (
              <span
                style={styles.flagBtn}
                onClick={() => {
                  if (user && selectedReport.userId === user.uid) return;
                  setFlagTarget(selectedReport);
                }}
              >
                ⚑
              </span>
            )}
          </div>
        </div>
      )}

      {/* Admin delete on selected event */}
      {isAdmin && selectedEvent && !selectedEvent.sourceUrl && !(selectedEvent.sourceUrls?.length) && (
        <div
          style={styles.adminDeleteFloat}
          onClick={() => {
            if (confirm(`Delete "${selectedEvent.title}"?`)) {
              deleteEvent(selectedEvent.id);
              setSelectedEvent(null);
            }
          }}
        >
          Delete
        </div>
      )}

      {/* Account and admin entry points shared with mobile. */}
      {!selectedEvent && !selectedReport && (
        <div style={styles.actionButtons}>
          {isAdmin && (
            <button style={styles.mapActionButton} onClick={() => navigate('/admin')}>
              Add event
            </button>
          )}
          {!user && (
            <button style={styles.mapActionButton} onClick={() => navigate('/sign-in')}>
              Sign in
            </button>
          )}
        </div>
      )}

      {/* Profile button */}
      {user && !selectedEvent && !selectedReport && (
        <div style={styles.profileFloat} onClick={() => setShowProfileMenu(true)}>
          {user.photoURL ? (
            <img src={user.photoURL} style={styles.profileImage} referrerPolicy="no-referrer" alt="" />
          ) : (
            <span style={styles.profileInitial}>
              {(displayName || user.email || '?')[0].toUpperCase()}
            </span>
          )}
        </div>
      )}

      {/* Pin drop mode banner */}
      {pinDropMode && (
        <div style={styles.pinDropBanner}>
          <span style={styles.pinDropBannerText}>Tap the map to drop a pin</span>
        </div>
      )}

      {/* Report form modal (bottom sheet) */}
      {pendingPin && (
        <div style={styles.modalBackdrop} onClick={() => { setPendingPin(null); setReportText(''); setReportCategory('other'); }}>
          <div style={styles.reportForm} onClick={(e) => e.stopPropagation()}>
            <div style={styles.reportFormHeader}>
              <span style={styles.reportFormTitle}>What's happening here?</span>
              <span
                style={styles.reportFormClose}
                onClick={() => { setPendingPin(null); setReportText(''); setReportCategory('other'); }}
              >
                ✕
              </span>
            </div>
            <div style={styles.reportCatScroll}>
              {(Object.keys(REPORT_CATEGORIES) as ReportCategory[]).map((key) => {
                const cat = REPORT_CATEGORIES[key];
                const active = reportCategory === key;
                return (
                  <div
                    key={key}
                    style={{ ...styles.reportCatPill, backgroundColor: active ? cat.color : '#f0f0f0' }}
                    onClick={() => setReportCategory(key)}
                  >
                    <span style={styles.reportCatEmoji}>{cat.emoji}</span>
                    <span style={{ ...styles.reportCatLabel, color: active ? '#fff' : '#333' }}>{cat.label}</span>
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
            <button
              style={{ ...styles.reportSubmit, opacity: submittingReport ? 0.6 : 1 }}
              disabled={submittingReport}
              onClick={async () => {
                if (!user || !pendingPin) return;
                setSubmittingReport(true);
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
                } catch {
                  alert('Failed to drop pin');
                } finally {
                  setSubmittingReport(false);
                }
              }}
            >
              {submittingReport ? 'Posting...' : 'Drop Pin'}
            </button>
          </div>
        </div>
      )}

      {/* Welcome modal */}
      {showWelcome && (
        <div style={styles.welcomeBackdrop}>
          <div style={styles.welcomeModal}>
            <div style={styles.welcomeHeader}>
              <div style={styles.welcomeHeaderDot} />
              <span style={styles.welcomeTitle}>Pulse</span>
            </div>
            <span style={styles.welcomeSubtitle}>What's happening in NYC right now</span>
            <div style={styles.welcomeCategories}>
              {CATEGORY_LIST.map((key) => {
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
            <button style={styles.welcomeButton} onClick={handleDismissWelcome}>
              Explore
            </button>
            <a href="/privacy" style={styles.privacyLink}>Privacy Policy</a>
          </div>
        </div>
      )}

      {/* Profile menu (mirrors the mobile account Alert) */}
      {showProfileMenu && user && (
        <div style={styles.alertOverlay} onClick={() => setShowProfileMenu(false)}>
          <div style={styles.alertCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.alertTitle}>{displayName || 'Account'}</div>
            <div style={styles.alertMessage}>{user.email || ''}</div>
            <button
              style={styles.alertButton}
              onClick={() => { setShowProfileMenu(false); navigate('/privacy'); }}
            >
              Privacy Policy
            </button>
            <button
              style={{ ...styles.alertButton, ...styles.alertButtonDestructive }}
              onClick={() => { setShowProfileMenu(false); setShowDeleteConfirm(true); }}
            >
              Delete Account
            </button>
            <button
              style={styles.alertButton}
              onClick={() => { setShowProfileMenu(false); signOut(); }}
            >
              Sign out
            </button>
            <button
              style={{ ...styles.alertButton, ...styles.alertButtonCancel }}
              onClick={() => setShowProfileMenu(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Delete account confirmation */}
      {showDeleteConfirm && (
        <div style={styles.alertOverlay} onClick={() => setShowDeleteConfirm(false)}>
          <div style={styles.alertCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.alertTitle}>Delete Account</div>
            <div style={styles.alertMessage}>
              This will permanently delete your account, comments, reports, and all associated data. This cannot be undone.
            </div>
            <button
              style={{ ...styles.alertButton, ...styles.alertButtonDestructive }}
              onClick={async () => {
                setShowDeleteConfirm(false);
                try {
                  await deleteAccount();
                } catch (e: any) {
                  alert(e.message || 'Failed to delete account');
                }
              }}
            >
              Delete
            </button>
            <button
              style={{ ...styles.alertButton, ...styles.alertButtonCancel }}
              onClick={() => setShowDeleteConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Flag report menu */}
      {flagTarget && (
        <div style={styles.alertOverlay} onClick={() => setFlagTarget(null)}>
          <div style={styles.flagMenu} onClick={(e) => e.stopPropagation()}>
            <div style={styles.flagMenuTitle}>Report This Pin</div>
            <div style={styles.flagMenuSubtitle}>Why are you reporting this?</div>
            {([
              { value: 'spam' as FlagReason, label: 'Spam' },
              { value: 'inappropriate' as FlagReason, label: 'Inappropriate' },
              { value: 'harassment' as FlagReason, label: 'Harassment' },
              { value: 'misleading' as FlagReason, label: 'Misleading' },
            ]).map((r) => (
              <button key={r.value} style={styles.flagMenuItem} onClick={() => handleFlagReport(r.value)}>
                {r.label}
              </button>
            ))}
            <button style={styles.flagMenuCancel} onClick={() => setFlagTarget(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Splash screen (covers everything until data loads) */}
      <div style={{ ...styles.splash, opacity: splashOpacity }}>
        <div style={styles.splashDot} />
        <span style={styles.splashTitle}>Pulse</span>
        <span style={styles.splashSubtitle}>NYC Events</span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    position: 'relative',
    overflow: 'hidden',
  },
  map: {
    width: '100%',
    height: '100%',
  },
  markerHitArea: {
    cursor: 'pointer',
    transform: 'translate(-50%, -50%)',
    userSelect: 'none',
  },
  markerWrapper: {
    width: 48,
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2.5px solid #fff',
    boxShadow: '0 2px 3px rgba(0,0,0,0.25)',
    boxSizing: 'border-box',
  },
  markerEmoji: {
    fontSize: 22,
    lineHeight: '27px',
    textAlign: 'center',
    transform: 'translateY(-1px)',
  },
  userLocationWrapper: {
    position: 'relative',
    width: 40,
    height: 40,
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
  },
  userLocationHalo: {
    position: 'absolute',
    inset: 0,
    borderRadius: 20,
    backgroundColor: 'rgba(26, 115, 232, 0.15)',
  },
  userLocationDot: {
    position: 'absolute',
    top: 12,
    left: 12,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#1a73e8',
    border: '2.5px solid #fff',
    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
    boxSizing: 'border-box',
  },
  filterContainer: {
    position: 'absolute',
    top: 16,
    right: 16,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    zIndex: 5,
  },
  filterToggle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
    cursor: 'pointer',
    userSelect: 'none',
  },
  filterToggleIcon: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 700,
  },
  layersIcon: {
    width: 22,
    height: 22,
    position: 'relative',
  },
  layersDiamond: {
    position: 'absolute',
    left: 5,
    width: 12,
    height: 12,
    borderRadius: 1,
    border: '1.5px solid rgba(255, 255, 255, 0.9)',
    transform: 'rotate(45deg)',
    boxSizing: 'border-box',
    top: 1,
  },
  layersDiamondMid: {
    top: 5,
    opacity: 0.7,
  },
  layersDiamondBack: {
    top: 9,
    opacity: 0.4,
  },
  filterPill: {
    width: 50,
    height: 50,
    borderRadius: 25,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid #fff',
    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
    cursor: 'pointer',
    userSelect: 'none',
    boxSizing: 'border-box',
    animation: 'filter-in 0.2s ease-out both',
  },
  filterEmoji: {
    fontSize: 22,
  },
  previewWrapper: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    maxWidth: 420,
    zIndex: 6,
  },
  previewCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    boxShadow: '0 4px 8px rgba(0,0,0,0.15)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
  },
  previewContent: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    padding: '16px 16px 30px',
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
  previewDistance: {
    color: '#2a7cff',
    fontWeight: 600,
  },
  previewHint: {
    fontSize: 12,
    color: '#2a7cff',
    fontWeight: 600,
    marginTop: 4,
  },
  interestedRow: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
    marginRight: 12,
  },
  interestedButton: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    border: 'none',
    borderRadius: 20,
    padding: '6px 14px',
    gap: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
  },
  interestedButtonActive: {
    backgroundColor: '#fff3cd',
  },
  interestedStar: {
    fontSize: 14,
  },
  interestedText: {
    fontSize: 13,
    fontWeight: 600,
    color: '#666',
  },
  interestedTextActive: {
    color: '#b8860b',
  },
  floatingVotes: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: -22,
    marginRight: 12,
    gap: 10,
    position: 'relative',
    zIndex: 1,
  },
  floatingVoteButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f0f0f0',
    border: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: 0,
  },
  floatingVoteActive: {
    backgroundColor: '#2a7cff',
  },
  floatingVoteDown: {
    backgroundColor: '#ff4444',
  },
  floatingVoteEmoji: {
    fontSize: 18,
    marginTop: -2,
    lineHeight: '20px',
  },
  floatingVoteCount: {
    fontSize: 10,
    color: '#666',
    fontWeight: 600,
    lineHeight: '12px',
  },
  floatingVoteCountActive: {
    color: '#fff',
  },
  mapTimeButton: {
    position: 'absolute',
    bottom: 76,
    left: 16,
    minWidth: 150,
    minHeight: 48,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(30, 30, 30, 0.9)',
    borderRadius: 16,
    padding: '8px 13px',
    boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
    cursor: 'pointer',
    userSelect: 'none',
    zIndex: 5,
    boxSizing: 'border-box',
  },
  mapTimeLabel: {
    color: '#7db1ff',
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '1px',
    marginBottom: 2,
  },
  mapTimeValue: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  },
  mapTimeChevron: {
    color: '#fff',
    fontSize: 18,
    marginLeft: 12,
  },
  listToggleButton: {
    position: 'absolute',
    bottom: 16,
    left: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
    cursor: 'pointer',
    userSelect: 'none',
    zIndex: 5,
  },
  listToggleText: {
    color: '#fff',
    fontSize: 22,
  },
  listOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#fff',
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
  },
  listHeader: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '20px 20px 16px',
    borderBottom: '1px solid #eee',
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
  listTimeControls: {
    display: 'flex',
    flexDirection: 'row',
    gap: 10,
    padding: '10px 14px',
    borderBottom: '1px solid #eee',
    flexShrink: 0,
  },
  listSelect: {
    flex: 1,
    border: '1px solid #ddd',
    borderRadius: 12,
    padding: '9px 12px',
    backgroundColor: '#fafafa',
    cursor: 'pointer',
    userSelect: 'none',
    display: 'flex',
    flexDirection: 'column',
  },
  listSelectLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.7px',
    marginBottom: 2,
  },
  listSelectValueRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listSelectValue: {
    fontSize: 14,
    fontWeight: 600,
    color: '#222',
  },
  listSelectChevron: {
    fontSize: 16,
    color: '#777',
    marginLeft: 6,
  },
  listPickerBackdrop: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 200,
    animation: 'fade-in 0.15s ease-out',
  },
  backdropFill: {
    position: 'absolute',
    inset: 0,
  },
  mapPickerCard: {
    position: 'relative',
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingTop: 20,
    overflow: 'hidden',
  },
  mapPickerSubtitle: {
    fontSize: 13,
    color: '#777',
    padding: '0 20px 12px',
  },
  mapPickerHeader: {
    minHeight: 58,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    borderBottom: '1px solid #eee',
    padding: '0 14px',
  },
  mapPickerBack: {
    width: 38,
    fontSize: 34,
    lineHeight: '38px',
    color: '#444',
    cursor: 'pointer',
    userSelect: 'none',
  },
  mapPickerStepTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: '#1a1a1a',
  },
  mapPickerActions: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    padding: 14,
  },
  mapPickerNowButton: {
    border: 'none',
    borderRadius: 12,
    padding: '10px 14px',
    backgroundColor: '#f0f0f0',
    color: '#444',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  mapPickerDoneButton: {
    border: 'none',
    borderRadius: 12,
    padding: '10px 18px',
    backgroundColor: '#1a1a1a',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  listPickerCard: {
    position: 'relative',
    width: '100%',
    maxWidth: 340,
    maxHeight: '70%',
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingTop: 20,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  listPickerTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: '#1a1a1a',
    padding: '0 20px 12px',
  },
  listPickerOptions: {
    borderTop: '1px solid #eee',
    overflowY: 'auto',
    maxHeight: '50vh',
  },
  listPickerOption: {
    minHeight: 50,
    padding: '0 20px',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '1px solid #f0f0f0',
    cursor: 'pointer',
    userSelect: 'none',
    boxSizing: 'border-box',
  },
  listPickerOptionSelected: {
    backgroundColor: '#f0f5ff',
  },
  listPickerOptionText: {
    fontSize: 16,
    color: '#333',
  },
  listPickerOptionTextSelected: {
    color: '#2a7cff',
    fontWeight: 700,
  },
  listPickerCheck: {
    color: '#2a7cff',
    fontSize: 17,
    fontWeight: 700,
  },
  listEmpty: {
    fontSize: 15,
    color: '#777',
    textAlign: 'center',
    padding: '48px 30px',
  },
  listClose: {
    fontSize: 20,
    color: '#999',
    padding: 8,
    cursor: 'pointer',
    userSelect: 'none',
  },
  listScroll: {
    flex: 1,
    overflowY: 'auto',
  },
  listItem: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    padding: '14px 20px',
    borderBottom: '1px solid #f0f0f0',
    cursor: 'pointer',
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
    fontSize: 16,
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
  listMapButton: {
    position: 'absolute',
    bottom: 16,
    left: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
    cursor: 'pointer',
    userSelect: 'none',
  },
  listMapButtonText: {
    color: '#fff',
    fontSize: 22,
  },
  welcomeBackdrop: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 900,
  },
  welcomeModal: {
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    padding: '32px 36px',
    width: '85%',
    maxWidth: 320,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    boxSizing: 'border-box',
  },
  welcomeHeader: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  welcomeHeaderDot: {
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
    textAlign: 'center',
  },
  welcomeCategories: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
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
    letterSpacing: 0.3,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  privacyLink: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    marginTop: 16,
    textDecoration: 'none',
  },
  confirmBtn: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f0f0f0',
    border: 'none',
    borderRadius: 20,
    padding: '6px 14px',
    margin: '0 16px 12px',
    alignSelf: 'flex-start',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  confirmBtnActive: {
    backgroundColor: '#e8f0fe',
  },
  confirmBtnEmoji: {
    fontSize: 14,
  },
  confirmBtnText: {
    fontSize: 13,
    fontWeight: 600,
    color: '#666',
  },
  confirmBtnTextActive: {
    color: '#1a73e8',
  },
  flagBtn: {
    position: 'absolute',
    top: 10,
    right: 12,
    padding: 4,
    fontSize: 18,
    color: '#999',
    cursor: 'pointer',
    userSelect: 'none',
  },
  adminDeleteBtn: {
    position: 'absolute',
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
    userSelect: 'none',
  },
  adminDeleteFloat: {
    position: 'absolute',
    top: 16,
    left: 16,
    backgroundColor: '#ff4444',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    zIndex: 10,
    userSelect: 'none',
  },
  actionButtons: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    display: 'flex',
    gap: 8,
    zIndex: 5,
  },
  mapActionButton: {
    minHeight: 44,
    padding: '10px 14px',
    border: 'none',
    borderRadius: 22,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: 14,
    cursor: 'pointer',
  },
  profileFloat: {
    position: 'absolute',
    top: 16,
    left: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
    overflow: 'hidden',
    border: '2px solid #000',
    cursor: 'pointer',
    userSelect: 'none',
    zIndex: 5,
    boxSizing: 'border-box',
  },
  profileImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  profileInitial: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 700,
  },
  pinDropBanner: {
    position: 'absolute',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: 'rgba(30, 30, 30, 0.9)',
    padding: '10px 20px',
    borderRadius: 20,
    zIndex: 10,
  },
  pinDropBannerText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  modalBackdrop: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    alignItems: 'center',
    zIndex: 300,
    animation: 'fade-in 0.15s ease-out',
  },
  reportForm: {
    width: '100%',
    maxWidth: 560,
    backgroundColor: '#fff',
    borderRadius: '20px 20px 0 0',
    padding: '20px 20px 40px',
    boxSizing: 'border-box',
    animation: 'slide-up 0.25s ease-out',
  },
  reportFormHeader: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  reportFormTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: '#1a1a1a',
  },
  reportFormClose: {
    fontSize: 18,
    color: '#999',
    padding: 4,
    cursor: 'pointer',
    userSelect: 'none',
  },
  reportCatScroll: {
    display: 'flex',
    flexDirection: 'row',
    overflowX: 'auto',
    marginBottom: 12,
    paddingBottom: 4,
  },
  reportCatPill: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: '8px 12px',
    borderRadius: 20,
    marginRight: 8,
    cursor: 'pointer',
    userSelect: 'none',
    flexShrink: 0,
  },
  reportCatEmoji: {
    fontSize: 14,
  },
  reportCatLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: '#333',
    whiteSpace: 'nowrap',
  },
  reportInput: {
    width: '100%',
    border: '1px solid #e0e0e0',
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    marginBottom: 12,
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  reportSubmit: {
    width: '100%',
    backgroundColor: '#1a1a1a',
    color: '#fff',
    border: 'none',
    borderRadius: 12,
    padding: '14px 0',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  alertOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1100,
    animation: 'fade-in 0.15s ease-out',
    padding: 24,
  },
  alertCard: {
    width: 270,
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
  alertTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: '#1a1a1a',
    textAlign: 'center',
    padding: '20px 16px 0',
  },
  alertMessage: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    padding: '6px 16px 20px',
    lineHeight: '18px',
  },
  alertButton: {
    display: 'block',
    width: '100%',
    padding: '12px 16px',
    border: 'none',
    borderTop: '1px solid #eee',
    background: 'none',
    fontSize: 17,
    color: '#2a7cff',
    cursor: 'pointer',
    textAlign: 'center',
    fontFamily: 'inherit',
  },
  alertButtonDestructive: {
    color: '#ff3b30',
  },
  alertButtonCancel: {
    fontWeight: 600,
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
    padding: '12px 16px 2px',
    textAlign: 'center',
  },
  flagMenuSubtitle: {
    fontSize: 13,
    color: '#888',
    padding: '0 16px 8px',
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
    fontFamily: 'inherit',
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
    fontFamily: 'inherit',
  },
  splash: {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#1a1a1a',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    pointerEvents: 'none',
    transition: 'opacity 0.4s ease',
  },
  splashDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#ff5252',
    marginBottom: 16,
    animation: 'pulse-dot 2s ease-in-out infinite',
  },
  splashTitle: {
    color: '#fff',
    fontSize: 36,
    fontWeight: 700,
    letterSpacing: 1,
  },
  splashSubtitle: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 16,
    marginTop: 6,
    fontWeight: 500,
  },
};
