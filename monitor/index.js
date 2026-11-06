const { watchView } = require('./live.js');
const { renderFrame } = require('./terminal.js');
const { emitKeypressEvents } = require('node:readline');

const help = `Agent Monitor — passive local Claude Code and Codex observer

Usage: node <monitor-folder> [project-folder] [--once]
       node <monitor-folder> --setup

The project defaults to the current directory. No model calls are made;
Claude quota is read from Anthropic's usage endpoint at most every 3 minutes.
Terminal and web run together; open the displayed URL in your browser.
--once   Print one terminal frame and exit without starting web.
--setup  Install passive command recorders once; preserve existing configuration.
--help   Show this help.

Config: LOG_PATH, WEB_IP, WEB_PORT and EFFECT_SPEED in config.js.
Logs: <LOG_PATH or launch directory>/.log/monitor/events.jsonl and result.json.
Environment: AGENT_MONITOR_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME.
Scroll the agent tree with Up/Down, PageUp/PageDown and Home/End.
Press Tab to switch scrolling between the tree and Completed table.
In the terminal press q or Ctrl+C to exit.`;

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  if (args.includes('--setup')) {
    if (args.length !== 1) throw new Error('--setup must be used alone.');
    const result = require('./setup.js').setupRecorder();
    console.log(result.message + '\n' + result.files.join('\n')); return;
  }
  const flags = args.filter(s => s.startsWith('--'));
  if (flags.some(s => s !== '--once') || args.filter(s => !s.startsWith('--')).length > 1) throw new Error('Invalid arguments. Use --help.');
  const options = { project: args.find(s => !s.startsWith('--')) ?? process.cwd() };
  const output = process.stdout, input = process.stdin;
  let view, web, stopView, stopped = false, frameTimer;
  const scroll = { offset: 0, section: 'tree', completed: { offset: 0 } };
  if (!args.includes('--once')) {
    web = await require('./web.js').startWeb({ ...options, watchView(callback, settings) {
      return watchView(next => { view = next; callback(next); }, settings);
    } });
    stopView = web.close;
  } else stopView = watchView(next => { view = next; }, options);
  const frame = () => renderFrame({ ...view, webUrl: web?.url }, { cols: output.columns || 120, rows: output.rows || 50, colors: output.isTTY ? /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '') ? 'truecolor' : '256' : 'none', scroll });
  if (!output.isTTY || args.includes('--once')) {
    if (web) {
      console.log(web.url);
      process.once('SIGINT', stopView); process.once('SIGTERM', stopView);
    } else { stopView(); output.write(frame() + '\n'); }
    return;
  }
  const wasRaw = input.isRaw;
  const cleanup = () => {
    if (stopped) return; stopped = true;
    stopView(); clearInterval(frameTimer);
    if (input.isTTY) input.setRawMode(Boolean(wasRaw));
    input.pause(); output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  const stop = code => { cleanup(); process.exit(code); };
  process.once('exit', cleanup); process.once('SIGINT', () => stop(0)); process.once('SIGTERM', () => stop(0));
  process.once('uncaughtException', error => { cleanup(); console.error(error.message); process.exit(1); });
  output.write('\x1b[?1049h\x1b[?25l');
  if (input.isTTY) input.setRawMode(true);
  emitKeypressEvents(input);
  input.on('keypress', (text, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) { stop(0); return; }
    if (key.name === 'tab') { scroll.section = scroll.section === 'tree' ? 'completed' : 'tree'; draw(); return; }
    const pane = scroll.section === 'completed' ? scroll.completed : scroll;
    switch (key.name) {
      case 'up': pane.offset--; break;
      case 'down': pane.offset++; break;
      case 'pageup': pane.offset -= pane.pageSize; break;
      case 'pagedown': pane.offset += pane.pageSize; break;
      case 'home': pane.offset = 0; break;
      case 'end': pane.offset = pane.totalLines; break;
      default: return;
    }
    draw();
  });
  input.resume();
  let previousLines = [], previousColumns;
  const draw = () => {
    const lines = frame().split('\n');
    const screen = Array.from({ length: output.rows || 50 }, (_, index) => lines[index] ?? '');
    const resized = previousColumns !== output.columns || previousLines.length !== screen.length;
    let changes = '';
    for (let index = 0; index < screen.length; index++) {
      if (resized || screen[index] !== previousLines[index]) changes += `\x1b[${index + 1};1H${screen[index]}\x1b[K`;
    }
    if (changes) output.write(changes);
    previousLines = screen; previousColumns = output.columns;
  };
  output.on('resize', draw); frameTimer = setInterval(draw, 1000 / 20); draw();
}
module.exports = { main, help };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
