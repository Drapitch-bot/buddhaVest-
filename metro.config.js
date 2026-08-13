/**
 * Metro bundler configuration.
 *
 * The only reason this file exists is `maxWorkers`.
 *
 * Metro's default is one worker per CPU core. On this machine that is 12, and
 * `eas update` therefore holds every core at 100% for the length of a full
 * bundle. That is the heaviest thing any script in this repo does.
 *
 * On 2026-08-12 and 08-13 the machine shut down three times while push.bat was
 * running: Event 41 + 6008 each time, and no Event 1074 — so nothing asked for
 * a shutdown, it hung or lost power. A push that skipped the bundle completed
 * normally. That is consistent with sustained all-core load rather than proof
 * of it, and this file is the cheap half of the response: cap the workers so a
 * bundle costs a fraction of the machine instead of all of it.
 *
 * The bundle takes longer. A slower bundle that finishes beats a faster one
 * that takes the computer down, and this app is bundled a few times a week.
 *
 * The other half is moving the bundle off this machine entirely — see
 * .github/workflows/ota.yml.
 */

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Leave the machine usable. Four workers on a 12-core box is roughly a third
// of the CPU, which keeps the fans and the power draw well short of the wall
// the last three runs appear to have hit.
config.maxWorkers = 4;

module.exports = config;
