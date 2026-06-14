# Moxfield Tagger

Firefox extension that activates on Moxfield deck pages (`https://moxfield.com/decks/<id>`), but only when you're logged in.

## How it works

- `content.js` runs on all moxfield.com pages and calls the Moxfield API itself, with the page's cookies (`credentials: "include"`):
  - `POST https://api2.moxfield.com/v1/startup/authenticated` → a 2xx response means we're logged in (checked once per page load).
  - `GET https://api2.moxfield.com/v3/decks/all/<publicId>` → the full deck JSON (cached per deck).
- Moxfield is a SPA, so the script polls the URL to detect route changes between decks.
- Once we're on a deck page, logged in, and have the deck data, `initialize()` fires (currently just logs to the console).

## Load it in Firefox (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder
4. Visit a deck page, e.g. https://moxfield.com/decks/g5x3orbdC0y6SPCQs9cJ1A
5. Open the devtools console — you should see `[moxfield-tagger]` log lines.

Temporary add-ons are removed when Firefox closes; reload after restarting.
