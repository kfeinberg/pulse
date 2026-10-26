import { EventSource } from "./base.js";
import { createNycForFreeScraper } from "./sites/nycforfree.js";
import { createDiceScraper } from "./sites/dice.js";
import { createOhMyRocknessScraper } from "./sites/ohmyrockness.js";
import { createNYEventRadarScraper } from "./sites/nyeventradar.js";
import { createTheSkintScraper } from "./sites/theskint.js";
import { createFieldnotesScraper } from "./sites/fieldnotes.js";
import { createUpstairsNycScraper } from "./sites/upstairsnyc.js";
import { createNycStreetFairsScraper } from "./sites/nycstreetfairs.js";
import { createTrickOrStreetsScraper } from "./sites/trickorstreets.js";
import { createNycGovScraper } from "./sites/nycgov.js";

// Register all event sources here.
// To add a new source:
//   1. Create a new file in scrapers/ that exports a create function
//   2. Add it to the array below
//
// Order matters for category assignment: Firestore dedup merges URLs and
// locations but never changes an existing event's category, so sources with
// a dedicated category (street fairs, Trick-or-Streets) run before the
// general NYC.gov calendar, which also lists many of the same events.
export function getAllSources(apiKey: string): EventSource[] {
  return [
    createNycForFreeScraper(apiKey),
    createDiceScraper(apiKey),
    createOhMyRocknessScraper(apiKey),
    createNYEventRadarScraper(apiKey),
    createTheSkintScraper(apiKey),
    createFieldnotesScraper(apiKey),
    createUpstairsNycScraper(apiKey),
    createNycStreetFairsScraper(),
    createTrickOrStreetsScraper(),
    createNycGovScraper(apiKey),
  ];
}
