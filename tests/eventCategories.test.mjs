import assert from 'node:assert/strict';
import test from 'node:test';
import { CHRISTMAS_CATEGORY, EVENT_CATEGORIES, eventCategory, storedEventCategory } from '../shared/eventCategories.ts';

test('Christmas replaces the Halloween filter without hiding existing Halloween listings', () => {
  assert.ok(EVENT_CATEGORIES.includes('christmas'));
  assert.ok(!EVENT_CATEGORIES.includes('trick_or_treat'));
  assert.equal(CHRISTMAS_CATEGORY.label, 'Christmas');
  assert.equal(eventCategory({ title: 'Neighborhood Trick-or-Treat', category: 'trick_or_treat' }), 'happening');
});

test('existing Pulse listings surface as Christmas across the city', () => {
  for (const [title, category] of [
    ['The Rockefeller Center Christmas Tree Lighting', 'happening'],
    ['Fort Greene Tree Lighting', 'happening'],
    ['Holiday Festival & Tree Lighting @ Astoria Park', 'happening'],
    ['Holiday Lights at Bronx Zoo', 'happening'],
    ['2026 Chinatown Holiday Market', 'happening'],
    ['Christmas with the Brooklyn Tabernacle', 'concerts'],
    ["Macy’s Santaland", 'popup'],
    ['New York Transit Museum Holiday Train Show 2026', 'happening'],
  ]) {
    assert.equal(eventCategory({ title, category }), 'christmas', title);
  }
  assert.equal(eventCategory({ title: 'The Coca-Cola Holiday Caravan', description: 'Take photos with Santa at the stop.', category: 'popup' }), 'christmas');
});

test('ordinary events and other holidays keep their normal categories', () => {
  for (const title of [
    'December Jazz Night', 'Holiday Party at the Office', 'Halloween Holiday Market',
    'Hanukkah Holiday Market', 'Thanksgiving Holiday Market', 'Lunar New Year Street Fair',
    'New Year’s Eve in the Winter Village', 'Santa Maria Pizza Pop-Up',
  ]) {
    assert.equal(eventCategory({ title, category: 'popup' }), 'popup', title);
  }
  assert.equal(eventCategory({ category: 'future_category', title: null }), 'happening');
});

test('admin-created Christmas events round-trip without hiding them from older Pulse clients', () => {
  const stored = storedEventCategory('christmas');
  assert.deepEqual(stored, { category: 'happening', seasonalCategory: 'christmas' });
  assert.equal(eventCategory({ ...stored, title: 'Sunday Singalong' }), 'christmas');
  assert.deepEqual(storedEventCategory('concerts'), { category: 'concerts' });
});
