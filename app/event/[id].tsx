import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Linking, TextInput, KeyboardAvoidingView, Platform, Image, Alert, Share, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CATEGORIES, ADMIN_EMAIL } from '@/constants/categories';
import { AppEvent, EventCategory, Comment, FlagReason } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { subscribeToComments, subscribeToEvent, addComment, deleteEvent, flagContent, markInterested } from '@/services/firebase';
import { getHiddenContent, getInterestedEvents, setHidden, setInterested as setInterestedLocal } from '@/services/votes';
import { eventStatus, formatEventRange } from '@/utils/eventTime';

const FLAG_REASONS: { value: FlagReason; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'misleading', label: 'Misleading' },
];

function parseUrls(sourceUrls?: string, sourceUrl?: string): string[] {
  if (sourceUrls) {
    try {
      const parsed = JSON.parse(sourceUrls);
      if (Array.isArray(parsed)) return parsed.filter((url): url is string => typeof url === 'string');
    } catch {}
  }
  return sourceUrl ? [sourceUrl] : [];
}

function finiteNumber(value?: string): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default function EventDetailScreen() {
  const params = useLocalSearchParams<{
    id: string;
    title?: string;
    category?: EventCategory;
    description?: string;
    location?: string;
    startTime?: string;
    endTime?: string;
    sourceUrl?: string;
    sourceUrls?: string;
    latitude?: string;
    longitude?: string;
  }>();
  const { id } = params;

  const { user, displayName } = useAuth();
  const router = useRouter();
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hiddenMap, setHiddenMap] = useState<Record<string, boolean>>({});
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  // undefined while loading; null once the event no longer exists.
  const [liveEvent, setLiveEvent] = useState<AppEvent | null | undefined>(undefined);
  const [interested, setInterested] = useState(false);

  // The map passes a snapshot for an instant first render; the live document
  // keeps counts and corrected times current, and serves links that carry
  // only an id (a tapped reminder notification).
  const event = useMemo(() => {
    const startMs = liveEvent?.startTime?.toMillis?.() ?? finiteNumber(params.startTime);
    const endMs = liveEvent?.endTime?.toMillis?.() ?? finiteNumber(params.endTime);
    const title = liveEvent?.title ?? params.title;
    if (!title || startMs === null || endMs === null) return null;
    return {
      title,
      category: (liveEvent?.category ?? params.category) as EventCategory | undefined,
      description: liveEvent?.description ?? params.description ?? '',
      location: liveEvent?.location ?? params.location ?? '',
      startMs,
      endMs,
      urls: liveEvent
        ? liveEvent.sourceUrls?.length ? liveEvent.sourceUrls : liveEvent.sourceUrl ? [liveEvent.sourceUrl] : []
        : parseUrls(params.sourceUrls, params.sourceUrl),
      latitude: liveEvent?.latitude ?? finiteNumber(params.latitude),
      longitude: liveEvent?.longitude ?? finiteNumber(params.longitude),
      interestedCount: liveEvent?.interested ?? 0,
    };
  }, [liveEvent, params]);

  const categoryConfig = event?.category ? CATEGORIES[event.category] : undefined;

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!id) return;
    const unsubscribe = subscribeToComments(id, setComments);
    return () => unsubscribe();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const unsubscribe = subscribeToEvent(id, setLiveEvent);
    return () => unsubscribe();
  }, [id]);

  useEffect(() => {
    getHiddenContent().then(setHiddenMap).catch(() => {});
    if (id) getInterestedEvents().then((all) => setInterested(!!all[id])).catch(() => {});
  }, [id]);

  const timeRange = event ? formatEventRange(event.startMs, event.endMs, currentTime) : '';
  const status = event ? eventStatus(event.startMs, event.endMs, currentTime) : '';
  const isUpcoming = !!event && event.startMs > currentTime;

  const handleSendComment = async () => {
    if (!user || !commentText.trim() || !id) return;
    const text = commentText.trim();
    setCommentText('');
    setSubmitting(true);
    try {
      await addComment(id, {
        text,
        userId: user.uid,
        userName: displayName || user.displayName || 'Anonymous',
        ...(user.photoURL ? { userPhoto: user.photoURL } : {}),
      });
    } catch (err) {
      console.error('Failed to add comment:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = () => {
    if (!id || !event) return;
    Alert.alert('Delete Event', `Delete "${event.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          await deleteEvent(id);
          router.back();
        },
      },
    ]);
  };

  const handleShare = useCallback(async () => {
    if (!event) return;
    const emoji = categoryConfig?.emoji || '';
    const locationLine = event.location ? `\n${event.location}` : '';
    const urlLine = event.urls.length > 0 ? `\n${event.urls[0]}` : '';

    const message = `${emoji} ${event.title}${locationLine}\n${timeRange}${urlLine}\n\nFound on Pulse - discover what's happening in NYC\nhttps://pulse-3ed92.web.app/`;

    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { message }
          : { message, title: event.title || 'Check out this event' }
      );
    } catch {}
  }, [event, timeRange, categoryConfig]);

  const handleDirections = useCallback(async () => {
    if (!event || event.latitude === null || event.longitude === null) return;
    const destination = `${event.latitude},${event.longitude}`;
    const web = `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
    const url = Platform.OS === 'ios'
      ? `https://maps.apple.com/?daddr=${destination}&q=${encodeURIComponent(event.location || event.title)}`
      : web;
    try {
      await Linking.openURL(url);
    } catch {
      Linking.openURL(web).catch(() => {});
    }
  }, [event]);

  const handleInterested = useCallback(async () => {
    if (!id) return;
    const wasInterested = interested;
    setInterested(!wasInterested);
    try {
      await Promise.all([
        markInterested(id, wasInterested, user?.uid),
        setInterestedLocal(id, !wasInterested),
      ]);
    } catch (e) {
      setInterested(wasInterested);
      console.warn('Interested failed:', e);
    }
  }, [id, interested, user]);

  const isAdmin = user?.email === ADMIN_EMAIL;

  const handleFlagComment = (comment: Comment) => {
    if (user && comment.userId === user.uid) return;
    Alert.alert('Report Comment', 'Why are you reporting this comment?',
      [
        ...FLAG_REASONS.map((r) => ({
          text: r.label,
          onPress: async () => {
            if (user) {
              await flagContent({
                contentType: 'comment' as const,
                contentId: comment.id,
                eventId: id,
                reason: r.value,
                reporterId: user.uid,
              });
            }
            await setHidden(comment.id);
            setHiddenMap((prev) => ({ ...prev, [comment.id]: true }));
            Alert.alert('Reported', 'Thanks for helping keep Pulse safe.');
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  };

  const timeAgo = (millis: number) => {
    const mins = Math.floor((currentTime - millis) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h`;
  };

  if (!event) {
    return (
      <View style={styles.missing}>
        {liveEvent === undefined ? (
          <ActivityIndicator size="large" color="#999" accessibilityLabel="Loading event" />
        ) : (
          <>
            <Text style={styles.missingTitle}>This event is no longer listed</Text>
            <Text style={styles.missingText}>It may have ended or been removed.</Text>
            <TouchableOpacity style={styles.missingButton} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityRole="button">
              <Text style={styles.missingButtonText}>Back to the map</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  const hasPin = event.latitude !== null && event.longitude !== null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
        <View style={styles.header}>
          {isAdmin && event.urls.length === 0 && (
            <TouchableOpacity style={styles.deleteButton} onPress={handleDelete} accessibilityRole="button" accessibilityLabel="Delete event">
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.emoji}>{categoryConfig?.emoji}</Text>
          <Text style={styles.title}>{event.title}</Text>
          <View style={[styles.categoryBadge, { backgroundColor: categoryConfig?.backgroundColor }]}>
            <Text style={[styles.categoryText, { color: categoryConfig?.color }]}>
              {categoryConfig?.label}
            </Text>
          </View>
          <Text style={styles.timeRange}>{timeRange}</Text>
          <Text style={[styles.status, status === 'Ended' && styles.statusEnded]}>{status}</Text>
          {event.location ? <Text style={styles.location}>{event.location}</Text> : null}
          <TouchableOpacity style={styles.shareButton} onPress={handleShare} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Share event">
            <Text style={styles.shareButtonIcon}>↗</Text>
          </TouchableOpacity>
          {(hasPin || isUpcoming) && (
            <View style={styles.actions}>
              {hasPin && (
                <TouchableOpacity style={styles.actionButton} onPress={handleDirections} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Get directions">
                  <Text style={styles.actionButtonText}>Directions</Text>
                </TouchableOpacity>
              )}
              {isUpcoming && (
                <TouchableOpacity
                  style={[styles.actionButton, styles.actionButtonSecondary, interested && styles.actionButtonInterested]}
                  onPress={handleInterested}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`Interested, ${event.interestedCount}`}
                  accessibilityState={{ selected: interested }}
                  accessibilityHint={user ? 'Sends you a reminder 30 minutes before it starts' : undefined}
                >
                  <Text style={[styles.actionButtonSecondaryText, interested && styles.actionButtonInterestedText]}>
                    {interested ? '⭐' : '☆'} {event.interestedCount > 0 ? `${event.interestedCount} interested` : 'Interested'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
        {event.description ? (
          <View style={styles.descriptionContainer}>
            <Text style={styles.description}>{event.description}</Text>
          </View>
        ) : null}
        {event.urls.length > 0 ? (
          <View style={styles.sourceLinks}>
            {event.urls.map((url, i) => (
              <TouchableOpacity
                key={i}
                style={styles.sourceLink}
                onPress={() => Linking.openURL(url)}
                activeOpacity={0.7}
                accessibilityRole="link"
              >
                <Text style={styles.sourceLinkText}>
                  {(() => {
                    try { return new URL(url).hostname.replace('www.', ''); }
                    catch { return url; }
                  })()}{' '}→
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* Comments */}
        <View style={styles.commentsSection}>
          <Text style={styles.commentsTitle}>
            Comments{comments.length > 0 ? ` (${comments.length})` : ''}
          </Text>
          {comments.filter((c) => !hiddenMap[c.id]).map((c) => (
            <View key={c.id} style={styles.commentItem}>
              {c.userPhoto ? (
                <Image source={{ uri: c.userPhoto }} style={styles.commentAvatar} />
              ) : (
                <View style={styles.commentAvatarPlaceholder}>
                  <Text style={styles.commentAvatarText}>
                    {(c.userName || '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.commentBody}>
                <Text style={styles.commentAuthor}>{c.userName}</Text>
                <Text style={styles.commentContent}>{c.text}</Text>
              </View>
              <View style={styles.commentActions}>
                <Text style={styles.commentTime}>{timeAgo(c.createdAt.toMillis())}</Text>
                {(!user || c.userId !== user.uid) && (
                  <TouchableOpacity onPress={() => handleFlagComment(c)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Report comment">
                    <Text style={styles.flagIcon}>⚑</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ))}
          {comments.length === 0 && (
            <Text style={styles.noComments}>No comments yet</Text>
          )}
        </View>
      </ScrollView>

      {/* Comment input */}
      {user ? (
        <View style={styles.commentInputBar}>
          <TextInput
            style={styles.commentInput}
            placeholder="Add a comment..."
            placeholderTextColor="#999"
            value={commentText}
            onChangeText={setCommentText}
            maxLength={280}
            returnKeyType="send"
            onSubmitEditing={handleSendComment}
            accessibilityLabel="Add a comment"
          />
          <TouchableOpacity
            style={[styles.sendButton, (!commentText.trim() || submitting) && { opacity: 0.4 }]}
            onPress={handleSendComment}
            disabled={!commentText.trim() || submitting}
            accessibilityRole="button"
            accessibilityLabel="Send comment"
          >
            <Text style={styles.sendButtonText}>↑</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.signInBar}
          onPress={() => router.push('/sign-in')}
          activeOpacity={0.8}
          accessibilityRole="button"
        >
          <Text style={styles.signInBarText}>Sign in to comment</Text>
        </TouchableOpacity>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  contentContainer: {
    paddingBottom: 20,
  },
  header: {
    paddingTop: 100,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  deleteButton: {
    position: 'absolute',
    top: 100,
    right: 68,
    backgroundColor: '#ff4444',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
  },
  deleteText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  emoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    color: '#1a1a1a',
  },
  categoryBadge: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    marginBottom: 12,
  },
  categoryText: {
    fontSize: 14,
    fontWeight: '600',
  },
  timeRange: {
    fontSize: 15,
    color: '#666',
  },
  status: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2a7cff',
    marginTop: 4,
  },
  statusEnded: {
    color: '#999',
  },
  location: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginTop: 6,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    marginTop: 16,
  },
  actionButton: {
    borderRadius: 20,
    paddingVertical: 9,
    paddingHorizontal: 18,
    backgroundColor: '#1a1a1a',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  actionButtonSecondary: {
    backgroundColor: '#f0f0f0',
  },
  actionButtonSecondaryText: {
    color: '#444',
    fontSize: 14,
    fontWeight: '600',
  },
  actionButtonInterested: {
    backgroundColor: '#fff3cd',
  },
  actionButtonInterestedText: {
    color: '#b8860b',
  },
  missing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#fff',
    gap: 10,
  },
  missingTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    textAlign: 'center',
  },
  missingText: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
  },
  missingButton: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 18,
    backgroundColor: '#1a1a1a',
  },
  missingButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  shareButton: {
    position: 'absolute',
    top: 100,
    right: 24,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareButtonIcon: {
    fontSize: 18,
    fontWeight: '700',
    color: '#666',
  },
  descriptionContainer: {
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  description: {
    fontSize: 16,
    lineHeight: 24,
    color: '#444',
  },
  sourceLinks: {
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 8,
  },
  sourceLink: {
    alignItems: 'center',
  },
  sourceLinkText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2a7cff',
  },
  commentsSection: {
    paddingHorizontal: 24,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    marginTop: 24,
  },
  commentsTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 12,
  },
  commentItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
  },
  commentAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  commentAvatarPlaceholder: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e0e0e0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#666',
  },
  commentBody: {
    flex: 1,
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  commentContent: {
    fontSize: 14,
    color: '#444',
    lineHeight: 20,
  },
  commentActions: {
    alignItems: 'flex-end',
    gap: 4,
  },
  commentTime: {
    fontSize: 11,
    color: '#aaa',
    marginTop: 2,
  },
  flagIcon: {
    fontSize: 15,
    color: '#999',
  },
  noComments: {
    fontSize: 14,
    color: '#999',
    fontStyle: 'italic',
  },
  commentInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingBottom: 32,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
    gap: 8,
  },
  commentInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  signInBar: {
    padding: 16,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  signInBarText: {
    fontSize: 14,
    color: '#2a7cff',
    fontWeight: '500',
  },
});
