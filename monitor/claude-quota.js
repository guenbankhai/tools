const fs = require('node:fs');
const path = require('node:path');

// Claude Code writes quota to no local file; this endpoint (the one /usage uses) serves CLI and VS Code alike.
// It is undocumented, so every failure degrades to the last valid reading plus a warning.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_MS = 3 * 60 * 1000;
const RETRY_LIMITED_MS = 10 * 60 * 1000;
const WINDOWS = ['five_hour', 'seven_day'];

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data)); fs.renameSync(temp, file);
}
const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// A window missing from a newer reply (seen when a limit is hit) must not erase a reading that has not reset yet.
function mergeWindows(previous, body, at) {
  const result = {};
  for (const key of WINDOWS) {
    const next = body?.[key], old = previous?.[key];
    if (validPercent(next?.utilization)) result[key] = { utilization: next.utilization, resets_at: next.resets_at ?? null, at };
    else if (old && Date.parse(old.resets_at) > at) result[key] = old;
  }
  return result;
}

function createClaudeQuota({ claudeDir, monitorHome, fetch = globalThis.fetch }) {
  const cacheFile = path.join(monitorHome, 'quotas', 'claude-usage.json');
  let pending = null;
  function token(at) {
    const oauth = readJson(path.join(claudeDir, '.credentials.json'))?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string') throw new Error('Claude login not found (OAuth credentials are required)');
    // shortcut: an expired token is not refreshed here; Claude Code refreshes it on its next request.
    if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= at) throw new Error('Claude token expired; it refreshes when Claude Code next runs');
    return oauth.accessToken;
  }
  async function fetchUsage(at, cache) {
    try {
      const response = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token(at)}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        const wait = response.status === 429 ? RETRY_LIMITED_MS : REFRESH_MS;
        throw Object.assign(new Error(response.status === 429 ? 'usage endpoint rate-limited' : `usage endpoint returned HTTP ${response.status}`), { wait });
      }
      writeJson(cacheFile, { windows: mergeWindows(cache?.windows, await response.json(), at), checkedAt: at, nextAt: at + REFRESH_MS, error: null });
    } catch (error) {
      writeJson(cacheFile, { windows: mergeWindows(cache?.windows, null, at), checkedAt: at, nextAt: at + (error.wait ?? REFRESH_MS), error: error.message });
    }
  }
  // The cache file is shared, so several monitors and quota.js runs make at most one request per interval.
  function refresh(at = Date.now()) {
    const cache = readJson(cacheFile);
    if (pending || (Number.isFinite(cache?.nextAt) && at < cache.nextAt && at >= cache.checkedAt)) return pending ?? Promise.resolve();
    pending = fetchUsage(at, cache).catch(() => {}).finally(() => { pending = null; });
    return pending;
  }
  function current() {
    const cache = readJson(cacheFile);
    return { limits: cache?.windows ?? null, error: cache?.error ?? null };
  }
  return { refresh, current };
}
module.exports = { createClaudeQuota, mergeWindows, USAGE_URL };
