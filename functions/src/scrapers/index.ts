import { EventSource } from "./base.js";
import { createNycForFreeScraper } from "./sites/nycforfree.js";
import { createDiceScraper } from "./sites/dice.js";
import { createPoshScraper } from "./sites/posh.js";
import { createOhMyRocknessScraper } from "./sites/ohmyrockness.js";
import { createNYEventRadarScraper } from "./sites/nyeventradar.js";
import { createTheSkintScraper } from "./sites/theskint.js";

// Register all event sources here.
// To add a new source:
//   1. Create a new file in scrapers/ that exports a create function
//   2. Add it to the array below
export function getAllSources(apiKey: string, scrapingBeeKey?: string): EventSource[] {
  const sources: EventSource[] = [
    createNycForFreeScraper(apiKey),
    createDiceScraper(apiKey),
    createOhMyRocknessScraper(apiKey),
    createNYEventRadarScraper(apiKey, scrapingBeeKey),
    createTheSkintScraper(apiKey),
  ];
  if (scrapingBeeKey) {
    sources.push(createPoshScraper(apiKey, scrapingBeeKey));
  }
  return sources;
}
