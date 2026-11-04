import { useState, useEffect } from 'react';
import { signInWithApple, signInWithGoogle, isDisplayNameTaken, setUserProfile } from './firebase';
import { useAuth } from './contexts/AuthContext';
import { goBack } from './router';

export function SignIn() {
  const { user, needsProfile, loading: authLoading, setDisplayName, setNeedsProfile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameChecking, setNameChecking] = useState(false);

  useEffect(() => {
    if (user && !needsProfile && !authLoading) {
      goBack();
    }
  }, [user, needsProfile, authLoading]);

  const handleSignIn = async (method: 'apple' | 'google') => {
    setLoading(true);
    setError(null);
    try {
      if (method === 'apple') {
        await signInWithApple();
      } else {
        await signInWithGoogle();
      }
    } catch (e: any) {
      if (
        e.code === 'ERR_REQUEST_CANCELED' ||
        e.code === 'SIGN_IN_CANCELLED' ||
        e.code === 'auth/popup-closed-by-user' ||
        e.code === 'auth/cancelled-popup-request'
      ) {
        // User cancelled
      } else {
        setError(e.message || 'Sign in failed');
      }
    } finally {
      setLoading(false);
    }
  };

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
      setNeedsProfile(false);
      goBack();
    } catch (err: any) {
      setNameError(err.message || 'Something went wrong');
    } finally {
      setNameChecking(false);
    }
  };

  // Show display name step if signed in but no profile
  if (user && needsProfile) {
    return (
      <div style={styles.outer}>
        <div style={styles.container}>
          <div style={styles.content}>
            <span style={styles.title}>Pulse</span>
            <span style={styles.subtitle}>Choose a display name</span>
          </div>
          <div style={styles.bottom}>
            <input
              style={styles.nameInput}
              placeholder="Display name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={20}
              autoFocus
              autoCapitalize="none"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSetName(); }}
            />
            {nameError && <span style={styles.error}>{nameError}</span>}
            <button
              style={{ ...styles.continueButton, opacity: nameChecking ? 0.6 : 1 }}
              onClick={handleSetName}
              disabled={nameChecking}
            >
              {nameChecking ? 'Checking...' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.outer}>
      <div style={styles.container}>
        <div style={styles.content}>
          <span style={styles.title}>Pulse</span>
          <span style={styles.subtitle}>See what's happening in NYC right now</span>
        </div>

        <div style={styles.bottom}>
          {error && <span style={styles.error}>{error}</span>}

          {loading ? (
            <div style={styles.spinner} />
          ) : (
            <div style={styles.buttons}>
              <button style={styles.appleButton} onClick={() => handleSignIn('apple')}>
                 Sign in with Apple
              </button>
              <button style={styles.googleButton} onClick={() => handleSignIn('google')}>
                Sign in with Google
              </button>
              <button style={styles.skipButton} onClick={() => goBack()}>
                Skip for now
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  outer: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111',
    display: 'flex',
    justifyContent: 'center',
  },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#111',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '120px 32px 80px',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  title: {
    fontSize: 48,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 18,
    color: 'rgba(255,255,255,0.6)',
    marginTop: 12,
    textAlign: 'center',
  },
  bottom: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  buttons: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  appleButton: {
    width: '100%',
    height: 52,
    backgroundColor: '#fff',
    color: '#000',
    border: 'none',
    borderRadius: 12,
    fontSize: 17,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  googleButton: {
    width: '100%',
    height: 52,
    backgroundColor: '#fff',
    color: '#333',
    border: 'none',
    borderRadius: 12,
    fontSize: 17,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  skipButton: {
    width: '100%',
    height: 44,
    background: 'none',
    border: 'none',
    fontSize: 15,
    color: 'rgba(255,255,255,0.5)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  spinner: {
    width: 36,
    height: 36,
    border: '3px solid rgba(255,255,255,0.25)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  nameInput: {
    width: '100%',
    backgroundColor: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: 12,
    padding: 14,
    fontSize: 18,
    color: '#fff',
    textAlign: 'center',
    marginBottom: 12,
    outline: 'none',
    fontFamily: 'inherit',
  },
  continueButton: {
    width: '100%',
    height: 52,
    backgroundColor: '#fff',
    color: '#1a1a1a',
    border: 'none',
    borderRadius: 12,
    fontSize: 17,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  error: {
    color: '#ff6b6b',
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
  },
};
