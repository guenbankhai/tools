const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { monitorHome } = require('./registry.js');

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new Error(`Invalid JSON configuration; left untouched: ${file}`); }
}
function saveConfig(file, data) {
  const content = JSON.stringify(data, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.agent-monitor-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, content); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function setupRecorder(options = {}) {
  const home = options.home ?? monitorHome();
  const claudeDir = options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const codexDir = options.codexDir ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const installDir = path.join(home, 'recorder');
  if (installDir.includes('"') || /[\r\n]/.test(installDir)) throw new Error('Recorder path contains unsupported shell characters.');
  const targets = [['claude', path.join(claudeDir, 'settings.json')], ['codex', path.join(codexDir, 'hooks.json')]];
  // Validate every existing file before touching any provider configuration.
  const configs = targets.map(([provider, file]) => ({ provider, file, data: readConfig(file) }));
  for (const c of configs) {
    if (c.data.hooks != null && (typeof c.data.hooks !== 'object' || Array.isArray(c.data.hooks))) throw new Error(`Invalid hooks object: ${c.file}`);
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'PostToolUseFailure']) {
      if (c.data.hooks?.[event] != null && !Array.isArray(c.data.hooks[event])) throw new Error(`Invalid ${event} hook array: ${c.file}`);
    }
  }
  fs.mkdirSync(installDir, { recursive: true });
  for (const name of ['recorder.js', 'registry.js', 'transcript.js']) fs.copyFileSync(path.join(__dirname, name), path.join(installDir, name));
  // Older setups wrapped the user's status line to capture quota; quota now comes from the usage endpoint.
  const oldStatus = path.join(installDir, 'statusline-config.json'), oldStatusCommand = `node "${path.join(installDir, 'statusline.js').replaceAll('\\', '/')}"`;
  const changes = [];
  for (const { provider, file, data } of configs) {
    const script = path.join(installDir, 'recorder.js').replaceAll('\\', '/');
    const command = `node "${script}" ${provider}`;
    const events = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
    if (provider === 'claude') events.push('PostToolUseFailure');
    data.hooks ??= {};
    for (const event of events) {
      if (data.hooks[event] != null && !Array.isArray(data.hooks[event])) throw new Error(`Invalid ${event} hook array: ${file}`);
      const groups = data.hooks[event] ?? [];
      if (!groups.some(g => g?.hooks?.some(h => h?.command === command))) groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
      data.hooks[event] = groups;
    }
    if (provider === 'claude' && data.statusLine?.command === oldStatusCommand) {
      const original = fs.existsSync(oldStatus) ? readConfig(oldStatus) : {};
      if (original.type === 'command' && typeof original.command === 'string') data.statusLine = original; else delete data.statusLine;
    }
    saveConfig(file, data); changes.push(file);
  }
  for (const name of ['statusline.js', 'statusline-config.json']) fs.rmSync(path.join(installDir, name), { force: true });
  return { home, files: changes, message: 'Recorder installed. Restart existing agent sessions to load hooks. The monitor never calls a model.' };
}
module.exports = { setupRecorder };
