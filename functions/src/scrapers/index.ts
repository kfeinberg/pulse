import { EventSource } from "./base.js";
import { createNycForFreeScraper } from "./sites/nycforfree.js";
import { createDiceScraper } from "./sites/dice.js";
import { createPoshScraper } from "./sites/posh.js";

// Register all event sources here.
// To add a new source:
//   1. Create a new file in scrapers/ that exports a create function
//   2. Add it to the array below
export function getAllSources(apiKey: string, scrapingBeeKey?: string): EventSource[] {
  const sources: EventSource[] = [
    createNycForFreeScraper(apiKey),
    createDiceScraper(apiKey),
  ];
  if (scrapingBeeKey) {
    sources.push(createPoshScraper(apiKey, scrapingBeeKey));
  }
  return sources;
}
