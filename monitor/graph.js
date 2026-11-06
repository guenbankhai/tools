(function (root) {
  function layoutGraph(view, orientation = 'Horizontal') {
    const vertical = orientation === 'Vertical', gap = 28, levelGap = 84, margin = 28;
    const byId = new Map(view.nodes.map(node => [node.id, node]));
    const children = new Map(view.nodes.map(node => [node.id, []]));
    for (const edge of view.edges) if (byId.has(edge.from) && byId.has(edge.to)) children.get(edge.from).push(edge.to);
    const order = [], seen = new Set(), roots = [], levels = [];
    const visit = id => {
      const stack = [{ id, depth: 0 }];
      while (stack.length) {
        const item = stack.pop();
        if (seen.has(item.id) || !byId.has(item.id)) continue;
        seen.add(item.id); order.push(item);
        levels[item.depth] = Math.max(levels[item.depth] ?? 0, vertical ? 216 : 332);
        const next = children.get(item.id);
        for (let index = next.length - 1; index >= 0; index--) stack.push({ id: next[index], depth: item.depth + 1 });
      }
    };
    for (const id of [...view.roots, ...byId.keys()]) if (!seen.has(id)) { roots.push(id); visit(id); }
    const extents = new Map();
    for (const item of [...order].reverse()) {
      const size = vertical ? 332 : 216;
      const next = children.get(item.id).filter(id => extents.has(id));
      extents.set(item.id, Math.max(size, next.reduce((sum, id) => sum + extents.get(id), 0) + Math.max(0, next.length - 1) * gap));
    }
    const offsets = [margin];
    for (let index = 0; index < levels.length; index++) offsets.push(offsets[index] + levels[index] + levelGap);
    const starts = new Map();
    let offset = margin;
    for (const id of roots) { starts.set(id, offset); offset += extents.get(id) + gap * 2; }
    const positions = new Map(), nodes = [];
    for (const item of order) {
      const height = 216, width = 332;
      const breadth = vertical ? width : height;
      const center = (starts.get(item.id) ?? margin) + extents.get(item.id) / 2;
      const position = { id: item.id, x: vertical ? center - breadth / 2 : offsets[item.depth],
        y: vertical ? offsets[item.depth] : center - breadth / 2, width, height };
      positions.set(item.id, position); nodes.push(position);
      const next = children.get(item.id);
      const total = next.reduce((sum, id) => sum + (extents.get(id) ?? 0), 0) + Math.max(0, next.length - 1) * gap;
      let childOffset = center - total / 2;
      for (const id of next) { starts.set(id, childOffset); childOffset += (extents.get(id) ?? 0) + gap; }
    }
    const wires = view.edges.filter(edge => positions.has(edge.from) && positions.has(edge.to)).map(edge => {
      const a = positions.get(edge.from), b = positions.get(edge.to);
      const start = vertical ? [a.x + a.width / 2, a.y + a.height] : [a.x + a.width, a.y + a.height / 2];
      const end = vertical ? [b.x + b.width / 2, b.y] : [b.x, b.y + b.height / 2];
      const mid = vertical ? (start[1] + end[1]) / 2 : (start[0] + end[0]) / 2;
      return { ...edge, key: JSON.stringify([edge.from, edge.to]), path: vertical
        ? `M${start[0]} ${start[1]} C${start[0]} ${mid} ${end[0]} ${mid} ${end[0]} ${end[1]}`
        : `M${start[0]} ${start[1]} C${mid} ${start[1]} ${mid} ${end[1]} ${end[0]} ${end[1]}` };
    });
    return { nodes, wires, width: Math.max(400, ...nodes.map(node => node.x + node.width + margin)),
      height: Math.max(160, ...nodes.map(node => node.y + node.height + margin)) };
  }
  if (typeof module === 'object' && module.exports) module.exports = { layoutGraph };
  else root.AgentMonitorGraph = { layoutGraph };
})(typeof globalThis === 'object' ? globalThis : this);
