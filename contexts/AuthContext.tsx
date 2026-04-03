import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthChange } from '@/services/auth';
import { getUserProfile } from '@/services/firebase';

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
    const unsubscribe = onAuthChange(async (u) => {
      setUser(u);
      if (u) {
        const profile = await getUserProfile(u.uid);
        if (profile) {
          setDisplayName(profile.displayName);
        } else {
          setNeedsProfile(true);
        }
      } else {
        setDisplayName(null);
        setNeedsProfile(false);
      }
      setLoading(false);
    });
    return unsubscribe;
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
