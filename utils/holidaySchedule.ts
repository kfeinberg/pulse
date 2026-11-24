import { CHRISTMAS_CATEGORY, EVENT_CATEGORIES, eventCategory, type EventCategory as SharedCategory } from '../shared/eventCategories.ts';

type HolidayDefinition = {
  label: string;
  emoji: string;
  color: string;
  backgroundColor: string;
  date: (year: number) => number | undefined;
  lead: number;
  tail: number;
  title: RegExp;
};

// These are civil-day numbers, not instants. Do calendar arithmetic in UTC
// after taking the New York date, so travel, DST, and UTC midnight don't
// cause the category to turn on or off a day early.
const DAY = 86_400_000;
const civil = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / DAY;
const fixed = (month: number, day: number) => (year: number) => civil(year, month, day);
const weekday = (day: number) => new Date(day * DAY).getUTCDay();
const nthWeekday = (month: number, target: number, nth: number) => (year: number) => {
  const first = civil(year, month, 1);
  return first + (target - weekday(first) + 7) % 7 + (nth - 1) * 7;
};
const lastWeekday = (month: number, target: number) => (year: number) => {
  const last = civil(year, month + 1, 0);
  return last - (weekday(last) - target + 7) % 7;
};

const nycDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', calendar: 'gregory', numberingSystem: 'latn',
  year: 'numeric', month: 'numeric', day: 'numeric',
});
export function nycCivilDay(ms: number): number {
  const parts = nycDate.formatToParts(ms);
  const component = (type: 'year' | 'month' | 'day') => Number(parts.find((part) => part.type === type)?.value);
  return civil(component('year'), component('month'), component('day'));
}

function easter(year: number): number {
  // Gregorian computus (Meeus/Jones/Butcher).
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const l = (32 + 2 * e + 2 * Math.floor(c / 4) - h - c % 4) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return civil(year, Math.floor(n / 31), (n % 31) + 1);
}

function lunarHoliday(calendar: 'chinese' | 'hebrew', month: string, day: string,
  startMonth: number, startDay: number, endMonth: number, endDay: number) {
  return (year: number) => {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        calendar, timeZone: 'UTC', numberingSystem: 'latn',
        month: calendar === 'hebrew' ? 'long' : 'numeric', day: 'numeric',
      });
      // A runtime without this calendar should omit the filter, not guess.
      if (formatter.resolvedOptions().calendar !== calendar) return undefined;
      for (let current = civil(year, startMonth, startDay); current <= civil(year, endMonth, endDay); current++) {
        const parts = formatter.formatToParts(current * DAY);
        if (parts.some((p) => p.type === 'month' && p.value === month) &&
          parts.some((p) => p.type === 'day' && p.value === day)) return current;
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    return undefined;
  };
}

const lunarNewYearFromCalendar = lunarHoliday('chinese', '1', '1', 1, 21, 2, 21);
function lunarNewYear(year: number) {
  // Some Intl calendar versions disagree with the Hong Kong Observatory's
  // published Gregorian–Lunar conversion tables for these years.
  // https://www.hko.gov.hk/en/gts/time/conversion.htm
  if (year === 2027) return civil(year, 2, 6);
  if (year === 2030) return civil(year, 2, 3);
  return lunarNewYearFromCalendar(year);
}

