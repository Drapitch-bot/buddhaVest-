/**
 * A number has to read as a number, whatever language the handset is set to.
 *
 * Reported from a real phone: the app was showing English and a net margin of
 * -19.8% rendered as "19.8%-", while the 52-week range printed the HIGH price
 * on the left and the LOW on the right, under a gradient that still ran red to
 * green left to right.
 *
 * One cause, two shapes. The handset's system language was Hebrew, so React
 * Native put the whole app in right-to-left: a leading minus is a
 * direction-neutral character and gets handed to the surrounding paragraph,
 * and flexDirection:'row' is mirrored. The gradient is NOT mirrored, because
 * it is drawn from explicit x coordinates, so the labels and the colours
 * disagreed.
 *
 * writingDirection was already set on those styles and did nothing: it is
 * iOS-only, so on Android it is ignored entirely. The isolate characters below
 * are part of the text, so they work on both.
 *
 * Run:  node scripts/test-bidi-numbers.js
 */
const fs = require('fs');

const cur = fs.readFileSync('utils/currency.js', 'utf8');
const body = cur.slice(cur.indexOf('export function ltrNum('));
const ltrNum = new Function('return ' + body.slice(body.indexOf('function ltrNum(')).replace(/\n\}[\s\S]*$/, '\n}'))();

const LRI = '⁦', PDI = '⁩';
let bad = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(56) +
    (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) bad++;
};

console.log('\n  the number itself');
t('a negative percentage is isolated', ltrNum('-19.8%'), LRI + '-19.8%' + PDI);
t('  the minus stays in front', ltrNum('-19.8%').indexOf('-') < ltrNum('-19.8%').indexOf('1'), true);
t('a positive percentage', ltrNum('+6.50%'), LRI + '+6.50%' + PDI);
t('a shekel price', ltrNum('₪902.23'), LRI + '₪902.23' + PDI);
t('a dollar price', ltrNum('$92.88'), LRI + '$92.88' + PDI);
t('a plain number', ltrNum('120.70M'), LRI + '120.70M' + PDI);

console.log('\n  what it must not do');
t('null stays null', ltrNum(null), null);
t('undefined stays undefined', ltrNum(undefined), undefined);
t('an empty string is untouched', ltrNum(''), '');
t('it never changes the characters between the marks',
  ltrNum('-19.8%').slice(1, -1), '-19.8%');
t('wrapping twice does not nest for ever',
  ltrNum(ltrNum('-1%')).split(LRI).length - 1, 2);

console.log('\n  where it is applied');
{
  const tile = fs.readFileSync('components/MetricTile.js', 'utf8');
  t('the metric value goes through it', /ltrNum\(value\)/.test(tile), true);
  t('  and the converted line under it', /ltrNum\(sub\)/.test(tile), true);
  // The note is a sentence, not a number. Pinning prose to one direction
  // would break the Hebrew translation of it.
  t('  but the note is left as prose', /ltrNum\(note\)/.test(tile), false);
  t('  and so is the label', /ltrNum\(label\)/.test(tile), false);
}
{
  const stock = fs.readFileSync('screens/StockScreen.js', 'utf8');
  const row = stock.slice(stock.indexOf('rangeLabels,'), stock.indexOf('</View>', stock.indexOf('rangeLabels,')));
  t('both range prices go through it', (row.match(/ltrNum\(/g) || []).length, 2);
  t('  the low is written first', row.indexOf('week52_low') < row.indexOf('week52_high'), true);
  t('  and the row is reversed only where the layout mirrors',
    /I18nManager\.isRTL \? \{ flexDirection: 'row-reverse' \}/.test(row), true);
  const marker = stock.slice(stock.indexOf('rangeMarker,'), stock.indexOf('/>', stock.indexOf('rangeMarker,')));
  t('the marker is measured from the same end as the gradient',
    /I18nManager\.isRTL \? \{ right: rangePct/.test(marker), true);
}

console.log(bad ? `\n  ${bad} failing` : '\n  all passing');
process.exit(bad ? 1 : 0);
