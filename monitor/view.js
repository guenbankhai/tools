const { modelColor, quotaColor, dimColor, colors } = require('./palette.js');
const { EFFECT_SPEED } = require('./config.js');
if (!Number.isFinite(EFFECT_SPEED) || EFFECT_SPEED <= 0) throw new Error('EFFECT_SPEED must be a positive number.');
const transferDuration = 3000, spawnInterval = 500 / EFFECT_SPEED;
const usageKeys = ['input', 'cached', 'cacheWrite', 'output', 'total'];
const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function formatTokens(value) {
  if (!validNumber(value)) return 'Unavailable';
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
  return String(Math.round(value));
}
function timestamp(value) {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function elapsed(start, end) {
  const from = timestamp(start), to = timestamp(end);
  if (from == null || to == null || to < from) return 'Unavailable';
  const seconds = Math.floor((to - from) / 1000);
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map(n => String(n).padStart(2, '0')).join(':');
}
const isArchived = node => ['Completed', 'Unknown'].includes(node.status) || (node.status === 'Idle' && node.model == null);
// Agents shown in the tree; quota is only relevant for a provider that has one.
const inTree = node => node.hasActivity !== false && !isArchived(node);
function buildView(snapshot, now = Date.now(), previous = {}) {
  const warnings = [...(snapshot.warnings ?? [])];
  const nodes = (snapshot.nodes ?? []).filter(node => node.hasActivity !== false).map(node => {
    const usage = Object.fromEntries(usageKeys.map(key => [key, validNumber(node.usage?.[key]) ? node.usage[key] : null]));
    const color = modelColor(node.model);
    const end = ['Completed', 'Failed'].includes(node.status) ? node.endedAt
      : ['Unknown', 'Idle'].includes(node.status) ? node.lastSeenAt : now;
    const knownMix = usageKeys.slice(0, 4).reduce((sum, key) => sum + (usage[key] ?? 0), 0);
    const usageSegments = ['Input', 'Cache read', 'Cache write', 'Output'].map((label, index) => {
      const key = usageKeys[index], value = usage[key];
      return { key, label, value, valueLabel: formatTokens(value), color: colors[key],
        fraction: value == null ? null : knownMix ? value / knownMix : 0 };
    });
    const sourceId = String(node.sourceId || node.id);
    const idLabel = sourceId.length > 12 ? sourceId.slice(0, 8) + '…' : sourceId;
    return { ...node, usage, idLabel, modelLabel: node.model ?? 'Unknown model', nameLabel: node.name || node.sourceId || node.id,
      statusLabel: node.status, color, displayColor: node.status === 'Completed' ? dimColor(color) : color,
      completed: node.status === 'Completed', archived: isArchived(node),
      tokenLabel: formatTokens(usage.total), usageSegments,
      elapsedLabel: elapsed(node.startedAt, end), activityElapsedLabel: elapsed(node.activityStartedAt, end) };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId != null && !byId.has(node.parentId)) {
      warnings.push(`Parent unavailable for ${node.id}; shown as a root.`);
      node.parentId = null;
    }
  }
  const checked = new Set();
  for (const node of nodes) {
    const chain = [], index = new Map();
    let current = node;
    while (current && !checked.has(current.id)) {
      if (index.has(current.id)) {
        const cycle = chain.slice(index.get(current.id));
        warnings.push(`Cyclic ancestry: ${cycle.map(item => item.id).join(', ')}; shown as roots.`);
        for (const item of cycle) item.parentId = null;
        break;
      }
      index.set(current.id, chain.length);
      chain.push(current);
      current = byId.get(current.parentId);
    }
    for (const item of chain) checked.add(item.id);
  }
  const displayOrder = [...nodes].sort((a, b) => Number(b.status === 'Running') - Number(a.status === 'Running')
    || (b.usage.total ?? -1) - (a.usage.total ?? -1));
  const roots = displayOrder.filter(node => node.parentId == null).map(node => node.id);
  const edges = displayOrder.filter(node => node.parentId != null).map(node => ({ from: node.parentId, to: node.id }));
  const totals = { nodeCount: nodes.length, coverage: {} };
  for (const key of usageKeys) {
    const known = nodes.map(node => node.usage[key]).filter(validNumber);
    totals[key] = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
    totals.coverage[key] = known.length;
  }
  totals.label = formatTokens(totals.total);
  totals.partial = totals.coverage.total < nodes.length;
  if (totals.partial) warnings.push(`Partial token total: usage available for ${totals.coverage.total}/${nodes.length} agents.`);
  const quotas = (snapshot.quotas ?? []).filter(quota => nodes.some(node => node.provider === quota.provider && !node.archived)).map(quota => ({ ...quota, label: String(quota.provider).toUpperCase(), windows: quota.windows.map(window => {
    const reset = timestamp(typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : window.resetsAt);
    return { ...window, label: window.minutes === 300 ? '5h' : window.minutes === 10080 ? '7d' : `${window.minutes}m`,
      percentLabel: validNumber(window.percent) ? `${Math.round(window.percent)}% used` : 'Unavailable',
      resetLabel: reset == null ? '' : `Resets ${new Date(reset).toLocaleString()}`,
      ageLabel: timestamp(window.updatedAt) == null ? 'Update time unavailable' : `${Math.floor(Math.max(0, now - window.updatedAt) / 60000)}m ago`,
      color: quotaColor(window.percent) };
  }) }));
  const transfers = (snapshot.transfers ?? []).filter(transfer => {
    const at = timestamp(transfer.at);
    return at != null && now >= at && now - at < transferDuration && byId.has(transfer.from) && byId.has(transfer.to);
  }).map(transfer => ({ ...transfer, color: byId.get(transfer.from).color, progress: (now - timestamp(transfer.at)) / transferDuration, duration: transferDuration }));
  const flows = new Map();
  const addFlow = flow => {
    const at = timestamp(flow.at), until = timestamp(flow.until);
    const from = byId.get(flow.from), to = byId.get(flow.to);
    if (from && to && !(from.archived && !from.completed) && !(to.archived && !to.completed)
      && at != null && now >= at && (until == null || now < until + transferDuration)) {
      flows.set(flow.id, { ...flow, color: from.color, duration: transferDuration, spawnInterval });
    }
  };
  for (const node of nodes) if (node.parentId && node.status === 'Running' && !byId.get(node.parentId)?.archived) {
    const id = `processing:${node.parentId}:${node.id}`;
    const prior = previous.processingFlows?.find(flow => flow.id === id && flow.until == null);
    addFlow({ id, from: node.parentId, to: node.id, at: prior?.at ?? node.activityStartedAt ?? node.startedAt ?? new Date(now).toISOString(), until: null });
  }
  for (const flow of previous.processingFlows ?? []) if (!flows.has(flow.id)) {
    addFlow({ ...flow, until: flow.until ?? new Date(now).toISOString() });
  }
  for (const transfer of snapshot.transfers ?? []) {
    const at = timestamp(transfer.at);
    if (at != null) addFlow({ ...transfer, until: new Date(at + transferDuration).toISOString() });
  }
  for (const node of nodes) if (node.parentId && ['Waiting', 'Idle', 'Completed'].includes(node.status)) {
    const at = node.endedAt ?? node.activityStartedAt ?? node.lastSeenAt;
    if (timestamp(at) != null && !(snapshot.transfers ?? []).some(transfer => transfer.from === node.id && transfer.to === node.parentId && transfer.kind === 'Result' && transfer.at === at)) {
      addFlow({ id: `returning:${node.id}:${at}`, from: node.id, to: node.parentId, at, until: new Date(timestamp(at) + transferDuration).toISOString() });
    }
  }
  const processingFlows = [...flows.values()].filter(flow => flow.id.startsWith('processing:'));
  return { view: { project: snapshot.project, logDir: snapshot.logDir, collectedAt: snapshot.collectedAt,
    nodes, roots, edges, transfers, flows: [...flows.values()], quotas, totals, warnings, completedCount: nodes.filter(node => node.completed).length }, memory: { ...previous, processingFlows } };
}
module.exports = { buildView, inTree, formatTokens, modelColor, quotaColor, dimColor };
