import { Timestamp } from 'firebase/firestore';

export type EventCategory = 'popup' | 'free_stuff' | 'happening' | 'bars' | 'clubs' | 'concerts';

export interface AppEvent {
  id: string;
  title: string;
  description: string;
  location?: string;
  category: EventCategory;
  latitude: number;
  longitude: number;
  startTime: Timestamp;
  endTime: Timestamp;
  createdAt: Timestamp;
  thumbsUp?: number;
  thumbsDown?: number;
}
