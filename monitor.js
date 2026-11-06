// Repository shortcut; the monitor folder also runs independently from any project.
const { main } = require('./monitor/index.js');
module.exports = require('./monitor/terminal.js');
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
