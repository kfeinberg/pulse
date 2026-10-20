import type { ExtractionCache } from "../services/extractionCache.js";

export const EVENT_CATEGORIES = [
  "popup",
  "free_stuff",
  "happening",
  "professional",
  "bars",
  "clubs",
  "concerts",
  "farmers_market",
  "street_fair",
  "trick_or_treat",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export interface ScrapedEvent {
  title: string;
  description: string;
  startTimestamp: number; // Unix ms
  endTimestamp: number;   // Unix ms
  location: string;
  category?: EventCategory;
  sourceUrl: string;
  sourceName: string;
  temporalStatus: "scheduled_event" | "limited_run";
  temporalEvidence: string;
  latitude?: number;
  longitude?: number;
}

export interface EventSource {
  name: string;
  scrape: (cache: ExtractionCache) => Promise<ScrapedEvent[]>;
}
