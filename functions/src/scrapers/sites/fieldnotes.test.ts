import assert from "node:assert/strict";
import test from "node:test";
import type { ScrapedEvent } from "../base.js";
import { ExtractionCache, type SeenItemStore } from "../../services/extractionCache.js";
import { parseEventTimes } from "../../services/parser.js";
import { archivePosts, archiveUrl, createFieldnotesScraper } from "./fieldnotes.js";

const BASE = "https://fieldnotesnyc.substack.com/";

function memoryCache() {
  const store: SeenItemStore = { findExisting: async () => new Set(), save: async () => {} };
  return new ExtractionCache("fieldnotes", { store });
}

test("the archive request no longer sends the offset Substack now rejects", () => {
  const url = new URL(archiveUrl());
  assert.equal(url.searchParams.has("offset"), false);
  assert.equal(url.searchParams.get("sort"), "new");
});

test("archive payloads are read in both the old array shape and the new { posts } shape", () => {
  assert.deepEqual(archivePosts([{ slug: "a" }]), [{ slug: "a" }]);
  assert.deepEqual(archivePosts({ posts: [{ slug: "b" }], nextCursor: "x" }), [{ slug: "b" }]);
  assert.equal(archivePosts({ errors: [{ param: "offset", msg: "Invalid value" }] }), null);
  assert.equal(archivePosts(null), null);
});

test("a post listed in the new archive shape is fetched and extracted", async () => {
  const future = parseEventTimes("2099-11-21", "19:00", "22:00");
  const requests: string[] = [];
  const scraper = createFieldnotesScraper("unused", {
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === archiveUrl()) return Response.json({ posts: [{ slug: "things-to-do", title: "things to do" }], nextCursor: null });
      if (url === `${BASE}api/v1/posts/things-to-do`) {
        return Response.json({ slug: "things-to-do", title: "things to do", post_date: "2026-11-16T15:38:13.911Z", canonical_url: `${BASE}p/things-to-do`, body_html: "<p>Friday: <a href=\"https://example.com/show\">A show</a></p>" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    extract: async (text, sourceName, sourceUrl): Promise<ScrapedEvent[]> => {
      assert.match(text, /A show \(https:\/\/example\.com\/show\)/);
      return [{ title: "A show", description: "", ...future, location: "1 Main St, Brooklyn", category: "concerts", sourceUrl, sourceName, temporalStatus: "scheduled_event", temporalEvidence: "Friday" }];
    },
  });
  const events = await scraper.scrape(memoryCache());
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceUrl, `${BASE}p/things-to-do`);
  assert.deepEqual(requests, [archiveUrl(), `${BASE}api/v1/posts/things-to-do`]);
});

test("a rejected archive request is a source error, not a healthy zero", async () => {
  const scraper = createFieldnotesScraper("unused", {
    fetch: (async () => Response.json({ errors: [{ param: "offset", msg: "Invalid value" }] }, { status: 400 })) as typeof fetch,
    extract: async () => { throw new Error("must not extract"); },
  });
  await assert.rejects(scraper.scrape(memoryCache()), /Fieldnotes archive/);
});
