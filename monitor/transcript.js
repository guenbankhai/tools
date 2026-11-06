const crypto = require('node:crypto');
const path = require('node:path');

const emptyUsage = () => ({ input: null, cached: null, cacheWrite: null, output: null, total: null });
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const iso = value => value != null && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = value => typeof value === 'string' ? value : null;

function codexUsage(u) {
  if (!u || typeof u !== 'object') return emptyUsage();
  const input = count(u.input_tokens), cached = count(u.cached_input_tokens), write = count(u.cache_write_input_tokens);
  const fresh = input != null && cached != null && input >= cached ? input - cached : null;
  // Cache-write accounting varies by version; leave fresh input unavailable if it cannot be reconciled.
  return { input: fresh != null && (write == null || fresh >= write) ? fresh - (write ?? 0) : null,
    cached, cacheWrite: write, output: count(u.output_tokens), total: count(u.total_tokens) };
}
function claudeUsage(u) {
  const result = { input: count(u?.input_tokens), cached: count(u?.cache_read_input_tokens), cacheWrite: count(u?.cache_creation_input_tokens), output: count(u?.output_tokens), total: null };
  if (Object.values(result).slice(0, 4).every(n => n != null)) result.total = result.input + result.cached + result.cacheWrite + result.output;
  return result;
}
function sumUsage(usages) {
  const rows = [...usages];
  return Object.fromEntries(Object.keys(emptyUsage()).map(key => [key, rows.length && rows.every(u => u[key] != null) ? count(rows.reduce((n, u) => n + u[key], 0)) : null]));
}
function argumentsOf(value) {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}
function toolDetails(name, input) {
  name = typeof name === 'string' ? name : 'Unknown tool';
  const args = argumentsOf(input), lower = name.toLowerCase();
  const command = text(args.cmd) ?? text(args.command);
  let target = text(args.file_path) ?? text(args.path) ?? text(args.filename);
  if (!target && /patch/i.test(name) && typeof input === 'string') {
    target = [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]).join(', ') || null;
  }
  const activity = /read|search|find|grep|glob|browse|web/.test(lower) ? 'Reading / searching'
    : /write|edit|patch/.test(lower) ? 'Writing / editing'
    : /spawn|agent|send_message|followup/.test(lower) ? 'Delegating / receiving'
    : 'Running tool';
  return { activity, tool: name, ...(target ? { target } : {}), ...(command ? { command } : {}) };
}

