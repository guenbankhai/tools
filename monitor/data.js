const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createTranscript, iso, emptyUsage } = require('./transcript.js');
const { LOG_PATH } = require('./config.js');
const { createClaudeQuota } = require('./claude-quota.js');
const { inTree } = require('./view.js');

function list(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function stat(file) { try { return fs.statSync(file); } catch { return null; } }
function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function files(dir) { return list(dir).flatMap(e => e.isDirectory() && !e.isSymbolicLink() ? files(path.join(dir, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []); }
function canonical(dir) { try { return fs.realpathSync(dir).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(); } catch { return path.resolve(dir).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(); } }
function belongs(cwd, roots) { if (typeof cwd !== 'string') return false; const c = canonical(cwd); return roots.some(r => c === r || c.startsWith(r + '/')); }
function worktreePaths(project) {
  try { return execFileSync('git', ['-C', project, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).split(/\r?\n/).filter(s => s.startsWith('worktree ')).map(s => s.slice(9)); }
  catch { return [project]; }
}
function quotaWindows(provider, limits, updatedAt) {
  let windows;
  if (provider === 'claude') windows = [limits?.five_hour, limits?.seven_day];
  else {
    windows = [limits?.primary, limits?.secondary].filter(w => Number.isFinite(w?.window_minutes)).sort((a, b) => a.window_minutes - b.window_minutes);
    if (windows.length === 1) windows = windows[0].window_minutes <= 1440 ? [windows[0], null] : [null, windows[0]];
  }
  return [300, 10080].map((minutes, i) => {
    const w = windows[i], percent = w?.utilization ?? w?.used_percent;
    // Providers can report past 100 once a limit is hit; that is a full window, not missing data.
    return { minutes, percent: Number.isFinite(percent) && percent >= 0 ? Math.min(percent, 100) : null, resetsAt: w?.resets_at ?? null, updatedAt: w?.at ?? updatedAt ?? null };
  });
}

function createCollector(options = {}) {
  const project = path.resolve(options.project ?? process.cwd());
  const roots = (options.worktrees ?? worktreePaths(project)).concat(project).map(canonical);
  const claudeDir = options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const codexDir = options.codexDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const monitorHome = options.monitorHome ?? process.env.AGENT_MONITOR_HOME ?? path.join(os.homedir(), '.agent-monitor');
  const logDir = path.join(path.resolve(options.logPath ?? (LOG_PATH || process.cwd())), '.log', 'monitor');
  const readers = new Map(), warnings = new Set(), hookNodes = new Map(), toolCalls = new Map(), transfers = new Map();
  let discoveredAt = 0, latestCodexQuota = null, quotaPending = Promise.resolve();
  const quotaFiles = new Map();
  const pendingFiles = new Map();
  const claudeQuota = createClaudeQuota({ claudeDir, monitorHome, fetch: options.fetch });
  const hookLifecycle = new Map();

  function readAccountQuota(candidates) {
    const newest = candidates.map(file => ({ file, info: stat(file) })).filter(e => e.info).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 10);
    for (const { file, info } of newest) {
      if (quotaFiles.get(file) === info.mtimeMs) continue;
      quotaFiles.set(file, info.mtimeMs);
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        // shortcut: quota search examines the last 1 MiB of ten recent rollouts; expand if rate-limit records move farther back.
        const buffer = Buffer.alloc(Math.min(info.size, 1024 * 1024));
        fs.readSync(fd, buffer, 0, buffer.length, info.size - buffer.length);
        const lines = buffer.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"rate_limits"')) continue;
          let record; try { record = JSON.parse(lines[i]); } catch { continue; }
          if (record.type === 'event_msg' && record.payload?.type === 'token_count' && (record.payload.rate_limits?.primary || record.payload.rate_limits?.secondary) && iso(record.timestamp)) {
            if (!latestCodexQuota || Date.parse(record.timestamp) > Date.parse(latestCodexQuota.at)) latestCodexQuota = { limits: record.payload.rate_limits, at: record.timestamp };
            break;
          }
        }
      } catch {} finally { if (fd != null) fs.closeSync(fd); }
    }
  }

  function discover() {
    const candidates = [...files(path.join(codexDir, 'sessions')).map(file => [file, 'codex']),
      ...files(path.join(claudeDir, 'projects')).map(file => [file, 'claude'])];
    readAccountQuota(candidates.filter(([, provider]) => provider === 'codex').map(([file]) => file));
    for (const [file, provider] of candidates) if (!readers.has(file)) readers.set(file, { provider, offset: 0, pending: Buffer.alloc(0), parser: createTranscript(provider, file), excluded: false, inode: null });
  }
  function acceptHook(e) {
    if (e.origin !== 'recorder' || !['claude', 'codex'].includes(e.provider) || typeof e.nodeId !== 'string' || typeof e.sourceId !== 'string' || e.nodeId !== `${e.provider}:${e.sourceId}` || typeof e.kind !== 'string' || !belongs(e.cwd, roots) || !iso(e.at)) return false;
    let n = hookNodes.get(e.nodeId);
    if (!n) {
      n = { id: e.nodeId, sourceId: e.sourceId, provider: e.provider, parentId: null, name: null, model: null, models: [], status: 'Unknown', activity: 'Unknown', detail: '', startedAt: e.at, endedAt: null, lastSeenAt: null, activityStartedAt: null, usage: emptyUsage(), turns: 0, toolCount: 0, hasActivity: false };
      hookNodes.set(n.id, n);
    }
    if (['Turn started', 'Model request started', 'Model request finished', 'Tool started', 'Tool finished', 'Tool failed', 'Agent started', 'Turn completed', 'Agent completed'].includes(e.kind)) n.hasActivity = true;
    if (e.at < n.startedAt) n.startedAt = e.at;
    if (e.model && !n.models.includes(e.model)) n.models.push(e.model);
    const newer = !n.lastSeenAt || Date.parse(e.at) >= Date.parse(n.lastSeenAt);
    if (e.parentId && (newer || n.parentId == null)) n.parentId = e.parentId;
    if (e.name && (newer || n.name == null)) n.name = e.name;
    if (newer) {
      if (e.model) n.model = e.model;
      n.lastSeenAt = e.at;
      if (e.kind === 'Session started') { n.status = 'Idle'; n.endedAt = null; n.activity = 'Idle'; hookLifecycle.set(n.id, { kind: e.kind, at: e.at }); }
      if (['Turn started', 'Model request started', 'Tool started', 'Tool finished', 'Tool failed', 'Agent started'].includes(e.kind)) {
        n.status = 'Running'; n.endedAt = null; n.activity = e.activity ?? 'Model processing';
        hookLifecycle.set(n.id, { kind: e.kind, at: e.at });
      }
      if (e.kind === 'Turn completed') { n.status = n.parentId ? 'Completed' : 'Idle'; n.activity = n.status; if (n.parentId) n.endedAt = e.at; hookLifecycle.set(n.id, { kind: e.kind, at: e.at }); }
      if (['Agent completed', 'Session ended'].includes(e.kind)) { n.status = 'Completed'; n.endedAt = e.at; n.activity = 'Completed'; hookLifecycle.set(n.id, { kind: e.kind, at: e.at }); }
      n.activityStartedAt = e.at; n.detail = e.command ?? e.target ?? e.tool ?? '';
    }
    const lifecycle = hookLifecycle.get(n.id);
    if (n.parentId && lifecycle?.kind === 'Turn completed') { n.status = 'Completed'; n.activity = 'Completed'; n.endedAt = lifecycle.at; }
    if (e.kind === 'Tool started' && e.callId) { if (!toolCalls.has(e.nodeId)) toolCalls.set(e.nodeId, new Set()); toolCalls.get(e.nodeId).add(e.callId); }
    if (e.from && e.to && e.transferKind) transfers.set(e.id, { id: e.id, from: e.from, to: e.to, kind: e.transferKind, at: e.at });
    return true;
  }
  function read(file, reader, pendingEvents) {
    const info = stat(file); if (!info || reader.excluded) return;
    if (info.size < reader.offset || (reader.inode != null && info.ino !== reader.inode)) {
      warnings.add(`Source replaced or truncated: ${file}. Usage is limited to the current source.`);
      reader.offset = 0; reader.pending = Buffer.alloc(0); reader.parser = createTranscript(reader.provider, file);
    }
    reader.inode = info.ino;
    if (info.size === reader.offset) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(Math.min(256 * 1024, info.size - reader.offset));
      while (reader.offset < info.size) {
        const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, info.size - reader.offset), reader.offset);
        if (!n) break;
        const data = Buffer.concat([reader.pending, buffer.subarray(0, n)]);
        let start = 0;
        for (let i = 0; i < data.length; i++) if (data[i] === 10) {
          const offset = reader.offset - reader.pending.length + start;
          const line = data.subarray(start, i).toString('utf8').trim(); start = i + 1;
          if (reader.skipping) { reader.skipping = false; continue; }
          if (!line) continue;
          try {
            const record = JSON.parse(line);
            if (!record || typeof record !== 'object') throw new Error('Not an object');
            if (reader.provider === 'recorder') { acceptHook(record); continue; }
            const events = reader.parser.accept(record, offset);
            if (reader.parser.cwd && !belongs(reader.parser.cwd, roots)) { reader.excluded = true; break; }
            pendingEvents.push(...events);
          } catch { warnings.add(`Unreadable JSONL record at ${file}:${offset}. The record was skipped.`); }
        }
        reader.offset += n;
        reader.pending = reader.skipping ? Buffer.alloc(0) : data.subarray(start);
        if (reader.pending.length > 16 * 1024 * 1024) {
          warnings.add(`Oversized JSONL record in ${file}; records larger than 16 MiB are not collected.`);
          reader.pending = Buffer.alloc(0); reader.skipping = true;
        }
        if (reader.excluded) break;
      }
    } catch (error) { warnings.add(`Cannot read ${file}: ${error.code ?? error.message}`); }
    finally { if (fd != null) fs.closeSync(fd); }
  }

  function poll(now = Date.now()) {
    if (!discoveredAt || now - discoveredAt >= 5000) { discover(); discoveredAt = now; }
    const events = [];
    for (const [file, reader] of readers) if (reader.provider !== 'recorder') read(file, reader, events);
    const hookFile = path.join(logDir, 'events.jsonl');
    if (!readers.has(hookFile)) readers.set(hookFile, { provider: 'recorder', offset: 0, pending: Buffer.alloc(0), excluded: false, inode: null });
    read(hookFile, readers.get(hookFile), events);
    const inbox = list(path.join(logDir, '.inbox')).filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(file => { const full = path.join(logDir, '.inbox', file.name); return { full, event: json(full) }; })
      .sort((a, b) => String(a.event?.at ?? '').localeCompare(String(b.event?.at ?? '')));
    for (const { full, event } of inbox) {
      if (!event || typeof event.id !== 'string' || event.origin !== 'recorder') { warnings.add(`Invalid recorder event: ${full}. Left untouched.`); continue; }
      if (!pendingFiles.has(event.id)) {
        if (!acceptHook(event)) { warnings.add(`Invalid recorder event fields: ${full}. Left untouched.`); continue; }
        pendingFiles.set(event.id, { file: full, event });
      }
    }
    events.push(...[...pendingFiles.values()].map(e => e.event));
    const byId = new Map([...hookNodes].map(([id, node]) => [id, structuredClone(node)])), sourceWarnings = [];
    for (const reader of readers.values()) {
      if (reader.provider === 'recorder' || reader.excluded || !reader.parser.node.id || !belongs(reader.parser.cwd, roots)) continue;
      const n = structuredClone(reader.parser.node);
      if (reader.parser.warning) sourceWarnings.push(reader.parser.warning);
      const hook = hookNodes.get(n.id);
      if (hook) {
        n.hasActivity ||= hook.hasActivity;
        n.parentId ??= hook.parentId; n.name ??= hook.name;
        if (Date.parse(hook.lastSeenAt) >= Date.parse(n.lastSeenAt ?? 0)) {
          Object.assign(n, { status: hook.status, activity: hook.activity, activityStartedAt: hook.activityStartedAt, detail: hook.detail, endedAt: hook.endedAt, lastSeenAt: hook.lastSeenAt });
          if (hook.model) n.model = hook.model;
        }
      }
      byId.set(n.id, n);
      const q = reader.parser.quota;
      if (q && (!latestCodexQuota || Date.parse(q.at) > Date.parse(latestCodexQuota.at))) latestCodexQuota = q;
    }
    const nodes = [...byId.values()];
    const pluginStates = options.pluginStates ?? [path.join(claudeDir, 'plugins/data/codex-openai-codex/state'), path.join(os.tmpdir(), 'codex-companion')];
    for (const base of pluginStates) for (const entry of list(base)) {
      const state = json(path.join(base, entry.name, 'state.json'));
      for (const job of Array.isArray(state?.jobs) ? state.jobs : []) {
        if (typeof job.threadId !== 'string' || typeof job.sessionId !== 'string') continue;
        const child = byId.get(`codex:${job.threadId}`), parent = byId.get(`claude:${job.sessionId}`);
        if (!child || !parent || child.parentId) continue;
        child.parentId = parent.id;
        if (iso(job.createdAt)) transfers.set(`plugin:${job.id}:dispatch`, { id: `plugin:${job.id}:dispatch`, from: parent.id, to: child.id, kind: 'Dispatch', at: iso(job.createdAt) });
        if (job.status === 'completed' && iso(job.completedAt)) transfers.set(`plugin:${job.id}:result`, { id: `plugin:${job.id}:result`, from: child.id, to: parent.id, kind: 'Result', at: iso(job.completedAt) });
      }
    }
    for (const n of nodes) if (['Running', 'Waiting'].includes(n.status) && (!n.lastSeenAt || now - Date.parse(n.lastSeenAt) > 120000)) { n.status = 'Unknown'; n.activity = 'Unknown (source inactive)'; }
    const ids = new Set(nodes.map(n => n.id));
    const accepted = events.filter(e => ids.has(e.nodeId));
    const rootOf = id => {
      const visited = new Set(); let current = byId.get(id);
      while (current?.parentId && byId.has(current.parentId) && !visited.has(current.id)) {
        visited.add(current.id); current = byId.get(current.parentId);
      }
      return current?.id;
    };
    // Source call IDs deduplicate tools reported by both a transcript and a hook.
    for (const e of accepted) {
      if (e.toAgentPath && !byId.has(e.to)) {
        const root = rootOf(e.from);
        const receiver = nodes.find(n => rootOf(n.id) === root && (n.agentPath === e.toAgentPath || (e.toAgentPath === '/root' && n.id === root)));
        if (receiver) e.to = receiver.id;
      }
      if (e.kind === 'Tool started' && e.callId) { if (!toolCalls.has(e.nodeId)) toolCalls.set(e.nodeId, new Set()); toolCalls.get(e.nodeId).add(e.callId); }
      if (e.from && e.to && e.transferKind) transfers.set(e.id, { id: e.id, from: e.from, to: e.to, kind: e.transferKind, at: e.at });
    }
    for (const n of nodes) if (toolCalls.has(n.id)) n.toolCount = toolCalls.get(n.id).size;
    while (transfers.size > 256) transfers.delete(transfers.keys().next().value);
    if (nodes.some(n => n.provider === 'claude' && inTree(n))) quotaPending = claudeQuota.refresh(now);
    const claude = claudeQuota.current();
    if (claude.error) sourceWarnings.push(`Claude quota: ${claude.error}`);
    return { project, logDir, collectedAt: new Date(now).toISOString(), nodes, events: accepted, transfers: [...transfers.values()],
      quotas: [ { provider: 'claude', windows: quotaWindows('claude', claude.limits, null) },
        { provider: 'codex', windows: quotaWindows('codex', latestCodexQuota?.limits, latestCodexQuota?.at ? Date.parse(latestCodexQuota.at) : null) } ],
      warnings: [...warnings, ...sourceWarnings, ...(!nodes.length ? ['No matching local sessions found. Start an agent in this project; new sessions are discovered automatically.'] : [])] };
  }
  function acknowledge() {
    for (const [id, entry] of pendingFiles) { fs.unlinkSync(entry.file); pendingFiles.delete(id); }
  }
  return { poll, acknowledge, quotaReady: () => quotaPending, logDir, project, roots };
}
module.exports = { createCollector, quotaWindows, belongs, canonical };
