import { EventSource, ScrapedEvent } from "../base.js";
import { parseEventsFromText, stripHtml } from "../../services/parser.js";

const BASE_URL = "https://fieldnotesnyc.substack.com/";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// Each post is a weekly roundup of many individual events. Fetch the most
// recent few posts so a one-off post published between roundups does not
// push the current roundup out of the scrape. Events that have already
// ended are dropped below, and Firestore dedup handles the overlap
// between posts (same rules as every other source).
const POSTS_TO_FETCH = 3;

interface SubstackArchivePost {
  title?: string;
  slug?: string;
  post_date?: string;
  canonical_url?: string;
}

interface SubstackPost extends SubstackArchivePost {
  subtitle?: string;
  body_html?: string;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  console.log(`Fetching: ${url}`);
  const response = await fetch(url, { headers: FETCH_HEADERS });
  if (!response.ok) {
    const body = await response.text();
    console.error(`Failed to fetch ${url}: ${response.status}, body: ${body.slice(0, 500)}`);
    return null;
  }
  return (await response.json()) as T;
}

export function createFieldnotesScraper(apiKey: string): EventSource {
  return {
    name: "fieldnotes",
    async scrape(): Promise<ScrapedEvent[]> {
      // Substack's public archive API lists posts newest-first. The archive
      // entries carry no body text, so each post is fetched individually
      // for its full body_html. Paid posts return only their public free
      // preview here — that is not circumvented, whatever events are in
      // the preview are simply extracted like any other post.
      const archive = await fetchJson<SubstackArchivePost[]>(
        `${BASE_URL}api/v1/archive?sort=new&search=&offset=0&limit=${POSTS_TO_FETCH}`
      );
      if (!archive) {
        return [];
      }

      const posts = archive.filter((post) => post.slug);
      console.log(`Fieldnotes archive returned ${posts.length} posts`);

      const allEvents: ScrapedEvent[] = [];

      for (const entry of posts) {
        const post = await fetchJson<SubstackPost>(
          `${BASE_URL}api/v1/posts/${encodeURIComponent(entry.slug!)}`
        );
        if (!post?.body_html) {
          console.warn(`No body found for Fieldnotes post: ${entry.slug}`);
          continue;
        }

        const postUrl = post.canonical_url || `${BASE_URL}p/${entry.slug}`;

        // The event day headings in the body ("Monday, September 28") have
        // no year, so prepend the post title / publish date for context.
        // stripHtml preserves each event's outbound link as
        // "Event Title (url)", which Claude returns as the event's url —
        // falling back to this post's URL when an event has no link.
        const published = post.post_date ? new Date(post.post_date) : null;
        const formatET = (d: Date) =>
          d.toLocaleString("en-US", {
            timeZone: "America/New_York",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false,
          });

        const header =
          `Post: ${post.title || entry.title || "field notes nyc"}\n` +
          (post.subtitle ? `Subtitle: ${post.subtitle}\n` : "") +
          (published ? `Published (Eastern Time): ${formatET(published)}\n` : "") +
          `URL: ${postUrl}\n\n`;

        const fullText = header + stripHtml(post.body_html);
        console.log(
          `Sending Fieldnotes post "${post.title}" to Claude (${fullText.length} chars)`
        );

        const parsedEvents = await parseEventsFromText(
          fullText,
          "fieldnotes",
          postUrl,
          apiKey
        );
        console.log(
          `Fieldnotes post "${post.title}": Claude extracted ${parsedEvents.length} events`
        );
        allEvents.push(...parsedEvents);
      }

      // Same upcoming-only scope as the other sources (Dice / NY Event
      // Radar query the next few days, NYC For Free uses its "upcoming"
      // feed): don't write events from older roundups that have ended.
      const now = Date.now();
      const upcomingEvents = allEvents.filter(
        (event) => event.endTimestamp >= now
      );
      console.log(
        `Fieldnotes: ${upcomingEvents.length}/${allEvents.length} events have not ended yet`
      );

      return upcomingEvents;
    },
  };
}
