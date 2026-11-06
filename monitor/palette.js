const colors = {
  opus: '#F5A524', sonnet: '#4C9AFF', haiku: '#F2D54B',
  astra: '#C77DFF', sol: '#3DDC97', luna: '#4FD1E0', terra: '#FA8F62', unknown: '#A0A0A0',
  background: '#101010', panel: '#191D25', wire: '#777D89', text: '#E2E8F0',
  input: '#4C9AFF', cached: '#8B7CF8', cacheWrite: '#F5A524', output: '#3DDC97',
  // Quota: green below 60%, yellow below 85%, red from 85%.
  green: '#3DDC97', yellow: '#F2D54B', red: '#F05A5A',
};
function modelColor(model) {
  const name = String(model ?? '').toLowerCase().replace(/^claude-/, '');
  const family = /^(opus|sonnet|haiku)(?:-|$)/.exec(name)?.[1]
    ?? /^gpt-\d+(?:\.\d+)*-(astra|sol|luna|terra)(?:-|$)/.exec(name)?.[1];
  return colors[family] ?? colors.unknown;
}
function quotaColor(percent) { return percent == null ? colors.unknown : percent < 60 ? colors.green : percent < 85 ? colors.yellow : colors.red; }
function dimColor(color) {
  const mix = [1, 3, 5].map(i => Math.round(parseInt(color.slice(i, i + 2), 16) * 0.45 + parseInt(colors.background.slice(i, i + 2), 16) * 0.55));
  return '#' + mix.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}
module.exports = { colors, modelColor, quotaColor, dimColor };
