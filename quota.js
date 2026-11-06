// Read-only one-shot quota/session summary for repository agents.
const { createCollector } = require('./monitor/data.js');
const { buildView } = require('./monitor/view.js');
async function render() {
  const collector = createCollector();
  collector.poll();
  await collector.quotaReady();
  const { view } = buildView(collector.poll(), Date.now());
  const lines = view.quotas.map(q => q.label + '  ' + q.windows.map(w => [w.label, w.percentLabel, w.resetLabel, w.ageLabel].filter(Boolean).join(' | ')).join('  '));
  for (const n of view.nodes) lines.push(`${n.provider} ${n.id} | ${n.modelLabel} | ${n.status} | ${n.tokenLabel} tokens`);
  lines.push(`Total known tokens: ${view.totals.label}`);
  return lines.join('\n');
}
if (require.main === module) {
  if (process.argv.includes('--watch')) { console.error('--watch was removed; use node <tools-folder>/monitor.js'); process.exitCode = 1; }
  else render().then(console.log, error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { render };
