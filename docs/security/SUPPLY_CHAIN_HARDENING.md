# Supply-chain hardening — OriginTrail/dkg

This document is the single source of truth for the supply-chain controls
that protect the repo, its CI, and the npm packages it ships. It is the
human-readable side of the policies enforced by the files in this same PR
(workflow SHA-pins, `dependabot.yml`, `supply-chain-scan.yml`, `.npmrc`)
plus the admin-only changes that must be applied via the GitHub UI or
`gh` CLI by a maintainer with appropriate permissions.

The threat model is the **TeamPCP campaign** (March 2026, CVE-2026-33634)
and equivalent supply-chain compromises — tag-poisoning of consumed
GitHub Actions, credential-stealer injection in `pull_request_target`
workflows, and self-propagating npm worms like CanisterWorm.

If you are reading this because something looks compromised, jump to
[§Incident response](#incident-response).

---

## Controls already enforced by code in this repo

### 1. Every GitHub Action is pinned to a full commit SHA

Every `uses:` line in `.github/workflows/*.yml` references an action by
**full 40-character commit SHA**, never by a `vN` tag. Each pin carries
a `# vX.Y.Z` comment so humans can see the version at a glance.

Why: the TeamPCP attackers force-pushed 75 of 76 `aquasecurity/trivy-action`
tags to malicious commits. Anyone consuming the action by tag would have
silently run the credential stealer; consumers pinned to a SHA were
unaffected because GitHub commits are immutable.

Enforced by: `supply-chain-scan.yml` runs `zizmor --persona auditor
--min-severity low` on every PR. Tag pins fail the check.

### 2. Every workflow declares an explicit minimum `permissions:` block

`ci.yml`, `knip.yml`, and `evm-integration.yml` declare `permissions:
contents: read` at the workflow root. `release.yml` and
`npm-continuous-publish.yml` keep `contents: read` at root and narrow
write scopes to the single job that needs them. `codex-review.yml` has
always had this.

Why: without an explicit block, the `GITHUB_TOKEN` inherits the
permissive legacy default. A successful code-execution exploit on any
step then has a write-default token in the runner environment.

### 3. No `pull_request_target`, `workflow_run`, or `issue_comment` triggers

This is verified by inspection (see the matching gh-actions audit notes
in the v10-ui-tests PR review). `pull_request_target` is the trigger
class TeamPCP exploited to plant the initial foothold against Aqua
Security. We do not use it anywhere; `codex-review.yml` uses the safer
`pull_request` event AND additionally guards on
`github.event.pull_request.head.repo.full_name == github.repository`
to short-circuit fork PRs.

### 4. `npm-continuous-publish.yml` runs in the `npm-publish` Environment

The publish job references `environment: npm-publish`. With the matching
GitHub Environment configured (see [§Tier 2 admin steps](#tier-2-admin-steps)),
this lets a maintainer require:
- a manual approval before `NPM_TOKEN` becomes accessible to the job;
- a wait timer so an emergency revert can land before a malicious push
  to `main` auto-publishes.

### 5. Lifecycle scripts of dependencies are blocked by default

pnpm 10 refuses to run any package's `preinstall` / `install` / `postinstall`
unless the package is listed in the repo-root `package.json`'s
`pnpm.onlyBuiltDependencies` allowlist. Today that list is:
`better-sqlite3`, `esbuild`, `oxigraph`, `protobufjs`. The list lives at
`/package.json` and is reviewed in every PR.

Why: CanisterWorm spread via `postinstall` hooks. A poisoned transitive
dep cannot execute on our runners without explicit allowlisting.

`.npmrc` documents this and pins `verify-store-integrity=true` so a
locally-cached tarball that was tampered with after the fact fails the
SHA-256 verification on next install.

### 6. Dependabot is enabled for `github-actions` and `npm`

`.github/dependabot.yml` opens weekly PRs to bump:
- every `uses:` SHA when upstream cuts a new release (one grouped PR
  for first-party `actions/*` updates; individual PRs for third-party
  actions so each can be reviewed in isolation);
- every npm dep, with dev/build tooling grouped to manage review noise.

Why: the cheapest defence against a zero-day in a dep we already pull is
to land the patched version fast. Manual lockfile bumps slip; automated
PRs with release notes do not.

### 7. Static analysis of every workflow file on every PR

`.github/workflows/supply-chain-scan.yml` runs **zizmor** (purpose-built
GitHub-Actions audit; flags PWN-request misconfigs, unpinned actions,
unsafe expansions in `run:` blocks, missing permissions blocks) and
**actionlint** (workflow syntax + schema linter) on every PR that
touches `.github/`.

Findings upload to GitHub Security → Code scanning so they survive past
the PR's discussion timeline.

---

## Tier 2 admin steps (require maintainer GitHub UI/API access)

The following must be applied manually because they live in repo settings,
not in repo files. A maintainer with admin permission should run through
this section once, end-to-end.

### A. Tighten the `protect-main` ruleset

The existing ruleset (`gh api repos/OriginTrail/dkg/rulesets/14325863`)
already enforces no force-push, no deletion, and a code-owner-approved PR.
Add the following parameters so a single stale approval cannot rubber-stamp
a malicious follow-up push (the exact pattern an attacker would use after
compromising one maintainer's session):

```bash
gh api -X PUT repos/OriginTrail/dkg/rulesets/14325863 -f - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_signatures" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["merge", "rebase", "squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Build packages" },
          { "context": "Tornado: core + storage + chain" },
          { "context": "Bura: cli" },
          { "context": "Bura: query" },
          { "context": "Kosava: node-ui" },
          { "context": "Kosava: adapters + epcis + graph-viz + mcp-server + network-sim" },
          { "context": "Codex Review" },
          { "context": "zizmor (GitHub Actions audit)" },
          { "context": "actionlint (workflow syntax + schema)" }
        ]
      }
    }
  ]
}
JSON
```

What each new bit does:
- `required_signatures`: blocks unsigned commits. The TeamPCP tag-poisoning
  attack used unsigned commits with cloned author/timestamp metadata.
  Enforcing signatures stops that exact technique.
- `dismiss_stale_reviews_on_push: true`: any new commit invalidates prior
  approvals. Stops the "approve-then-push-malicious-commit" pattern.
- `require_last_push_approval: true`: the merger must be a different
  account from the last pusher. Stops a single compromised account from
  approving + merging its own PR.
- `required_review_thread_resolution: true`: blocks merge until reviewer
  threads are explicitly resolved (no silently-overridden objections).
- `required_status_checks`: makes the CI + supply-chain-scan jobs hard
  merge gates, not just informational signals.

### B. Replicate the ruleset for `v10-rc`

`v10-rc` is a release branch that feeds npm-continuous-publish. It is
currently unprotected:

```bash
gh api repos/OriginTrail/dkg/rules/branches/v10-rc   # → []
```

Create a parallel ruleset targeting `refs/heads/v10-rc`:

```bash
gh api -X POST repos/OriginTrail/dkg/rulesets -f - <<'JSON'
{
  "name": "protect-v10-rc",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/v10-rc"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_signatures" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["merge", "rebase", "squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Build packages" },
          { "context": "Tornado: core + storage + chain" },
          { "context": "Bura: cli" },
          { "context": "zizmor (GitHub Actions audit)" }
        ]
      }
    }
  ]
}
JSON
```

### C. Configure the `npm-publish` GitHub Environment

The publish job references `environment: npm-publish` but the environment
itself must be created in repo settings. Settings → Environments → **New
environment** → name it `npm-publish`, then:

1. **Required reviewers**: add at least one (ideally two) maintainer
   accounts. Without this set the environment is decorative — GitHub
   Actions does NOT fail-closed on a missing environment configuration.
2. **Wait timer**: 5 minutes is the minimum useful value. Gives a
   reviewer a window to abort if something looks wrong.
3. **Deployment branches**: restrict to `main` only. Default allows any
   branch, which would let a feature branch publish if the workflow were
   ever triggered against it.
4. **Environment secrets**: move `NPM_TOKEN` from repo-level secrets to
   this environment. Repo-level `NPM_TOKEN` would still be accessible to
   any workflow run on `main`, defeating the point.

Verify via:

```bash
gh api repos/OriginTrail/dkg/environments/npm-publish
```

### D. Enable required signed commits on the personal level

`required_signatures` in §A enforces signatures, but only blocks unsigned
commits server-side. Each maintainer should also configure local git to
sign commits by default. Either GPG or SSH-key signing works:

```bash
# SSH-based commit signing (simplest if you already have an SSH key in your
# GitHub account's "Signing keys" list):
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

Then verify on the next commit:

```bash
git log -1 --show-signature   # should print "Good signature"
```

### E. Enable repo-level security features

Settings → Code security:
- **Private vulnerability reporting**: ON. Gives external researchers a
  triaged path instead of forcing them to post on X.
- **Dependency graph**: ON (probably already on for public repos).
- **Dependabot alerts**: ON.
- **Dependabot security updates**: ON.
- **Secret scanning**: ON.
- **Push protection**: ON. Refuses pushes that contain detected secret
  patterns; the cheapest defence against accidentally landing an
  unrotated NPM_TOKEN in a commit.
- **Code scanning default setup**: leave the existing CodeQL workflow.
  Our supply-chain-scan job complements it.

---

## Tier 3 admin steps — defence-in-depth

These reduce the blast radius of a successful attack further, but are
more involved than the Tier 2 list above. Apply when there's bandwidth.

### F. Migrate `NPM_TOKEN` to npm Trusted Publishing (OIDC)

npm supports OIDC-based publishing for github.com publishers, removing
the long-lived `NPM_TOKEN` entirely. The flow is:

1. On npmjs.com, for each `@origintrail-official/*` package, enable
   **Trusted publishing** under Package settings, pointing at:
   - Repository: `OriginTrail/dkg`
   - Workflow: `.github/workflows/npm-continuous-publish.yml`
   - Environment: `npm-publish`
2. Replace the `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` env in
   `npm-continuous-publish.yml` with `permissions: { id-token: write }`
   on the job, and use `npm publish --provenance` (pnpm has an
   equivalent flag).
3. Revoke the existing `NPM_TOKEN` on npmjs.com once provenance
   publishes are verified working.

After this, no long-lived npm credential exists anywhere. A
CanisterWorm-style worm cannot exfiltrate something we don't have.

### G. Turn on GitHub immutable releases on this repo

Settings → Code & automation → **Releases** → **Immutable releases**:
ON. Once enabled, no one — not even an admin — can move an existing
release tag, and the GitHub web UI marks each release as "Immutable".
This is the single control that protected `trivy-action@0.35.0` during
the TeamPCP attack.

### H. Hook `pnpm audit` into CI

Add a job to `.github/workflows/supply-chain-scan.yml` (already in this
PR) that runs `pnpm audit --audit-level=high` and fails the check on any
finding. Currently we surface npm advisories via Dependabot alerts; this
turns the same data into a hard merge gate.

A starter snippet (review before adopting):

```yaml
  audit:
    name: pnpm audit (high+ severity)
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@<SHA-here>  # see existing SHA pins
      - uses: pnpm/action-setup@<SHA-here>
      - uses: actions/setup-node@<SHA-here>
        with:
          node-version-file: .nvmrc
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --audit-level=high --prod
```

`--prod` excludes devDeps so a vuln in `vitest` doesn't block a release.

### I. Reduce direct npm-publish surface area

Most of our 11 workspace packages are private workspace deps consumed
internally. Re-audit which packages actually need to be published to
npm; mark the rest `"private": true`. The fewer packages we publish, the
narrower the CanisterWorm attack surface.

---

## What this PR does and does not change

**Done in this PR (file-level changes):**
- SHA-pinned every `uses:` in every workflow.
- Added explicit `permissions:` blocks to `ci.yml`, `knip.yml`,
  `evm-integration.yml`, and narrowed scope in `release.yml`.
- Added `environment: npm-publish` to `npm-continuous-publish.yml`.
- Created `.github/dependabot.yml`.
- Created `.github/workflows/supply-chain-scan.yml` (zizmor + actionlint).
- Hardened `.npmrc` (explicit `verify-store-integrity`; comments
  documenting why `ignore-scripts` is NOT set).
- This document.

**Not done in this PR (require maintainer admin clicks):**
- Tighten the `protect-main` ruleset (Tier 2 §A).
- Create the `protect-v10-rc` ruleset (Tier 2 §B).
- Configure the `npm-publish` Environment with required reviewers and
  move `NPM_TOKEN` into it (Tier 2 §C).
- Enable required-signed-commits + each maintainer's signing key
  (Tier 2 §D).
- Repo-level security features: private vulnerability reporting,
  secret-scanning push protection (Tier 2 §E).
- npm Trusted Publishing migration (Tier 3 §F).
- Immutable releases setting (Tier 3 §G).
- `pnpm audit` CI gate (Tier 3 §H).
- Workspace-package publish surface review (Tier 3 §I).

---

## Incident response

If you have specific evidence of compromise (a tag we use was force-pushed,
a CI run showed an unexpected `pip`/`curl` to an attacker domain, a leaked
NPM_TOKEN appears in a public paste, etc.):

1. **Rotate first, investigate second.** In order: `NPM_TOKEN`,
   `OPENAI_API_KEY`, `TURBO_TOKEN`, every personal access token any
   maintainer has against the repo. Force-revoke each one in the
   provider UI rather than just deleting and replacing the secret.
2. **Suspend the affected workflows.** Settings → Actions → General →
   "Disable Actions for this repository" while you investigate.
3. **Pull the runner audit log.** `gh api repos/OriginTrail/dkg/actions/runs/<id>/logs`
   and grep for unexpected `pip install`, `npm install`, `curl`, `wget`
   to non-localhost.
4. **Check for `tpcp-docs` or similar fallback-exfiltration repos** on
   the GitHub org and on every maintainer's account. The TeamPCP stealer
   creates a public repo named `tpcp-docs` under the victim's GitHub
   account when its primary C2 is unreachable.
5. **Mass-replace npm tokens AND any cloud-provider OIDC trust** since
   the credential-stealer scrapes ~50 paths including `~/.aws/credentials`
   and Kubernetes config.
6. Once contained, file a private security advisory on the repo:
   `gh api repos/OriginTrail/dkg/security-advisories -X POST …`.
