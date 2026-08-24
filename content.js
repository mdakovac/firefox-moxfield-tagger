// Content script. Calls the Moxfield API directly (with the page's cookies)
// to check login state and load the deck, then initializes on deck pages.
(() => {
  "use strict";

  const API = "https://api2.moxfield.com";
  // Deck public IDs are 22-char base64url strings; requiring that shape keeps
  // utility routes like /decks/personal or /decks/following from matching.
  const DECK_PATH_RE = /^\/decks\/([A-Za-z0-9_-]{22})(?:[/?#]|$)/;

  const state = {
    authenticated: null, // null = not checked yet, true/false afterwards
    user: null, // username only; the rest of the auth payload is not kept
    decks: new Map(), // publicId -> deck JSON
    initializedFor: null, // publicId we've already initialized on
    pending: null, // publicId currently being set up (guards re-entry)
    cards: [], // current deck's cards with their scryfall tags
    tagCounts: [], // [tag, count] pairs sorted by frequency
    selectedTags: new Set(), // tags checked in the toolbar popup
    applying: false, // true while applyTags is running (survives popup close)
    write: null, // plain copy of deck fields needed for tag writes
  };

  // Force API JSON into plain content-script objects. Assigning nested
  // fetch results directly onto objects can hit Firefox XrayWrapper errors.
  function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function cloneAuthorTags(authorTags) {
    const out = {};
    for (const [name, tags] of Object.entries(authorTags ?? {})) {
      out[name] = Array.isArray(tags) ? tags.map(String) : [];
    }
    return out;
  }

  function initWriteState(deck) {
    state.write = {
      internalId: String(deck.id),
      publicId: String(deck.publicId),
      version: Number(deck.version ?? 0),
      authorTags: cloneAuthorTags(deck.authorTags),
    };
  }

  function log(...args) {
    console.log("[moxfield-tagger]", ...args);
  }

  function currentDeckId() {
    const m = DECK_PATH_RE.exec(location.pathname);
    return m ? m[1] : null;
  }

  // ---- API calls ----
  async function startupAuthenticated() {
    // The refresh token is sent automatically as an HttpOnly cookie
    // (hence credentials: "include"); the body just mirrors the web app's.
    const res = await fetch(`${API}/v1/startup/authenticated`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignoreCookie: false, isAppLogin: false }),
    });
    if (res.ok) captureAccessToken(await res.clone().json().catch(() => null));
    return res;
  }

  // How long a negative auth result is trusted before we ask again.
  const AUTH_RECHECK_MS = 30_000;
  let lastAuthCheck = 0;

  async function checkAuth() {
    // Only a positive result is cached for good. Caching "false" would lock
    // the extension out for the life of the tab if the user logs in
    // afterwards, but re-checking is a POST, so back it off rather than
    // firing one on every SPA navigation.
    if (state.authenticated) return true;
    if (state.authenticated === false && Date.now() - lastAuthCheck < AUTH_RECHECK_MS) {
      return false;
    }
    lastAuthCheck = Date.now();
    try {
      const res = await startupAuthenticated();
      state.authenticated = res.ok;
      if (res.ok) {
        // Keep the username and nothing else: the startup payload is the same
        // object the access token is read out of, so holding or logging it
        // would put a live bearer JWT in memory and in the page's console.
        const payload = await res.json().catch(() => null);
        state.user = payload?.userName ?? null;
        log("logged in", state.user ?? "");
      } else {
        log(`not logged in (startup/authenticated returned ${res.status})`);
      }
    } catch (err) {
      state.authenticated = false;
      log("auth check failed:", err);
    }
    return state.authenticated;
  }

  // ---- access token (Bearer JWT, ~15 min lifetime, for write requests) ----
  let accessToken = null; // { token, expiresAt }

  const JWT_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
  // Field names that hold the short-lived access token we want.
  const ACCESS_TOKEN_KEYS = ["access_token", "accessToken"];
  // Never lift a bearer token out of one of these: sending a long-lived
  // refresh or identity token as an Authorization header is far worse than
  // failing the write and asking the user to reload.
  const NON_ACCESS_KEY_RE = /refresh|identity|id_?token/i;

  const isJwt = (value) => typeof value === "string" && JWT_RE.test(value);

  // Preferred path: a field actually named like an access token, at any depth.
  function findTokenByKey(value, seen) {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const key of ACCESS_TOKEN_KEYS) {
      if (isJwt(value[key])) return value[key];
    }
    for (const inner of Object.values(value)) {
      const token = findTokenByKey(inner, seen);
      if (token) return token;
    }
    return null;
  }

  // Fallback for a renamed field: any JWT-shaped string that isn't sitting
  // under a refresh/identity key.
  function findAnyJwt(value, seen) {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const [key, inner] of Object.entries(value)) {
      if (NON_ACCESS_KEY_RE.test(key)) continue;
      if (isJwt(inner)) return inner;
      const token = findAnyJwt(inner, seen);
      if (token) return token;
    }
    return null;
  }

  function findAccessToken(payload) {
    return findTokenByKey(payload, new Set()) ?? findAnyJwt(payload, new Set());
  }

  function captureAccessToken(startupResponse) {
    const token = findAccessToken(startupResponse);
    if (!token) return;
    let expiresAt = 0;
    try {
      expiresAt = JSON.parse(atob(token.split(".")[1])).exp * 1000;
    } catch {
      /* token without readable exp: treat as already stale */
    }
    accessToken = { token, expiresAt };
  }

  async function getAccessToken() {
    // 30s safety margin so we don't send a token that expires mid-flight.
    if (accessToken && Date.now() < accessToken.expiresAt - 30_000) {
      return accessToken.token;
    }
    accessToken = null;
    const res = await startupAuthenticated();
    if (!res.ok || !accessToken) {
      throw new Error(`could not obtain access token (startup returned ${res.status})`);
    }
    return accessToken.token;
  }

  async function fetchDeck(publicId, { force = false } = {}) {
    if (!force && state.decks.has(publicId)) return state.decks.get(publicId);
    const res = await fetch(`${API}/v3/decks/all/${publicId}`, {
      credentials: "include",
    });
    if (!res.ok) {
      log(`deck request failed (${res.status}) for`, publicId);
      return null;
    }
    const deck = toPlain(await res.json());
    state.decks.set(publicId, deck);
    log(force ? "deck refreshed:" : "deck loaded:", publicId, deck?.name ?? "");
    return deck;
  }

  async function refreshDeckState(publicId) {
    const deck = await fetchDeck(publicId, { force: true });
    if (!deck) return false;

    const scryfallTagsById = new Map(state.cards.map((c) => [c.scryfallId, c.scryfallTags]));
    const cards = collectCards(deck);
    for (const card of cards) {
      card.scryfallTags = (scryfallTagsById.get(card.scryfallId) ?? []).map(String);
    }
    state.cards = cards;
    initWriteState(deck);
    log("deck state refreshed for apply, version", state.write.version);
    return true;
  }

  // ---- lifecycle ----
  async function maybeInitialize() {
    const deckId = currentDeckId();
    if (!deckId) {
      log("not a deck page, doing nothing:", location.pathname);
      return;
    }
    if (state.initializedFor === deckId || state.pending === deckId) return;
    if (state.applying) return; // see teardown(): the running apply owns state

    state.pending = deckId;
    try {
      if (!(await checkAuth())) return;
      const deck = await fetchDeck(deckId);
      if (!deck) return;
      // Bail if the user navigated away while we were fetching.
      if (currentDeckId() !== deckId) return;

      state.initializedFor = deckId;
      initialize(deckId, deck);
    } finally {
      state.pending = null;
    }
  }

  const TAGGED_BOARDS = ["mainboard", "sideboard", "maybeboard"];

  function collectCards(deck) {
    const cards = [];
    for (const board of TAGGED_BOARDS) {
      for (const entry of Object.values(deck.boards?.[board]?.cards ?? {})) {
        cards.push({
          board,
          name: entry.card.name,
          quantity: entry.quantity,
          scryfallId: entry.card.scryfall_id,
          cardId: entry.card.id, // used by the tags write endpoint
        });
      }
    }
    return cards;
  }

  // Tag -> number of cards carrying it (each copy counts, so 4x Shock
  // contributes 4), sorted by count descending, ties alphabetical.
  function countTags(cards) {
    const counts = new Map();
    for (const card of cards) {
      for (const tag of card.scryfallTags) {
        counts.set(tag, (counts.get(tag) ?? 0) + card.quantity);
      }
    }
    return [...counts.entries()].sort(([tagA, a], [tagB, b]) => b - a || tagA.localeCompare(tagB));
  }

  async function initialize(deckId, deck) {
    log("initialized on deck", deckId, deck.name);
    const cards = collectCards(deck);
    try {
      const tagsByScryfallId = await ScryfallTags.getTags(cards.map((c) => c.scryfallId));
      for (const card of cards) {
        card.scryfallTags = (tagsByScryfallId.get(card.scryfallId) ?? []).map(String);
      }
      state.cards = cards;
      state.tagCounts = countTags(cards);
      initWriteState(deck);
      log(`scryfall tags loaded for ${cards.length} cards, ${state.tagCounts.length} distinct tags`);
    } catch (err) {
      log("failed to load scryfall tags:", err);
    }
    // TODO: actual tagger functionality goes here.
  }

  function teardown() {
    // A run in flight owns state.write and state.cards; clearing them mid-loop
    // would throw and abandon the rest of the deck. applyTags re-syncs to the
    // current URL when it finishes.
    if (state.applying) {
      log("apply in progress; deferring teardown");
      return;
    }
    state.initializedFor = null;
    state.cards = [];
    state.tagCounts = [];
    state.selectedTags = new Set();
    state.write = null;
    // TODO: remove any injected UI here.
  }

  // ---- applying tags to Moxfield ----
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function syncWriteState() {
    if (!state.write) return false;
    const res = await fetch(`${API}/v3/decks/all/${state.write.publicId}`, {
      credentials: "include",
    });
    if (!res.ok) return false;
    const fresh = toPlain(await res.json());
    state.write.version = Number(fresh.version ?? 0);
    state.write.authorTags = cloneAuthorTags(fresh.authorTags);
    return true;
  }

  // Statuses where both retrying this card and continuing with the rest of the
  // deck are pointless: the session or the permission is the problem, not the
  // request. Applying to a deck you can't edit used to cost three PUTs and two
  // full deck reads *per card* before giving up.
  const FATAL_STATUSES = new Set([401, 403, 404, 410]);
  // Stop the run once this many cards fail back to back. A deck-wide problem
  // that isn't one of the statuses above still shouldn't cost hundreds of
  // requests before it surfaces.
  const MAX_CONSECUTIVE_FAILURES = 3;

  function describeStatus(status) {
    if (status === 401) return "Moxfield rejected the session — reload the page and try again";
    if (status === 403) return "you don't have permission to edit this deck";
    if (status === 404 || status === 410) return "the deck or card no longer exists";
    return `Moxfield returned ${status}`;
  }

  // Retry-After isn't CORS-safelisted, so this is usually unreadable; the
  // caller falls back to a fixed delay when it returns null.
  function retryAfterMs(res) {
    try {
      const value = res.headers.get("retry-after");
      if (!value) return null;
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0), 60) * 1000;
      const at = Date.parse(value);
      return Number.isNaN(at) ? null : Math.min(Math.max(at - Date.now(), 0), 60_000);
    } catch {
      return null;
    }
  }

  function readDeckVersion(res) {
    // Cross-origin Response headers can throw in Firefox content scripts;
    // never let that escape to the popup message channel.
    try {
      const v = res.headers.get("x-deck-version");
      return v !== null ? Number(v) : null;
    } catch {
      return null;
    }
  }

  // Writes are guarded by optimistic concurrency: every write bumps the deck
  // version, and writes carrying a stale X-Deck-Version are rejected. The site
  // itself doesn't re-fetch the deck after a successful tag write — it just reads
  // the new version from the response header — so we do the same.
  // Returns { ok: true }, or { ok: false, reason, fatal } where `fatal` means
  // the caller should abandon the whole run rather than move to the next card.
  async function putCardTags(card, tags, token) {
    const write = state.write;
    const ATTEMPTS = 3;
    let reason = "request failed";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      let res;
      try {
        res = await fetch(`${API}/v2/decks/${write.internalId}/cards/${card.cardId}/tags`, {
          method: "PUT",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Deck-Version": String(write.version),
          },
          body: JSON.stringify({ tags }),
        });
      } catch (err) {
        reason = String(err);
        log(`tagging ${card.name} threw (attempt ${attempt}/${ATTEMPTS}):`, reason);
        if (attempt < ATTEMPTS) await sleep(1500);
        continue;
      }

      const newVersion = readDeckVersion(res);
      if (res.ok) {
        if (newVersion !== null) write.version = newVersion;
        else write.version += 1;
        return { ok: true };
      }
      if (newVersion !== null) write.version = newVersion;

      let body = "";
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      log(
        `tagging ${card.name} failed (${res.status}, attempt ${attempt}/${ATTEMPTS}):`,
        body.slice(0, 300)
      );
      reason = `HTTP ${res.status}`;

      if (FATAL_STATUSES.has(res.status)) {
        return { ok: false, fatal: true, reason: describeStatus(res.status) };
      }
      if (res.status === 429) {
        if (attempt < ATTEMPTS) await sleep(retryAfterMs(res) ?? 5000);
        continue;
      }
      if (res.status === 409) {
        // The version-conflict path the API is designed around, and the only
        // failure a fresh deck read actually fixes — so it's the only one that
        // pays for a full deck fetch.
        if (attempt < ATTEMPTS) {
          if (!(await syncWriteState())) {
            return { ok: false, fatal: true, reason: "could not re-read the deck" };
          }
          await sleep(400);
        }
        continue;
      }
      // Any other 4xx is about this request; a retry sends the same thing.
      if (res.status < 500) return { ok: false, reason };
      if (attempt < ATTEMPTS) await sleep(400 * attempt);
    }
    return { ok: false, reason };
  }

  // For every card: append checked scryfall tags the card has onto its
  // existing author tags. Existing tags are never removed.
  // Cards that would gain no new tags are skipped.
  async function applyTags(selectedList) {
    if (state.applying) {
      return { updated: 0, skipped: 0, failed: 0, error: "already applying" };
    }
    state.applying = true;
    const summary = { updated: 0, skipped: 0, failed: 0 };
    try {
      const publicId = state.initializedFor;
      if (!publicId) {
        return { ...summary, error: "no initialized deck" };
      }
      const selected = new Set(selectedList.map(String));
      const token = await getAccessToken();
      if (!(await refreshDeckState(publicId))) {
        return { ...summary, error: "could not refresh deck" };
      }
      if (!state.cards.length || !state.write) {
        return { ...summary, error: "no initialized deck" };
      }

      let consecutiveFailures = 0;
      for (const card of state.cards) {
        const existing = (state.write.authorTags[card.name] ?? []).map(String);
        const existingSet = new Set(existing);
        const tags = [...existing];
        let added = false;

        for (const tag of card.scryfallTags) {
          if (!selected.has(tag) || existingSet.has(tag)) continue;
          tags.push(tag);
          existingSet.add(tag);
          added = true;
        }

        if (!added) {
          summary.skipped++;
          continue;
        }
        const result = await putCardTags(card, tags, token);
        if (result.ok) {
          state.write.authorTags[card.name] = tags;
          summary.updated++;
          consecutiveFailures = 0;
          log(`tagged ${card.name}:`, tags, `(deck version now ${state.write.version})`);
        } else {
          summary.failed++;
          if (result.fatal) {
            log("aborting apply:", result.reason);
            return { ...summary, error: result.reason };
          }
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            const abort = `stopped after ${consecutiveFailures} cards in a row failed (${result.reason})`;
            log("aborting apply:", abort);
            return { ...summary, error: abort };
          }
        }
        await sleep(250);
      }
      log("apply tags done:", summary);
      return summary;
    } catch (err) {
      log("apply tags error:", String(err));
      return { ...summary, error: String(err?.message ?? err) };
    } finally {
      state.applying = false;
      // Navigation was deferred while the run held state.write; catch up now.
      if (state.initializedFor !== currentDeckId()) onUrlChange();
    }
  }

  // ---- toolbar popup messaging ----
  // Only ever return plain JSON-serializable objects — Firefox throws
  // "not allowed to define cross-origin object as property" if a rejected
  // Promise carries a non-cloneable Error across this boundary.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "getState") {
      return Promise.resolve({
        deckId: state.initializedFor,
        deckName: state.decks.get(state.initializedFor)?.name ?? null,
        tagCounts: state.tagCounts.map(([tag, count]) => [tag, count]),
        selected: [...state.selectedTags],
        applying: state.applying,
      });
    }
    if (msg.type === "setSelectedTags") {
      if (!Array.isArray(msg.selected)) return Promise.resolve({ ok: false });
      state.selectedTags = new Set(msg.selected);
      log("selected tags:", [...state.selectedTags]);
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "applyTags") {
      if (!Array.isArray(msg.selected)) {
        return Promise.resolve({ ok: false, updated: 0, skipped: 0, failed: 0, error: "bad request" });
      }
      // A run outlives SPA navigation (see teardown), so remember which deck
      // it was for. Reloading whatever deck the user has since opened would be
      // unrelated collateral, and could interrupt its initialization.
      const startedOn = currentDeckId();
      return applyTags(msg.selected).then((summary) => {
        // Reload whenever anything was written — including a run that aborted
        // part-way, since the page is showing stale tags either way. The reload
        // fires the page's beforeunload handler, so Moxfield still guards
        // genuinely unsaved editor changes; a run that wrote nothing skips it.
        if (summary.updated > 0 && currentDeckId() === startedOn) {
          setTimeout(() => {
            // Re-check: the user can still navigate during the delay.
            if (currentDeckId() === startedOn) location.reload();
          }, 800);
        }
        return {
          ok: !summary.error,
          updated: summary.updated,
          skipped: summary.skipped,
          failed: summary.failed,
          error: summary.error ?? null,
        };
      });
    }
  });

  // ---- SPA navigation detection ----
  // Moxfield is a React app; the URL changes without page reloads.
  function onUrlChange() {
    if (state.initializedFor && state.initializedFor !== currentDeckId()) {
      log("left deck page", state.initializedFor);
      teardown();
    }
    maybeInitialize();
  }

  if (typeof navigation !== "undefined") {
    // Navigation API (Firefox 147+): fires for every URL change, including
    // the history.pushState calls React Router makes.
    navigation.addEventListener("currententrychange", onUrlChange);
  } else {
    // Older Firefox: no event covers pushState from outside the page's world,
    // so fall back to polling.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onUrlChange();
    }, 500);
  }

  // Cross-document back/forward: Firefox restores the page frozen from the
  // bfcache without re-running content scripts, so catch the restore event.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return; // normal load; the bottom maybeInitialize() handles it
    log("restored from back/forward cache, state:", {
      initializedFor: state.initializedFor,
      authenticated: state.authenticated,
    });
    onUrlChange();
  });

  maybeInitialize();
})();
