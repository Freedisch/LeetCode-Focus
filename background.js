// background.js (Manifest V3)

// ---- constants ----
const REDIRECT_TARGET = "https://leetcode.com/";

const SOCIAL_MEDIA_DOMAINS = [
  { id: 1, urlFilter: "||x.com/" },
  { id: 2, urlFilter: "||twitter.com/" },
  { id: 3, urlFilter: "||instagram.com/" },
  { id: 4, urlFilter: "||facebook.com/" }
];
const SOCIAL_RULE_IDS = SOCIAL_MEDIA_DOMAINS.map((d) => d.id);

const defaultSettings = {
  dailyTarget: 1,
  mode: "any" // kept for future; redirect target is stable root
};

// ---- utilities ----
function todayKey() {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    timeZone: "UTC"
  });
  return dtf.format(new Date());
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["settings", "progress", "breakUntil"], (v) => {
      resolve({
        settings: v.settings || defaultSettings,
        progress: v.progress || {},
        breakUntil: v.breakUntil || null
      });
    });
  });
}

async function setState(patch) {
  return new Promise((resolve) => chrome.storage.local.set(patch, resolve));
}

function isOnBreak(breakUntil) {
  return breakUntil && Date.now() < breakUntil;
}

// ---- DNR rule updater (loop-safe) ----
async function updateBlockRule() {
  const { settings, progress, breakUntil } = await getState();
  const key = todayKey();
  const count = (progress[key]?.count) || 0;
  const quotaMet = count >= settings.dailyTarget;
  const onBreak = isOnBreak(breakUntil);
  const shouldBlock = !(quotaMet || onBreak);

  if (shouldBlock) {
    const addRules = SOCIAL_MEDIA_DOMAINS.map(({ id, urlFilter }) => ({
      id,
      priority: 1,
      action: { type: "redirect", redirect: { url: REDIRECT_TARGET } },
      condition: { resourceTypes: ["main_frame"], urlFilter }
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: SOCIAL_RULE_IDS,
      addRules
    });
  } else {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: SOCIAL_RULE_IDS
    });
  }

  await updateBadge();
}

async function updateBadge() {
  const { settings, progress, breakUntil } = await getState();
  const key = todayKey();
  const count = (progress[key]?.count) || 0;
  const onBreak = isOnBreak(breakUntil);

  let text = `${count}/${settings.dailyTarget}`;
  if (onBreak) text = "⏸";

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({
    color: onBreak
      ? "#777777"
      : count >= settings.dailyTarget
      ? "#2E7D32"
      : "#D32F2F"
  });
}

// ---- lifecycle ----
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getState();
  await setState({ settings: settings || defaultSettings });
  await updateBlockRule();
});

chrome.runtime.onStartup.addListener(updateBlockRule);

// ---- messages from content / popup / options ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "markSolved") {
      const slug = msg.slug;
      const isDaily = msg.isDaily || false;
      if (!slug) return;

      const state = await getState();
      const key = todayKey();
      const day = state.progress[key] || { solvedSlugs: [], count: 0 };

      // Check mode
      const mode = state.settings.mode || "any";
      
      // If in daily mode, only count if it's the daily challenge
      if (mode === "daily" && !isDaily) {
        console.log("[LeetCode Focus] Daily mode active - only daily challenge counts");
        sendResponse({ ok: false, reason: "daily-only", count: day.count });
        return;
      }

      if (!day.solvedSlugs.includes(slug)) {
        day.solvedSlugs.push(slug);
        day.count += 1;
        state.progress[key] = day;
        await setState({ progress: state.progress });
        await updateBlockRule();
      }
      sendResponse({ ok: true, count: state.progress[key].count });
      return;
    }

    if (msg.type === "getState") {
      const state = await getState();
      const key = todayKey();
      const count = (state.progress[key]?.count) || 0;
      sendResponse({
        settings: state.settings,
        breakUntil: state.breakUntil,
        today: { key, count }
      });
      return;
    }

    if (msg.type === "setSettings") {
      const settings = msg.settings || defaultSettings;
      await setState({ settings });
      await updateBlockRule();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "startBreak") {
      const ms = Math.max(0, msg.ms || 0);
      const until = Date.now() + ms;
      await setState({ breakUntil: until });
      chrome.alarms.create("breakOver", { when: until });
      await updateBlockRule();
      sendResponse({ ok: true, breakUntil: until });
      return;
    }

    if (msg.type === "endBreak") {
      await setState({ breakUntil: null });
      await updateBlockRule();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "manualMarkOne") {
      const state = await getState();
      const key = todayKey();
      const day = state.progress[key] || { solvedSlugs: [], count: 0 };
      day.count += 1;
      state.progress[key] = day;
      await setState({ progress: state.progress });
      await updateBlockRule();
      sendResponse({ ok: true, count: day.count });
      return;
    }
  })();
  return true; // keep channel open
});

// ---- alarms ----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "breakOver") {
    await setState({ breakUntil: null });
    await updateBlockRule();
  }
});

// ---- guard: refresh rules when tabs change ----
chrome.tabs.onActivated.addListener(updateBlockRule);
chrome.tabs.onCreated.addListener(updateBlockRule);
chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, _tab) => updateBlockRule());
