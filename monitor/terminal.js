const { colors } = require('./palette.js');
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
function sanitize(value) {
  return String(value ?? '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
}
function characterWidth(text) {
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(text)) return 0;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Unified_Ideograph}\u20e3\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(text) ? 2 : 1;
}
function displayWidth(text) {
  return [...graphemes.segment(sanitize(text))].reduce((sum, part) => sum + characterWidth(part.segment), 0);
}
function foreground(color, mode) {
  if (mode === 'none') return '';
  const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
  return mode === '256' ? `\x1b[38;5;${16 + 36 * Math.round(rgb[0] / 51) + 6 * Math.round(rgb[1] / 51) + Math.round(rgb[2] / 51)}m`
    : `\x1b[38;2;${rgb.join(';')}m`;
}
function paint(segments, width, mode) {
  let result = '', used = 0;
  for (const [text, color = colors.text] of segments) {
    let part = '';
    for (const item of graphemes.segment(sanitize(text))) {
      const size = characterWidth(item.segment);
      if (used + size > width) return result + (part ? foreground(color, mode) + part + (mode === 'none' ? '' : '\x1b[0m') : '');
      part += item.segment; used += size;
    }
    if (part) result += foreground(color, mode) + part + (mode === 'none' ? '' : '\x1b[0m');
  }
  return result;
}
function tokenBar(node, length) {
  const known = node.usageSegments.filter(segment => segment.fraction != null);
  if (!known.length) return [['Unavailable', colors.unknown]];
  let used = 0;
  return node.usageSegments.map(segment => {
    const target = Math.round((used + (segment.fraction ?? 0)) * length);
    const count = target - Math.round(used * length);
    used += segment.fraction ?? 0;
    return ['━'.repeat(Math.max(0, count)), segment.color];
  });
}
function flowArrows(flows, parentId, childId, width, now) {
  const arrows = [];
  for (const flow of flows) {
    if (!((flow.from === parentId && flow.to === childId) || (flow.to === parentId && flow.from === childId))) continue;
    const at = Date.parse(flow.at), until = flow.until == null ? Infinity : Date.parse(flow.until);
    const first = Math.max(0, Math.floor((now - flow.duration - at) / flow.spawnInterval) + 1);
    const last = Math.min(Math.floor((now - at) / flow.spawnInterval), Math.ceil((until - at) / flow.spawnInterval) - 1);
    const outbound = flow.from === parentId;
    for (let step = 0; step < width - 1; step++) {
      const ordinal = Math.min(last, Math.floor((now - at - step * flow.duration / (width - 1)) / flow.spawnInterval));
      if (ordinal < first) continue;
      const emittedAt = at + ordinal * flow.spawnInterval;
      const progress = (now - emittedAt) / flow.duration;
      if (Math.floor(progress * (width - 1)) !== step) continue;
      const index = outbound ? 1 + step : width - 1 - step;
      arrows.push({ index, text: outbound ? '→' : '←', color: flow.color, emittedAt });
    }
  }
  const cells = new Map();
  for (const arrow of arrows.sort((a, b) => b.emittedAt - a.emittedAt)) {
    if (!cells.has(arrow.index)) cells.set(arrow.index, arrow);
  }
  return cells;
}
function renderFrame(view, { cols = 100, rows = 30, colors: mode = 'truecolor', now = Date.now(), scroll = { offset: 0 } } = {}) {
  cols = Math.max(1, Math.floor(cols)); rows = Math.max(1, Math.floor(rows));
  const content = [], add = segments => content.push({ segments });
  const header = [{ segments: [[`AGENT MONITOR  ${view.project ?? ''}`, colors.text]] }];
  if (rows > 8) for (const quota of view.quotas) for (const window of quota.windows) {
    const count = window.percent == null ? 0 : Math.round(Math.max(0, Math.min(100, window.percent)) / 10);
    const bar = window.percent == null ? 'Unavailable' : `${'━'.repeat(count)}${'─'.repeat(10 - count)}`;
    header.push({ segments: [[`${quota.label} ${window.label} `, colors.text], [`[${bar}] ${window.percentLabel}`, window.color],
      [`  ${window.resetLabel}  ${window.ageLabel}`, colors.wire]] });
  }
  const unresolved = node => node.status === 'Unknown' || (node.status === 'Idle' && node.modelLabel === 'Unknown model');
  const unknownIds = new Set(view.nodes.filter(unresolved).map(node => node.id));
  const flows = (view.flows ?? []).filter(flow => {
    const at = Date.parse(flow.at), until = flow.until == null ? Infinity : Date.parse(flow.until);
    return !unknownIds.has(flow.from) && !unknownIds.has(flow.to) && Number.isFinite(at) && now >= at && Number.isFinite(flow.duration) && flow.duration > 0
      && Number.isFinite(flow.spawnInterval) && flow.spawnInterval > 0 && now < until + flow.duration;
  });
  const flowingIds = new Set(flows.flatMap(flow => [flow.from, flow.to]));
  const graphNodes = view.nodes.filter(node => !unresolved(node) && (!node.completed || flowingIds.has(node.id))).sort((a, b) =>
    Number(b.status === 'Running') - Number(a.status === 'Running') || (b.usage.total ?? -1) - (a.usage.total ?? -1));
  const graphIds = new Set(graphNodes.map(node => node.id));
  const completed = view.nodes.filter(node => unresolved(node) || (node.completed && !flowingIds.has(node.id))).sort((a, b) =>
    Number(unresolved(a)) - Number(unresolved(b)) || (b.usage.total ?? -1) - (a.usage.total ?? -1));
  const children = new Map(graphNodes.map(node => [node.id, []]));
  const byId = new Map(view.nodes.map(node => [node.id, node]));
  for (const node of graphNodes) children.get(node.parentId)?.push(node.id);
  const branchWidth = Math.min(12, Math.max(4, cols - 42));
  const stack = graphNodes.filter(node => !graphIds.has(node.parentId)).reverse().map(node => ({ id: node.id, prefix: '', last: true, root: true }));
  while (stack.length) {
    const item = stack.pop(), node = byId.get(item.id);
    if (!node) continue;
    const sourceId = node.idLabel || node.sourceId || node.id;
    const label = `[${sourceId}] ${node.statusLabel} ${node.elapsedLabel}  ${node.completed ? `${node.tokenLabel} tokens · ${node.modelLabel} · ` : ''}${node.nameLabel}`;
    const wire = item.root ? '' : (item.last ? '└' : '├') + '─'.repeat(branchWidth - 2) + ' ';
    const maxIndent = Math.max(0, cols - 42);
    const prefix = item.prefix.length > maxIndent ? (maxIndent >= 2 ? '⋮ ' + item.prefix.slice(-(maxIndent - 2)) : '') : item.prefix;
    const wireSegments = [[prefix, colors.wire]];
    const arrows = item.root ? new Map() : flowArrows(flows, node.parentId, node.id, branchWidth, now);
    for (let index = 0; index < wire.length; index++) {
      const arrow = arrows.get(index);
      wireSegments.push(arrow ? [arrow.text, arrow.color] : [wire[index], colors.wire]);
    }
    const indent = prefix + (item.root ? '' : item.last ? ' '.repeat(branchWidth) : '│' + ' '.repeat(branchWidth - 1));
    const boxWidth = cols - displayWidth(indent);
    const innerWidth = Math.max(0, boxWidth - 4);
    const boxLine = segments => {
      if (boxWidth < 4) { add([[indent, colors.wire], ...segments]); return; }
      let remaining = innerWidth;
      const clipped = segments.map(([text, color]) => {
        const part = paint([[text]], remaining, 'none');
        remaining -= displayWidth(part);
        return [part, color];
      });
      add([[indent, colors.wire], ['│ ', node.displayColor], ...clipped,
        [' '.repeat(remaining), colors.text], [' │', node.displayColor]]);
    };
    if (boxWidth >= 4) add([...wireSegments, ['┌' + '─'.repeat(boxWidth - 2) + '┐', node.displayColor]]);
    boxLine([[['Running', 'Waiting'].includes(node.status) ? '● ' : '○ ', node.displayColor], [label, node.displayColor]]);
    boxLine([[`${node.modelLabel} · ${node.provider ?? 'Unknown provider'}`, node.displayColor]]);
    boxLine([[`Activity: ${node.activity || 'Unknown'} · ${node.activityElapsedLabel}`, colors.text]]);
    if (node.detail) boxLine([[node.detail, colors.wire]]);
    boxLine([[`Tokens: ${node.tokenLabel} [`, colors.text], ...tokenBar(node, Math.min(24, Math.max(4, innerWidth - 30))), [']', colors.text]]);
    boxLine(node.usageSegments.flatMap(segment => [[`${segment.label} ${segment.valueLabel}  `, segment.color]]));
    if (boxWidth >= 4) add([[indent, colors.wire], ['└' + '─'.repeat(boxWidth - 2) + '┘', node.displayColor]]);
    const descendants = children.get(node.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) stack.push({ id: descendants[index],
      prefix: item.root ? '' : item.prefix + (item.last ? ' '.repeat(branchWidth) : '│' + ' '.repeat(branchWidth - 1)), last: index === descendants.length - 1, root: false });
  }
  if (!graphNodes.length) add([[view.nodes.length ? 'No active agents.' : 'No agent sessions found. Waiting for source events.', colors.unknown]]);
  const footer = [{ segments: [[`Total tokens: ${view.totals.label}${view.totals.partial ? ' known (partial)' : ''} · ${view.totals.coverage.total}/${view.totals.nodeCount} agents · Completed: ${view.completedCount}`, colors.text]] }];
  if (view.webUrl) footer.push({ segments: [[`Web: ${view.webUrl}`, colors.text]] });
  if (rows >= 6) footer.push({ segments: [[`Logs: ${view.logDir ?? 'Unavailable'}`, colors.wire]] });
  if (rows >= 10) for (const warning of view.warnings.slice(0, 2)) footer.push({ segments: [[`Warning: ${warning}`, colors.yellow]] });
  const fixedFooter = footer.slice(0, rows);
  const fixedHeader = header.slice(0, Math.max(0, rows - fixedFooter.length - (completed.length ? 4 : 2)));
  const available = Math.max(0, rows - fixedHeader.length - fixedFooter.length);
  const tableVisible = completed.length > 0 && available >= 4;
  const treeMinimum = Math.min(4, Math.max(1, available - 3));
  const tableCapacity = tableVisible ? Math.min(5, completed.length, available - treeMinimum - 2) : 0;
  const treeAvailable = available - (tableVisible ? tableCapacity + 2 : 0);
  const showScroll = content.length > treeAvailable && treeAvailable > 1;
  const capacity = treeAvailable - (showScroll ? 1 : 0);
  scroll.offset = Math.max(0, Math.min(Math.floor(scroll.offset || 0), Math.max(0, content.length - capacity)));
  scroll.pageSize = Math.max(1, capacity);
  scroll.totalLines = content.length;
  const visible = content.slice(scroll.offset, scroll.offset + capacity);
  const padding = Array.from({ length: capacity - visible.length }, () => ({ segments: [] }));
  const position = showScroll ? [{ segments: [[`Lines ${scroll.offset + 1}-${scroll.offset + visible.length} / ${content.length} · ↑/↓ PgUp/PgDn Home/End${scroll.section !== 'completed' ? ' · [Tree]' : ''}`, colors.unknown]] }] : [];
  const table = [];
  scroll.completed ??= { offset: 0 };
  scroll.completed.offset = Math.max(0, Math.min(Math.floor(scroll.completed.offset || 0), Math.max(0, completed.length - tableCapacity)));
  scroll.completed.pageSize = Math.max(1, tableCapacity);
  scroll.completed.totalLines = completed.length;
  if (tableVisible) {
    const offset = scroll.completed.offset;
    const range = completed.length > tableCapacity ? ` · Rows ${offset + 1}-${offset + tableCapacity} / ${completed.length}` : '';
    const unknownCount = completed.filter(unresolved).length;
    table.push({ segments: [[`Completed (${completed.length - unknownCount})${unknownCount ? ` · Unknown (${unknownCount})` : ''}${range} · ${scroll.section === 'completed' ? '[Active] ' : ''}Tab: switch scroll`, colors.text]] });
    const nameWidth = Math.max(5, Math.floor((cols - 68) / 2)), modelWidth = Math.max(5, cols - 68 - nameWidth);
    const widths = [nameWidth, modelWidth, 12, 11, 11, 11, 11];
    const cells = entries => entries.flatMap(([value, color], index) => {
      const text = paint([[value]], widths[index], 'none');
      return [[text + ' '.repeat(widths[index] - displayWidth(text)), color], ...(index < widths.length - 1 ? [['  ', colors.wire]] : [])];
    });
    table.push({ segments: cells(['Agent', 'Model', 'Total tokens', 'Input', 'Cache read', 'Cache write', 'Output'].map(label => [label, colors.wire])) });
    for (const node of completed.slice(offset, offset + tableCapacity)) {
      const name = `[${node.idLabel || node.sourceId || node.id}] ${node.nameLabel}`;
      const suffix = node.status === 'Unknown' ? ' (Unknown)' : unresolved(node) ? ' (Unknown model)' : '';
      const label = suffix ? `${paint([[name]], Math.max(0, nameWidth - suffix.length), 'none')}${suffix}` : name;
      table.push({ segments: cells([[label, node.color], [node.modelLabel, node.color],
        [node.tokenLabel, colors.text], ...node.usageSegments.map(segment => [segment.valueLabel, segment.color])]) });
    }
  }
  return [...fixedHeader, ...visible, ...padding, ...position, ...table, ...fixedFooter].map(line => paint(line.segments, cols, mode)).join('\n');
}
module.exports = { renderFrame, displayWidth, sanitize };
