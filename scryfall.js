// Scryfall oracle-tag lookup.
// Tags come from the daily oracle_tags bulk file (https://scryfall.com/docs/api/bulk-data),
// which keys taggings by oracle_id. Moxfield cards only carry scryfall_id (a print
// ID), so we resolve those to oracle_ids via POST /cards/collection first.
//
// Loaded before content.js in the same content-script scope; exposes ScryfallTags.
const ScryfallTags = (() => {
  "use strict";

  const SCRYFALL_API = "https://api.scryfall.com";
  const DB_NAME = "moxfield-tagger";
  const DB_STORE = "scryfall";
  // Bump the suffix when the index format changes so stale caches are rebuilt.
  const INDEX_KEY = "oracleTagIndex@3";

  function log(...args) {
    console.log("[moxfield-tagger:scryfall]", ...args);
  }

  // ---- IndexedDB cache (so the ~17 MB bulk file is downloaded once a day) ----
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbRequest(mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const req = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  const cacheGet = (key) => dbRequest("readonly", (store) => store.get(key));
  const cachePut = (key, value) => dbRequest("readwrite", (store) => store.put(value, key));

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
    const metaRes = await fetch(`${SCRYFALL_API}/bulk-data/oracle_tags`, {
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

    log(`downloading oracle tags bulk file (${(meta.size / 1e6).toFixed(1)} MB)…`);
    const res = await fetch(meta.download_uri);
    if (!res.ok) throw new Error(`bulk file download failed (${res.status})`);
    const tags = await res.json();

    // A tagging implies the tag itself plus all its ancestors in the tag
    // hierarchy (Tagger shows these as "inherited" tags), so expand each tag
    // to its full label set up front.
    const byId = new Map(tags.map((t) => [t.id, t]));
    const labelSets = new Map(); // tag id -> Set of labels (own + ancestors)
    function labelsFor(tagId, visiting = new Set()) {
      const known = labelSets.get(tagId);
      if (known) return known;
      const labels = new Set();
      const tag = byId.get(tagId);
      if (tag && !visiting.has(tagId)) {
        visiting.add(tagId);
        labels.add(tag.label);
        for (const parentId of tag.parent_ids ?? []) {
          for (const label of labelsFor(parentId, visiting)) labels.add(label);
        }
      }
      labelSets.set(tagId, labels);
      return labels;
    }

    const sets = new Map(); // oracle_id -> Set of labels
    for (const tag of tags) {
      const labels = labelsFor(tag.id);
      for (const tagging of tag.taggings ?? []) {
        let set = sets.get(tagging.oracle_id);
        if (!set) sets.set(tagging.oracle_id, (set = new Set()));
        for (const label of labels) set.add(label);
      }
    }
    const index = new Map(); // oracle_id -> sorted [tag labels]
    for (const [oracleId, set] of sets) index.set(oracleId, [...set].sort());
    log(`built oracle tag index: ${tags.length} tags across ${index.size} cards`);

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
      const res = await fetch(`${SCRYFALL_API}/cards/collection`, {
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
