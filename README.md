# Moxfield Tagger

Firefox extension that activates on Moxfield deck pages (`https://moxfield.com/decks/<id>`) and enables automatic tagging of cards using scryfall tags system.

## Load it in Firefox (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder
4. Visit a deck page, e.g. https://moxfield.com/decks/g5x3orbdC0y6SPCQs9cJ1A
5. Open the devtools console — you should see `[moxfield-tagger]` log lines.

Temporary add-ons are removed when Firefox closes; reload after restarting.
