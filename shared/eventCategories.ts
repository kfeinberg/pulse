export const EVENT_CATEGORIES = [
  'popup',
  'free_stuff',
  'happening',
  'professional',
  'bars',
  'clubs',
  'concerts',
  'farmers_market',
  'street_fair',
  'christmas',
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const CHRISTMAS_CATEGORY = {
  label: 'Christmas',
  emoji: '🎄',
  color: '#B71C1C',
  backgroundColor: '#FFEBEE',
};

// Classify the listing, not the date: ordinary December events and mentions
// of "the holidays" alone don't make an event a Christmas event.
const CHRISTMAS_TITLE = /\b(?:christmas|xmas|santaland|santa\s+claus|meet\s+santa|photos?\s+with\s+santa|nutcracker|(?:tree|evergreen)\s+lightings?|holiday\s+(?:markets?|train\s+show|lights|trees?|nostalgia\s+rides)|winter\s+village|lightscape)\b/i;
const OTHER_HOLIDAY = /\b(?:halloween|trick[\s-]+or[\s-]+treat(?:ing)?|thanksgiving|hanukkah|chanukah|menorah|kwanzaa|diwali|(?:lunar|chinese)\s+new\s+year|new\s+year(?:['’]s)?\s+eve)\b/i;
const EXPLICIT_CHRISTMAS = /\b(?:christmas|xmas|santaland|santa\s+claus)\b/i;
const CHRISTMAS_ACTIVITY = /\b(?:christmas\s+tree\s+lightings?|christmas\s+caroling|meet\s+santa|photos?\s+with\s+santa)\b/i;
const DISPLAY_CATEGORIES: ReadonlySet<unknown> = new Set(EVENT_CATEGORIES);

export function eventCategory(event: {
  category?: unknown;
  seasonalCategory?: unknown;
  title?: unknown;
  description?: unknown;
}): EventCategory {
  if (event.seasonalCategory === 'christmas' || event.category === 'christmas') return 'christmas';

  const title = typeof event.title === 'string' ? event.title : '';
  const description = typeof event.description === 'string' ? event.description : '';
  if ((!OTHER_HOLIDAY.test(title) || EXPLICIT_CHRISTMAS.test(title)) &&
      (CHRISTMAS_TITLE.test(title) || CHRISTMAS_ACTIVITY.test(description))) {
    return 'christmas';
  }

  // Includes the retired Halloween category and any unknown stored category.
  return DISPLAY_CATEGORIES.has(event.category) ? event.category as EventCategory : 'happening';
}

// Keep the existing Firestore category readable by shipped clients. The
// updated apps read the opt-in tag and also classify existing feed entries.
export function storedEventCategory(category: EventCategory) {
  return category === 'christmas'
    ? { category: 'happening', seasonalCategory: 'christmas' }
    : { category };
}
