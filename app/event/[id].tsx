import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Linking, TextInput, KeyboardAvoidingView, Platform, Image, Alert, Share } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CATEGORIES, ADMIN_EMAIL } from '@/constants/categories';
import { EventCategory, Comment, FlagReason } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { subscribeToComments, addComment, deleteEvent, flagContent } from '@/services/firebase';
import { getHiddenContent, setHidden } from '@/services/votes';

const FLAG_REASONS: { value: FlagReason; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'misleading', label: 'Misleading' },
];


export default function EventDetailScreen() {
  const { id, title, category, description, location, startTime, endTime, sourceUrl, sourceUrls } = useLocalSearchParams<{
    id: string;
    title: string;
    category: EventCategory;
    description: string;
    location: string;
    startTime: string;
    endTime: string;
    sourceUrl: string;
    sourceUrls: string;
  }>();

  const urls = useMemo((): string[] => {
    if (sourceUrls) {
      try { return JSON.parse(sourceUrls); } catch {}
    }
    if (sourceUrl) return [sourceUrl];
    return [];
  }, [sourceUrl, sourceUrls]);

  const { user, displayName } = useAuth();
  const router = useRouter();
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hiddenMap, setHiddenMap] = useState<Record<string, boolean>>({});
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  const categoryConfig = CATEGORIES[category as EventCategory];
  const start = useMemo(() => new Date(Number(startTime)), [startTime]);
  const end = useMemo(() => new Date(Number(endTime)), [endTime]);

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
    getHiddenContent().then(setHiddenMap);
  }, []);

  const formatTime = (date: Date) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 86400000);
    const eventDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    const h = date.getHours();
    const hour = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    const min = date.getMinutes().toString().padStart(2, '0');
    const time = `${hour}:${min} ${ampm}`;

    if (eventDay.getTime() === today.getTime()) return `Today, ${time}`;
    if (eventDay.getTime() === tomorrow.getTime()) return `Tomorrow, ${time}`;

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${time}`;
  };

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
    if (!id) return;
    Alert.alert('Delete Event', `Delete "${title}"?`, [
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
    const emoji = categoryConfig?.emoji || '';
    const timeStr = `${formatTime(start)} — ${formatTime(end)}`;
    const locationLine = location ? `\n${location}` : '';
    const urlLine = urls.length > 0 ? `\n${urls[0]}` : '';

    const message = `${emoji} ${title}${locationLine}\n${timeStr}${urlLine}\n\nFound on Pulse - discover what's happening in NYC\nhttps://pulse-3ed92.web.app/`;

    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { message }
          : { message, title: title || 'Check out this event' }
      );
    } catch {}
  }, [title, location, start, end, urls, categoryConfig]);

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

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
        <View style={styles.header}>
          {isAdmin && urls.length === 0 && (
            <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.emoji}>{categoryConfig?.emoji}</Text>
          <Text style={styles.title}>{title}</Text>
          <View style={[styles.categoryBadge, { backgroundColor: categoryConfig?.backgroundColor }]}>
            <Text style={[styles.categoryText, { color: categoryConfig?.color }]}>
              {categoryConfig?.label}
            </Text>
          </View>
          <Text style={styles.timeRange}>
            {formatTime(start)} — {formatTime(end)}
          </Text>
          <TouchableOpacity style={styles.shareButton} onPress={handleShare} activeOpacity={0.7}>
            <Text style={styles.shareButtonIcon}>↗</Text>
          </TouchableOpacity>
        </View>
        {description ? (
          <View style={styles.descriptionContainer}>
            <Text style={styles.description}>{description}</Text>
          </View>
        ) : null}
        {urls.length > 0 ? (
          <View style={styles.sourceLinks}>
            {urls.map((url, i) => (
              <TouchableOpacity
                key={i}
                style={styles.sourceLink}
                onPress={() => Linking.openURL(url)}
                activeOpacity={0.7}
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
                  <TouchableOpacity onPress={() => handleFlagComment(c)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
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
          />
          <TouchableOpacity
            style={[styles.sendButton, (!commentText.trim() || submitting) && { opacity: 0.4 }]}
            onPress={handleSendComment}
            disabled={!commentText.trim() || submitting}
          >
            <Text style={styles.sendButtonText}>↑</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.signInBar}
          onPress={() => router.push('/sign-in')}
          activeOpacity={0.8}
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
