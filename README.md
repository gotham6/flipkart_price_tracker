# Flipkart Price Tracker

Tracks exact Flipkart product pages with Playwright and sends a Telegram alert when the observed price changes.

## Behavior

- Reads products from `watchlist.json`
- Checks each enabled product page
- Extracts the product title and current price
- Stores the last observed price in `state.json`
- Sends one Telegram alert per actual price change
- First successful run creates a baseline and does not alert

## Setup

1. Install dependencies:

   ```bash
   npm install
   npx playwright install chromium
   ```

2. Copy the env template and fill in your Telegram values:

   ```bash
   cp .env.example .env
   ```

3. Replace the dummy links in `watchlist.json` with exact Flipkart product URLs.

## Usage

Run once:

```bash
npm run check
```

Run continuously with a 60 minute interval:

```bash
npm run watch
```

Validate your config without launching the browser:

```bash
npm run test:config
```

## GitHub Actions

This project can run once per hour on GitHub Actions instead of using the built-in loop.

1. Push the project to a GitHub repository.
2. In the repository settings, add these Actions secrets:

   ```text
   TELEGRAM_BOT_TOKEN
   TELEGRAM_CHAT_ID
   ```

3. Keep the workflow file at `.github/workflows/price-check.yml`.
4. The workflow runs every hour with cron `0 * * * *`.
5. Price history is stored in a separate branch named `tracker-state`.

After pushing, open the `Actions` tab in GitHub and run the workflow once with `workflow_dispatch` to initialize the state branch and verify Telegram delivery.

## Cron Alternative

If you prefer cron over the built-in loop, use:

```cron
0 * * * * cd /home/neo/flipkart-price-tracker && /usr/bin/npm run check >> /home/neo/flipkart-price-tracker/tracker.log 2>&1
```
