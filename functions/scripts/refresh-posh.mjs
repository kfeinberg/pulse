#!/usr/bin/env node

const EXPLORE_API =
  "https://posh.vip/api/bff/v1/explore/events?lat=40.7128&lng=-74.006&timezone=America%2FNew_York&when=This%20Month";
const INGEST_URL =
  process.env.POSH_INGEST_URL ||
  "https://us-central1-pulse-3ed92.cloudfunctions.net/ingestPoshEvents";
const TOKEN = process.env.POSH_INGEST_TOKEN;
const CONCURRENCY = 5;
const HEADERS = {
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

if (!TOKEN) {
  throw new Error("POSH_INGEST_TOKEN is required");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: HEADERS });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }
  throw lastError;
}

function extractNextFlightText(html) {
  const chunks = [];
  const pattern = /<script(?:\s[^>]*)?>self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const payload = JSON.parse(match[1]);
      if (Array.isArray(payload) && payload[0] === 1 && typeof payload[1] === "string") {
        chunks.push(payload[1]);
      }
    } catch {
      // Ignore non-JSON bootstrap chunks.
    }
  }
  return chunks.join("\n");
}

function extractJsonStringField(text, field) {
  const pattern = new RegExp(`"${field}":"((?:\\\\.|[^"\\\\])*)"`);
  const match = text.match(pattern);
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
}

async function addDetails(event) {
  const detailUrl = `https://posh.vip/e/${event.url}`;
  try {
    const flightText = extractNextFlightText(await fetchText(detailUrl));
    return {
      ...event,
      venueAddress: extractJsonStringField(flightText, "venueAddress"),
      shortDescription: extractJsonStringField(flightText, "shortDescription"),
    };
  } catch (error) {
    console.warn(`Could not fetch details for "${event.title}": ${error}`);
    return { ...event, venueAddress: "", shortDescription: "" };
  }
}

async function main() {
  console.log(`Fetching Posh NYC events at ${new Date().toISOString()}`);
  const exploreResponse = JSON.parse(await fetchText(EXPLORE_API));
  const sourceEvents = Array.isArray(exploreResponse.events) ? exploreResponse.events : [];
  if (sourceEvents.length === 0) throw new Error("Posh Explore returned no events");
  console.log(`Posh Explore returned ${sourceEvents.length} events`);

  const events = [];
  for (let index = 0; index < sourceEvents.length; index += CONCURRENCY) {
    const batch = sourceEvents.slice(index, index + CONCURRENCY);
    events.push(...(await Promise.all(batch.map(addDetails))));
    console.log(`Fetched details for ${Math.min(index + batch.length, sourceEvents.length)}/${sourceEvents.length}`);
  }

  const response = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-posh-ingest-token": TOKEN,
    },
    body: JSON.stringify({ events }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Posh ingestion failed (${response.status}): ${body}`);
  console.log(body);
}

await main();
