import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { StyleSheet, View, TouchableOpacity, Text, Alert, Dimensions, GestureResponderEvent, LayoutChangeEvent, Animated, FlatList, ScrollView, Linking, TextInput, Modal, Image } from 'react-native';
import MapView, { Marker, MapPressEvent, PROVIDER_GOOGLE } from 'react-native-maps';
import { useRouter } from 'expo-router';
import { AppEvent, Report, ReportCategory } from '@/types';
import { subscribeToUpcomingEvents, voteOnEvent, markInterested, subscribeToReports, createReport, confirmReport, deleteEvent, deleteReport } from '@/services/firebase';
import { getAllVotes, setVote, getInterestedEvents, setInterested as setInterestedLocal, VoteType } from '@/services/votes';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CATEGORIES, CATEGORY_LIST, NYC_REGION, ADMIN_PASSCODE } from '@/constants/categories';
import { EventCategory } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { signOut } from '@/services/auth';

const WELCOME_KEY = 'pulse_welcomed';
const ADMIN_EMAIL = 'kalli.feinberg@gmail.com';

const REPORT_CATEGORIES: Record<ReportCategory, { emoji: string; label: string; color: string }> = {
  live_music: { emoji: '🎵', label: 'Live Music', color: '#9b59b6' },
  free_stuff: { emoji: '🎁', label: 'Free Stuff', color: '#2ecc71' },
  popup: { emoji: '✨', label: 'Pop-up', color: '#e67e22' },
  long_line: { emoji: '🚶', label: 'Long Line', color: '#e74c3c' },
  street_performance: { emoji: '🎭', label: 'Performance', color: '#3498db' },
  other: { emoji: '📍', label: 'Other', color: '#95a5a6' },
};

import { MAP_STYLE } from '@/constants/mapStyle';
import { AdminPasscodeModal } from '@/components/AdminPasscodeModal';

