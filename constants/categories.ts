import { HOLIDAY_CATEGORIES, HOLIDAY_KEYS, REGULAR_CATEGORIES, type MobileEventCategory } from '@/utils/holidaySchedule';

interface CategoryConfig {
  label: string;
  emoji: string;
  color: string;
  backgroundColor: string;
}

export const CATEGORIES: Record<MobileEventCategory, CategoryConfig> = {
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
  professional: {
    label: 'Professional',
    emoji: '💼',
    color: '#455A64',
    backgroundColor: '#ECEFF1',
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
  farmers_market: {
    label: 'Farmers Markets',
    emoji: '🥕',
    color: '#558B2F',
    backgroundColor: '#F1F8E9',
  },
  street_fair: {
    label: 'Street Fairs',
    emoji: '🎡',
    color: '#00838F',
    backgroundColor: '#E0F7FA',
  },
  ...HOLIDAY_CATEGORIES,
};

// Admins can tag listings ahead of the season; discovery uses the live schedule.
export const ADMIN_CATEGORY_LIST: readonly MobileEventCategory[] = [...REGULAR_CATEGORIES, ...HOLIDAY_KEYS];

export const ADMIN_EMAIL = 'kalli.feinberg@gmail.com';

export const NYC_REGION = {
  latitude: 40.7128,
  longitude: -74.006,
  latitudeDelta: 0.0922,
  longitudeDelta: 0.0421,
};