// Windows include the holiday and both endpoints. More recognizable seasonal
// events (e.g. Christmas markets) start earlier than one-day celebrations.
const HOLIDAYS = {
  lunar_new_year: { label: 'Lunar New Year', emoji: '🏮', color: '#B71C1C', backgroundColor: '#FFEBEE', date: lunarNewYear, lead: 10, tail: 14, title: /\b(?:(?:lunar|chinese)\s+new\s+year|spring\s+festival\s+gala)\b|\bTết\b/i },
  new_year: { label: 'New Year', emoji: '🎆', color: '#4527A0', backgroundColor: '#EDE7F6', date: fixed(12, 31), lead: 5, tail: 2, title: /\b(?:new\s+year(?:['’]s)?|nye)\b/i },
  valentine: { label: 'Valentine’s Day', emoji: '💘', color: '#AD1457', backgroundColor: '#FCE4EC', date: fixed(2, 14), lead: 7, tail: 1, title: /\b(?:valentine|galentine)(?:['’]s|s)?\b/i },
  st_patricks: { label: 'St. Patrick’s Day', emoji: '☘️', color: '#1B5E20', backgroundColor: '#E8F5E9', date: fixed(3, 17), lead: 10, tail: 3, title: /\b(?:(?:st\.?|saint)\s+patrick(?:['’]s|s)?|st\.?\s+paddy(?:['’]s)?)\b/i },
  easter: { label: 'Easter', emoji: '🐣', color: '#6A1B9A', backgroundColor: '#F3E5F5', date: easter, lead: 10, tail: 1, title: /\b(?:easter|egg\s+hunts?)\b/i },
  mothers_day: { label: 'Mother’s Day', emoji: '💐', color: '#AD1457', backgroundColor: '#FCE4EC', date: nthWeekday(5, 0, 2), lead: 7, tail: 1, title: /\bmothers?(?:['’]s?)?\s+day\b/i },
  memorial_day: { label: 'Memorial Day', emoji: '🇺🇸', color: '#283593', backgroundColor: '#E8EAF6', date: lastWeekday(5, 1), lead: 7, tail: 0, title: /\bmemorial\s+day\b/i },
  juneteenth: { label: 'Juneteenth', emoji: '✊🏾', color: '#1B5E20', backgroundColor: '#E8F5E9', date: fixed(6, 19), lead: 10, tail: 4, title: /\bjuneteenth\b/i },
  fathers_day: { label: 'Father’s Day', emoji: '💙', color: '#1565C0', backgroundColor: '#E3F2FD', date: nthWeekday(6, 0, 3), lead: 7, tail: 1, title: /\bfathers?(?:['’]s?)?\s+day\b/i },
  fourth_of_july: { label: 'Fourth of July', emoji: '🎇', color: '#B71C1C', backgroundColor: '#FFEBEE', date: fixed(7, 4), lead: 7, tail: 2, title: /\b(?:(?:fourth|4th)\s+of\s+july|july\s+4(?:th)?|independence\s+day)\b/i },
  labor_day: { label: 'Labor Day', emoji: '🎉', color: '#006064', backgroundColor: '#E0F7FA', date: nthWeekday(9, 1, 1), lead: 7, tail: 0, title: /\b(?:labor|labour)\s+day\b/i },
  halloween: { label: 'Halloween', emoji: '🎃', color: '#BF360C', backgroundColor: '#FBE9E7', date: fixed(10, 31), lead: 17, tail: 2, title: /\b(?:halloween|trick[\s-]+or[\s-]+(?:treat(?:ing)?|streets)|spooktacular)\b/i },
  thanksgiving: { label: 'Thanksgiving', emoji: '🦃', color: '#8D421B', backgroundColor: '#FFF3E0', date: nthWeekday(11, 4, 4), lead: 10, tail: 2, title: /\b(?:thanksgiving|friendsgiving|turkey\s+trot)\b/i },
  hanukkah: { label: 'Hanukkah', emoji: '🕎', color: '#0D47A1', backgroundColor: '#E3F2FD', date: lunarHoliday('hebrew', 'Kislev', '25', 11, 25, 12, 31), lead: 7, tail: 7, title: /\b(?:hanukkah|hanukah|chanukah|chanukkah|menorah\s+lighting)\b/i },
  christmas: { ...CHRISTMAS_CATEGORY, date: fixed(12, 25), lead: 35, tail: 12, title: /\b(?:christmas|xmas|santaland|santa\s+claus)\b/i },
} satisfies Record<string, HolidayDefinition>;

export const HOLIDAY_CATEGORIES = HOLIDAYS;
export type HolidayCategory = keyof typeof HOLIDAYS;
export type RegularCategory = Exclude<SharedCategory, 'christmas'>;
export type MobileEventCategory = RegularCategory | HolidayCategory;
export const REGULAR_CATEGORIES = EVENT_CATEGORIES.filter((key) => key !== 'christmas');
export const HOLIDAY_KEYS = Object.keys(HOLIDAYS) as HolidayCategory[];

const schedules = new Map<number, { key: HolidayCategory; start: number; end: number }[]>();
function schedule(year: number) {
  const cached = schedules.get(year);
  if (cached) return cached;
  const result = HOLIDAY_KEYS.flatMap((key) => {
    const holiday = HOLIDAYS[key];
    const date = holiday.date(year);
    return date === undefined ? [] : [{ key, start: date - holiday.lead, end: date + holiday.tail }];
  });
  if (schedules.size >= 6) schedules.clear();
  schedules.set(year, result);
  return result;
}

export function seasonalCategories(day: number): HolidayCategory[] {
  const year = new Date(day * DAY).getUTCFullYear();
  return [...schedule(year - 1), ...schedule(year), ...schedule(year + 1)]
    .filter(({ start, end }) => start <= day && day <= end)
    .sort((a, b) => a.end - b.end)
    .map(({ key }) => key);
}

function isHoliday(value: unknown): value is HolidayCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HOLIDAYS, value);
}

export function classifyListing(event: { category?: unknown; seasonalCategory?: unknown; title?: unknown; description?: unknown }) {
  const category: RegularCategory = REGULAR_CATEGORIES.find((key) => key === event.category) ?? 'happening';
  const title = typeof event.title === 'string' ? event.title : '';
  const holiday = isHoliday(event.seasonalCategory) ? event.seasonalCategory
    : isHoliday(event.category) ? event.category
    : event.category === 'trick_or_treat' ? 'halloween'
    : HOLIDAY_KEYS.find((key) => HOLIDAYS[key].title.test(title))
      ?? (eventCategory(event) === 'christmas' ? 'christmas' : undefined);
  return { category, holiday };
}

export function displayMobileCategory(event: { category: MobileEventCategory; holiday?: HolidayCategory }, active: readonly HolidayCategory[]): MobileEventCategory {
  return event.holiday && active.includes(event.holiday) ? event.holiday : event.category;
}

export function storeMobileCategory(category: MobileEventCategory) {
  return isHoliday(category) ? { category: 'happening', seasonalCategory: category } : { category };
}

// Null represents "All", so newly-in-season categories are on by default.
// A solo holiday that ends goes back to All, never to an empty discovery view.
export function visibleSelection(categories: readonly MobileEventCategory[], selected: ReadonlySet<MobileEventCategory> | null): Set<MobileEventCategory> {
  const visible = selected ? categories.filter((key) => selected.has(key)) : categories;
  return new Set(visible.length ? visible : categories);
}
