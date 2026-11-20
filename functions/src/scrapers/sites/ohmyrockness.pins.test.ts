import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import type { ScrapedEvent } from "../base.js";
import { resolveEventLocation } from "../../services/geocoder.js";
import { resolvedLocationViolations } from "../../services/pipeline/contracts.js";
import { overlayShowData, type OmrShow } from "./ohmyrockness.js";

const show: OmrShow = {
  id: 481493, starts_at: "2026-11-21T20:00:00-05:00",
  url: "http://www.ohmyrockness.com/shows/481493-thrilliam-angels-market-hotel",
  cached_bands: [{ name: "Thrilliam Angels" }],
  venue: { name: "Market Hotel", full_address: "1142 Myrtle Ave\nBrooklyn, NY 11221", latitude: "40.6973", longitude: "-73.9322" },
};

function parsed(overrides: Partial<ScrapedEvent> = {}): ScrapedEvent {
  return {
    title: "Thrilliam Angels", description: "Live concert", location: "Market Hotel, 1142 Myrtle Ave, Brooklyn, NY 11221",
    startTimestamp: Date.parse("2026-11-21T20:00:00-05:00"), endTimestamp: Date.parse("2026-11-21T23:00:00-05:00"),
    category: "concerts", sourceUrl: "https://www.ohmyrockness.com/shows", sourceName: "ohmyrockness",
    temporalStatus: "scheduled_event", temporalEvidence: "November 21 at 8pm", ...overrides,
  };
}

const noIo = {
  db: { collection: () => { throw new Error("Unexpected DB access"); } } as unknown as Firestore,
  fetch: async (): Promise<Response> => { throw new Error("Unexpected network request"); },
  sleep: async (): Promise<void> => { throw new Error("Unexpected provider sleep"); },
};

test("a matched show carries its venue's own pin, which needs no Nominatim lookup", async () => {
  const event = parsed();
  overlayShowData(event, [show]);
  assert.equal(event.sourceUrl, "https://www.ohmyrockness.com/shows/481493-thrilliam-angels-market-hotel");
  assert.equal(event.location, "Market Hotel, 1142 Myrtle Ave, Brooklyn, NY 11221");
  const pin = await resolveEventLocation(event, noIo);
  assert.equal(pin?.provider, "ohmyrockness");
  assert.equal(pin?.latitude, 40.6973);
  assert.deepEqual(resolvedLocationViolations(pin), []);
});

test("New Jersey venues and shows whose time the extraction did not reproduce get no pin", () => {
  const jersey = parsed({ location: "Starland Ballroom, 570 Jernee Mill Road, Sayreville, NJ 08872" });
  overlayShowData(jersey, [{ ...show, venue: { name: "Starland Ballroom", full_address: "570 Jernee Mill Road\nSayreville, NJ 08872", latitude: "40.4648", longitude: "-74.3324" } }]);
  assert.equal(jersey.sourceLocation, undefined);
  assert.equal(jersey.location, "Starland Ballroom, 570 Jernee Mill Road, Sayreville, NJ 08872");
  const otherNight = parsed({ startTimestamp: Date.parse("2026-11-22T20:00:00-05:00") });
  overlayShowData(otherNight, [show]);
  assert.equal(otherNight.sourceLocation, undefined);
});
