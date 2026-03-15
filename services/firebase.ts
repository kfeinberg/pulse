import { AppEvent, NewEventInput } from '@/types';
import { initializeApp } from 'firebase/app';
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  increment,
  onSnapshot,
  orderBy,
  query,
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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const EVENTS_COLLECTION = 'events';

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

export function subscribeToActiveEvents(
  callback: (events: AppEvent[]) => void
): () => void {
  const now = Timestamp.now();
  const q = query(
    collection(db, EVENTS_COLLECTION),
    where('endTime', '>', now),
    orderBy('endTime', 'asc')
  );

  const unsubscribe = onSnapshot(q, (snapshot) => {
    const currentTime = Date.now();
    const events: AppEvent[] = snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .filter((event: any) => {
        const started = event.startTime.toMillis() <= currentTime;
        const notEnded = event.endTime.toMillis() > currentTime;
        return started && notEnded;
      }) as AppEvent[];
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
    // Removing existing vote
    updates[voteType === 'up' ? 'thumbsUp' : 'thumbsDown'] = increment(-1);
  } else {
    // Adding new vote
    updates[voteType === 'up' ? 'thumbsUp' : 'thumbsDown'] = increment(1);
    // Remove previous vote if switching
    if (previousVote) {
      updates[previousVote === 'up' ? 'thumbsUp' : 'thumbsDown'] = increment(-1);
    }
  }

  await updateDoc(ref, updates);
}

