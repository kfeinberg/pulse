import { initializeApp } from 'firebase/app';
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { AppEvent, Comment, Report, ReportCategory, UserProfile } from './types';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export { auth };
export type { User };

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export function subscribeToUpcomingEvents(
  callback: (events: AppEvent[]) => void
): () => void {
  const now = Timestamp.now();
  const q = query(
    collection(db, 'events'),
    where('endTime', '>', now),
    orderBy('endTime', 'asc')
  );

  const unsubscribe = onSnapshot(q, (snapshot) => {
    const events: AppEvent[] = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as AppEvent[];
    callback(events);
  });

  return unsubscribe;
}

export async function voteOnEvent(
  eventId: string,
  voteType: 'up' | 'down',
  previousVote: 'up' | 'down' | null
): Promise<void> {
  const ref = doc(db, 'events', eventId);
  const updates: Record<string, any> = {};

  if (previousVote === voteType) {
    updates[voteType === 'up' ? 'thumbsUp' : 'thumbsDown'] = increment(-1);
  } else {
    updates[voteType === 'up' ? 'thumbsUp' : 'thumbsDown'] = increment(1);
    if (previousVote) {
      updates[previousVote === 'up' ? 'thumbsUp' : 'thumbsDown'] = increment(-1);
    }
  }

  await updateDoc(ref, updates);
}

export async function markInterested(
  eventId: string,
  wasInterested: boolean
): Promise<void> {
  const ref = doc(db, 'events', eventId);
  await updateDoc(ref, {
    interested: increment(wasInterested ? -1 : 1),
  });
}

// Reports
export async function createReport(report: {
  text: string;
  category: ReportCategory;
  latitude: number;
  longitude: number;
  userId: string;
  userName: string;
  userPhoto?: string;
}): Promise<string> {
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + 4 * 60 * 60 * 1000);
  const docRef = await addDoc(collection(db, 'reports'), {
    ...report,
    confirmations: 0,
    createdAt: now,
    expiresAt,
  });
  return docRef.id;
}

export function subscribeToReports(callback: (reports: Report[]) => void): () => void {
  const now = Timestamp.now();
  const q = query(
    collection(db, 'reports'),
    where('expiresAt', '>', now),
    orderBy('expiresAt', 'asc')
  );
  return onSnapshot(q, (snapshot) => {
    const reports: Report[] = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Report[];
    callback(reports);
  });
}

export async function confirmReport(reportId: string, delta: number = 1): Promise<void> {
  const ref = doc(db, 'reports', reportId);
  await updateDoc(ref, { confirmations: increment(delta) });
}

// User profiles
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return null;
  return { uid: snap.id, ...snap.data() } as UserProfile;
}

export async function isDisplayNameTaken(displayName: string): Promise<boolean> {
  const q = query(
    collection(db, 'users'),
    where('displayName', '==', displayName)
  );
  const snap = await getDocs(q);
  return !snap.empty;
}

export async function setUserProfile(uid: string, displayName: string, photoURL?: string): Promise<void> {
  await setDoc(doc(db, 'users', uid), {
    displayName,
    photoURL: photoURL || null,
    createdAt: Timestamp.now(),
  });
}

export async function deleteEvent(eventId: string): Promise<void> {
  await deleteDoc(doc(db, 'events', eventId));
}

export async function deleteReport(reportId: string): Promise<void> {
  await deleteDoc(doc(db, 'reports', reportId));
}

// Comments
export async function addComment(eventId: string, comment: {
  text: string;
  userId: string;
  userName: string;
  userPhoto?: string;
}): Promise<string> {
  const docRef = await addDoc(collection(db, 'events', eventId, 'comments'), {
    ...comment,
    createdAt: Timestamp.now(),
  });
  return docRef.id;
}

export function subscribeToComments(
  eventId: string,
  callback: (comments: Comment[]) => void
): () => void {
  const q = query(
    collection(db, 'events', eventId, 'comments'),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(q, (snapshot) => {
    const comments: Comment[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as Comment[];
    callback(comments);
  });
}
