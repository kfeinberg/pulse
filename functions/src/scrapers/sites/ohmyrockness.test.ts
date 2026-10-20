import assert from "node:assert/strict";
import test from "node:test";

import {
  extractApiToken,
  extractBundleUrl,
  showsInWindow,
  type OmrShow,
} from "./ohmyrockness.js";

test("extractBundleUrl finds the application bundle script", () => {
  const html = `
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
    <script src="/assets/application-9635d8d6879987e0.js"></script>
    <script src="/assets/new-db67354ffa865a20.js"></script>
  `;
  assert.equal(
    extractBundleUrl(html),
    "https://www.ohmyrockness.com/assets/application-9635d8d6879987e0.js"
  );
  assert.equal(extractBundleUrl("<html></html>"), null);
});

test("extractApiToken reads the token the lazy loader sends", () => {
  const js =
    'function(){var t;t="3b35f8a73dabd5f14b1cac167a14c1f6",$.fn.lazy=function(){' +
    "return this.each(function(){e.setRequestHeader(\"Authorization\",'Token token=\"'+t+'\"')})}}";
  assert.equal(extractApiToken(js), "3b35f8a73dabd5f14b1cac167a14c1f6");
  assert.equal(extractApiToken('var t="not-a-token",$.fn.lazy=function(){}'), null);
});

test("showsInWindow keeps only shows starting within the window", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const shows: OmrShow[] = [
    { id: 1, starts_at: "2026-10-16T07:00:00.000-04:00" }, // started earlier today
    { id: 2, starts_at: "2026-10-16T19:00:00.000-04:00" },
    { id: 3, starts_at: "2026-10-19T07:59:00.000-04:00" }, // just inside 3 days
    { id: 4, starts_at: "2026-10-19T09:00:00.000-04:00" }, // just outside
    { id: 5 },
  ];
  assert.deepEqual(
    showsInWindow(shows, now, 3).map((show) => show.id),
    [2, 3]
  );
});
