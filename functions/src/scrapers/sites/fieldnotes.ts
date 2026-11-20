import { EventSource, ScrapedEvent } from "../base.js";
import type { ExtractionCache } from "../../services/extractionCache.js";
import { parseNewItems, stripHtml } from "../../services/parser.js";

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

async function fetchJson<T>(url: string, request: typeof fetch): Promise<T | null> {
  console.log(`Fetching: ${url}`);
  const response = await request(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const body = await response.text();
    console.error(`Failed to fetch ${url}: ${response.status}, body: ${body.slice(0, 500)}`);
    return null;
  }
  return (await response.json()) as T;
}

// Substack's archive API used to return a bare array and accept offset=0. It
// now rejects any offset (HTTP 400) and wraps the list as { posts, nextCursor }.
export function archiveUrl(): string {
  return `${BASE_URL}api/v1/archive?sort=new&search=&limit=${POSTS_TO_FETCH}`;
}

export function archivePosts(payload: unknown): SubstackArchivePost[] | null {
  const posts = Array.isArray(payload) ? payload : (payload as { posts?: unknown } | null)?.posts;
  return Array.isArray(posts) ? (posts as SubstackArchivePost[]) : null;
}

type ExtractItems = NonNullable<NonNullable<Parameters<typeof parseNewItems>[5]>["extract"]>;

export function createFieldnotesScraper(apiKey: string, dependencies: { fetch?: typeof fetch; extract?: ExtractItems } = {}): EventSource {
  const request = dependencies.fetch ?? fetch;
  return {
    name: "fieldnotes",
    async scrape(cache: ExtractionCache): Promise<ScrapedEvent[]> {
      // Substack's public archive API lists posts newest-first. The archive
      // entries carry no body text, so each post is fetched individually
      // for its full body_html. Paid posts return only their public free
      // preview here — that is not circumvented, whatever events are in
      // the preview are simply extracted like any other post.
      // A failed or unrecognized archive is an error, not a quiet zero: a
      // source that has always listed zero cannot trip the circuit breaker.
      const archive = archivePosts(await fetchJson<unknown>(archiveUrl(), request));
      if (!archive) {
        throw new Error("Fieldnotes archive request failed or returned no post list");
      }

      const posts = archive.filter((post) => post.slug);
      console.log(`Fieldnotes archive returned ${posts.length} posts`);

      const allEvents: ScrapedEvent[] = [];

      for (const entry of posts) {
        const post = await fetchJson<SubstackPost>(
          `${BASE_URL}api/v1/posts/${encodeURIComponent(entry.slug!)}`,
          request
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

        // Each post is one item: an unchanged roundup is not re-extracted.
        const fullText = header + stripHtml(post.body_html);
        const { events: parsedEvents } = await parseNewItems(
          [fullText],
          (text) => text,
          cache,
          postUrl,
          apiKey,
          { extract: dependencies.extract }
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
