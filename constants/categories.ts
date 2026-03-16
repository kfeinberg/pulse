import { EventCategory } from '@/types';

interface CategoryConfig {
  label: string;
  emoji: string;
  color: string;
  backgroundColor: string;
}

export const CATEGORIES: Record<EventCategory, CategoryConfig> = {
  popup: {
    label: 'Pop-up',
    emoji: '🎪',
    color: '#E65100',
    backgroundColor: '#FFF3E0',
  },
  free_stuff: {
    label: 'Free Stuff',
    emoji: '🎁',
    color: '#2E7D32',
    backgroundColor: '#E8F5E9',
  },
  happening: {
    label: 'Happening',
    emoji: '📣',
    color: '#1565C0',
    backgroundColor: '#E3F2FD',
  },
  bars: {
    label: 'Bars',
    emoji: '🍸',
    color: '#AD1457',
    backgroundColor: '#FCE4EC',
  },
  clubs: {
    label: 'Clubs',
    emoji: '🪩',
    color: '#6A1B9A',
    backgroundColor: '#F3E5F5',
  },
  concerts: {
    label: 'Concerts',
    emoji: '🎵',
    color: '#EF6C00',
    backgroundColor: '#FFF3E0',
  },
};

export const CATEGORY_LIST: EventCategory[] = ['popup', 'free_stuff', 'happening', 'bars', 'clubs', 'concerts'];

export const ADMIN_PASSCODE = '5254';

export const NYC_REGION = {
  latitude: 40.7128,
  longitude: -74.006,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};
