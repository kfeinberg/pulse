import { useEffect, useState, useCallback, useMemo } from 'react';
import { CATEGORIES, ADMIN_EMAIL } from './categories';
import { EventCategory, Comment, FlagReason } from './types';
import { useAuth } from './contexts/AuthContext';
import { subscribeToComments, addComment, deleteEvent, flagContent } from './firebase';
import { getHiddenContent, setHidden } from './votes';
import { formatTime, getSourceUrls } from './utils';
import { navigate, goBack } from './router';

const FLAG_REASONS: { value: FlagReason; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'misleading', label: 'Misleading' },
];

function getParams() {
  const parts = window.location.pathname.split('/');
  const id = decodeURIComponent(parts[2] || '');
  const search = new URLSearchParams(window.location.search);
  return {
    id,
    title: search.get('title') || '',
    category: (search.get('category') || '') as EventCategory,
    description: search.get('description') || '',
    location: search.get('location') || '',
    startTime: search.get('startTime') || '',
    endTime: search.get('endTime') || '',
    sourceUrl: search.get('sourceUrl') || '',
    sourceUrls: search.get('sourceUrls') || '',
  };
}

export function EventDetail() {
  const { id, title, category, description, location, startTime, endTime, sourceUrl, sourceUrls } = useMemo(getParams, []);

  const urls = useMemo(() => getSourceUrls(sourceUrls, sourceUrl), [sourceUrl, sourceUrls]);

  const { user, displayName } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hiddenMap, setHiddenMap] = useState<Record<string, boolean>>({});
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [flagTarget, setFlagTarget] = useState<Comment | null>(null);
  const [copied, setCopied] = useState(false);

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
    setHiddenMap(getHiddenContent());
  }, []);

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
    if (confirm(`Delete "${title}"?`)) {
      deleteEvent(id).then(() => goBack());
    }
  };

  const handleShare = useCallback(async () => {
    const emoji = categoryConfig?.emoji || '';
    const timeStr = `${formatTime(start.getTime())} — ${formatTime(end.getTime())}`;
    const locationLine = location ? `\n${location}` : '';
    const urlLine = urls.length > 0 ? `\n${urls[0]}` : '';

    const message = `${emoji} ${title}${locationLine}\n${timeStr}${urlLine}\n\nFound on Pulse - discover what's happening in NYC\nhttps://pulse-3ed92.web.app/`;

    try {
      if (navigator.share) {
        await navigator.share({ text: message });
      } else {
        await navigator.clipboard.writeText(message);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {}
  }, [title, location, start, end, urls, categoryConfig]);

  const isAdmin = user?.email === ADMIN_EMAIL;

  const handleFlagComment = async (reason: FlagReason) => {
    if (!flagTarget) return;
    const comment = flagTarget;
    setFlagTarget(null);
    if (user) {
      await flagContent({
        contentType: 'comment' as const,
        contentId: comment.id,
        eventId: id,
        reason,
        reporterId: user.uid,
      });
    }
    setHidden(comment.id);
    setHiddenMap((prev) => ({ ...prev, [comment.id]: true }));
    alert('Thanks for helping keep Pulse safe.');
  };

  const timeAgo = (millis: number) => {
    const mins = Math.floor((currentTime - millis) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h`;
  };

  return (
    <div style={styles.page}>
      <div style={styles.navBar}>
        <div style={styles.navInner}>
          <button style={styles.backButton} onClick={() => goBack()}>
            ‹ Map
          </button>
        </div>
      </div>
      <div style={styles.scroll}>
        <div style={styles.content}>
          <div style={styles.header}>
            {isAdmin && urls.length === 0 && (
              <button style={styles.deleteButton} onClick={handleDelete}>
                Delete
              </button>
            )}
            <span style={styles.emoji}>{categoryConfig?.emoji}</span>
            <span style={styles.title}>{title}</span>
            <div style={{ ...styles.categoryBadge, backgroundColor: categoryConfig?.backgroundColor }}>
              <span style={{ ...styles.categoryText, color: categoryConfig?.color }}>
                {categoryConfig?.label}
              </span>
            </div>
            <span style={styles.timeRange}>
              {formatTime(start.getTime())} — {formatTime(end.getTime())}
            </span>
            <button style={styles.shareButton} onClick={handleShare} title="Share">
              {copied ? '✓' : '↗'}
            </button>
          </div>
          {description ? (
            <div style={styles.descriptionContainer}>
              <p style={styles.description}>{description}</p>
            </div>
          ) : null}
          {urls.length > 0 ? (
            <div style={styles.sourceLinks}>
              {urls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.sourceLinkText}
                >
                  {(() => {
                    try { return new URL(url).hostname.replace('www.', ''); }
                    catch { return url; }
                  })()}{' '}→
                </a>
              ))}
            </div>
          ) : null}

          {/* Comments */}
          <div style={styles.commentsSection}>
            <span style={styles.commentsTitle}>
              Comments{comments.length > 0 ? ` (${comments.length})` : ''}
            </span>
            {comments.filter((c) => !hiddenMap[c.id]).map((c) => (
              <div key={c.id} style={styles.commentItem}>
                {c.userPhoto ? (
                  <img src={c.userPhoto} style={styles.commentAvatar} referrerPolicy="no-referrer" alt="" />
                ) : (
                  <div style={styles.commentAvatarPlaceholder}>
                    <span style={styles.commentAvatarText}>
                      {(c.userName || '?')[0].toUpperCase()}
                    </span>
                  </div>
                )}
                <div style={styles.commentBody}>
                  <span style={styles.commentAuthor}>{c.userName}</span>
                  <span style={styles.commentContent}>{c.text}</span>
                </div>
                <div style={styles.commentActions}>
                  <span style={styles.commentTime}>{timeAgo(c.createdAt.toMillis())}</span>
                  {(!user || c.userId !== user.uid) && (
                    <span style={styles.flagIcon} onClick={() => setFlagTarget(c)}>⚑</span>
                  )}
                </div>
              </div>
            ))}
            {comments.length === 0 && (
              <span style={styles.noComments}>No comments yet</span>
            )}
          </div>
        </div>
      </div>

      {/* Comment input */}
      {user ? (
        <div style={styles.commentInputBarOuter}>
          <div style={styles.commentInputBar}>
            <input
              style={styles.commentInput}
              placeholder="Add a comment..."
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              maxLength={280}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSendComment();
                }
              }}
            />
            <button
              style={{ ...styles.sendButton, opacity: !commentText.trim() || submitting ? 0.4 : 1 }}
              onClick={handleSendComment}
              disabled={!commentText.trim() || submitting}
            >
              ↑
            </button>
          </div>
        </div>
      ) : (
        <div style={styles.signInBar} onClick={() => navigate('/sign-in')}>
          <span style={styles.signInBarText}>Sign in to comment</span>
        </div>
      )}

      {flagTarget && (
        <div style={styles.flagOverlay} onClick={() => setFlagTarget(null)}>
          <div style={styles.flagMenu} onClick={(e) => e.stopPropagation()}>
            <div style={styles.flagMenuTitle}>Report Comment</div>
            <div style={styles.flagMenuSubtitle}>Why are you reporting this comment?</div>
            {FLAG_REASONS.map((r) => (
              <button key={r.value} style={styles.flagMenuItem} onClick={() => handleFlagComment(r.value)}>
                {r.label}
              </button>
            ))}
            <button style={styles.flagMenuCancel} onClick={() => setFlagTarget(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: '#fff',
    position: 'relative',
  },
  navBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  navInner: {
    width: '100%',
    maxWidth: 720,
    padding: '12px 16px',
    display: 'flex',
  },
  backButton: {
    background: 'none',
    border: 'none',
    color: '#2a7cff',
    fontSize: 17,
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: 4,
    pointerEvents: 'auto',
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  content: {
    width: '100%',
    maxWidth: 720,
    paddingBottom: 20,
  },
  header: {
    position: 'relative',
    padding: '100px 24px 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  deleteButton: {
    position: 'absolute',
    top: 100,
    right: 68,
    backgroundColor: '#ff4444',
    color: '#fff',
    border: 'none',
    padding: '6px 14px',
    borderRadius: 16,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  emoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    textAlign: 'center',
    marginBottom: 12,
    color: '#1a1a1a',
  },
  categoryBadge: {
    padding: '6px 16px',
    borderRadius: 16,
    marginBottom: 12,
  },
  categoryText: {
    fontSize: 14,
    fontWeight: 600,
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
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    fontWeight: 700,
    color: '#666',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  descriptionContainer: {
    padding: '20px 24px 0',
  },
  description: {
    fontSize: 16,
    lineHeight: '24px',
    color: '#444',
  },
  sourceLinks: {
    padding: '16px 24px 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  sourceLinkText: {
    fontSize: 15,
    fontWeight: 600,
    color: '#2a7cff',
    textDecoration: 'none',
  },
  commentsSection: {
    padding: '24px 24px 0',
    borderTop: '1px solid #eee',
    marginTop: 24,
    display: 'flex',
    flexDirection: 'column',
  },
  commentsTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: '#1a1a1a',
    marginBottom: 12,
  },
  commentItem: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 0',
  },
  commentAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    flexShrink: 0,
  },
  commentAvatarPlaceholder: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e0e0e0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  commentAvatarText: {
    fontSize: 12,
    fontWeight: 700,
    color: '#666',
  },
  commentBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: 600,
    color: '#1a1a1a',
  },
  commentContent: {
    fontSize: 14,
    color: '#444',
    lineHeight: '20px',
  },
  commentActions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4,
    flexShrink: 0,
  },
  commentTime: {
    fontSize: 11,
    color: '#aaa',
    marginTop: 2,
  },
  flagIcon: {
    fontSize: 15,
    color: '#999',
    cursor: 'pointer',
    userSelect: 'none',
    padding: 4,
  },
  noComments: {
    fontSize: 14,
    color: '#999',
    fontStyle: 'italic',
  },
  commentInputBarOuter: {
    borderTop: '1px solid #eee',
    backgroundColor: '#fff',
    display: 'flex',
    justifyContent: 'center',
  },
  commentInputBar: {
    width: '100%',
    maxWidth: 720,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    padding: '12px 12px 32px',
    gap: 8,
  },
  commentInput: {
    flex: 1,
    border: '1px solid #e0e0e0',
    borderRadius: 20,
    padding: '10px 16px',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1a1a1a',
    color: '#fff',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: 'inherit',
  },
  signInBar: {
    padding: '16px 16px 36px',
    borderTop: '1px solid #eee',
    backgroundColor: '#fff',
    display: 'flex',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  signInBarText: {
    fontSize: 14,
    color: '#2a7cff',
    fontWeight: 500,
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
    animation: 'fade-in 0.15s ease-out',
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
};
