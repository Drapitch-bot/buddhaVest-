/**
 * run-ci.js — run the whole GitHub Actions workflow here, before pushing.
 *
 * Why this exists: on 2026-08-12 a commit went out with a failing build, and
 * the first anyone knew of it was an email from GitHub. The cause was not the
 * code — it was the habit. I had run the test files, decided that counted as
 * "CI passes", and pushed. But more than half of ci.yml is not tests: it is
 * lint-style checks that read the source (no silent swallows, no orphan style
 * keys, i18n parity, no secrets in the bundle), and one of those was what
 * failed. Running the tests and calling it CI is checking the half you already
 * expected to pass.
 *
 * So this does not reimplement the checks. It reads .github/workflows/ci.yml
 * and executes every `run:` step exactly as written, in the declared
 * working-directory. A step can never drift from what CI actually runs,
 * because it IS what CI runs.
 *
 * Skipped: `pip install` and `npm ci`, which only install what is already here.
 *
 *   node scripts/run-ci.js          all jobs
 *   node scripts/run-ci.js python   one job
 */

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', BOLD = '\x1b[1m';

const root = execSync('git rev-parse --show-toplevel',
                      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const wf = path.join(root, '.github', 'workflows', 'ci.yml');
if (!fs.existsSync(wf)) {
  console.error('no .github/workflows/ci.yml here');
  process.exit(1);
}

const doc = YAML.parse(fs.readFileSync(wf, 'utf8'));
const only = process.argv[2];

// GitHub's runners call it `python`; Windows installs it as `python` too, but
// a bare Linux/macOS box may only have `python3`. Resolve once and tell the
// steps about it via PATH rather than rewriting their command lines.
function pythonCmd() {
  for (const c of ['python', 'python3']) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const PY = pythonCmd();
if (!PY) {
  console.error('python not found on PATH');
  process.exit(1);
}

/**
 * The bash to run steps with — and, on Windows, emphatically NOT the one that
 * comes first on PATH.
 *
 * Windows ships C:\Windows\System32\bash.exe. It is not a shell: it is the
 * launcher for the Windows Subsystem for Linux. System32 sits near the front
 * of PATH on essentially every machine, so a bare spawn('bash') finds THAT
 * one, and each call boots or attaches a WSL 2 virtual machine. This script
 * makes 23 of them back to back, on a machine already running Node, Python
 * and whatever else — and a WSL 2 VM reserves memory up front.
 *
 * Reported on 2026-08-12: running push.bat took the machine down. This is the
 * mechanism I can name and rule out, so it is ruled out here by construction:
 * anything under System32 is refused outright, and the bash that ships with
 * Git for Windows is located directly instead of being looked up by name.
 *
 * If neither is found, this stops with an explanation. It does not fall back
 * to the PATH lookup — the whole point is not to run that one.
 */
function resolveBash() {
  if (process.platform !== 'win32') return 'bash';

  const tried = [];
  const candidates = [];

  // Ask git where it lives, and take the bash next to it. More reliable than
  // guessing Program Files, and it works for portable installs.
  try {
    const gitPath = execSync('where git', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')[0].trim();
    if (gitPath) {
      const gitRoot = path.resolve(path.dirname(gitPath), '..');
      candidates.push(path.join(gitRoot, 'bin', 'bash.exe'));
      candidates.push(path.join(gitRoot, '..', 'bin', 'bash.exe'));
    }
  } catch { /* git not on PATH; the fixed locations below still apply */ }

  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
                      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }

  const sys32 = (process.env.SystemRoot || 'C:\\Windows').toLowerCase() + '\\system32';
  for (const c of candidates) {
    const full = path.resolve(c);
    tried.push(full);
    if (full.toLowerCase().startsWith(sys32)) continue;      // the WSL launcher
    if (fs.existsSync(full)) return full;
  }

  console.error('\n' + RED + 'Could not find the bash that ships with Git for Windows.' + RESET);
  console.error('Looked in:');
  tried.forEach(t => console.error('  ' + t));
  console.error('\nNot falling back to whatever `bash` is on PATH: on Windows that is');
  console.error('usually C:\\Windows\\System32\\bash.exe, which starts a WSL virtual');
  console.error('machine rather than a shell.\n');
  console.error('Install Git for Windows, or run the checks one at a time:');
  console.error('  cd assets\\1BuddhaVest && ' + PY + ' test_market_cap.py\n');
  process.exit(2);
}

const BASH = resolveBash();
console.log(DIM + 'shell:  ' + BASH + RESET);
console.log(DIM + 'python: ' + PY + RESET);

let failed = [];
let ran = 0;

for (const [jobName, job] of Object.entries(doc.jobs || {})) {
  if (only && only !== jobName) continue;
  console.log('\n' + BOLD + '── ' + jobName + ' — ' + (job.name || '') + RESET);

  for (const step of job.steps || []) {
    if (!step.run) continue;                       // `uses:` steps: checkout, setup-*
    const name = step.name || step.run.trim().split('\n')[0].slice(0, 60);
    if (/npm ci|pip install/.test(step.run)) {
      console.log('  ' + DIM + 'skip  ' + name + '  (installs only)' + RESET);
      continue;
    }

    const cwd = path.join(root, step['working-directory'] || '.');
    // Steps are written for GitHub's bash. On Windows, Git for Windows ships
    // one; without it there is no honest way to run the workflow and pretending
    // otherwise is how you end up trusting a check that never ran.
    const res = spawnSync(BASH, ['-c', step.run.replace(/\bpython\b/g, PY)],
                          { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

    if (res.error) {
      console.error('\n' + RED + 'could not run ' + BASH + ': ' + res.error.message + RESET);
      process.exit(2);
    }

    ran++;
    if (res.status === 0) {
      console.log('  ' + GREEN + 'ok  ' + RESET + '  ' + name);
    } else {
      failed.push(jobName + ' / ' + name);
      console.log('  ' + RED + 'FAIL' + RESET + '  ' + name);
      const out = ((res.stdout || '') + (res.stderr || '')).trimEnd().split('\n');
      for (const line of out.slice(-18)) console.log('        ' + DIM + '|' + RESET + ' ' + line);
    }
  }
}

console.log();
if (failed.length) {
  console.log(RED + failed.length + ' of ' + ran + ' step(s) FAILED:' + RESET);
  failed.forEach(f => console.log('  - ' + f));
  console.log('\nFix these before pushing; GitHub will run exactly the same steps.\n');
  process.exit(1);
}
console.log(GREEN + 'All ' + ran + ' steps passed — the same ones GitHub will run.' + RESET + '\n');
