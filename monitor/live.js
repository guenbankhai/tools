const { buildView } = require('./view.js');
const { createStore } = require('./store.js');
const { registerProject, monitorHome } = require('./registry.js');
const { createCollector } = require('./data.js');

function watchView(publish, options = {}) {
  const collector = createCollector(options);
  const unregister = registerProject({ home: options.monitorHome ?? monitorHome(), project: collector.project, roots: collector.roots, logDir: collector.logDir });
  let store;
  try { store = createStore(collector.logDir); } catch (error) { unregister(); throw error; }
  let memory, timer;
  const close = () => { clearInterval(timer); unregister(); };
  const update = () => {
    const snapshot = collector.poll();
    store.update(snapshot);
    collector.acknowledge();
    const result = buildView(snapshot, Date.now(), memory);
    memory = result.memory;
    publish(result.view);
  };
  try { update(); timer = setInterval(update, 1500); }
  catch (error) { close(); throw error; }
  return close;
}
module.exports = { watchView };
