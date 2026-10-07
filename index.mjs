// GitHub Action entry point. Node 20 built-ins only: no third-party code runs in your CI.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { LIMITS, isBinary, isLockfile, parseDiff, selectFiles, shouldFail, shouldInclude } from './lib.mjs';

const input = (name, def) => process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || def;
const rawApiUrl = input('api-url', '');
if (!rawApiUrl) {
  console.log('::error::Set the `api-url` input (copy the workflow from your Afterprompt dashboard). There is no default on purpose.');
  process.exit(1);
}
const apiUrl = new URL(rawApiUrl).origin;
if (!apiUrl.startsWith('https://')) {
  console.log('::error::`api-url` must use https:// so your code is encrypted in transit.');
  process.exit(1);
}
const failOn = input('fail-on', 'high');
const timeoutMs = Number(input('timeout-minutes', '10')) * 60_000;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const setOutput = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const summary = (md) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('OIDC is not available. Add `permissions: { id-token: write, contents: read }` to the job.');
  const res = await fetch(`${url}&audience=${encodeURIComponent(apiUrl)}`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`Could not get an OIDC token (${res.status})`);
  return (await res.json()).value;
}

function collect() {
  const event = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sha = process.env.GITHUB_SHA;
  let base = null;
  if (event === 'pull_request' || event === 'pull_request_target') base = payload.pull_request?.base?.sha ?? null;
  else if (event === 'push' && payload.before && !/^0+$/.test(payload.before)) base = payload.before;

  let ranges;
  if (base) {
    try {
      git('cat-file', '-e', `${base}^{commit}`);
    } catch {
      git('fetch', '--no-tags', '--depth=1', 'origin', base);
    }
    ranges = parseDiff(git('diff', '-U0', '--no-color', '--diff-filter=ACMR', base, 'HEAD'));
  } else {
    // First push / manual / scheduled run: full scan of tracked files.
    ranges = new Map(git('ls-files').split('\n').filter(Boolean).map((p) => [p, 'all']));
  }

  const files = [];
  for (const [path, changed] of ranges) {
    if (!shouldInclude(path)) continue;
    if (changed !== 'all' && changed.length === 0) continue;
    let buf;
    try {
      buf = readFileSync(path);
    } catch {
      continue;
    }
    if (buf.length > LIMITS.maxFileBytes || isBinary(buf)) continue;
    // Lockfiles: only when changed (or on full scans), so old advisories don't fail every PR.
    files.push({ path, content: buf.toString('utf8'), changed: isLockfile(path) ? 'all' : changed });
  }
  return { event: event === 'pull_request_target' ? 'pull_request' : ['push', 'pull_request', 'workflow_dispatch', 'schedule'].includes(event) ? event : 'workflow_dispatch', sha, base, pr: payload.pull_request?.number, ref: process.env.GITHUB_REF, files };
}

async function main() {
  const c = collect();
  const { files, skipped } = selectFiles(c.files);
  console.log(`Uploading ${files.length} changed file(s)${skipped ? ` (${skipped} skipped: size limits)` : ''}. Code is encrypted in transit and never stored.`);
  if (files.length === 0) {
    console.log('Nothing to scan in this change.');
    return;
  }
  const body = JSON.stringify({ v: 1, event: c.event, sha: c.sha, ...(c.base ? { baseSha: c.base } : {}), ref: c.ref, ...(c.pr ? { pr: c.pr } : {}), files });
  const res = await fetch(`${apiUrl}/api/ci/scans`, { method: 'POST', headers: { authorization: `Bearer ${await oidcToken()}`, 'content-type': 'application/json' }, body });
  const created = await res.json().catch(() => ({}));
  if (res.status === 402 && created.error === 'quota_exceeded') throw new Error('Monthly deep-scan quota reached for this account. It resets on the 1st (UTC); upgrade your plan for more.');
  if (res.status === 402) throw new Error('This repository is connected, but the account has no active plan.');
  if (res.status === 404) throw new Error('This repository is not connected. Install the GitHub App from your dashboard first.');
  if (!res.ok) throw new Error(`Upload rejected: ${created.error ?? res.status}`);
  setOutput('report-url', created.reportUrl);

  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await fetch(`${apiUrl}/api/ci/scans/${created.scanId}`, { headers: { authorization: `Bearer ${await oidcToken()}` } });
    if (!s.ok) continue;
    status = await s.json();
    if (status.status === 'completed' || status.status === 'failed') break;
  }
  if (!status || status.status !== 'completed') throw new Error(`Scan did not complete${status?.errorCode ? `: ${status.errorCode}` : ' in time'}. Report: ${created.reportUrl}`);

  setOutput('grade', status.grade);
  const n = status.new;
  const line = `Grade **${status.grade}** (${status.score}/100). New in this change: ${n.critical} critical, ${n.high} high, ${n.medium} medium, ${n.low} low.`;
  console.log(line.replace(/\*\*/g, ''));
  summary(`### Security scan\n${line}\n\n[Full report and fixes](${created.reportUrl})`);
  if (shouldFail(failOn, n)) {
    process.exitCode = 1;
    console.log(`::error::New ${failOn}+ severity findings. See ${created.reportUrl}`);
  }
}

main().catch((e) => {
  console.log(`::error::${e.message}`);
  process.exitCode = 1;
});
