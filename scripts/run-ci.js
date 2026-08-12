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
    const res = spawnSync('bash', ['-c', step.run.replace(/\bpython\b/g, PY)],
                          { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

    if (res.error) {
      console.error('\n' + RED + 'could not run bash: ' + res.error.message + RESET);
      console.error('On Windows this comes with Git — make sure Git\'s bin folder is on PATH.\n');
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
