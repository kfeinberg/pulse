import { AppEvent, NewEventInput, Report, Comment, ReportCategory, UserProfile } from '@/types';
import { initializeApp, getApps } from 'firebase/app';
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

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

const EVENTS_COLLECTION = 'events';

// User profiles
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return null;
  return { uid: snap.id, ...snap.data() } as UserProfile;
}

export async function isDisplayNameTaken(displayName: string): Promise<boolean> {
  const q = query(collection(db, 'users'), where('displayName', '==', displayName));
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

// Events
export async function addEvent(input: NewEventInput): Promise<string> {
  const docRef = await addDoc(collection(db, EVENTS_COLLECTION), {
    title: input.title,
    description: input.description,
    category: input.category,
    latitude: input.latitude,
    longitude: input.longitude,
    startTime: Timestamp.fromDate(input.startTime),
    endTime: Timestamp.fromDate(input.endTime),
    createdAt: Timestamp.now(),
  });
  return docRef.id;
}

export function subscribeToUpcomingEvents(
  callback: (events: AppEvent[]) => void
): () => void {
  const now = Timestamp.now();
  const q = query(
    collection(db, EVENTS_COLLECTION),
    where('endTime', '>', now),
    orderBy('endTime', 'asc')
  );
  const unsubscribe = onSnapshot(q, (snapshot) => {
    const events: AppEvent[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as AppEvent[];
    callback(events);
  });
  return unsubscribe;
}

export async function deleteEvent(eventId: string): Promise<void> {
  await deleteDoc(doc(db, EVENTS_COLLECTION, eventId));
}

export async function voteOnEvent(
  eventId: string,
  voteType: 'up' | 'down',
  previousVote: 'up' | 'down' | null
): Promise<void> {
  const ref = doc(db, EVENTS_COLLECTION, eventId);
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
  const ref = doc(db, EVENTS_COLLECTION, eventId);
  await updateDoc(ref, {
    interested: increment(wasInterested ? -1 : 1),
  });
}

// Comments
export async function addComment(eventId: string, comment: {
  text: string;
  userId: string;
  userName: string;
  userPhoto?: string;
}): Promise<string> {
  const docRef = await addDoc(collection(db, EVENTS_COLLECTION, eventId, 'comments'), {
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
    collection(db, EVENTS_COLLECTION, eventId, 'comments'),
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
    const reports: Report[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as Report[];
    callback(reports);
  });
}

export async function confirmReport(reportId: string, delta: number = 1): Promise<void> {
  const ref = doc(db, 'reports', reportId);
  await updateDoc(ref, { confirmations: increment(delta) });
}

export async function deleteReport(reportId: string): Promise<void> {
  await deleteDoc(doc(db, 'reports', reportId));
}
