const EVENTBRITE_HOST = "www.eventbrite.com";
const EVENTBRITE_DETAIL_PATH = /^\/e\/.+-tickets-\d+\/?$/i;
const URL_CACHE = new Map<string, string | null>();

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "event",
  "for",
  "from",
  "in",
  "more",
  "of",
  "on",
  "show",
  "the",
  "tickets",
  "to",
  "with",
]);

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function canonicalEventbriteUrl(value: string): string | null {
  try {
    const url = new URL(value.replace(/&amp;/g, "&"));
    if (url.hostname.toLowerCase() !== EVENTBRITE_HOST) return null;
    if (!EVENTBRITE_DETAIL_PATH.test(url.pathname)) return null;
    return `https://${EVENTBRITE_HOST}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function isEventbriteUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase().endsWith("eventbrite.com");
  } catch {
    return false;
  }
}

export function isUsableEventUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return !isEventbriteUrl(value) || canonicalEventbriteUrl(value) !== null;
  } catch {
    return false;
  }
}

function similarityScore(title: string, candidateUrl: string, originalUrl: string): number {
  const titleWords = words(title);
  const candidateWords = words(new URL(candidateUrl).pathname.replace(/^\/e\//, "").replace(/-tickets-\d+$/, ""));
  if (titleWords.length === 0 || candidateWords.length === 0) return 0;

  const candidateSet = new Set(candidateWords);
  const titleCoverage = titleWords.filter((word) => candidateSet.has(word)).length / titleWords.length;

  let originalCoverage = 0;
  try {
    const originalWords = words(new URL(originalUrl).pathname.replace(/^\/e\//, ""));
    if (originalWords.length > 0) {
      originalCoverage = originalWords.filter((word) => candidateSet.has(word)).length / originalWords.length;
    }
  } catch {
    // A malformed original URL simply contributes no additional confidence.
  }

  return titleCoverage * 0.8 + originalCoverage * 0.2;
}

export function resolveEventbriteUrlFromHtml(
  title: string,
  originalUrl: string,
  rawHtml: string
): string | null {
  const html = rawHtml.replace(/\\u002F/gi, "/");
  const matches = html.match(/https:\/\/www\.eventbrite\.com\/e\/[^"'<>?\\\s]+/gi) || [];
  const candidates = [
    ...new Set(matches.map(canonicalEventbriteUrl).filter((url): url is string => Boolean(url))),
  ];
  const ranked = candidates
    .map((url) => ({ url, score: similarityScore(title, url, originalUrl) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 0.6 ? ranked[0].url : null;
}

/**
 * Return a canonical Eventbrite event-detail URL. Eventbrite links without the
 * numeric ticket ID redirect to a generic page, so resolve those through the
 * public NYC event search and require a strong title/slug match.
 */
export async function resolveEventbriteUrl(
  title: string,
  candidateUrl: string
): Promise<string | null> {
  if (!candidateUrl || !isEventbriteUrl(candidateUrl)) return candidateUrl || null;

  const canonical = canonicalEventbriteUrl(candidateUrl);
  if (canonical) return canonical;

  const cacheKey = `${title}\n${candidateUrl}`;
  if (URL_CACHE.has(cacheKey)) return URL_CACHE.get(cacheKey) ?? null;

  try {
    const searchUrl = new URL("https://www.eventbrite.com/d/ny--new-york/events/");
    searchUrl.searchParams.set("q", title);
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!response.ok) {
      throw new Error(`Eventbrite search returned ${response.status}`);
    }

    const resolved = resolveEventbriteUrlFromHtml(title, candidateUrl, await response.text());

    if (resolved) {
      console.log(`Resolved incomplete Eventbrite URL for "${title}" → ${resolved}`);
    } else {
      console.warn(`Could not resolve a specific Eventbrite URL for "${title}"`);
    }
    URL_CACHE.set(cacheKey, resolved);
    return resolved;
  } catch (error) {
    console.warn(`Eventbrite URL resolution failed for "${title}":`, error);
    URL_CACHE.set(cacheKey, null);
    return null;
  }
}
