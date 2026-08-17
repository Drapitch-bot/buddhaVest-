/**
 * The currency calculator's arithmetic, run rather than eyeballed.
 *
 * The trap this file exists for: a share price is quoted in the STOCK's own
 * currency, not the reader's and not always the dollar. Delek trades in
 * shekels. The exchange service quotes everything against the dollar. So going
 * straight from an 81.68 shekel price to shekels with a dollar rate would
 * multiply it by three and tell someone a holding costs three times what it
 * does - the same class of error as the market cap that read 2,106B.
 *
 * The rates below are real ones, read from the live service on the day this
 * was written, so the expected answers are arithmetic anyone can check.
 *
 * Run:  node scripts/test-calculator.js
 */
const fs = require('fs');

const src = fs.readFileSync('screens/CalculatorScreen.js', 'utf8');
// Pull the real functions out of the screen rather than restating them here;
// a copy would keep passing after the original changed.
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) { console.error('not found: ' + name); process.exit(1); }
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}
// utils/currency.js is an ES module, and require() of one is a hard error on
// Node 20 - which is what CI runs. It works on Node 22, which is what this
// machine has, so requiring it passed here and failed there. Read the table
// out of the source instead: no loader involved, no version to be wrong about.
const symbolFor = (function () {
  const m = fs.readFileSync('utils/currency.js', 'utf8');
  const o = m.indexOf('const SYMBOLS = {');
  const c = m.indexOf('};', o) + 1;
  const S = new Function('return ' + m.slice(o + 'const SYMBOLS = '.length, c))();
  return (cur) => S[cur] || (cur + ' ');
})();

const ctx = { symbolFor, DECIMALS: null };
const bodies = ['decimalsFor', 'fmtMoney', 'fmtShares', 'parseNum'].map(grab).join('\n');
const decl = src.match(/const DECIMALS = \{[^}]*\};/)[0];
const F = new Function('symbolFor', decl + '\n' + bodies +
  '\nreturn {decimalsFor, fmtMoney, fmtShares, parseNum};')(symbolFor);

// The conversion itself, lifted from the component.
const convBody = src.slice(src.indexOf('const convert = useCallback('), src.indexOf('}, [rates]);') + 12);
const inner = convBody.slice(convBody.indexOf('function (amount, from, to)'), convBody.lastIndexOf('}') + 1);
const makeConvert = (rates) => new Function('rates', 'return ' + inner + ';')(rates);

let bad = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(58) +
    (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) bad++;
};
const near = (name, got, want, tol) => {
  const ok = got != null && Math.abs(got - want) <= (tol == null ? 0.01 : tol);
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(58) +
    (ok ? '' : ` got ${got} want ~${want}`));
  if (!ok) bad++;
};

// Read from /exchange-rate on the live service. USD is the hub and is 1.
const RATES = { USD: 1, ILS: 2.94914, EUR: 0.8625, GBP: 0.7376,
                RUB: 84.69, JPY: 159.163, CHF: 0.81023, CAD: 1.38602, AUD: 1.4029 };
const convert = makeConvert(RATES);

console.log('\n  conversion');
// 1 · The whole reason this file exists.
near('a shekel price shown in shekels is unchanged', convert(81.68, 'ILS', 'ILS'), 81.68, 0.001);
near('  the same price in dollars', convert(81.68, 'ILS', 'USD'), 27.70, 0.01);
near('  and in euros', convert(81.68, 'ILS', 'EUR'), 23.89, 0.01);
near('a dollar price in shekels', convert(305.93, 'USD', 'ILS'), 902.23, 0.01);
near('a dollar price in dollars is unchanged', convert(305.93, 'USD', 'USD'), 305.93, 0.001);

// 2 · Round trips, because a wrong divide would show up here and nowhere else.
for (const a of ['ILS', 'EUR', 'JPY', 'RUB']) {
  near(`${a} → USD → ${a} returns the same number`,
    convert(convert(1234.5, a, 'USD'), 'USD', a), 1234.5, 0.001);
}
near('EUR → JPY agrees with going via the dollar',
  convert(100, 'EUR', 'JPY'), (100 / 0.8625) * 159.163, 0.01);

// 3 · Nothing to convert must give no answer, never a confident zero.
t('a missing amount gives no answer', convert(null, 'USD', 'ILS'), null);
t('an unknown source currency gives no answer', convert(10, 'XXX', 'ILS'), null);
t('an unknown target currency gives no answer', convert(10, 'USD', 'XXX'), null);
t('a rate that has not arrived gives no answer',
  makeConvert({ USD: 1 })(10, 'ILS', 'USD'), null);
t('a zero rate is refused, not divided by',
  makeConvert({ USD: 1, ILS: 0 })(10, 'ILS', 'USD'), null);
t('a NaN amount gives no answer', convert(NaN, 'USD', 'ILS'), null);

