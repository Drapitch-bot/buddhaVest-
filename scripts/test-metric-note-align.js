/**
 * The three explanation boxes on the metric screen are centred in every
 * language, and nothing else on that screen moved.
 *
 * They were the only blocks that swung to one edge, and which edge depended
 * on the language: on a Hebrew handset showing English they landed against
 * the right margin. Next to ten already-centred elements on the same screen,
 * that read as a mistake, because it was one.
 *
 * The narrowness is the point. This file exists to prove the change stayed
 * inside those three boxes.
 *
 * Run:  node scripts/test-metric-note-align.js
 */
const fs = require('fs');
const src = fs.readFileSync('screens/MetricHistoryScreen.js', 'utf8');

let bad = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(56) +
    (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) bad++;
};

const noteStyle = (src.match(/const noteStyle = \{[^}]*\}/) || [''])[0];

console.log('\n  the centred style');
t('noteStyle exists', !!noteStyle, true);
t('  it centres, in every language', /textAlign: 'center'/.test(noteStyle), true);
t('  with no language condition on the alignment',
  /textAlign:[^,]*isRtl/.test(noteStyle), false);
// Centring does not decide where punctuation sits inside a Hebrew line.
t('  and writingDirection still follows the language',
  /writingDirection: isRtl \? 'rtl' : 'ltr'/.test(noteStyle), true);

console.log('\n  applied to exactly three blocks');
t('three explanation texts use it', (src.match(/noteStyle\]/g) || []).length, 3);
t('  the verdict line', /signalColor\(tileSignal, tileScore, colors\) \}, noteStyle\]/.test(src), true);
t('  the built-in explanation', /colors\.textDim \}, noteStyle\]/.test(src), true);
t('  the server explanation', /colors\.textDimmer \}, noteStyle\]/.test(src), true);

console.log('\n  and nothing else on the screen changed');
t('dirStyle is still defined', /const dirStyle = \{/.test(src), true);
t('  and still aligns by language',
  /const dirStyle = \{ textAlign: isRtl \? 'right' : 'left'/.test(src), true);
t('no explanation text is left on dirStyle', /explText[^\]]*dirStyle\]/.test(src), false);
// The screen was already centred nearly everywhere; that is what these boxes
// are now consistent with, so the count must not have dropped.
t('the screen still centres everything it centred before',
  (src.match(/textAlign: 'center'/g) || []).length >= 10, true);

console.log(bad ? `\n  ${bad} failing` : '\n  all passing');
process.exit(bad ? 1 : 0);