function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function MapScreen() {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AppEvent | null>(null);
  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [votes, setVotes] = useState<Record<string, VoteType>>({});
  const [dataLoaded, setDataLoaded] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeChecked, setWelcomeChecked] = useState(false);
  const splashOpacity = useRef(new Animated.Value(1)).current;
  const dotScale = useRef(new Animated.Value(1)).current;
  const router = useRouter();
  const mapRef = useRef<MapView>(null);
  const [showListView, setShowListView] = useState(false);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [timelineVisualIndex, setTimelineVisualIndex] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterAnim = useRef(new Animated.Value(0)).current;
  const [activeCategories, setActiveCategories] = useState<Set<EventCategory>>(
    new Set(CATEGORY_LIST)
  );
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [interestedMap, setInterestedMap] = useState<Record<string, boolean>>({});
  const { user, displayName } = useAuth();
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [pinDropMode, setPinDropMode] = useState(false);
  const [pendingPin, setPendingPin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [reportText, setReportText] = useState('');
  const [reportCategory, setReportCategory] = useState<ReportCategory>('other');
  const [submittingReport, setSubmittingReport] = useState(false);
  const isAdmin = user?.email === ADMIN_EMAIL;

  // Check if user has seen welcome before
  useEffect(() => {
    AsyncStorage.getItem(WELCOME_KEY).then((val) => {
      if (val) setShowWelcome(false);
      setWelcomeChecked(true);
    });
  }, []);

  // Pulsing dot animation
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dotScale, { toValue: 0.75, duration: 1000, useNativeDriver: true }),
        Animated.timing(dotScale, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [dotScale]);

  // Fade out splash once data arrives and welcome is not needed
  useEffect(() => {
    if (!dataLoaded || !welcomeChecked) return;
    if (showWelcome) {
      // Fade splash to reveal welcome modal behind it
      Animated.timing(splashOpacity, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start();
    } else {
      // Returning user — fade splash then remove
      const timer = setTimeout(() => {
        Animated.timing(splashOpacity, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }).start();
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [dataLoaded, welcomeChecked, showWelcome, splashOpacity]);

  useEffect(() => {
    if (filtersOpen) {
      filterAnim.setValue(0);
      Animated.timing(filterAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      filterAnim.stopAnimation();
      filterAnim.setValue(0);
    }
  }, [filtersOpen, filterAnim]);

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
    AsyncStorage.setItem(WELCOME_KEY, '1');
    setShowWelcome(false);
  }, []);

  const timelineSnaps = useMemo(() => {
    const snaps: { label: string; time: Date }[] = [];
    const now = new Date();
    const endTime = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    snaps.push({ label: 'Now', time: now });

    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    // Generate 2-hour snaps for the next 72 hours
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

  const timelineTrackRef = useRef<View>(null);
  const timelineTrackX = useRef(0);

  const timelineMoveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateTimelineFromTouch = useCallback((pageX: number, immediate = false) => {
    if (!trackWidth) return;
    const x = pageX - timelineTrackX.current;
    const fraction = Math.max(0, Math.min(1, x / trackWidth));
    const index = Math.round(fraction * (timelineSnaps.length - 1));
    setTimelineVisualIndex(index);
    if (immediate) {
      setTimelineIndex(index);
    } else {
      if (timelineMoveTimer.current) clearTimeout(timelineMoveTimer.current);
      timelineMoveTimer.current = setTimeout(() => setTimelineIndex(index), 100);
    }
  }, [trackWidth, timelineSnaps.length]);

  const handleTimelineGrant = useCallback((evt: GestureResponderEvent) => {
    timelineTrackRef.current?.measureInWindow((x) => {
      timelineTrackX.current = x;
      updateTimelineFromTouch(evt.nativeEvent.pageX, true);
    });
  }, [updateTimelineFromTouch]);

  const handleTimelineMove = useCallback((evt: GestureResponderEvent) => {
    updateTimelineFromTouch(evt.nativeEvent.pageX);
  }, [updateTimelineFromTouch]);

  const handleTrackLayout = useCallback((evt: LayoutChangeEvent) => {
    setTrackWidth(evt.nativeEvent.layout.width);
  }, []);

  useEffect(() => {
    getAllVotes().then(setVotes).catch(() => {});
    getInterestedEvents().then(setInterestedMap).catch(() => {});
  }, []);

  const handleVote = useCallback(async (event: AppEvent, voteType: 'up' | 'down') => {
    const previousVote = votes[event.id] ?? null;
    const newVote: VoteType = previousVote === voteType ? null : voteType;

    // Optimistic local update for counts
    const updatedEvents = events.map((e) => {
      if (e.id !== event.id) return e;
      const updated = { ...e };
      if (previousVote === voteType) {
        // Removing vote
        if (voteType === 'up') updated.thumbsUp = (updated.thumbsUp ?? 0) - 1;
        else updated.thumbsDown = (updated.thumbsDown ?? 0) - 1;
      } else {
        // Adding new vote
        if (voteType === 'up') updated.thumbsUp = (updated.thumbsUp ?? 0) + 1;
        else updated.thumbsDown = (updated.thumbsDown ?? 0) + 1;
        // Remove previous
        if (previousVote === 'up') updated.thumbsUp = (updated.thumbsUp ?? 0) - 1;
        if (previousVote === 'down') updated.thumbsDown = (updated.thumbsDown ?? 0) - 1;
      }
      return updated;
    });
    setEvents(updatedEvents);
    setVotes((prev) => ({ ...prev, [event.id]: newVote }));

    // Update selected event if it's the one being voted on
    setSelectedEvent((prev) => {
      if (!prev || prev.id !== event.id) return prev;
      return updatedEvents.find((e) => e.id === event.id) ?? prev;
    });

    try {
      await Promise.all([
        voteOnEvent(event.id, voteType, previousVote),
        setVote(event.id, newVote),
      ]);
    } catch (e) {
      console.warn('Vote failed:', e);
    }
  }, [votes, events]);

  const handleInterested = useCallback(async (event: AppEvent) => {
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

    try {
      await Promise.all([
        markInterested(event.id, wasInterested),
        setInterestedLocal(event.id, !wasInterested),
      ]);
    } catch (e) {
      console.warn('Interested failed:', e);
    }
  }, [interestedMap]);

  const [allEvents, setAllEvents] = useState<AppEvent[]>([]);

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

    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToReports(setReports);
    return () => unsubscribe();
  }, []);

  // Filter events based on selected timeline time and category
  useEffect(() => {
    const selectedTime = timelineSnaps[timelineIndex].time.getTime();
    const filtered = allEvents.filter((event: any) => {
      const started = event.startTime.toMillis() <= selectedTime;
      const notEnded = event.endTime.toMillis() > selectedTime;
      return started && notEnded && activeCategories.has(event.category);
    });
    setEvents(filtered);
    // Clear selected event if it's no longer visible
    setSelectedEvent((prev) => {
      if (!prev) return null;
      return filtered.find((e) => e.id === prev.id) ? prev : null;
    });
  }, [allEvents, timelineIndex, timelineSnaps, activeCategories]);

  const handleMapPress = useCallback((e: MapPressEvent) => {
    if (e.nativeEvent.action === 'marker-press') return;
    if (pinDropMode) {
      setPendingPin(e.nativeEvent.coordinate);
      setPinDropMode(false);
      return;
    }
    setSelectedEvent(null);
    setSelectedReport(null);
    setTimelineOpen(false);
    setFiltersOpen(false);
    setShowListView(false);
  }, [pinDropMode]);

  const handleMarkerPress = useCallback(async (event: AppEvent) => {
    setSelectedEvent(event);
    setSelectedReport(null);
    setFiltersOpen(false);
    try {
      const bounds = await mapRef.current?.getMapBoundaries();
      if (bounds) {
        const latSpan = bounds.northEast.latitude - bounds.southWest.latitude;
        const lngSpan = bounds.northEast.longitude - bounds.southWest.longitude;
        const margin = 0.25;
        const innerNorth = bounds.northEast.latitude - latSpan * margin;
        const innerSouth = bounds.southWest.latitude + latSpan * margin;
        const innerEast = bounds.northEast.longitude - lngSpan * margin;
        const innerWest = bounds.southWest.longitude + lngSpan * margin;
        const isInner = event.latitude < innerNorth && event.latitude > innerSouth &&
          event.longitude < innerEast && event.longitude > innerWest;
        if (!isInner) {
          mapRef.current?.animateCamera({
            center: { latitude: event.latitude, longitude: event.longitude },
          }, { duration: 300 });
        }
      }
    } catch {}
  }, []);

  const handlePreviewPress = useCallback(() => {
    if (!selectedEvent) return;
    router.push({
      pathname: '/event/[id]',
      params: {
        id: selectedEvent.id,
        title: selectedEvent.title,
        category: selectedEvent.category,
        description: selectedEvent.description,
        location: selectedEvent.location ?? '',
        startTime: selectedEvent.startTime.toMillis().toString(),
        endTime: selectedEvent.endTime.toMillis().toString(),
        sourceUrl: selectedEvent.sourceUrl ?? '',
        sourceUrls: JSON.stringify(selectedEvent.sourceUrls ?? (selectedEvent.sourceUrl ? [selectedEvent.sourceUrl] : [])),
      },
    });
  }, [selectedEvent, router]);

  const eventsSortedByDistance = useMemo(() => {
    if (!userLocation) return events;
    return [...events].sort((a, b) => {
      const distA = getDistance(userLocation.latitude, userLocation.longitude, a.latitude, a.longitude);
      const distB = getDistance(userLocation.latitude, userLocation.longitude, b.latitude, b.longitude);
      return distA - distB;
    });
  }, [events, userLocation]);

  const handleAdminPress = () => {
    if (isAdmin) {
      router.push('/admin');
    } else {
      setShowPasscodeModal(true);
    }
  };

  const handlePasscodeSubmit = (code: string) => {
    if (code === ADMIN_PASSCODE) {
      setShowPasscodeModal(false);
      router.push('/admin');
    } else {
      Alert.alert('Incorrect', 'Wrong passcode. Try again.');
    }
  };

  const formatDistance = (event: AppEvent): string | null => {
    if (!userLocation) return null;
    const miles = getDistance(userLocation.latitude, userLocation.longitude, event.latitude, event.longitude);
    if (miles < 0.1) return '< 0.1 mi';
    if (miles < 10) return `${miles.toFixed(1)} mi`;
    return `${Math.round(miles)} mi`;
  };

  const formatTime = (millis: number) => {
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
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={NYC_REGION}
        customMapStyle={MAP_STYLE}
        showsUserLocation
        showsMyLocationButton={false}
        onUserLocationChange={(e) => {
          const { latitude, longitude } = e.nativeEvent.coordinate;
          setUserLocation({ latitude, longitude });
        }}
        onPress={handleMapPress}
      >
        {events.map((event) => {
          const category = CATEGORIES[event.category];
          if (!category) return null;
          return (
            <Marker
              key={event.id}
              coordinate={{
                latitude: event.latitude,
                longitude: event.longitude,
              }}
              tracksViewChanges={false}
              onPress={(e) => {
                e.stopPropagation();
                handleMarkerPress(event);
              }}
            >
              <View style={styles.markerWrapper}>
                <View style={[styles.marker, { backgroundColor: category.color }]}>
                  <Text style={styles.markerEmoji}>{category.emoji}</Text>
                </View>
                <View style={[styles.markerArrow, { borderTopColor: category.color }]} />
              </View>
            </Marker>
          );
        })}
        {/* Report markers */}
        {reports.map((report) => {
          const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.other;
          return (
            <Marker
              key={`report-${report.id}`}
              coordinate={{ latitude: report.latitude, longitude: report.longitude }}
              tracksViewChanges={false}
              onPress={(e) => {
                e.stopPropagation();
                setSelectedReport(report);
                setSelectedEvent(null);
              }}
            >
              <View style={styles.markerWrapper}>
                <View style={[styles.reportMarker, { borderColor: cat.color }]}>
                  <Text style={styles.markerEmoji}>{cat.emoji}</Text>
                </View>
                <View style={[styles.markerArrow, { borderTopColor: cat.color }]} />
              </View>
            </Marker>
          );
        })}
        {/* Pending pin */}
        {pendingPin && (
          <Marker coordinate={pendingPin} tracksViewChanges={false}>
            <View style={styles.markerWrapper}>
              <View style={styles.pendingMarker}>
                <Text style={styles.markerEmoji}>📍</Text>
              </View>
              <View style={[styles.markerArrow, { borderTopColor: '#ff5252' }]} />
            </View>
          </Marker>
        )}
      </MapView>

      {/* Category filter toggle + pills */}
      {!selectedEvent && (
        <View style={styles.filterContainer}>
          <TouchableOpacity
            style={styles.filterToggle}
            onPress={() => setFiltersOpen((v) => !v)}
            activeOpacity={0.7}
          >
            {filtersOpen ? (
              <Text style={styles.filterToggleIcon}>✕</Text>
            ) : (
              <View style={styles.layersIcon}>
                <View style={[styles.layersDiamond]} />
                <View style={[styles.layersDiamond, styles.layersDiamondMid]} />
                <View style={[styles.layersDiamond, styles.layersDiamondBack]} />
              </View>
            )}
          </TouchableOpacity>
          {filtersOpen && CATEGORY_LIST.map((key, i) => {
            const cat = CATEGORIES[key];
            const active = activeCategories.has(key);
            return (
              <Animated.View
                key={key}
                style={{
                  opacity: filterAnim,
                  transform: [{
                    scale: filterAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.5, 1],
                    }),
                  }, {
                    translateY: filterAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-8, 0],
                    }),
                  }],
                }}
              >
                <TouchableOpacity
                  style={[
                    styles.filterPill,
                    { backgroundColor: active ? cat.color : 'rgba(30, 30, 30, 0.5)' },
                    !active && styles.filterPillInactive,
                  ]}
                  onPress={() => toggleCategory(key)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.filterEmoji}>{cat.emoji}</Text>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </View>
      )}

      {selectedEvent && (
        <View style={styles.previewWrapper}>
          <TouchableOpacity
            style={styles.previewCard}
            onPress={handlePreviewPress}
            activeOpacity={0.9}
          >
            <View style={styles.previewContent}>
              <Text style={styles.previewEmoji}>
                {CATEGORIES[selectedEvent.category]?.emoji}
              </Text>
              <View style={styles.previewText}>
                <Text style={styles.previewTitle} numberOfLines={1}>
                  {selectedEvent.title}
                </Text>
                {selectedEvent.location ? (
                  <Text style={styles.previewLocation} numberOfLines={1}>
                    {selectedEvent.location}
                  </Text>
                ) : null}
                <Text style={styles.previewTime}>
                  {formatTime(selectedEvent.startTime.toMillis())} — {formatTime(selectedEvent.endTime.toMillis())}
                  {formatDistance(selectedEvent) && (
                    <Text style={styles.previewDistance}> · {formatDistance(selectedEvent)}</Text>
                  )}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
          {selectedEvent.startTime.toMillis() > Date.now() ? (
            <View style={styles.interestedRow}>
              <TouchableOpacity
                style={[styles.interestedButton, interestedMap[selectedEvent.id] && styles.interestedButtonActive]}
                onPress={() => handleInterested(selectedEvent)}
                activeOpacity={0.8}
              >
                <Text style={styles.interestedStar}>{interestedMap[selectedEvent.id] ? '⭐' : '☆'}</Text>
                <Text style={[styles.interestedText, interestedMap[selectedEvent.id] && styles.interestedTextActive]}>
                  {(selectedEvent.interested ?? 0) > 0
                    ? `${selectedEvent.interested} interested`
                    : 'Interested'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.floatingVotes}>
              <TouchableOpacity
                style={[styles.floatingVoteButton, votes[selectedEvent.id] === 'up' && styles.floatingVoteActive]}
                onPress={() => handleVote(selectedEvent, 'up')}
                activeOpacity={0.8}
              >
                <Text style={styles.floatingVoteEmoji}>👍</Text>
                <Text style={[styles.floatingVoteCount, votes[selectedEvent.id] === 'up' && styles.floatingVoteCountActive]}>
                  {selectedEvent.thumbsUp ?? 0}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.floatingVoteButton, votes[selectedEvent.id] === 'down' && styles.floatingVoteDown]}
                onPress={() => handleVote(selectedEvent, 'down')}
                activeOpacity={0.8}
              >
                <Text style={styles.floatingVoteEmoji}>👎</Text>
                <Text style={[styles.floatingVoteCount, votes[selectedEvent.id] === 'down' && styles.floatingVoteCountActive]}>
                  {selectedEvent.thumbsDown ?? 0}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      <View style={[styles.timelineBar, !timelineOpen && { right: 'auto' as any }]}>
        <TouchableOpacity
          style={styles.timelinePill}
          onPress={() => setTimelineOpen((v) => !v)}
          activeOpacity={0.8}
        >
          <View style={styles.timelinePillDot} />
          <Text style={[styles.timelinePillText, timelineOpen && { minWidth: 72 }]}>
            {timelineVisualIndex === 0 ? 'Now' : timelineSnaps[timelineVisualIndex].label}
          </Text>
        </TouchableOpacity>
        {timelineOpen && (
          <View
            ref={timelineTrackRef}
            style={styles.timelineTrack}
            onLayout={handleTrackLayout}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={handleTimelineGrant}
            onResponderMove={handleTimelineMove}
          >
            <View style={styles.trackLine} />
            {timelineSnaps.map((snap, i) => {
              const isActive = i === timelineVisualIndex;
              return (
                <View
                  key={i}
                  style={[
                    styles.timelineDotWrapper,
                    { left: `${(i / (timelineSnaps.length - 1)) * 100}%` },
                  ]}
                >
                  <View
                    style={[
                      styles.timelineDot,
                      isActive && styles.timelineDotActive,
                    ]}
                  />
                </View>
              );
            })}
          </View>
        )}
      </View>

      <TouchableOpacity
        style={styles.listToggleButton}
        onPress={() => setShowListView((v) => !v)}
        activeOpacity={0.8}
      >
        <Text style={styles.listToggleText}>{showListView ? '🗺' : '☰'}</Text>
      </TouchableOpacity>

      {showListView && (
        <View style={styles.listOverlay}>
          <View style={styles.listHeader}>
            <Text style={styles.listTitle}>Nearby</Text>
            <TouchableOpacity onPress={() => setShowListView(false)}>
              <Text style={styles.listClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.listScroll}>
            {eventsSortedByDistance.map((event) => {
              const category = CATEGORIES[event.category];
              if (!category) return null;
              return (
                <TouchableOpacity
                  key={event.id}
                  style={styles.listItem}
                  onPress={() => {
                    setShowListView(false);
                    setSelectedEvent(event);
                    mapRef.current?.animateToRegion({
                      latitude: event.latitude,
                      longitude: event.longitude,
                      latitudeDelta: 0.01,
                      longitudeDelta: 0.01,
                    }, 300);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.listItemDot, { backgroundColor: category.color }]}>
                    <Text style={styles.listItemEmoji}>{category.emoji}</Text>
                  </View>
                  <View style={styles.listItemContent}>
                    <Text style={styles.listItemTitle} numberOfLines={1}>{event.title}</Text>
                    {event.location ? (
                      <Text style={styles.listItemLocation} numberOfLines={1}>{event.location}</Text>
                    ) : null}
                    <Text style={styles.listItemMeta}>
                      {formatTime(event.startTime.toMillis())}
                      {formatDistance(event) && (
                        <Text style={styles.listItemDistance}> · {formatDistance(event)}</Text>
                      )}
                    </Text>
                  </View>
                  {(event.interested ?? 0) > 0 && (
                    <Text style={styles.listItemInterested}>⭐ {event.interested}</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TouchableOpacity
            style={styles.listMapButton}
            onPress={() => setShowListView(false)}
            activeOpacity={0.8}
          >
            <Text style={styles.listMapButtonText}>◉</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Selected report card */}
      {selectedReport && (
        <View style={styles.previewWrapper}>
          <View style={styles.previewCard}>
            {isAdmin && (
              <TouchableOpacity
                style={styles.adminDeleteBtn}
                onPress={() => {
                  Alert.alert('Delete Report', 'Delete this report?', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => {
                      deleteReport(selectedReport.id);
                      setSelectedReport(null);
                    }},
                  ]);
                }}
              >
                <Text style={styles.adminDeleteText}>✕</Text>
              </TouchableOpacity>
            )}
            <View style={styles.previewContent}>
              <Text style={styles.previewEmoji}>
                {REPORT_CATEGORIES[selectedReport.category]?.emoji || '📍'}
              </Text>
              <View style={styles.previewText}>
                <Text style={styles.previewTitle} numberOfLines={2}>
                  {selectedReport.text}
                </Text>
                <Text style={styles.previewTime}>
                  {selectedReport.userName} · {(() => {
                    const mins = Math.floor((Date.now() - selectedReport.createdAt.toMillis()) / 60000);
                    if (mins < 1) return 'just now';
                    if (mins < 60) return `${mins}m ago`;
                    return `${Math.floor(mins / 60)}h ago`;
                  })()}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.confirmBtn}
              onPress={() => {
                confirmReport(selectedReport.id);
                setSelectedReport({ ...selectedReport, confirmations: selectedReport.confirmations + 1 });
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.confirmBtnEmoji}>👍</Text>
              <Text style={styles.confirmBtnText}>
                {selectedReport.confirmations > 0
                  ? `${selectedReport.confirmations} confirmed`
                  : 'Still happening'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Admin delete on selected event */}
      {isAdmin && selectedEvent && !selectedEvent.sourceUrl && !(selectedEvent.sourceUrls?.length) && (
        <TouchableOpacity
          style={styles.adminDeleteFloat}
          onPress={() => {
            Alert.alert('Delete Event', `Delete "${selectedEvent.title}"?`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => {
                deleteEvent(selectedEvent.id);
                setSelectedEvent(null);
              }},
            ]);
          }}
        >
          <Text style={styles.adminDeleteFloatText}>Delete</Text>
        </TouchableOpacity>
      )}

      {/* Drop pin button */}
      <TouchableOpacity
        style={[styles.dropPinButton, pinDropMode && styles.dropPinButtonActive]}
        onPress={() => {
          if (!user) {
            router.push('/sign-in');
            return;
          }
          setPinDropMode((v) => !v);
          setPendingPin(null);
        }}
        activeOpacity={0.8}
      >
        <Text style={styles.dropPinText}>+</Text>
      </TouchableOpacity>

      {/* Profile / Sign-in button */}
      {!selectedEvent && !selectedReport && (
        user ? (
          <TouchableOpacity
            style={styles.profileFloat}
            onPress={() => {
              Alert.alert(displayName || 'Account', user.email || '', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
              ]);
            }}
            activeOpacity={0.8}
          >
            {user.photoURL ? (
              <Image source={{ uri: user.photoURL }} style={styles.profileImage} />
            ) : (
              <Text style={styles.profileInitial}>
                {(displayName || user.email || '?')[0].toUpperCase()}
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.signInFloat}
            onPress={() => router.push('/sign-in')}
            activeOpacity={0.8}
          >
            <Text style={styles.signInFloatText}>Sign in</Text>
          </TouchableOpacity>
        )
      )}

      {/* Pin drop mode banner */}
      {pinDropMode && (
        <View style={styles.pinDropBanner}>
          <Text style={styles.pinDropBannerText}>Tap the map to drop a pin</Text>
        </View>
      )}

      {/* Report form modal */}
      <Modal visible={!!pendingPin} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.reportForm}>
            <View style={styles.reportFormHeader}>
              <Text style={styles.reportFormTitle}>What's happening here?</Text>
              <TouchableOpacity onPress={() => { setPendingPin(null); setReportText(''); setReportCategory('other'); }}>
                <Text style={styles.reportFormClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.reportCatScroll}>
              {(Object.keys(REPORT_CATEGORIES) as ReportCategory[]).map((key) => {
                const cat = REPORT_CATEGORIES[key];
                const active = reportCategory === key;
                return (
                  <TouchableOpacity
                    key={key}
                    style={[styles.reportCatPill, { backgroundColor: active ? cat.color : '#f0f0f0' }]}
                    onPress={() => setReportCategory(key)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.reportCatEmoji}>{cat.emoji}</Text>
                    <Text style={[styles.reportCatLabel, active && { color: '#fff' }]}>{cat.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TextInput
              style={styles.reportInput}
              placeholder="Add a note (optional)"
              placeholderTextColor="#999"
              value={reportText}
              onChangeText={setReportText}
              maxLength={140}
            />
            <TouchableOpacity
              style={[styles.reportSubmit, submittingReport && { opacity: 0.6 }]}
              disabled={submittingReport}
              onPress={async () => {
                if (!user || !pendingPin) return;
                setSubmittingReport(true);
                try {
                  await createReport({
                    text: reportText || REPORT_CATEGORIES[reportCategory].label,
                    category: reportCategory,
                    latitude: pendingPin.latitude,
                    longitude: pendingPin.longitude,
                    userId: user.uid,
                    userName: displayName || user.displayName || 'Anonymous',
                    userPhoto: user.photoURL || undefined,
                  });
                  setPendingPin(null);
                  setReportText('');
                  setReportCategory('other');
                } catch (err) {
                  Alert.alert('Error', 'Failed to drop pin');
                } finally {
                  setSubmittingReport(false);
                }
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.reportSubmitText}>{submittingReport ? 'Posting...' : 'Drop Pin'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <AdminPasscodeModal
        visible={showPasscodeModal}
        onClose={() => setShowPasscodeModal(false)}
        onSubmit={handlePasscodeSubmit}
      />

      {/* Welcome modal */}
      {showWelcome && (
        <View style={styles.welcomeBackdrop}>
          <View style={styles.welcomeModal}>
            <View style={styles.welcomeHeader}>
              <Animated.View style={[styles.welcomeHeaderDot, { transform: [{ scale: dotScale }] }]} />
              <Text style={styles.welcomeTitle}>Pulse</Text>
            </View>
            <Text style={styles.welcomeSubtitle}>What's happening in NYC right now</Text>
            <View style={styles.welcomeCategories}>
              {CATEGORY_LIST.map((key) => {
                const cat = CATEGORIES[key];
                return (
                  <View key={key} style={styles.welcomeRow}>
                    <View style={[styles.welcomeSwatch, { backgroundColor: cat.color }]}>
                      <Text style={styles.welcomeSwatchEmoji}>{cat.emoji}</Text>
                    </View>
                    <Text style={styles.welcomeLabel}>{cat.label}</Text>
                  </View>
                );
              })}
            </View>
            <TouchableOpacity style={styles.welcomeButton} onPress={handleDismissWelcome} activeOpacity={0.8}>
              <Text style={styles.welcomeButtonText}>Explore</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Splash screen (covers everything until data loads) */}
      <Animated.View style={[styles.splash, { opacity: splashOpacity }]} pointerEvents="none">
        <Animated.View style={[styles.splashDot, { transform: [{ scale: dotScale }] }]} />
        <Text style={styles.splashTitle}>Pulse</Text>
        <Text style={styles.splashSubtitle}>NYC Events</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  markerWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  marker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5,
  },
  markerEmoji: {
    fontSize: 20,
  },
  markerArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    alignSelf: 'center',
    marginTop: -2,
  },
  filterContainer: {
    position: 'absolute',
    top: 60,
    right: 16,
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  filterToggle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  filterToggleIcon: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  layersIcon: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  layersDiamond: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 1,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    transform: [{ rotate: '45deg' }],
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
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  filterPillInactive: {
    opacity: 0.5,
  },
  filterEmoji: {
    fontSize: 22,
  },
  previewWrapper: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
  },
  previewCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  previewContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingBottom: 30,
  },
  previewEmoji: {
    fontSize: 32,
    marginRight: 12,
  },
  previewText: {
    flex: 1,
  },
  previewTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 2,
  },
  previewLocation: {
    fontSize: 14,
    color: '#666',
    marginBottom: 2,
  },
  previewTime: {
    fontSize: 13,
    color: '#999',
  },
  previewDistance: {
    color: '#2a7cff',
    fontWeight: '600',
  },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  sourceLink: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    marginTop: -20,
  },
  sourceLinkText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2a7cff',
  },
  interestedRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
    marginRight: 12,
  },
  interestedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    gap: 6,
  },
  interestedButtonActive: {
    backgroundColor: '#fff3cd',
  },
  interestedStar: {
    fontSize: 14,
  },
  interestedText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
  },
  interestedTextActive: {
    color: '#b8860b',
  },
  floatingVotes: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: -22,
    marginRight: 12,
    gap: 10,
  },
  floatingVoteButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 6,
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
  },
  floatingVoteCount: {
    fontSize: 10,
    color: '#666',
    fontWeight: '600',
  },
  floatingVoteCountActive: {
    color: '#fff',
  },
  timelineBar: {
    position: 'absolute',
    bottom: 100,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderRadius: 22,
    paddingRight: 6,
  },
  timelinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
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
    fontWeight: '600',
  },
  timelineTrack: {
    flex: 1,
    height: 20,
    marginRight: 10,
    justifyContent: 'center',
  },
  trackLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 1,
  },
  timelineDotWrapper: {
    position: 'absolute',
    top: '50%',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateX: -3 }, { translateY: -3 }],
  },
  timelineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  timelineDotActive: {
    backgroundColor: '#fff',
    width: 14,
    height: 14,
    borderRadius: 7,
    shadowColor: '#fff',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    transform: [{ translateX: -7 }, { translateY: -7 }],
  },
  listToggleButton: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  listToggleText: {
    color: '#fff',
    fontSize: 22,
  },
  listOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#fff',
    zIndex: 100,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  listTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  listClose: {
    fontSize: 20,
    color: '#999',
    padding: 8,
  },
  listScroll: {
    flex: 1,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  listItemDot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  listItemEmoji: {
    fontSize: 18,
  },
  listItemContent: {
    flex: 1,
  },
  listItemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 2,
  },
  listItemLocation: {
    fontSize: 13,
    color: '#666',
    marginBottom: 2,
  },
  listItemMeta: {
    fontSize: 12,
    color: '#999',
  },
  listItemDistance: {
    color: '#2a7cff',
    fontWeight: '600',
  },
  listItemInterested: {
    fontSize: 12,
    color: '#b8860b',
    fontWeight: '600',
    marginLeft: 8,
  },
  listMapButton: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  listMapButtonText: {
    color: '#fff',
    fontSize: 22,
  },
  adminButton: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  adminButtonText: {
    color: '#fff',
    fontSize: 22,
  },
  welcomeBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  welcomeModal: {
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    paddingVertical: 32,
    paddingHorizontal: 36,
    width: '85%',
    maxWidth: 320,
    alignItems: 'center',
  },
  welcomeHeader: {
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
  },
  welcomeTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  welcomeSubtitle: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 14,
    marginBottom: 24,
  },
  welcomeCategories: {
    width: '100%',
    gap: 12,
    marginBottom: 28,
  },
  welcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  welcomeSwatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeSwatchEmoji: {
    fontSize: 16,
  },
  welcomeLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  welcomeButton: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 36,
  },
  welcomeButtonText: {
    color: '#1a1a1a',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  reportMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a1a',
    borderWidth: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5,
  },
  pendingMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ff5252',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5,
  },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f0f0f0',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    alignSelf: 'flex-start',
  },
  confirmBtnEmoji: {
    fontSize: 14,
  },
  confirmBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
  },
  adminDeleteBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ff4444',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  adminDeleteText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  adminDeleteFloat: {
    position: 'absolute',
    top: 60,
    left: 16,
    backgroundColor: '#ff4444',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 10,
  },
  adminDeleteFloatText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  dropPinButton: {
    position: 'absolute',
    bottom: 40,
    right: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  dropPinButtonActive: {
    backgroundColor: '#ff5252',
  },
  dropPinText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2,
  },
  profileFloat: {
    position: 'absolute',
    top: 60,
    left: 16,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#000',
  },
  profileImage: {
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  profileInitial: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  signInFloat: {
    position: 'absolute',
    top: 60,
    left: 16,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  signInFloatText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  pinDropBanner: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.9)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  pinDropBannerText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  reportForm: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 40,
  },
  reportFormHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  reportFormTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  reportFormClose: {
    fontSize: 18,
    color: '#999',
    padding: 4,
  },
  reportCatScroll: {
    marginBottom: 12,
  },
  reportCatPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginRight: 8,
  },
  reportCatEmoji: {
    fontSize: 14,
  },
  reportCatLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#333',
  },
  reportInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  reportSubmit: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  reportSubmitText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  splash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  splashDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#ff5252',
    marginBottom: 16,
  },
  splashTitle: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: 1,
  },
  splashSubtitle: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 16,
    marginTop: 6,
    fontWeight: '500',
  },
});
