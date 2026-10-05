import { EventCategory } from './types';

interface CategoryConfig {
  label: string;
  emoji: string;
  color: string;
  backgroundColor: string;
}

export const CATEGORIES: Record<EventCategory, CategoryConfig> = {
  popup: { label: 'Pop-up', emoji: '\u{1F3AA}', color: '#E65100', backgroundColor: '#FFF3E0' },
  free_stuff: { label: 'Free Stuff', emoji: '\u{1F381}', color: '#2E7D32', backgroundColor: '#E8F5E9' },
  happening: { label: 'Happening', emoji: '\u{1F4E3}', color: '#1565C0', backgroundColor: '#E3F2FD' },
  professional: { label: 'Professional', emoji: '💼', color: '#455A64', backgroundColor: '#ECEFF1' },
  bars: { label: 'Bars', emoji: '\u{1F378}', color: '#AD1457', backgroundColor: '#FCE4EC' },
  clubs: { label: 'Clubs', emoji: '💃', color: '#6A1B9A', backgroundColor: '#F3E5F5' },
  concerts: { label: 'Concerts', emoji: '\u{1F3B5}', color: '#EF6C00', backgroundColor: '#FFF3E0' },
};

export const ADMIN_EMAIL = 'kalli.feinberg@gmail.com';