console.log('\n  what the reader types');
t('an empty box is not zero', F.parseNum(''), null);
t('a lone dot is not zero', F.parseNum('.'), null);
t('letters are not zero', F.parseNum('abc'), null);
t('a plain number', F.parseNum('40'), 40);
t('a decimal', F.parseNum('12.5'), 12.5);
t('thousands separators are ignored', F.parseNum('5,000'), 5000);
t('spaces are ignored', F.parseNum(' 1 200 '), 1200);
t('a currency sign typed in is ignored', F.parseNum('₪5000'), 5000);
t('Arabic-Indic digits from a third-party keyboard', F.parseNum('٤٠'), 40);
t('a negative number is refused', F.parseNum('-5'), null);
t('zero is a real answer, not a missing one', F.parseNum('0'), 0);

console.log('\n  how it reads');
t('shekels', F.fmtMoney(902.23, 'ILS'), '₪902.23');
t('dollars', F.fmtMoney(305.93, 'USD'), '$305.93');
t('euros', F.fmtMoney(23.89, 'EUR'), '€23.89');
t('roubles', F.fmtMoney(2345.6, 'RUB'), '₽2,345.60');
t('yen carries no decimals', F.fmtMoney(48690.4, 'JPY'), '¥48,690');
t('thousands are grouped', F.fmtMoney(1234567.891, 'USD'), '$1,234,567.89');
t('no answer prints a dash, not zero', F.fmtMoney(null, 'ILS'), '—');
t('infinity prints a dash', F.fmtMoney(Infinity, 'ILS'), '—');
t('shares are whole', F.fmtShares(12.9), '12');
t('  and grouped', F.fmtShares(12345.6), '12,345');
t('no answer prints a dash', F.fmtShares(null), '—');

console.log('\n  the money → shares direction');
{
  // 5,000 shekels of Apple at $305.93, with the shekel at 2.94914.
  const unit = convert(305.93, 'USD', 'ILS');       // ≈ 902.23
  const affordable = 5000 / unit;                    // ≈ 5.54
  t('whole shares only', F.fmtShares(affordable), '5');
  near('  and the change left over', 5000 - Math.floor(affordable) * unit, 488.83, 0.02);
  // A stock nobody can afford one of must say zero, not round up to one.
  t('a share you cannot afford reads zero', F.fmtShares(100 / unit), '0');
}

console.log('\n  the currency list');
{
  const listed = new Function('return ' + src.match(/const CURRENCIES = \[[^\]]*\]/)[0]
    .replace('const CURRENCIES = ', ''))();
  // Every one of these was confirmed against /exchange-rate. A currency in the
  // picker with no rate behind it is a control that silently does nothing.
  const verified = ['USD', 'ILS', 'EUR', 'GBP', 'RUB', 'JPY', 'CHF', 'CAD', 'AUD'];
  t('only currencies checked against the service are offered',
    listed.slice().sort(), verified.slice().sort());
  t('every one of them has a sign of its own',
    listed.filter(c => !symbolFor(c) || symbolFor(c) === c + ' '), []);
  t('the dollar is in the list, since it is the hub', listed.includes('USD'), true);
}

console.log('\n  defaults');
{
  // The app's default is English and dollars. A currency chosen off the
  // interface language puts one country's money in front of everyone who
  // happens to read that language, and an initialiser that reads the language
  // once cannot follow a change of it either.
  const init = src.match(/const \[target, setTarget\] = useState\(([^)]*)\)/)[1].trim();
  t('the target currency starts as dollars, unconditionally', init, "'USD'");
  t('  and is not derived from the interface language',
    /lang\s*===\s*'(he|ru|es)'/.test(init), false);
}
{
  const api = fs.readFileSync('constants/api.js', 'utf8');
  t('exchangeRate defaults to dollars', /exchangeRate: \(currency = 'USD'\)/.test(api), true);
  for (const fn of ['analyze', 'signals', 'news', 'stockNews']) {
    t(`${fn} defaults to English`,
      new RegExp(fn + ": \\([^)]*lang = 'en'").test(api), true);
  }
  t('no endpoint helper still defaults to Hebrew', /lang = 'he'/.test(api), false);
  t('no endpoint helper still defaults to shekels', /= 'ILS'\)/.test(api), false);
}
{
  const py = fs.readFileSync('assets/1BuddhaVest/main.py', 'utf8');
  t('no server endpoint still defaults to Hebrew', /lang: str = "he"/.test(py), false);
  t('exchange-rate defaults to dollars', /currency: str = "USD"/.test(py), true);
  t('  and an unknown code falls back to dollars, not shekels',
    /if currency not in \([^)]*\):[\s\S]{0,400}?currency = "USD"/.test(py), true);
}

console.log(bad ? `\n  ${bad} failing` : '\n  all passing');
process.exit(bad ? 1 : 0);
