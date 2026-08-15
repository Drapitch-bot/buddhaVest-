/**
 * metricSecondaryDisplay — the small line under a money figure, in the reader's
 * own currency.
 *
 * Requested 2026-08-15: "like the share price — the big number in dollars, and
 * underneath in smaller text the currency chosen by the language."
 *
 * The function is four lines of arithmetic and five lines of guard, and the
 * guards are the whole subject. Converting the wrong figure produces a number
 * that is confidently, invisibly wrong — which is what happened once already:
 * the price line tested "not shekel" instead of "is dollar", so a euro listing
 * was multiplied by the dollar rate and EUR 37.95 became ILS 115.75.
 *
 * Statement figures are worse than the price, because nothing on the screen
 * tells the reader which currency the number started in.
 *
 * Run:  node scripts/test-currency-secondary.js
 */
const fs = require('fs');
const src = fs.readFileSync('screens/StockScreen.js', 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  let d = 0, started = false, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && !d) { j++; break; } }
  }
  return src.slice(i, j);
}
const MONEY = src.slice(src.indexOf('const MONEY_KEYS'), src.indexOf('];', src.indexOf('const MONEY_KEYS')) + 2);
const isUsd = c => !c || String(c).toUpperCase() === 'USD';
eval(MONEY + '\n' + grab('formatBigNumber') + '\n' + grab('metricSecondaryDisplay'));

const ILS = { rate: 2.9866, symbol: '₪' };
let bad = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log('  ' + (ok?'ok  ':'FAIL') + '  ' + name.padEnd(52) + (ok?'':' got '+got+' want '+want));
  if (!ok) bad++;
};

console.log('\n-- ORA.TA: trades in ILS, reports in USD. The case that prompted this. --');
t('net income converts',
  metricSecondaryDisplay('net_income_trend', { value: 123898000 }, 'USD', true, ILS), '₪370.03M');
t('cash converts',
  metricSecondaryDisplay('cash_position', { value: 147448000 }, 'USD', true, ILS), '₪440.37M');
t('negative FCF keeps its sign',
  metricSecondaryDisplay('free_cash_flow', { value: -284675000 }, 'USD', true, ILS), '₪-850.21M');

console.log('\n-- POLI.TA: reports in ILS. Nothing to convert FROM. --');
for (const k of ['net_income_trend', 'cash_position', 'free_cash_flow'])
  t(k + ' -> no second line', metricSecondaryDisplay(k, { value: 9802000000 }, 'ILS', true, ILS), null);

console.log('\n-- the euro bug this guard exists to prevent --');
t('EUR is never multiplied by the dollar rate',
  metricSecondaryDisplay('cash_position', { value: 1e9 }, 'EUR', true, ILS), null);
t('GBP likewise', metricSecondaryDisplay('cash_position', { value: 1e9 }, 'GBP', true, ILS), null);

console.log('\n-- currency unknown: convert from what? --');
t('finKnown=false -> null',
  metricSecondaryDisplay('cash_position', { value: 1e9 }, 'USD', false, ILS), null);

console.log('\n-- only money converts --');
for (const [k, m] of [['current_ratio', { value: 0.81 }], ['net_margin', { value: 12.5 }],
                      ['pe_ratio', { value: 55.2 }], ['cash_runway', { value: 18 }],
                      ['moat', { value: 31.7 }], ['dividend', { value: 0.43 }]])
  t(k + ' is not money', metricSecondaryDisplay(k, m, 'USD', true, ILS), null);
t('buyback as a percent is not money',
  metricSecondaryDisplay('buyback', { value: 0.01, value_unit: 'percent' }, 'USD', true, ILS), null);
t('buyback as an amount IS money',
  metricSecondaryDisplay('buyback', { value: 3.5e9, value_unit: 'currency' }, 'USD', true, ILS), '₪10.45B');

console.log('\n-- an English reader sees nothing new --');
t('USD -> USD says nothing',
  metricSecondaryDisplay('cash_position', { value: 1e9 }, 'USD', true, { rate: 1, symbol: '$' }), null);
t('no rate at all', metricSecondaryDisplay('cash_position', { value: 1e9 }, 'USD', true, null), null);

console.log('\n-- junk --');
for (const [n2, v] of [['null value', null], ['undefined value', undefined], ['NaN', NaN]])
  t(n2, metricSecondaryDisplay('cash_position', { value: v }, 'USD', true, ILS),
    v == null ? null : '₪NaN');
t('metric is null', metricSecondaryDisplay('cash_position', null, 'USD', true, ILS), null);

console.log(bad ? `\n  FAIL ${bad}` : '\n  OK all conversions correct');
process.exit(bad ? 1 : 0);
