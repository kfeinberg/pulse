import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthChange, getUserProfile } from '../firebase';

interface AuthContextType {
  user: User | null;
  displayName: string | null;
  loading: boolean;
  needsProfile: boolean;
  setDisplayName: (name: string) => void;
  setNeedsProfile: (v: boolean) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  displayName: null,
  loading: true,
  needsProfile: false,
  setDisplayName: () => {},
  setNeedsProfile: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsProfile, setNeedsProfile] = useState(false);

  useEffect(() => {
    let revision = 0;
    let active = true;
    const unsubscribe = onAuthChange(async (u) => {
      const current = ++revision;
      setUser(u);
      setDisplayName(null);
      setNeedsProfile(false);
      setLoading(true);
      try {
        if (u) {
          const profile = await getUserProfile(u.uid);
          if (!active || current !== revision) return;
          setDisplayName(profile?.displayName ?? null);
          setNeedsProfile(!profile);
        }
      } catch (error) {
        console.warn('Could not load user profile:', error);
      } finally {
        if (active && current === revision) setLoading(false);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, displayName, loading, needsProfile, setDisplayName, setNeedsProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
