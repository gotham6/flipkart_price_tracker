import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const watchlistPath = path.join(projectRoot, "watchlist.json");
const statePath = path.join(projectRoot, "state.json");
const envPath = path.join(projectRoot, ".env");
const checkIntervalMs = 60 * 60 * 1000;

const priceSelectorCandidates = [
  '[itemprop="price"]',
  'meta[property="product:price:amount"]',
  "div.Nx9bqj",
  "div._30jeq3",
  "div[class*='Nx9bqj']",
  "div[class*='_30jeq3']"
];
const productReadySelectorCandidates = [
  ...priceSelectorCandidates,
  "h1",
  "span.VU-ZEz",
  'meta[property="og:title"]'
];

async function main() {
  const args = new Set(process.argv.slice(2));
  const env = await readEnvFile(envPath);

  if (args.has("--validate-config")) {
    await validateConfig(env);
    console.log("Configuration looks valid.");
    return;
  }

  const runOnce = args.has("--once");

  if (runOnce) {
    await runCheck(env);
    return;
  }

  console.log(`Watching products every ${checkIntervalMs / (60 * 1000)} minutes.`);

  while (true) {
    try {
      await runCheck(env);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Scheduled run failed:`, error.message);
    }

    await sleep(checkIntervalMs);
  }
}

async function validateConfig(env) {
  const watchlist = await loadWatchlist();
  const enabledCount = watchlist.filter((item) => item.enabled !== false).length;

  if (enabledCount === 0) {
    throw new Error("No enabled items found in watchlist.json.");
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env.");
  }
}

async function runCheck(env) {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Starting price check.`);

  const watchlist = await loadWatchlist();
  const state = await loadState();
  const browserLaunchOptions = await getBrowserLaunchOptions();
  const browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext({
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  try {
    for (const item of watchlist) {
      if (item.enabled === false) {
        continue;
      }

      try {
        const result = await inspectProduct(context, item);
        const previous = state[item.url];
        const isFirstObservation = !previous || typeof previous.lastSeenPrice !== "number";
        const priceChanged = !isFirstObservation && previous.lastSeenPrice !== result.price;

        state[item.url] = {
          name: result.name,
          url: item.url,
          lastSeenPrice: result.price,
          lastCheckedAt: new Date().toISOString()
        };

        if (isFirstObservation) {
          console.log(`Baseline recorded for "${result.name}": Rs ${result.price}`);
        } else if (priceChanged) {
          console.log(`Price changed for "${result.name}": Rs ${previous.lastSeenPrice} -> Rs ${result.price}`);
          await sendTelegramAlert(env, {
            name: result.name,
            url: item.url,
            oldPrice: previous.lastSeenPrice,
            newPrice: result.price
          });
        } else {
          console.log(`No change for "${result.name}": Rs ${result.price}`);
        }
      } catch (error) {
        console.error(`Failed to process ${item.url}:`, error.message);
      }
    }
  } finally {
    await browser.close();
    await saveState(state);
  }

  console.log(`[${new Date().toISOString()}] Price check finished.`);
}

async function inspectProduct(context, item) {
  const page = await context.newPage();

  try {
    await page.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
        return route.abort();
      }

      return route.continue();
    });

    await navigateToProductPage(page, item.url);

    await dismissLoginPrompt(page);
    await waitForProductSignals(page);
    await page.waitForTimeout(1500);

    const product = await page.evaluate((selectors) => {
      function normalizePrice(raw) {
        if (!raw) {
          return null;
        }

        const digits = raw.replace(/[^\d]/g, "");
        if (!digits) {
          return null;
        }

        return Number.parseInt(digits, 10);
      }

      function titleFromDom() {
        const candidates = [
          document.querySelector("span.VU-ZEz"),
          document.querySelector("h1 span"),
          document.querySelector("h1"),
          document.querySelector('meta[property="og:title"]')
        ];

        for (const node of candidates) {
          if (!node) {
            continue;
          }

          const value = node.getAttribute?.("content") ?? node.textContent;
          if (value?.trim()) {
            return value.trim();
          }
        }

        return document.title.trim();
      }

      function priceFromMetadata() {
        const metaAmount = document.querySelector('meta[property="product:price:amount"]');
        const itemProp = document.querySelector('[itemprop="price"]');
        const directValue = metaAmount?.getAttribute("content") ?? itemProp?.getAttribute("content") ?? itemProp?.textContent;

        const parsedDirectValue = normalizePrice(directValue);
        if (parsedDirectValue !== null) {
          return parsedDirectValue;
        }

        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));

        for (const script of scripts) {
          try {
            const parsed = JSON.parse(script.textContent);
            const candidates = Array.isArray(parsed) ? parsed : [parsed];

            for (const candidate of candidates) {
              const offerPrice = candidate?.offers?.price ?? candidate?.price;
              const parsedOfferPrice = normalizePrice(String(offerPrice ?? ""));
              if (parsedOfferPrice !== null) {
                return parsedOfferPrice;
              }
            }
          } catch {
            continue;
          }
        }

        return null;
      }

      function priceFromSelectors() {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!node) {
            continue;
          }

          const value = node.getAttribute?.("content") ?? node.textContent;
          const parsed = normalizePrice(value);
          if (parsed !== null) {
            return parsed;
          }
        }

        const bodyText = document.body?.innerText ?? "";
        const rupeeMatch = bodyText.match(/₹\s?([\d,]+)/);
        return rupeeMatch ? normalizePrice(rupeeMatch[1]) : null;
      }

      const price = priceFromMetadata() ?? priceFromSelectors();
      const name = titleFromDom();

      return { name, price };
    }, priceSelectorCandidates);

    if (!product.price || Number.isNaN(product.price)) {
      throw new Error("Could not extract a product price from the page.");
    }

    return {
      name: item.name?.trim() || product.name || "Unknown Product",
      price: product.price
    };
  } finally {
    await page.close();
  }
}

