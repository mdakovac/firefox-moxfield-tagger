// Toolbar popup: shows the current deck's scryfall tags as a searchable
// checkbox list. State lives in the content script; we read/write via messages.
(async () => {
  "use strict";

  const headerEl = document.getElementById("header");
  const applyEl = document.getElementById("apply");
  const selectedTagsEl = document.getElementById("selected-tags");
  const deckNameEl = document.getElementById("deck-name");
  const searchEl = document.getElementById("search");
  const tagsEl = document.getElementById("tags");
  const statusEl = document.getElementById("status");

  function showStatus(text) {
    statusEl.textContent = text;
    statusEl.classList.remove("hidden");
    headerEl.classList.add("hidden");
    tagsEl.classList.add("hidden");
  }

  let tabId = null;
  let applyingPoll = null;
  let getSelectedCount = () => 0;

  function stopApplyingPoll() {
    if (applyingPoll !== null) {
      clearInterval(applyingPoll);
      applyingPoll = null;
    }
  }

  function syncApplyButton(applying) {
    applyEl.disabled = applying || getSelectedCount() === 0;
    applyEl.textContent = applying ? "Applying…" : "Apply Tags";
  }

  function renderSelectedTags(selected, tagCounts, checkboxes, syncSelected) {
    const tags = tagCounts.map(([tag]) => tag).filter((tag) => selected.has(tag));
    selectedTagsEl.replaceChildren(
      ...tags.map((tag) => {
        const chip = document.createElement("span");
        chip.className = "selected-tag";

        const name = document.createElement("span");
        name.className = "selected-tag-name";
        name.textContent = tag;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "selected-tag-remove";
        remove.setAttribute("aria-label", `Remove ${tag}`);
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          selected.delete(tag);
          const checkbox = checkboxes.get(tag);
          if (checkbox) checkbox.checked = false;
          syncSelected();
        });

        chip.append(name, remove);
        return chip;
      })
    );
  }

  function watchApplying() {
    stopApplyingPoll();
    applyingPoll = setInterval(async () => {
      try {
        const fresh = await browser.tabs.sendMessage(tabId, { type: "getState" });
        if (!fresh?.applying) {
          stopApplyingPoll();
          syncApplyButton(false);
        }
      } catch {
        stopApplyingPoll();
      }
    }, 500);
  }

  async function loadState() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("no active tab");
    tabId = tab.id;
    // Throws if the content script isn't running in this tab (not moxfield.com).
    return browser.tabs.sendMessage(tabId, { type: "getState" });
  }

  function render(state) {
    deckNameEl.textContent = state.deckName || "Moxfield Tagger";
    const selected = new Set(state.selected);
    const checkboxes = new Map();
    getSelectedCount = () => selected.size;

    function syncSelected() {
      renderSelectedTags(selected, state.tagCounts, checkboxes, syncSelected);
      syncApplyButton(false);
      browser.tabs.sendMessage(tabId, { type: "setSelectedTags", selected: [...selected] });
    }

    tagsEl.replaceChildren(
      ...state.tagCounts.map(([tag, count]) => {
        const label = document.createElement("label");
        label.dataset.tag = tag.toLowerCase();

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(tag);
        checkboxes.set(tag, checkbox);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(tag);
          else selected.delete(tag);
          syncSelected();
        });

        const name = document.createElement("span");
        name.className = "tag-name";
        name.textContent = tag;

        const countEl = document.createElement("span");
        countEl.className = "tag-count";
        countEl.textContent = count;

        label.append(checkbox, name, countEl);
        return label;
      })
    );

    applyEl.addEventListener("click", async () => {
      if (selected.size === 0) return;
      syncApplyButton(true);
      let resultText;
      try {
        const reply = await browser.tabs.sendMessage(tabId, {
          type: "applyTags",
          selected: [...selected],
        });
        if (!reply?.ok) {
          resultText = reply?.error ?? "Apply failed";
        } else {
          resultText = `Updated ${reply.updated}, skipped ${reply.skipped}`;
          if (reply.failed) resultText += `, failed ${reply.failed}`;
        }
      } catch (err) {
        console.error("applyTags failed:", err);
        resultText = `Failed: ${String(err?.message ?? err)}`.slice(0, 80);
      }
      applyEl.textContent = resultText;
      setTimeout(() => syncApplyButton(false), 3000);
    });

    searchEl.addEventListener("input", () => {
      const query = searchEl.value.trim().toLowerCase();
      for (const label of tagsEl.children) {
        label.classList.toggle("hidden", !label.dataset.tag.includes(query));
      }
    });

    renderSelectedTags(selected, state.tagCounts, checkboxes, syncSelected);

    statusEl.classList.add("hidden");
    headerEl.classList.remove("hidden");
    tagsEl.classList.remove("hidden");
    syncApplyButton(state.applying);
    if (state.applying) watchApplying();
    searchEl.focus();
  }

  try {
    const state = await loadState();
    if (!state?.deckId) {
      showStatus("Open a Moxfield deck page to see its tags.");
    } else if (!state.tagCounts.length) {
      showStatus("Tags are still loading (or this deck has none). Try again in a moment.");
    } else {
      render(state);
    }
  } catch {
    showStatus("Open a Moxfield deck page to see its tags.");
  }
})();
