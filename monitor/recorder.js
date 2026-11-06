const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { activeProjects, contains } = require('./registry.js');
const { toolDetails, iso } = require('./transcript.js');

function recordHook(payload, { provider, home, now = new Date().toISOString() } = {}) {
  if (!['claude', 'codex'].includes(provider) || typeof payload?.session_id !== 'string' || typeof payload.cwd !== 'string' || typeof payload.hook_event_name !== 'string') return false;
  const projects = activeProjects(home).filter(p => p.roots.some(root => typeof root === 'string' && contains(root, payload.cwd)));
  if (!projects.length) return false;
  const hook = payload.hook_event_name, child = hook === 'SubagentStart' || hook === 'SubagentStop';
  const agent = typeof payload.agent_id === 'string' ? payload.agent_id : null;
  const sourceId = agent ? provider === 'claude' ? `${payload.session_id}:${agent}` : agent : payload.session_id;
  const nodeId = `${provider}:${sourceId}`;
  const explicitParent = typeof payload.parent_agent_id === 'string' ? payload.parent_agent_id : null;
  const normalizedParent = explicitParent == null || explicitParent === payload.session_id ? `${provider}:${payload.session_id}`
    : explicitParent.startsWith(provider + ':') ? explicitParent
    : provider === 'claude' ? `claude:${payload.session_id}:${explicitParent}` : `codex:${explicitParent}`;
  const parentId = child ? normalizedParent : null;
  const names = { SessionStart: 'Session started', SessionEnd: 'Session ended', UserPromptSubmit: 'Turn started', PreToolUse: 'Tool started', PostToolUse: 'Tool finished', PostToolUseFailure: 'Tool failed', SubagentStart: 'Agent started', SubagentStop: 'Agent completed', Stop: 'Turn completed', Notification: 'Notification', PreModelRequest: 'Model request started', PostModelRequest: 'Model request finished' };
  if (!names[hook]) return false;
  const event = { id: crypto.randomUUID(), origin: 'recorder', provider, nodeId, sourceId, sessionId: payload.session_id, at: iso(payload.timestamp) ?? now,
    recordedAt: now, timeBasis: iso(payload.timestamp) ? 'source' : 'recorder', kind: names[hook], cwd: payload.cwd,
    ...(parentId ? { parentId } : {}), ...(typeof payload.parent_agent_id === 'string' ? { parentAgentId: payload.parent_agent_id } : {}),
    ...(typeof payload.agent_type === 'string' ? { name: payload.agent_type } : {}),
    ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
    source: { type: 'hook', event: hook }, ...(typeof payload.tool_use_id === 'string' ? { callId: payload.tool_use_id } : {}) };
  if (typeof payload.tool_name === 'string') Object.assign(event, toolDetails(payload.tool_name, payload.tool_input));
  if (hook === 'PostToolUseFailure') event.error = typeof payload.error === 'string' ? payload.error : 'Tool reported an error';
  if (hook === 'PostToolUse') {
    const r = payload.tool_response;
    event.status = r?.is_error || (typeof r?.exit_code === 'number' && r.exit_code !== 0) ? 'Failed' : 'Completed';
    if (typeof r?.exit_code === 'number') event.exitCode = r.exit_code;
  }
  if (child && agent) Object.assign(event, { from: hook === 'SubagentStart' ? parentId : nodeId, to: hook === 'SubagentStart' ? nodeId : parentId, transferKind: hook === 'SubagentStart' ? 'Dispatch' : 'Result' });
  for (const project of projects) {
    // One collector owns the journal. Hooks hand over atomic event files instead of racing appends.
    const inbox = path.join(project.logDir, '.inbox'); fs.mkdirSync(inbox, { recursive: true });
    const file = path.join(inbox, event.id + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(event)); fs.renameSync(file + '.tmp', file);
  }
  return true;
}
if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    // Observation must never inject context or make the agent retry a tool.
    try { recordHook(JSON.parse(raw), { provider: process.argv[2] }); } catch {}
  });
}
module.exports = { recordHook };
