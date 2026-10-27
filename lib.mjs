// Pure helpers (unit-tested). No dependencies.

export const LIMITS = { maxFiles: 400, maxFileBytes: 512 * 1024, maxTotalBytes: 7.5 * 1024 * 1024 };

const SKIP = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|vendor|\.git|\.turbo|\.vercel)(\/|$)|\.(min\.js|map|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|mp3|wasm|lock\.b)$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;

export function shouldInclude(path) {
  return !SKIP.test(path) && !path.split('/').some((s) => s === '..' || s === '');
}

export function isLockfile(path) {
  return LOCKFILE.test(path);
}

/** Parse `git diff -U0` output into { path: [[start, end], ...] } for added/modified lines. */
export function parseDiff(diff) {
  const out = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    const m = current && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) out.get(current).push([start, start + count - 1]);
    }
  }
  return out;
}

export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Choose files to upload within limits: most-changed files first.
 * @param {{path:string, content:string, changed:'all'|[number,number][]}[]} files
 */
export function selectFiles(files) {
  const weight = (f) => (f.changed === 'all' ? 1e6 : f.changed.reduce((n, [a, b]) => n + (b - a + 1), 0));
  const sorted = [...files].sort((a, b) => weight(b) - weight(a));
  const picked = [];
  let total = 0;
  for (const f of sorted) {
    const size = Buffer.byteLength(f.content);
    if (size > LIMITS.maxFileBytes || picked.length >= LIMITS.maxFiles || total + size > LIMITS.maxTotalBytes) continue;
    picked.push(f);
    total += size;
  }
  return { files: picked, skipped: files.length - picked.length };
}

const RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 99 };

export function shouldFail(failOn, counts) {
  const threshold = RANK[failOn] ?? RANK.high;
  return Object.entries(counts).some(([sev, n]) => n > 0 && (RANK[sev] ?? 0) >= threshold);
}

// GitLab CI (same client, other variables). See gitlab.mjs.

/** The event, base commit and ref of a GitLab pipeline, from its predefined variables. */
export function gitlabContext(env) {
  const mr = env.CI_MERGE_REQUEST_IID && /^\d+$/.test(env.CI_MERGE_REQUEST_IID) ? Number(env.CI_MERGE_REQUEST_IID) : null;
  const source = env.CI_PIPELINE_SOURCE ?? '';
  const before = env.CI_COMMIT_BEFORE_SHA;
  const base = mr ? env.CI_MERGE_REQUEST_DIFF_BASE_SHA || null : source === 'push' && before && !/^0+$/.test(before) ? before : null;
  const event = mr ? 'pull_request' : source === 'push' ? 'push' : source === 'schedule' ? 'schedule' : 'workflow_dispatch';
  const name = (env.CI_COMMIT_TAG || env.CI_COMMIT_BRANCH || env.CI_COMMIT_REF_NAME || 'unknown').replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 200);
  const ref = mr ? `refs/merge-requests/${mr}/head` : env.CI_COMMIT_TAG ? `refs/tags/${name}` : `refs/heads/${name}`;
  return { event, sha: env.CI_COMMIT_SHA, base: base && /^[0-9a-f]{40}$/.test(base) ? base : null, mr, ref };
}

export const NOTE_MARKER = '<!-- afterprompt-security-scan -->';

/** The merge request comment: grade, what's new in this change, and the report link. */
export function noteBody(status, reportUrl) {
  const n = status.new;
  return `${NOTE_MARKER}\n### Security scan: grade ${status.grade} (${status.score}/100)\n\nNew in this change: ${n.critical} critical, ${n.high} high, ${n.medium} medium, ${n.low} low.\n\n[Full report and fixes](${reportUrl})`;
}
