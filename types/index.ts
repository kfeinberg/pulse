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
  sourceUrl?: string;
  sourceUrls?: string[];
  thumbsUp?: number;
  thumbsDown?: number;
  interested?: number;
}

export type ReportCategory = 'live_music' | 'free_stuff' | 'popup' | 'long_line' | 'street_performance' | 'other';

export interface Report {
  id: string;
  text: string;
  category: ReportCategory;
  latitude: number;
  longitude: number;
  userId: string;
  userName: string;
  userPhoto?: string;
  confirmations: number;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface Comment {
  id: string;
  text: string;
  userId: string;
  userName: string;
  userPhoto?: string;
  createdAt: Timestamp;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  photoURL?: string;
  createdAt: Timestamp;
}

export interface NewEventInput {
  title: string;
  description: string;
  category: EventCategory;
  latitude: number;
  longitude: number;
  startTime: Date;
  endTime: Date;
}