async function navigateToProductPage(page, url) {
  const navigationAttempts = [
    { waitUntil: "domcontentloaded", timeout: 90000 },
    { waitUntil: "commit", timeout: 90000 }
  ];
  const maxRetries = 3;

  let lastError = null;

  for (let retry = 1; retry <= maxRetries; retry += 1) {
    for (const attempt of navigationAttempts) {
      try {
        await page.goto(url, attempt);
        return;
      } catch (error) {
        lastError = error;
        if (!isRetriableNavigationError(error)) {
          throw error;
        }
      }
    }

    if (retry < maxRetries) {
      console.warn(`Navigation retry ${retry}/${maxRetries - 1} for ${url}`);
      await page.waitForTimeout(3000 * retry);
    }
  }

  throw lastError;
}

async function waitForProductSignals(page) {
  try {
    await page.waitForFunction(
      (selectors) => selectors.some((selector) => document.querySelector(selector)),
      productReadySelectorCandidates,
      { timeout: 15000 }
    );
  } catch {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  }
}

function isRetriableNavigationError(error) {
  return error instanceof Error && /(timeout|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_ABORTED)/i.test(error.message);
}

async function dismissLoginPrompt(page) {
  const closeButtonSelectors = [
    'button:has-text("✕")',
    'button[aria-label="Close"]',
    'button._2KpZ6l._2doB4z'
  ];

  for (const selector of closeButtonSelectors) {
    const button = page.locator(selector).first();
    if (await button.count()) {
      try {
        await button.click({ timeout: 2000 });
        return;
      } catch {
        continue;
      }
    }
  }
}

async function sendTelegramAlert(env, payload) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram is not configured; skipping alert.");
    return;
  }

  const message = [
    "Flipkart price change detected",
    `${payload.name}`,
    `Old price: Rs ${payload.oldPrice}`,
    `New price: Rs ${payload.newPrice}`,
    `${payload.url}`
  ].join("\n");

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram alert failed: ${response.status} ${body}`);
  }
}

async function getBrowserLaunchOptions() {
  const defaultExecutablePath = chromium.executablePath();

  if (await fileExists(defaultExecutablePath)) {
    return { headless: true };
  }

  const fallbackExecutablePath = await findFallbackChromiumExecutable();
  if (fallbackExecutablePath) {
    return {
      headless: true,
      executablePath: fallbackExecutablePath
    };
  }

  return { headless: true };
}

async function loadWatchlist() {
  const raw = await fs.readFile(watchlistPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("watchlist.json must contain an array.");
  }

  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item.url !== "string" || item.url.trim() === "") {
      throw new Error(`watchlist.json item ${index} is missing a valid url.`);
    }
  }

  return parsed;
}

async function loadState() {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function saveState(state) {
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function findFallbackChromiumExecutable() {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME || projectRoot, ".cache", "ms-playwright");

  let entries = [];
  try {
    entries = await fs.readdir(browsersPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const chromiumDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
    .map((entry) => path.join(browsersPath, entry.name))
    .sort()
    .reverse();

  const executableCandidates = [
    path.join("chrome-linux", "chrome"),
    path.join("chrome-linux64", "chrome")
  ];

  for (const chromiumDir of chromiumDirs) {
    for (const candidate of executableCandidates) {
      const fullPath = path.join(chromiumDir, candidate);
      if (await fileExists(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

async function readEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const env = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      env[key] = value;
    }

    return {
      ...env,
      ...process.env
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...process.env };
    }

    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
