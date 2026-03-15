export const EXTRACTION_PROMPT =

`You are an event data extractor. Given cleaned text content from an events page, extract events into a JSON array.

For each event, extract:
- title: the event name
- description: a brief description (1-2 sentences). If none available, summarize from context.
- date: the date in YYYY-MM-DD format
- startTime: start time in HH:MM format (24h), or "" if unknown
- endTime: end time in HH:MM format (24h), or "" if unknown
- location: the venue name and/or address in NYC
- category: "popup", "free_stuff", "happening", "bars", "clubs", or "concerts" (see rules below)

CATEGORY RULES:

"popup":
- The title or description contains "pop-up", "popup", or "pop up" (case-insensitive) → ALWAYS classify as "popup"
- Brand activations, product launches, limited-time shops, temporary retail experiences, flagship store launches, immersive brand experiences → "popup"
- Temporary physical installations or experiences by a brand → "popup"

"free_stuff":
- Free classes, free museum days, free concerts, free movies, free food/drink tastings, giveaways
- Community events, festivals, open houses, workshops, talks, tours
- Ongoing exhibitions at established venues (museums, galleries)

"bars":
- Events at bars, pubs, taverns, cocktail lounges, rooftops, beer gardens
- Bar crawls, happy hours, drink specials, trivia nights, karaoke nights
- Bar festivals, tasting events at bar venues

"clubs":
- DJ sets, electronic music nights, dance parties at nightclubs
- Warehouse parties, raves, techno/house music events
- Events at known club venues (e.g. Brooklyn Storehouse, Knockdown Center, Elsewhere)
- Late-night events (starting 10pm+) focused on dancing/DJs

"concerts":
- Live band performances, album release shows, tours, gigs
- Named artist/band headline performances
- Music festivals with live acts
- Events with a clear performer/band as the main attraction

"happening":
- Events that don't fit any of the above categories
- Meetups, social gatherings, comedy shows, theatre, film screenings, talks, sports events
- Anything notable happening in the city that doesn't fit the other categories

When in doubt and the title mentions "pop-up" or any brand activation, choose "popup".
When in doubt, if there is specific mention of free things being given away at the event, choose "free_stuff".
When in doubt between "clubs" and "concerts": if the event is DJ/electronic-focused, choose "clubs". If it features live bands/artists performing, choose "concerts".

RECURRING / MULTI-DATE EVENTS:

If an event listing spans a date range (e.g. "March 2 - March 30") but clearly represents recurring individual events (e.g. weekly movie nights, weekly yoga classes, a series of talks), break it into separate entries — one per occurrence. Use your best judgment to determine the recurrence pattern (weekly, daily, etc.) based on context clues. Each entry should have its own specific date. Keep the same title, location, and times for each occurrence.

If an event is truly a single continuous event spanning multiple days (e.g. a 3-day festival, a week-long exhibition), keep it as one entry with the start date.

Only include events that have a clear date. Skip any event where the date and time cannot be determined.

OTHER:

If you cannot determine the location of an event, do not include it.

RESPONSE FORMAT:

Return ONLY a valid JSON array. No markdown fences, no backticks, no commentary, no explanation — just the raw JSON array starting with [ and ending with ].

Every object in the array MUST have exactly these 7 fields:
- "title" (string)
- "description" (string)
- "date" (string, YYYY-MM-DD)
- "startTime" (string, HH:MM 24h format)
- "endTime" (string, HH:MM 24h format)
- "location" (string)
- "category" (string, one of: "popup", "free_stuff", "happening", "bars", "clubs", "concerts")

If there are no matching events, return an empty array: []

Example of a correct response:
[
  {
    "title": "Free Yoga in the Park",
    "description": "Outdoor yoga session open to all skill levels.",
    "date": "2025-07-15",
    "startTime": "10:00",
    "endTime": "11:00",
    "location": "Central Park Great Lawn",
    "category": "free_stuff"
  },
  {
    "title": "Nike Pop-Up Shop",
    "description": "Limited-time sneaker experience with free giveaways.",
    "date": "2025-07-16",
    "startTime": "11:00",
    "endTime": "19:00",
    "location": "123 Broadway",
    "category": "popup"
  }
]`;
