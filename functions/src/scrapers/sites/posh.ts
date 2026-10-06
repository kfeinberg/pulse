import { ScrapedEvent } from "../base.js";
import { parseEventsFromText } from "../../services/parser.js";

export const POSH_EXPLORE_URL =
  "https://posh.vip/explore?location=new_york_city";

export interface PoshIngestEvent {
  id: string;
  title: string;
  url: string;
  startDate: string;
  endDate: string;
  timezone?: string;
  venueName?: string;
  venueAddress?: string;
  shortDescription?: string;
  minTicketPrice?: number;
  groupName?: string;
  lineup?: Array<{ name?: string }>;
}

const NON_NYC_LOCATION = /\b(?:NJ|New Jersey|Passaic|Paterson|Jersey City|Hoboken)\b/i;

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidEvent(value: unknown): value is PoshIngestEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    isString(event.id) &&
    isString(event.title) &&
    isString(event.url) &&
    isString(event.startDate) &&
    isString(event.endDate) &&
    Number.isFinite(Date.parse(event.startDate)) &&
    Number.isFinite(Date.parse(event.endDate))
  );
}

function eventLocation(event: PoshIngestEvent): string {
  return [event.venueName, event.venueAddress]
    .filter(isString)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(", ");
}

export function validatePoshPayload(payload: unknown): PoshIngestEvent[] {
  if (!Array.isArray(payload)) {
    throw new Error("Posh payload must be an array");
  }
  if (payload.length > 50) {
    throw new Error("Posh payload exceeds the 50-event limit");
  }

  const now = Date.now();
  return payload
    .filter(isValidEvent)
    .filter((event) => Date.parse(event.endDate) > now)
    .filter((event) => {
      const address = event.venueAddress?.trim() ?? "";
      if (!address) {
        console.warn(`Skipping Posh event without a detail-page address: "${event.title}"`);
        return false;
      }
      if (!/\b\d{1,6}[a-z]?\b/i.test(address)) {
        console.warn(`Skipping Posh event without a street address: "${event.title}" at ${address}`);
        return false;
      }
      if (NON_NYC_LOCATION.test(address)) {
        console.log(`Skipping non-NYC Posh event: "${event.title}" at ${address}`);
        return false;
      }
      return true;
    });
}

export async function parsePoshPayload(
  payload: unknown,
  apiKey: string
): Promise<ScrapedEvent[]> {
  const events = validatePoshPayload(payload);
  if (events.length === 0) return [];

  const eventTexts = events.map((event) => {
    const lineup = (event.lineup ?? [])
      .map((performer) => performer.name)
      .filter(isString)
      .join(", ");
    const eventUrl = `https://posh.vip/e/${event.url}`;

    return (
      `Event: ${event.title}\n` +
      `Description: ${event.shortDescription || ""}\n` +
      `Organizer: ${event.groupName || "N/A"}\n` +
      `Lineup: ${lineup || "N/A"}\n` +
      `Minimum ticket price: ${event.minTicketPrice ?? "unknown"}\n` +
      `Start (UTC): ${event.startDate}\n` +
      `End (UTC): ${event.endDate}\n` +
      `Timezone: ${event.timezone || "America/New_York"}\n` +
      `Location: ${eventLocation(event)}\n` +
      `URL: ${eventUrl}`
    );
  });

  const fullText = eventTexts.join("\n\n---\n\n");
  console.log(`Sending ${events.length} Posh NYC events to Claude (${fullText.length} chars)`);
  const parsedEvents = await parseEventsFromText(
    fullText,
    "posh",
    POSH_EXPLORE_URL,
    apiKey
  );

  const matchedEvents: ScrapedEvent[] = [];
  for (const parsed of parsedEvents) {
    const normalizedTitle = parsed.title.toLowerCase();
    const match = events.find((event) => {
      const sourceTitle = event.title.toLowerCase();
      return (
        normalizedTitle.includes(sourceTitle.slice(0, 20)) ||
        sourceTitle.includes(normalizedTitle.slice(0, 20))
      );
    });
    if (!match) {
      console.warn(`Discarding unmatched Posh extraction: "${parsed.title}"`);
      continue;
    }

    parsed.startTimestamp = Date.parse(match.startDate);
    parsed.endTimestamp = Date.parse(match.endDate);
    parsed.location = eventLocation(match);
    parsed.sourceUrl = `https://posh.vip/e/${match.url}`;
    parsed.sourceName = "posh";
    matchedEvents.push(parsed);
  }

  console.log(`Posh: Claude extracted ${matchedEvents.length} validated NYC events`);
  return matchedEvents;
}
