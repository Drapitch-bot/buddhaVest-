// CalculatorScreen.js — what a holding costs, in the reader's own money.
//
// The app already shows a converted line under a price, but only for the one
// stock on screen and only for one share. The question people actually ask is
// "forty of those, how much is that in shekels" - and the answer needs a live
// price, a live rate, and the stock's OWN currency, which is not always USD.
//
// Three things in one screen, because they are the same arithmetic read in
// three directions:
//   shares  → money     how much would 40 AAPL cost me
//   money   → shares    I have 5,000 ILS, how many is that
//   money   → money     a plain converter, no stock involved
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../constants/AppContext';
import { ENDPOINTS } from '../constants/api';
import { symbolFor } from '../utils/currency';
import BrandHeader from '../components/BrandHeader';
import { captureIssue } from '../utils/monitoring';

// Every one of these was checked against the live service before being listed:
// /exchange-rate returns a finite, positive rate for all nine. Adding a tenth
// without checking would put a currency in the picker that silently answers
// nothing, which is worse than not offering it.
const CURRENCIES = ['USD', 'ILS', 'EUR', 'GBP', 'RUB', 'JPY', 'CHF', 'CAD', 'AUD'];

// The service quotes everything against the dollar, so USD is the hub: any
// pair is one divide and one multiply through it. Hard-coded to 1 rather than
// fetched, because "one dollar is one dollar" cannot fail or go stale.
const USD_RATE = 1;

// Yen has no subunit anyone quotes, so two decimals on a yen figure is noise.
const DECIMALS = { JPY: 0 };

function decimalsFor(cur) {
  return DECIMALS[cur] == null ? 2 : DECIMALS[cur];
}

function fmtMoney(value, cur) {
  if (value == null || !isFinite(value)) return '—';
  var d = decimalsFor(cur);
  var s = Math.abs(value) >= 1000
    ? value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
    : value.toFixed(d);
  return symbolFor(cur) + s;
}

// Shares are whole things. Showing 12.4 of them invites someone to try to buy
// 12.4, so the fraction is kept as a separate, quieter line.
function fmtShares(n) {
  if (n == null || !isFinite(n)) return '—';
  return Math.floor(n).toLocaleString('en-US');
}

// A number typed on a phone can arrive with spaces, commas or an Arabic-Indic
// digit from a third-party keyboard. Anything that is not a number is not a
// zero - it is "no answer yet", so it returns null rather than 0 and the
// result line stays blank instead of confidently saying nothing costs nothing.
function parseNum(raw) {
  if (raw == null) return null;
  var s = String(raw).replace(/[٠-٩]/g, function (d) {
    return String(d.charCodeAt(0) - 0x0660);
  });
  // A minus can only arrive by paste, and there is no such thing as minus five
  // shares. Stripping it would turn "-5" into 5 and answer a question nobody
  // asked; refusing it leaves the result blank, which is the truth.
  if (/-/.test(s)) return null;
  s = s.replace(/[^0-9.]/g, '');
  if (!s || s === '.') return null;
  var n = parseFloat(s);
  return isFinite(n) && n >= 0 ? n : null;
}

// ── pieces ──────────────────────────────────────────────────────────────────
//
// These live out here, at module scope, and that placement is the whole point.
//
// They were declared inside CalculatorScreen. A function declared in a render
// body is a NEW function on every render, so React sees a different component
// type each time and unmounts the old subtree to mount a fresh one. The
// TextInput inside it is destroyed and rebuilt after every single keystroke,
// which takes the focus and the keyboard with it: typing "1" worked, and then
// the field closed before a second digit could be typed.
//
// Everything they need is passed in. Nothing here may close over component
// state, or it drifts back to being defined inside the component in spirit.

