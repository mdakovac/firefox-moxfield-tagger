// Scryfall oracle-tag lookup.
// Tags come from the daily oracle_tags bulk file (https://scryfall.com/docs/api/bulk-data),
// which keys taggings by oracle_id. Moxfield cards only carry scryfall_id (a print
// ID), so we resolve those to oracle_ids via POST /cards/collection first.
//
// Loaded before content.js in the same content-script scope; exposes ScryfallTags.
const ScryfallTags = (() => {
  "use strict";

  const SCRYFALL_API = "https://api.scryfall.com";
  // Bump the suffix when the index format changes so stale caches are rebuilt.
  const INDEX_KEY = "oracleTagIndex@4";
  // Scryfall's API guidelines ask for 50-100ms between requests; enforced for
  // every API-host call by apiFetch below.
  const REQUEST_SPACING_MS = 100;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(...args) {
    console.log("[moxfield-tagger:scryfall]", ...args);
  }

  // ---- request scheduler ----
  // Every api.scryfall.com request goes through here, so the spacing holds no
  // matter how the callers are composed: getTags() deliberately runs the index
  // load and the id resolution concurrently, which would otherwise put the
  // bulk-metadata GET and the first /cards/collection POST on the wire at the
  // same instant. Requests are issued one at a time, REQUEST_SPACING_MS apart.
  //
  // The bulk file itself is not routed through here: it is served from a
  // separate CDN host, not the rate-limited API host, and serialising a ~17 MB
  // download behind this queue would stall every other request.
  let apiQueue = Promise.resolve();
  let lastRequestAt = 0;

  function apiFetch(path, init) {
    const result = apiQueue.then(async () => {
      const wait = REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      return fetch(`${SCRYFALL_API}${path}`, init);
    });
    // Keep the queue moving when a request fails; the caller still sees it.
    apiQueue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  // ---- cache (so the ~17 MB bulk file is downloaded once a day) ----
  // Deliberately browser.storage.local rather than indexedDB: a content
  // script's indexedDB belongs to the *page's* origin, so the index would live
  // in moxfield.com's storage bucket, where page scripts could read it, rewrite
  // it (and so choose the tags we write back onto the user's decks), or push
  // the site over its quota.
  async function cacheGet(key) {
    const stored = await browser.storage.local.get(key);
    return stored?.[key] ?? null;
  }

  const cachePut = (key, value) => browser.storage.local.set({ [key]: value });

  // Versions before 0.2.0 cached into page-origin indexedDB. Drop that copy so
  // the stale ~17 MB isn't left sitting in moxfield.com's quota. No-op once gone.
  try {
    indexedDB.deleteDatabase("moxfield-tagger");
  } catch (err) {
    log("could not remove legacy page-origin cache:", err);
  }

  // ---- gzipped JSONL reader ----
  // Bulk files are newline-delimited JSON served as application/gzip with no
  // Content-Encoding header, so the browser hands us the raw gzip bytes and we
  // have to inflate them ourselves. Records are handed to the caller one at a
  // time and never collected here: the decompressed file is ~18 MB of text and
  // several times that once parsed into objects, and this all runs inside the
  // page's content process.
  async function streamJsonl(url, onRecord) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bulk file download failed (${res.status})`);
    if (!res.body) throw new Error("bulk file response had no body");
    const reader = res.body
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream())
      .getReader();

    let buffer = "";
    const flush = (upTo) => {
      for (const line of buffer.slice(0, upTo).split("\n")) {
        if (line.trim()) onRecord(JSON.parse(line));
      }
      buffer = buffer.slice(upTo);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      // Only parse up to the last complete line; keep the partial tail.
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline !== -1) flush(lastNewline + 1);
    }
    flush(buffer.length);
  }

  // ---- oracle_id -> [tag labels] index ----
  let indexPromise = null; // memoized per page load

  function getTagIndex() {
    indexPromise ??= loadTagIndex().catch((err) => {
      indexPromise = null; // allow retry on a later deck
      throw err;
    });
    return indexPromise;
  }

  async function loadTagIndex() {
    const metaRes = await apiFetch("/bulk-data/oracle_tags", {
      headers: { Accept: "application/json" },
    });
    if (!metaRes.ok) throw new Error(`bulk-data meta request failed (${metaRes.status})`);
    const meta = await metaRes.json();

    let cached = null;
    try {
      cached = await cacheGet(INDEX_KEY);
    } catch (err) {
      log("cache read failed (continuing without):", err);
    }
    if (cached && cached.updatedAt === meta.updated_at) {
      const index = new Map(cached.indexEntries);
      log(`using cached oracle tag index (${index.size} cards, ${meta.updated_at})`);
      return index;
    }

    log(`downloading oracle tags bulk file (${(meta.compressed_size / 1e6).toFixed(1)} MB gzipped)…`);

    // Keep only the two things the index needs. A tag record also carries the
    // full tagging objects (status, timestamps, ids); holding those for every
    // tagging in the file is what makes this expensive, so they're dropped as
    // each line arrives.
    const hierarchy = new Map(); // tag id -> { label, parentIds }
    const taggedOracleIds = new Map(); // tag id -> [oracle_id]
    let tagCount = 0;
    await streamJsonl(meta.jsonl_download_uri, (tag) => {
      tagCount++;
      hierarchy.set(tag.id, { label: tag.label, parentIds: tag.parent_ids ?? [] });
      const oracleIds = [];
      for (const tagging of tag.taggings ?? []) oracleIds.push(tagging.oracle_id);
      taggedOracleIds.set(tag.id, oracleIds);
    });

    // A tagging implies the tag itself plus all its ancestors in the tag
    // hierarchy (Tagger shows these as "inherited" tags), so expand each tag
    // to its full label set up front.
    //
    // Walked breadth-first rather than by recursive descent so that a cycle in
    // the hierarchy can't leave a half-computed label set memoized: every tag
    // gets the labels of everything reachable from it, whatever order the tags
    // are resolved in.
    const labelSets = new Map(); // tag id -> Set of labels (own + ancestors)
    function labelsFor(tagId) {
      const known = labelSets.get(tagId);
      if (known) return known;
      const labels = new Set();
      const seen = new Set();
      const queue = [tagId];
      while (queue.length) {
        const id = queue.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const node = hierarchy.get(id);
        if (!node) continue; // parent_id pointing outside the file
        labels.add(node.label);
        for (const parentId of node.parentIds) queue.push(parentId);
      }
      labelSets.set(tagId, labels);
      return labels;
    }

    const sets = new Map(); // oracle_id -> Set of labels
    for (const [tagId, oracleIds] of taggedOracleIds) {
      const labels = labelsFor(tagId);
      for (const oracleId of oracleIds) {
        let set = sets.get(oracleId);
        if (!set) sets.set(oracleId, (set = new Set()));
        for (const label of labels) set.add(label);
      }
    }
    const index = new Map(); // oracle_id -> sorted [tag labels]
    for (const [oracleId, set] of sets) index.set(oracleId, [...set].sort());
    log(`built oracle tag index: ${tagCount} tags across ${index.size} cards`);

    try {
      await cachePut(INDEX_KEY, {
        updatedAt: meta.updated_at,
        indexEntries: [...index.entries()],
      });
    } catch (err) {
      log("cache write failed (continuing without):", err);
    }
    return index;
  }

  // ---- scryfall_id -> oracle_id ----
  async function resolveOracleIds(scryfallIds) {
    const result = new Map();
    const BATCH = 75; // API limit for /cards/collection
    for (let i = 0; i < scryfallIds.length; i += BATCH) {
      const batch = scryfallIds.slice(i, i + BATCH);
      const res = await apiFetch("/cards/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ identifiers: batch.map((id) => ({ id })) }),
      });
      if (!res.ok) throw new Error(`cards/collection request failed (${res.status})`);
      const json = await res.json();
      for (const card of json.data ?? []) result.set(card.id, card.oracle_id);
      if (json.not_found?.length) {
        log("cards unknown to Scryfall:", json.not_found.map((x) => x.id));
      }
    }
    return result;
  }

  // ---- public API ----
  // scryfallIds: array of scryfall_id strings.
  // Returns Map scryfall_id -> [tag labels] (untagged/unknown cards map to []).
  async function getTags(scryfallIds) {
    const unique = [...new Set(scryfallIds)];
    const [index, oracleIds] = await Promise.all([getTagIndex(), resolveOracleIds(unique)]);
    const result = new Map();
    for (const id of unique) {
      const oracleId = oracleIds.get(id);
      result.set(id, (oracleId && index.get(oracleId)) || []);
    }
    return result;
  }

  return { getTags };
})();
