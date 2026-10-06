import { EventSource } from "./base.js";
import { createNycForFreeScraper } from "./sites/nycforfree.js";
import { createDiceScraper } from "./sites/dice.js";
import { createOhMyRocknessScraper } from "./sites/ohmyrockness.js";
import { createNYEventRadarScraper } from "./sites/nyeventradar.js";
import { createTheSkintScraper } from "./sites/theskint.js";
import { createFieldnotesScraper } from "./sites/fieldnotes.js";
import { createUpstairsNycScraper } from "./sites/upstairsnyc.js";

// Register all event sources here.
// To add a new source:
//   1. Create a new file in scrapers/ that exports a create function
//   2. Add it to the array below
export function getAllSources(apiKey: string): EventSource[] {
  return [
    createNycForFreeScraper(apiKey),
    createDiceScraper(apiKey),
    createOhMyRocknessScraper(apiKey),
    createNYEventRadarScraper(apiKey),
    createTheSkintScraper(apiKey),
    createFieldnotesScraper(apiKey),
    createUpstairsNycScraper(apiKey),
  ];
}
