import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { StyleSheet, View, TouchableOpacity, Text, Alert, Dimensions, GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import MapView, { Marker, Callout, MapPressEvent, PROVIDER_GOOGLE } from 'react-native-maps';
import { useRouter } from 'expo-router';
import { AppEvent } from '@/types';
import { subscribeToUpcomingEvents, voteOnEvent } from '@/services/firebase';
import { getAllVotes, setVote, VoteType } from '@/services/votes';
import { CATEGORIES, NYC_REGION, ADMIN_PASSCODE } from '@/constants/categories';
import { MAP_STYLE } from '@/constants/mapStyle';
import { AdminPasscodeModal } from '@/components/AdminPasscodeModal';

export default function MapScreen() {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AppEvent | null>(null);
  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [votes, setVotes] = useState<Record<string, VoteType>>({});
  const router = useRouter();
  const mapRef = useRef<MapView>(null);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);

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

  const updateTimelineFromTouch = useCallback((pageX: number) => {
    if (!trackWidth) return;
    const x = pageX - timelineTrackX.current;
    const fraction = Math.max(0, Math.min(1, x / trackWidth));
    const index = Math.round(fraction * (timelineSnaps.length - 1));
    setTimelineIndex(index);
  }, [trackWidth, timelineSnaps.length]);

  const handleTimelineGrant = useCallback((evt: GestureResponderEvent) => {
    timelineTrackRef.current?.measureInWindow((x) => {
      timelineTrackX.current = x;
      updateTimelineFromTouch(evt.nativeEvent.pageX);
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

  const [allEvents, setAllEvents] = useState<AppEvent[]>([]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = subscribeToUpcomingEvents((upcoming) => {
        setAllEvents(upcoming);
      });
    } catch (e) {
      console.warn('Firebase not configured yet:', e);
    }

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Filter events based on selected timeline time
  useEffect(() => {
    const selectedTime = timelineSnaps[timelineIndex].time.getTime();
    const filtered = allEvents.filter((event: any) => {
      const started = event.startTime.toMillis() <= selectedTime;
      const notEnded = event.endTime.toMillis() > selectedTime;
      return started && notEnded;
    });
    setEvents(filtered);
    // Clear selected event if it's no longer visible
    setSelectedEvent((prev) => {
      if (!prev) return null;
      return filtered.find((e) => e.id === prev.id) ? prev : null;
    });
  }, [allEvents, timelineIndex, timelineSnaps]);

  const handleMapPress = useCallback((e: MapPressEvent) => {
    // Only dismiss if tapping the map itself, not a marker
    if (e.nativeEvent.action !== 'marker-press') {
      setSelectedEvent(null);
      setTimelineOpen(false);
    }
  }, []);

  const handleMarkerPress = useCallback((event: AppEvent) => {
    setSelectedEvent(event);
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
      },
    });
  }, [selectedEvent, router]);

  const handleAdminPress = () => {
    if (isAdmin) {
      router.push('/admin');
    } else {
      setShowPasscodeModal(true);
    }
  };

  const handlePasscodeSubmit = (code: string) => {
    if (code === ADMIN_PASSCODE) {
      setIsAdmin(true);
      setShowPasscodeModal(false);
      router.push('/admin');
    } else {
      Alert.alert('Incorrect', 'Wrong passcode. Try again.');
    }
  };

  const formatTime = (millis: number) => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d = new Date(millis);
    const h = d.getHours();
    const hour = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    const min = d.getMinutes().toString().padStart(2, '0');
    return `${months[d.getMonth()]} ${d.getDate()}, ${hour}:${min} ${ampm}`;
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
        showsMyLocationButton
        onPress={handleMapPress}
      >
        {events.map((event) => {
          const category = CATEGORIES[event.category];
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
              <View style={[styles.marker, { backgroundColor: category.color }]}>
                <Text style={styles.markerEmoji}>{category.emoji}</Text>
              </View>
              <View style={[styles.markerArrow, { borderTopColor: category.color }]} />
              <Callout tooltip>
                <View />
              </Callout>
            </Marker>
          );
        })}
      </MapView>

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
                  {formatTime(selectedEvent.startTime.toMillis())} —{' '}
                  {formatTime(selectedEvent.endTime.toMillis())}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
          {timelineIndex === 0 && (
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

      {!timelineOpen ? (
        <TouchableOpacity
          style={styles.timelinePill}
          onPress={() => setTimelineOpen(true)}
          activeOpacity={0.8}
        >
          <View style={styles.timelinePillDot} />
          <Text style={styles.timelinePillText}>
            {timelineIndex === 0 ? 'Now' : timelineSnaps[timelineIndex].label}
          </Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.timelineContainer}>
          <View style={styles.timelineHeader}>
            <Text style={styles.timelineLabel}>
              {timelineSnaps[timelineIndex].label}
            </Text>
            <TouchableOpacity onPress={() => setTimelineOpen(false)}>
              <Text style={styles.timelineClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <View
            ref={timelineTrackRef}
            style={styles.timelineTrack}
            onLayout={handleTrackLayout}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={handleTimelineGrant}
            onResponderMove={handleTimelineMove}
          >
            {timelineSnaps.map((snap, i) => {
              const isActive = i === timelineIndex;
              const isDay = snap.label.includes('12AM') || i === 0;
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
                  {isDay && (
                    <Text style={styles.timelineTickLabel}>
                      {i === 0 ? 'Now' : snap.label.split(' ')[0]}
                    </Text>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      )}

      <TouchableOpacity style={styles.adminButton} onPress={handleAdminPress}>
        <Text style={styles.adminButtonText}>{isAdmin ? '＋' : '⚙'}</Text>
      </TouchableOpacity>

      <AdminPasscodeModal
        visible={showPasscodeModal}
        onClose={() => setShowPasscodeModal(false)}
        onSubmit={handlePasscodeSubmit}
      />
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
  timelinePill: {
    position: 'absolute',
    bottom: 100,
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
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
  timelineContainer: {
    position: 'absolute',
    bottom: 100,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(30, 30, 30, 0.85)',
    borderRadius: 16,
    paddingTop: 10,
    paddingBottom: 8,
    paddingHorizontal: 12,
  },
  timelineHeader: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  timelineLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
    textAlign: 'center',
  },
  timelineClose: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 16,
    paddingLeft: 8,
  },
  timelineTrack: {
    height: 36,
    position: 'relative',
  },
  timelineDotWrapper: {
    position: 'absolute',
    top: 0,
    alignItems: 'center',
    transform: [{ translateX: -6 }],
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  timelineDotActive: {
    backgroundColor: '#fff',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginTop: -2,
  },
  timelineTickLabel: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 9,
    marginTop: 4,
  },
  adminButton: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#333',
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
});
