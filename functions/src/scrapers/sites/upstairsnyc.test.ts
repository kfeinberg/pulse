import assert from "node:assert/strict";
import test from "node:test";

import {
  eventToText,
  extractDetailUrls,
  extractEventJsonLd,
  extractPostTitle,
} from "./upstairsnyc.js";

test("extractDetailUrls normalizes and deduplicates canonical detail pages", () => {
  const html = `
    <a href="/events-1/gallery-opening?utm_source=test">Opening</a>
    <a href="https://www.upstairsnyc.org/events-1/gallery-opening/">Duplicate</a>
    <a href="/post/weekly-picks#details">Weekly picks</a>
    <a href="/events-1/gallery-opening/form">Registration form</a>
    <a href="https://example.com/events-1/not-upstairs">External</a>
  `;

  assert.deepEqual(extractDetailUrls(html), [
    "https://www.upstairsnyc.org/events-1/gallery-opening",
    "https://www.upstairsnyc.org/post/weekly-picks",
  ]);
});

test("extractEventJsonLd finds an Event inside an @graph", () => {
  const html = `
    <script type="application/ld+json">not-json</script>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"WebPage","name":"Listing"},
        {"@type":["Event","Thing"],"name":"Gallery Opening","startDate":"2026-10-10T19:00:00-04:00"}
      ]}
    </script>
  `;

  assert.equal(extractEventJsonLd(html)?.name, "Gallery Opening");
});

test("eventToText formats structured postal addresses and rejects invalid dates", () => {
  const text = eventToText(
    {
      "@type": "Event",
      name: "Gallery Opening",
      description: "Opening night",
      startDate: "2026-10-10T19:00:00-04:00",
      endDate: "2026-10-10T21:00:00-04:00",
      location: {
        name: "Example Gallery",
        address: {
          streetAddress: "123 Example St",
          addressLocality: "New York",
          addressRegion: "NY",
          postalCode: "10001",
          addressCountry: "US",
        },
      },
    },
    "https://www.upstairsnyc.org/events-1/gallery-opening"
  );

  assert.match(text ?? "", /Location: Example Gallery, 123 Example St, New York, NY, 10001, US/);
  assert.match(text ?? "", /Start \(Eastern Time\): 10\/10\/2026, 19:00/);
  assert.equal(
    eventToText(
      { "@type": "Event", name: "Broken", startDate: "not-a-date" },
      "https://www.upstairsnyc.org/events-1/broken"
    ),
    null
  );
});

test("extractPostTitle prefers BlogPosting metadata and falls back to og:title", () => {
  assert.equal(
    extractPostTitle(
      '<script type="application/ld+json">{"@type":"BlogPosting","headline":"What\\u2019s On"}</script>'
    ),
    "What’s On"
  );
  assert.equal(
    extractPostTitle('<meta property="og:title" content="Weekly Picks &amp; More">'),
    "Weekly Picks & More"
  );
});
