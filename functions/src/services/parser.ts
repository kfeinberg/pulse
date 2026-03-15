import Anthropic from "@anthropic-ai/sdk";
import { ScrapedEvent } from "../scrapers/base.js";
import { EXTRACTION_PROMPT } from "./extractionPrompt.js";


export function stripHtml(html: string): string {
  // Extract JSON-LD blocks (structured data) before stripping
  const jsonLdBlocks: string[] = [];
  const jsonLdRegex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    jsonLdBlocks.push(match[1]);
  }

  let cleaned = html;

  // Remove <script> tags and contents (except JSON-LD already extracted)
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Remove <style> tags and contents
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Remove <link>, <meta>, <noscript> tags
  cleaned = cleaned.replace(/<(link|meta|noscript)[^>]*\/?>/gi, "");
  cleaned = cleaned.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");

  // Remove SVG blocks
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, "");

  // Remove all HTML tags, keep text content
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Prepend JSON-LD data if found
  if (jsonLdBlocks.length > 0) {
    const jsonLdSection = "STRUCTURED DATA:\n" + jsonLdBlocks.join("\n") + "\n\nPAGE CONTENT:\n";
    cleaned = jsonLdSection + cleaned;
  }

  return cleaned;
}

async function sendToClaude(
  content: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string
): Promise<ScrapedEvent[]> {
  const client = new Anthropic({ apiKey });

  const truncatedContent = content.slice(0, 100_000);
  console.log(
    `Content: ${content.length} chars → sent: ${truncatedContent.length} chars`
  );

  let message;
  try {
    message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16384,
      messages: [
        {
          role: "user",
          content: `${EXTRACTION_PROMPT}\n\nPage content:\n${truncatedContent}`,
        },
      ],
    });
  } catch (err) {
    console.error("Claude API call failed:", err);
    throw err;
  }

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  console.log("Claude response length:", text.length, "stop_reason:", message.stop_reason);
  console.log("Response start:", text.slice(0, 200));
  console.log("Response end:", text.slice(-200));

  // Strip markdown fences if present
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").trim();

  let parsed: Array<{
    title: string;
    description: string;
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    category: string;
  }>;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("Failed to parse Claude response:", text);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error("Claude response was not an array:", parsed);
    return [];
  }

  return parsed.map((e) => {
    const dateStr = e.date || new Date().toISOString().split("T")[0];
    const startTimeStr = e.startTime || "12:00";
    const endTimeStr = e.endTime || "23:59";
    // Store times as-is (EST) — no timezone conversion
    const startTimestamp = new Date(`${dateStr}T${startTimeStr}:00`).getTime();
    let endTimestamp = new Date(`${dateStr}T${endTimeStr}:00`).getTime();
    // If end time is before start time, the event crosses midnight — bump end to next day
    if (endTimestamp <= startTimestamp) {
      const nextDay = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      endTimestamp = new Date(`${nextDay}T${endTimeStr}:00`).getTime();
    }
    console.log(`Parsed event: "${e.title}" date=${dateStr} start=${startTimeStr} end=${endTimeStr} startTs=${startTimestamp} endTs=${endTimestamp} category=${e.category}`);
    return {
      title: e.title || "Untitled Event",
      description: e.description || "",
      startTimestamp,
      endTimestamp,
      location: e.location || "",
      category: (["popup", "free_stuff", "happening", "bars", "clubs", "concerts"].includes(e.category) ? e.category : "happening") as ScrapedEvent["category"],
      sourceUrl,
      sourceName,
    };
  });
}

export async function parseEventsFromHtml(
  html: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string
): Promise<ScrapedEvent[]> {
  const strippedContent = stripHtml(html);
  console.log(
    `HTML: ${html.length} chars → stripped: ${strippedContent.length} chars`
  );
  return sendToClaude(strippedContent, sourceName, sourceUrl, apiKey);
}

export async function parseEventsFromText(
  text: string,
  sourceName: string,
  sourceUrl: string,
  apiKey: string
): Promise<ScrapedEvent[]> {
  return sendToClaude(text, sourceName, sourceUrl, apiKey);
}
