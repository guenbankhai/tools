// Root folder; logs always go in .log/monitor. Empty uses the launch directory.
const LOG_PATH = '';
const WEB_IP = '127.0.0.1';
const WEB_PORT = 4777;
// Arrow emission rate: 2 = twice as many, 0.5 = half as many. Travel stays fixed.
const EFFECT_SPEED = 1;

module.exports = { LOG_PATH, WEB_IP, WEB_PORT, EFFECT_SPEED };
