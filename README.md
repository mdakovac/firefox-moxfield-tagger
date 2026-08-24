# Moxfield Tagger

Firefox extension that enables automatic tagging of cards using scryfall tags system on Moxfield deck pages.

## Load it in Firefox (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder
4. Visit a deck page, e.g. https://moxfield.com/decks/g5x3orbdC0y6SPCQs9cJ1A
5. Open the devtools console — you should see `[moxfield-tagger]` log lines.

Temporary add-ons are removed when Firefox closes; reload after restarting.

## What it sends and stores

- **To Scryfall** (`api.scryfall.com`): the Scryfall print IDs of the cards in
  the deck you have open, so their oracle tags can be looked up. No account
  information is sent — the requests are unauthenticated.
- **To Moxfield** (`api2.moxfield.com`): the same requests the site itself
  makes, using your existing session cookie — deck reads, and tag writes when
  you press Apply.
- **Stored locally**: Scryfall's daily oracle-tag index (~17 MB) is cached in
  extension storage (`browser.storage.local`) so it is downloaded at most once
  a day. Nothing is stored on any server, and no auth token is persisted.

Tag writes only ever *add* tags. Existing tags on a card are never removed.
