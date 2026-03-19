import { initializeApp } from 'firebase/app';
import {
  Timestamp,
  collection,
  doc,
  getFirestore,
  increment,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { AppEvent } from './types';

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
