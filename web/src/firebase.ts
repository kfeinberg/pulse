import { initializeApp } from 'firebase/app';
import {
  Timestamp,
  collection,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
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