function Chips({ value, onChange, colors, rates }) {
  return (
    <View style={s.chipRow}>
      {CURRENCIES.map(function (cur) {
        var on = value === cur;
        // A currency whose rate never arrived is shown disabled rather than
        // hidden, so the row does not silently change shape.
        var usable = !!rates[cur];
        return (
          <TouchableOpacity
            key={cur}
            disabled={!usable}
            onPress={function () { onChange(cur); }}
            style={[s.chip, {
              backgroundColor: on ? (colors.primary || '#f59e0b') : colors.cardAlt,
              borderColor: on ? (colors.primary || '#f59e0b') : colors.cardBorder,
              opacity: usable ? 1 : 0.35,
            }]}>
            <Text style={[s.chipText, { color: on ? '#fff' : colors.text }]}>
              {symbolFor(cur) + ' ' + cur}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Card({ title, colors, dir, children }) {
  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
      <Text style={[s.cardTitle, { color: colors.text }, dir]}>{title}</Text>
      {children}
    </View>
  );
}

function Field(props) {
  var colors = props.colors, dir = props.dir;
  return (
    <View style={s.field}>
      <Text style={[s.label, { color: colors.textDim }, dir]}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        onSubmitEditing={props.onSubmitEditing}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textDim}
        keyboardType={props.keyboardType || 'decimal-pad'}
        autoCapitalize={props.autoCapitalize || 'none'}
        autoCorrect={false}
        returnKeyType={props.returnKeyType || 'done'}
        // The keyboard must survive a keystroke. Without this, submitting or a
        // re-render dismisses it and the reader has to tap the field again for
        // every digit.
        blurOnSubmit={false}
        style={[s.input, {
          backgroundColor: colors.cardAlt,
          borderColor: colors.cardBorder,
          color: colors.text,
        }, dir]}
      />
    </View>
  );
}

function Result({ label, value, note, muted, colors, dir }) {
  return (
    <View style={[s.result, { borderTopColor: colors.cardBorder }]}>
      <Text style={[s.resultLabel, { color: colors.textDim }, dir]}>{label}</Text>
      <Text style={[s.resultValue, { color: muted ? colors.textDim : colors.text }, dir]}>
        {value}
      </Text>
      {note ? (
        <Text style={[s.resultNote, { color: colors.textDim }, dir]}>{note}</Text>
      ) : null}
    </View>
  );
}

export default function CalculatorScreen() {
  const { colors, t, lang } = useApp();
  const insets = useSafeAreaInsets();
  const rtl = lang === 'he';
  const dir = { textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' };

  // rates[cur] = how many of `cur` one dollar buys.
  const [rates, setRates] = useState({ USD: USD_RATE });
  const [ratesError, setRatesError] = useState(false);
  // Dollars, whatever language the app is in. Prices arrive in dollars, the
  // rates are quoted against the dollar, and the app's default is English -
  // picking a currency off the interface language would put one country's
  // money in front of everyone who happens to read that language, and it also
  // could not follow a language change, because this initialiser runs once.
  const [target, setTarget] = useState('USD');

  const [ticker, setTicker] = useState('');
  const [quote, setQuote] = useState(null);       // {ticker, price, price_currency, company_name}
  const [quoteErr, setQuoteErr] = useState(null); // 'notfound' | 'net'
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [shares, setShares] = useState('');
  const [budget, setBudget] = useState('');

  const [convAmount, setConvAmount] = useState('');
  // The converter picks BOTH sides itself. The selector at the top of the
  // screen governs what a share price is shown in; down here the reader wants
  // any currency into any other, and tying the answer to that selector meant
  // the bottom card could never do what its own title says.
  const [convFrom, setConvFrom] = useState('USD');
  const [convTo, setConvTo] = useState('ILS');

  // A quote that comes back after the reader has typed a different symbol must
  // not land on the screen: it would show one company's name over another
  // company's price.
  const quoteGenRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(function () { return function () { aliveRef.current = false; }; }, []);

  // One fetch per currency, once. They are cached server-side and none of them
  // moves fast enough to matter over a single visit to this screen.
  useEffect(function () {
    var cancelled = false;
    Promise.all(CURRENCIES.filter(function (c) { return c !== 'USD'; }).map(function (cur) {
      return fetch(ENDPOINTS.exchangeRate(cur))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var rate = d && d.rate;
          return (typeof rate === 'number' && isFinite(rate) && rate > 0) ? [cur, rate] : null;
        })
        .catch(function () { return null; });
    })).then(function (pairs) {
      if (cancelled) return;
      var next = { USD: USD_RATE };
      var got = 0;
      pairs.forEach(function (p) { if (p) { next[p[0]] = p[1]; got++; } });
      setRates(next);
      // Nothing but the hard-coded dollar came back: say so, rather than
      // showing a converter that quietly only converts dollars to dollars.
      if (got === 0) setRatesError(true);
    });
    return function () { cancelled = true; };
  }, []);

  // The heart of it. A share price is quoted in the stock's OWN currency -
  // Delek is in shekels, not dollars - so going straight from price to the
  // reader's currency with a USD rate would be wrong by the whole exchange
  // rate. Everything goes through the dollar.
  const convert = useCallback(function (amount, from, to) {
    if (amount == null || !isFinite(amount)) return null;
    var rf = rates[from], rt = rates[to];
    if (!rf || !rt || !isFinite(rf) || !isFinite(rt) || rf <= 0 || rt <= 0) return null;
    return (amount / rf) * rt;
  }, [rates]);

  const lookUp = useCallback(function () {
    var sym = String(ticker || '').trim().toUpperCase();
    if (!sym) return;
    Keyboard.dismiss();
    var myGen = ++quoteGenRef.current;
    setLoadingQuote(true);
    setQuoteErr(null);
    fetch(ENDPOINTS.quotes(sym))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!aliveRef.current || myGen !== quoteGenRef.current) return;
        var q = d && Array.isArray(d.quotes) ? d.quotes[0] : null;
        if (!q || typeof q.price !== 'number' || !isFinite(q.price) || q.price <= 0) {
          setQuote(null); setQuoteErr('notfound'); return;
        }
        setQuote(q);
      })
      .catch(function (err) {
        if (!aliveRef.current || myGen !== quoteGenRef.current) return;
        captureIssue('calculator quote failed', err);
        setQuote(null); setQuoteErr('net');
      })
      .then(function () {
        if (aliveRef.current && myGen === quoteGenRef.current) setLoadingQuote(false);
      });
  }, [ticker]);

  var priceCur = (quote && quote.price_currency) || 'USD';
  var unitInTarget = quote ? convert(quote.price, priceCur, target) : null;
  var sharesNum = parseNum(shares);
  var totalInTarget = (unitInTarget != null && sharesNum != null) ? unitInTarget * sharesNum : null;

  var budgetNum = parseNum(budget);
  var affordable = (unitInTarget != null && budgetNum != null && unitInTarget > 0)
    ? budgetNum / unitInTarget : null;
  var leftover = (affordable != null) ? (budgetNum - Math.floor(affordable) * unitInTarget) : null;

  var convNum = parseNum(convAmount);
  var convOut = convert(convNum, convFrom, convTo);

  return (
    <View style={[s.screen, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <BrandHeader greeting={t.calc_subtitle} />
      <ScrollView
        contentContainerStyle={[s.body, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled">

        {ratesError ? (
          <View style={[s.warn, { backgroundColor: colors.cardAlt, borderColor: colors.cardBorder }]}>
            <Text style={[s.warnText, { color: colors.text }, dir]}>{t.calc_no_rates}</Text>
          </View>
        ) : null}

        <Text style={[s.sectionLabel, { color: colors.textDim }, dir]}>{t.calc_currency_label}</Text>
        <Chips value={target} onChange={setTarget} colors={colors} rates={rates} />

        {/* ── shares → money ─────────────────────────────────────────────── */}
        <Card title={t.calc_holding_title} colors={colors} dir={dir}>
          <Field colors={colors} dir={dir}
            label={t.calc_ticker_label}
            value={ticker}
            onChangeText={setTicker}
            onSubmitEditing={lookUp}
            placeholder={t.calc_ticker_ph}
            keyboardType="default"
            autoCapitalize="characters"
            returnKeyType="search"
          />
          <TouchableOpacity
            onPress={lookUp}
            disabled={loadingQuote || !String(ticker).trim()}
            style={[s.button, {
              backgroundColor: colors.primary || '#f59e0b',
              opacity: (loadingQuote || !String(ticker).trim()) ? 0.5 : 1,
            }]}>
            {loadingQuote
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={s.buttonText}>{t.calc_fetch}</Text>}
          </TouchableOpacity>

          {quoteErr ? (
            <Text style={[s.error, { color: colors.red || '#dc2626' }, dir]}>
              {quoteErr === 'notfound' ? t.calc_not_found : t.calc_net_error}
            </Text>
          ) : null}

          {quote ? (
            <Result colors={colors} dir={dir}
              label={quote.company_name || quote.ticker}
              value={fmtMoney(quote.price, priceCur) + ' · ' + priceCur}
              note={priceCur !== target && unitInTarget != null
                ? t.calc_per_share + ' ' + fmtMoney(unitInTarget, target)
                : null}
            />
          ) : null}

          {/* Always on screen, price or no price. Hiding them until a quote
          arrived meant the card showed a ticker box and a button and gave
          no sign of what it was for - it read as though the sum had been
          taken away. Empty is honest; absent is misleading. */}
          <Field colors={colors} dir={dir}
          label={t.calc_shares_label}
          value={shares}
          onChangeText={setShares}
          placeholder="0"
          />
          <Result colors={colors} dir={dir}
          label={t.calc_total_label}
          value={totalInTarget != null ? fmtMoney(totalInTarget, target) : '—'}
          muted={totalInTarget == null}
          />

          {/* the same sum read backwards */}
          <View style={[s.divider, { backgroundColor: colors.cardBorder }]} />
          <Field colors={colors} dir={dir}
          label={t.calc_budget_label.replace('{cur}', symbolFor(target))}
          value={budget}
          onChangeText={setBudget}
          placeholder="0"
          />
          <Result colors={colors} dir={dir}
          label={t.calc_affordable_label}
          value={affordable != null ? fmtShares(affordable) : '—'}
          muted={affordable == null}
          note={affordable != null
          ? t.calc_leftover.replace('{amount}', fmtMoney(leftover, target))
          : null}
          />
        </Card>

        {/* ── money → money ──────────────────────────────────────────────── */}
        <Card title={t.calc_convert_title} colors={colors} dir={dir}>
          <Field colors={colors} dir={dir}
            label={t.calc_amount_label}
            value={convAmount}
            onChangeText={setConvAmount}
            placeholder="0"
          />
          <Text style={[s.label, { color: colors.textDim, marginTop: 2 }, dir]}>{t.calc_from_label}</Text>
          <Chips value={convFrom} onChange={setConvFrom} colors={colors} rates={rates} />
          <Text style={[s.label, { color: colors.textDim, marginTop: 2 }, dir]}>{t.calc_into_label}</Text>
          <Chips value={convTo} onChange={setConvTo} colors={colors} rates={rates} />
          <Result colors={colors} dir={dir}
            label={t.calc_to_label.replace('{cur}', convTo)}
            value={convOut != null ? fmtMoney(convOut, convTo) : '—'}
            muted={convOut == null}
            note={convFrom !== convTo && rates[convFrom] && rates[convTo]
              ? '1 ' + convFrom + ' = ' + ((rates[convTo] / rates[convFrom]).toFixed(4)) + ' ' + convTo
              : null}
          />
        </Card>

        {/* Rates move, and someone about to spend money should know how fresh
            the number is - or rather, that it is indicative and not a quote. */}
        <Text style={[s.disclaimer, { color: colors.textDim }, dir]}>{t.calc_disclaimer}</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 14 },
  sectionLabel: { fontSize: 12, fontWeight: '600', marginBottom: 8, marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  chip: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: '600' },
  card: { borderRadius: 12, borderWidth: 0.5, padding: 14, marginBottom: 14 },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 12 },
  field: { marginBottom: 10 },
  label: { fontSize: 12, marginBottom: 4 },
  input: { borderRadius: 8, borderWidth: 0.5, paddingVertical: 10, paddingHorizontal: 12, fontSize: 16 },
  button: { borderRadius: 8, paddingVertical: 11, alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  error: { fontSize: 12, marginTop: 8 },
  result: { borderTopWidth: 0.5, paddingTop: 10, marginTop: 12 },
  resultLabel: { fontSize: 12, marginBottom: 2 },
  resultValue: { fontSize: 22, fontWeight: '700' },
  resultNote: { fontSize: 12, marginTop: 2 },
  divider: { height: 0.5, marginTop: 14 },
  warn: { borderRadius: 8, borderWidth: 0.5, padding: 10, marginBottom: 12 },
  warnText: { fontSize: 12 },
  disclaimer: { fontSize: 11, lineHeight: 15, marginTop: 2 },
});
