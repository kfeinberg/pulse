import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function renderPage(
  url: string,
  options?: {
    waitMs?: number;
    scrolls?: number;
    returnInnerText?: boolean;
  }
): Promise<string> {
  const { waitMs = 5000, scrolls = 3, returnInnerText = false } = options ?? {};

  console.log(`Rendering page with Puppeteer: ${url}`);

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 720 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(waitMs);

    // Scroll to load lazy content
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, 2000));
      await delay(2000);
    }

    if (returnInnerText) {
      const text = await page.evaluate(() => document.body.innerText);
      console.log(`Puppeteer extracted ${text.length} chars of innerText for ${url}`);
      return text;
    }

    const html = await page.content();
    console.log(`Puppeteer rendered ${html.length} chars for ${url}`);
    return html;
  } finally {
    await browser.close();
  }
}