function createTranscript(provider, file) {
  const node = { id: '', sourceId: '', provider, parentId: null, name: null, model: null, models: [], byModelUsage: {}, status: 'Unknown', activity: 'Unknown', detail: '', startedAt: null, endedAt: null, lastSeenAt: null, activityStartedAt: null, usage: emptyUsage(), turns: 0, toolCount: 0, hasActivity: false };
  const messages = new Map(), messageModels = new Map(), calls = new Map(), turns = new Set(), modelUsages = new Map();
  let cwd = null, quota = null, previousUsage = null, historyStart = null, awaitingOwnHistory = false;
  const setModel = model => { if (typeof model === 'string' && model !== '<synthetic>') { node.model = model; if (!node.models.includes(model)) node.models.push(model); } };
  function identify(id) { if (typeof id === 'string' && id) { node.sourceId = id; node.id = `${provider}:${id}`; } }
  function updateCodexUsage(raw) {
    const usage = codexUsage(raw), delta = {};
    if (Object.values(usage).some(value => value != null)) node.hasActivity = true;
    for (const key of Object.keys(usage)) delta[key] = previousUsage == null ? usage[key]
      : usage[key] != null && previousUsage[key] != null && usage[key] >= previousUsage[key] ? usage[key] - previousUsage[key] : null;
    const model = node.model ?? 'Unknown model';
    if (!modelUsages.has(model)) modelUsages.set(model, []);
    if (!previousUsage || Object.values(delta).some(v => v !== 0 && v != null)) modelUsages.get(model).push(delta);
    node.byModelUsage = Object.fromEntries([...modelUsages].map(([name, values]) => [name, sumUsage(values)]));
    node.usage = usage; previousUsage = usage;
  }
  function activity(label, at, detail = '') { node.hasActivity = true; node.activity = label; node.activityStartedAt = at; node.detail = detail; }
  function accept(record, offset) {
    const at = iso(record.timestamp), p = record.payload ?? {};
    if (provider === 'codex') {
      if (record.type === 'session_meta') {
        // Forks embed retimestamped parent records, including another session header.
        if (node.id) return [];
        historyStart = count(p.subagent_history_start_ordinal);
        awaitingOwnHistory = historyStart != null || !!p.forked_from_id;
      } else {
        if (record.type === 'token_usage_record' && p.thread_id && p.thread_id !== node.sourceId) return [];
        if (historyStart != null && count(record.ordinal) != null) {
          if (record.ordinal < historyStart) return [];
          awaitingOwnHistory = false;
        }
        if (record.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_id === node.sourceId) awaitingOwnHistory = false;
        if (awaitingOwnHistory && !(record.type === 'token_usage_record' && p.thread_id === node.sourceId)) return [];
      }
    }
    const events = [];
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 20);
    const emit = (kind, fields = {}) => events.push({ id: `${provider}:${file}:${offset}:${fingerprint}:${kind}`, at, nodeId: node.id, provider, model: node.model, kind, source: { file, offset }, ...fields });
    if (at) { node.startedAt ??= at; node.lastSeenAt = at; }
    if (provider === 'codex') {
      if (record.type === 'session_meta') {
        identify(p.id ?? p.session_id); cwd = text(p.cwd);
        const spawn = p.source?.subagent?.thread_spawn ?? p.source?.subagent?.spawn;
        const parent = text(p.parent_thread_id) ?? text(spawn?.parent_thread_id);
        if (parent) node.parentId = `codex:${parent}`;
        const agentPath = text(p.agent_path) ?? text(spawn?.agent_path);
        node.agentPath = agentPath;
        node.name = agentPath?.split('/').filter(Boolean).at(-1) ?? text(p.agent_nickname);
        emit('Session discovered', { host: typeof p.source === 'string' ? p.source : 'subagent', ...(node.parentId ? { from: node.parentId, to: node.id, transferKind: 'Dispatch' } : {}) });
      } else if (record.type === 'turn_context') { setModel(p.model); emit('Model selected'); }
      else if (record.type === 'token_usage_record' && p.thread_token_usage) {
        updateCodexUsage(p.thread_token_usage); emit('Usage', { usage: node.usage, scope: 'thread' });
      } else if (record.type === 'event_msg') {
        if (p.type === 'task_started') {
          if (!turns.has(p.turn_id ?? offset)) { turns.add(p.turn_id ?? offset); node.turns++; }
          node.status = 'Running'; node.endedAt = null; activity('Model processing', at); emit('Turn started', { turnId: p.turn_id });
        } else if (p.type === 'task_complete' || p.type === 'task_completed') {
          node.status = node.parentId ? 'Completed' : 'Idle'; if (node.parentId) node.endedAt = at;
          activity(node.status, at); emit('Turn completed', { turnId: p.turn_id });
          if (node.parentId) emit('Agent completed', { from: node.id, to: node.parentId, transferKind: 'Result' });
        } else if (p.type === 'turn_aborted') { node.status = 'Idle'; activity('Interrupted', at); emit('Turn interrupted'); }
        else if (p.type === 'token_count') {
          if (p.info?.total_token_usage) { updateCodexUsage(p.info.total_token_usage); emit('Usage', { usage: node.usage, scope: 'thread' }); }
          // Codex also logs limit buckets without windows (e.g. premium); they must not hide the last real reading.
          if (p.rate_limits?.primary || p.rate_limits?.secondary) quota = { limits: p.rate_limits, at };
        }
      } else if (record.type === 'response_item') {
        if (p.type === 'message' && p.role === 'assistant') node.hasActivity = true;
        if (p.type === 'function_call' || p.type === 'custom_tool_call') {
          const details = toolDetails(text(p.name) ?? 'Unknown tool', p.arguments ?? p.input);
          calls.set(p.call_id, { name: p.name, namespace: p.namespace, args: argumentsOf(p.arguments ?? p.input), at });
          node.toolCount++; node.status = 'Running'; activity(details.activity, at, details.command ?? details.target ?? details.tool);
          emit('Tool started', { callId: p.call_id, ...details });
        } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
          const call = calls.get(p.call_id), result = argumentsOf(p.output);
          const exitCode = Number.isSafeInteger(result.exit_code) ? result.exit_code : null;
          emit('Tool finished', { callId: p.call_id, tool: call?.name ?? 'Unknown tool', status: typeof result.exit_code === 'number' ? result.exit_code === 0 ? 'Completed' : 'Failed' : 'Unknown', ...(exitCode != null ? { exitCode } : {}) });
          const collaborationAck = call?.namespace === 'collaboration' && p.output === '';
          if (call && ['send_message', 'send_input', 'followup_task'].includes(call.name) && (collaborationAck || result.success === true || typeof result.submission_id === 'string' || typeof result.message_id === 'string')) {
            const receiver = text(call.args.receiver_thread_id) ?? text(call.args.target) ?? text(call.args.id);
            if (receiver) emit('Message sent', { from: node.id, to: receiver.startsWith('codex:') ? receiver : `codex:${receiver}`, transferKind: 'Message',
              ...(call.namespace === 'collaboration' ? { toAgentPath: path.posix.resolve(node.agentPath ?? '/root', receiver) } : {}) });
          }
          if (call?.name === 'spawn_agent' && text(result.task_name)) {
            // The child transcript is linked separately using provider metadata; task names are labels only.
            emit('Agent label', { taskName: result.task_name });
          }
          activity('Model processing', at);
        } else if (p.type === 'reasoning') { node.status = 'Running'; activity('Model processing', at); }
      }
    } else {
      cwd ??= text(record.cwd);
      if (!node.id && record.sessionId) {
        const agentId = text(record.agentId) ?? (/[/\\]subagents[/\\]agent-(.+)\.jsonl$/.exec(file)?.[1]);
        identify(agentId ? `${record.sessionId}:${agentId}` : record.sessionId);
        if (agentId && text(record.parentAgentId)) node.parentId = `claude:${record.sessionId}:${record.parentAgentId}`;
      }
      const message = record.message;
      if (record.type === 'user' && message && !record.isMeta) {
        const content = message.content;
        if (typeof content === 'string' || (Array.isArray(content) && content.some(c => c.type === 'text'))) {
          node.turns++; node.status = 'Running'; node.endedAt = null; activity('Model processing', at); emit('Turn started');
        }
        if (Array.isArray(content)) for (const item of content) if (item.type === 'tool_result') {
          emit('Tool finished', { callId: item.tool_use_id, tool: calls.get(item.tool_use_id)?.name ?? 'Unknown tool', status: item.is_error ? 'Failed' : 'Completed', ...(item.is_error ? { error: typeof item.content === 'string' ? item.content : 'Tool reported an error' } : {}) });
          activity('Model processing', at);
        }
      } else if (record.type === 'assistant' && message) {
        node.hasActivity = true;
        setModel(message.model);
        if (message.usage && message.id) {
          messages.set(message.id, claudeUsage(message.usage));
          messageModels.set(message.id, message.model ?? messageModels.get(message.id) ?? 'Unknown model');
          node.usage = sumUsage(messages.values());
          const grouped = new Map();
          for (const [id, usage] of messages) { const model = messageModels.get(id); if (!grouped.has(model)) grouped.set(model, []); grouped.get(model).push(usage); }
          node.byModelUsage = Object.fromEntries([...grouped].map(([model, usages]) => [model, sumUsage(usages)]));
          emit('Usage', { usage: node.usage, scope: 'agent', messageId: message.id });
        }
        for (const item of Array.isArray(message.content) ? message.content : []) if (item.type === 'tool_use') {
          if (!calls.has(item.id)) {
            const details = toolDetails(item.name ?? 'Unknown tool', item.input);
            calls.set(item.id, { name: item.name, at }); node.toolCount++;
            activity(details.activity, at, details.command ?? details.target ?? details.tool); emit('Tool started', { callId: item.id, ...details });
          }
        }
        if (message.stop_reason === 'end_turn') { node.status = node.parentId ? 'Completed' : 'Idle'; if (node.parentId) node.endedAt = at; activity(node.status, at); emit('Turn completed'); }
      } else if (record.type === 'system' && record.subtype === 'turn_duration') { node.status = node.parentId ? 'Completed' : 'Idle'; if (node.parentId) node.endedAt = at; activity(node.status, at); emit('Turn completed'); }
    }
    for (const event of events) event.nodeId = node.id;
    return events.filter(e => e.nodeId);
  }
  return { accept, get node() { return node; }, get cwd() { return cwd; }, get quota() { return quota; },
    get warning() { return awaitingOwnHistory ? `Fork history boundary unavailable for ${file}; only explicitly scoped usage is collected.` : null; } };
}

module.exports = { createTranscript, emptyUsage, sumUsage, codexUsage, claudeUsage, toolDetails, iso };
