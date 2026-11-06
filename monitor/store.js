const fs = require('node:fs');
const path = require('node:path');
const { sumUsage } = require('./transcript.js');

const timeFields = new Set(['at', 'recordedAt', 'collectedAt', 'updatedAt', 'startedAt', 'endedAt', 'lastSeenAt', 'activityStartedAt', 'resetsAt']);
function localLogTime(key, value) {
  if (!timeFields.has(key) || value == null) return value;
  const date = new Date(typeof value === 'number' && key === 'resetsAt' ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return value;
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const eventFile = path.join(dir, 'events.jsonl'), resultFile = path.join(dir, 'result.json');
  const seen = new Set(), recoveryWarnings = [];
  if (!fs.existsSync(eventFile)) fs.closeSync(fs.openSync(eventFile, 'a'));
  const bytes = fs.readFileSync(eventFile);
  if (bytes.length && bytes[bytes.length - 1] !== 10) {
    const start = bytes.lastIndexOf(10) + 1, tail = bytes.subarray(start);
    try { JSON.parse(tail.toString('utf8')); fs.appendFileSync(eventFile, '\n'); }
    catch {
      const recovered = `${eventFile}.recovered-${Date.now()}`;
      fs.writeFileSync(recovered, tail, { flag: 'wx' });
      fs.truncateSync(eventFile, start);
      recoveryWarnings.push(`Recovered an incomplete final event; original bytes preserved in ${recovered}.`);
    }
  }
  if (fs.existsSync(eventFile)) for (const line of fs.readFileSync(eventFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.id) seen.add(e.id); }
    catch { throw new Error(`Event log contains an incomplete or invalid record: ${eventFile}. Preserve it before repairing the last line.`); }
  }
  function update(snapshot) {
    const fresh = (snapshot.events ?? []).filter(e => !seen.has(e.id)).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    if (fresh.length) {
      const records = fresh.map(e => ({ ...e, recordedAt: snapshot.collectedAt }));
      fs.appendFileSync(eventFile, records.map(e => JSON.stringify(e, localLogTime)).join('\n') + '\n');
      for (const e of records) seen.add(e.id);
    }
    const byId = new Map(snapshot.nodes.map(n => [n.id, n]));
    function rootOf(node) {
      const visited = new Set(); let current = node;
      while (current.parentId && byId.has(current.parentId) && !visited.has(current.id)) { visited.add(current.id); current = byId.get(current.parentId); }
      return visited.has(current.id) ? node.id : current.id;
    }
    const groups = new Map();
    for (const node of snapshot.nodes) { const root = rootOf(node); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(node); }
    const result = { project: snapshot.project, updatedAt: snapshot.collectedAt,
      sessions: [...groups].map(([id, members]) => {
        const root = byId.get(id);
        const end = root.endedAt ?? (['Running', 'Waiting'].includes(root.status) ? snapshot.collectedAt : root.lastSeenAt);
        const span = root.startedAt && end ? Date.parse(end) - Date.parse(root.startedAt) : NaN;
        const models = new Map();
        for (const member of members) for (const [model, usage] of Object.entries(member.byModelUsage ?? {})) { if (!models.has(model)) models.set(model, []); models.get(model).push(usage); }
        return { id, provider: root.provider, model: root.model ?? null,
          models: [...new Set(members.flatMap(n => n.models ?? (n.model ? [n.model] : [])))],
          status: root.status, startedAt: root.startedAt ?? null, endedAt: root.endedAt ?? null,
          lastSeenAt: root.lastSeenAt ?? null, elapsedSpanMs: Number.isFinite(span) && span >= 0 ? span : null, agentCount: members.length,
          usage: sumUsage(members.map(n => n.usage)),
          byModelUsage: Object.fromEntries([...models].map(([model, usages]) => [model, sumUsage(usages)])),
          usageCoverage: { known: members.filter(n => n.usage.total != null).length, total: members.length },
          main: { id: root.id, usage: root.usage },
          agents: members.filter(n => n.id !== id).map(n => ({ id: n.id, parentId: n.parentId, provider: n.provider, model: n.model, status: n.status, usage: n.usage })),
          turns: members.reduce((n, m) => n + (m.turns ?? 0), 0), tools: members.reduce((n, m) => n + (m.toolCount ?? 0), 0) };
      }), quotas: snapshot.quotas ?? [], warnings: [...recoveryWarnings, ...(snapshot.warnings ?? [])] };
    const temp = `${resultFile}.${process.pid}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(result, localLogTime, 2) + '\n'); fs.renameSync(temp, resultFile); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return result;
  }
  return { update, eventFile, resultFile };
}
module.exports = { createStore };
