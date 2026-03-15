import React, { useEffect, useState, useCallback, useRef } from 'react';
import { StyleSheet, View, TouchableOpacity, Text, Alert } from 'react-native';
import MapView, { Marker, Callout, MapPressEvent, PROVIDER_GOOGLE } from 'react-native-maps';
import { useRouter } from 'expo-router';
import { AppEvent } from '@/types';
import { subscribeToActiveEvents, voteOnEvent } from '@/services/firebase';
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

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = subscribeToActiveEvents((activeEvents) => {
        setEvents(activeEvents);
      });
    } catch (e) {
      console.warn('Firebase not configured yet:', e);
    }

    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleMapPress = useCallback((e: MapPressEvent) => {
    // Only dismiss if tapping the map itself, not a marker
    if (e.nativeEvent.action !== 'marker-press') {
      setSelectedEvent(null);
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
