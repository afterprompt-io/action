# Security scan GitHub Action

```yaml
# .github/workflows/security.yml
name: Security scan
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write   # short-lived OIDC token: no API key to store
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: afterprompt-io/action@v1
        with:
          api-url: https://<your Afterprompt domain>   # required, copy it from your dashboard
          fail-on: high   # critical | high | medium | none
```

- Uploads **only changed files** (plus changed lockfiles) and the changed line ranges. Full scan on the first push and on manual or scheduled runs.
- Authenticates with GitHub's OIDC token; the API checks it is for this exact repository and commit.
- Code is encrypted in transit, scanned in a throwaway network-less sandbox, and never stored. Only findings are kept.
- No third-party dependencies: this action is ~150 lines of plain Node.js you can read.
