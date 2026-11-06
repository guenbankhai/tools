const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const monitorHome = () => process.env.AGENT_MONITOR_HOME ?? path.join(os.homedir(), '.agent-monitor');
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function normalized(dir) { return path.resolve(dir).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(); }
function contains(root, cwd) { const r = normalized(root), c = normalized(cwd); return c === r || c.startsWith(r + '/'); }
function activeProjects(home = monitorHome()) {
  const dir = path.join(home, 'watchers');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => {
    try { const entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return alive(entry.pid) && typeof entry.logDir === 'string' && Array.isArray(entry.roots) ? [entry] : []; } catch { return []; }
  });
}
function registerProject({ home = monitorHome(), project, roots = [project], logDir }) {
  const dir = path.join(home, 'watchers'); fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('sha256').update(normalized(project)).digest('hex').slice(0, 20);
  const file = path.join(dir, key + '.json');
  if (fs.existsSync(file)) {
    let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Invalid watcher registration: ${file}`); }
    if (alive(old.pid)) throw new Error(`A monitor is already recording this project (PID ${old.pid}). Close it before starting another monitor.`);
    fs.unlinkSync(file);
  }
  const entry = { pid: process.pid, project, roots, logDir, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(entry), { flag: 'wx' });
  return () => { try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.pid === process.pid) fs.unlinkSync(file); } catch {} };
}
module.exports = { monitorHome, activeProjects, registerProject, contains };
