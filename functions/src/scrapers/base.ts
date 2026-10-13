export interface ScrapedEvent {
  title: string;
  description: string;
  startTimestamp: number; // Unix ms
  endTimestamp: number;   // Unix ms
  location: string;
  category?: "popup" | "free_stuff" | "happening" | "professional" | "bars" | "clubs" | "concerts";
  sourceUrl: string;
  sourceName: string;
  temporalStatus: "scheduled_event" | "limited_run";
  temporalEvidence: string;
  latitude?: number;
  longitude?: number;
}

export interface EventSource {
  name: string;
  scrape: () => Promise<ScrapedEvent[]>;
}
