# Verification plan — issue #437 / PR #443 (Codex CLI TOML auto-detect)

**Owner:** `qa-engineer`
**Status:** v2 — narrowed to Codex-CLI-only per PR #443 round-4 Codex Review (2026-05-08). Phase 2 manual-smoke execution pending team-lead dispatch.
**Date:** 2026-05-08
**Branch:** `feat/mcp-setup-codex-continue` (worktree `C:/Projects/dkg-v9-mcp-437`).
**Issue:** [#437](https://github.com/OriginTrail/dkg/issues/437) — auto-detect Codex CLI (TOML) + Continue (YAML/JSON) in `dkg mcp setup`.
**PR:** [#443](https://github.com/OriginTrail/dkg/pull/443).
**Scope source:** `C:/Users/jurij/.claude/plans/ethereal-dazzling-scott.md` §Verification.

> **Note on Continue scope (added 2026-05-08, v2):** the original v1 of this plan covered both Codex CLI (TOML) AND Continue (YAML/JSON) per the issue title and the original plan. **Continue was deferred during PR #443 iteration** (commits `b401dceb` README revert + `9ac26dc4` mcp-setup revert; Continue's workspace-local config layout didn't fit the home-dir-anchored detection pattern cleanly). PR #443 ships Codex CLI only; Continue moves to a follow-up tracked as #444. This v2 narrows the verification-plan to Codex-CLI-only behavior. The deferred Continue gates (manual YAML round-trip, JSON fallback, FIX 26 in YAML, Continue WSL implications) are **out of scope for this PR** — they'll be re-introduced in the #444 verification plan.

---

## Scope summary

One new client added to `detectClients()` in `packages/cli/src/mcp-setup.ts`:

1. **Codex CLI** — config at `~/.codex/config.toml` (TOML format). Block: `[mcp_servers.dkg]` with `command` and `args` keys.

Test count progression expected: **98 (PR #394 baseline) → ~103 at HEAD `9ac26dc4`** (+5 covering Codex CLI candidate detection, write, idempotency, FIX 26 preservation in TOML, classify-stale parity).

The implementation reuses the existing `ClientTarget` dispatch shape established in PR #394 phase-1; **no architecture changes**. Per-client format dispatch happens at the read/write boundary via a `format: 'json' | 'toml'` field on `ClientTarget` (mcp-lead's #107 design). `'yaml'` was a stage in iteration but reverted; the production dispatch only needs `'json'` and `'toml'` for PR #443.

---

## Section 1 — Pre-merge unit + build gates

### 1.1 Unit suite green

```bash
cd C:/Projects/dkg-v9-mcp-437
pnpm --filter @origintrail-official/dkg exec vitest run mcp-setup.test.ts
```

**Pass criteria:**
- `Tests <N> passed (<N>)` where `N` is in the **~103** range (98 PR #394 baseline + ~5 Codex CLI cases).
- `Test Files 1 passed (1)`.
- Exit code 0.

**Coverage expected from the new tests** (per plan §Part 3 + my read of the implementation contract, narrowed to Codex CLI):

- Codex CLI candidate:
  - Detected when `~/.codex/config.toml` exists (or `~/.codex/` dir is present per the existing detection-permissive convention).
  - Writes `[mcp_servers.dkg]` block with `command = "..."` and `args = ["mcp", "serve"]`.
  - Idempotent: re-run leaves the block byte-aligned (or differs only in whitespace within tolerance documented in §6 below).
- FIX 26 preservation in TOML:
  - Pre-populate `[mcp_servers.dkg]` with a user-added `cwd = "/somewhere"` key before setup.
  - Run setup `--force`.
  - Confirm `cwd` survives alongside refreshed `command` / `args`.
- Classify-stale parity: TOML format triages registered/stale/not-registered the same way JSON does.

**Failure mode signalling:**
- If test count is < 100, fewer Codex CLI cases shipped than the plan calls for; flag for parity with the 6 already-shipped JSON clients (each got ~3-5 tests in PR #394).
- If test count is > 105, mcp-lead landed extra cases (likely covering an unforeseen edge case — flag for inspection but not blocking).

### 1.2 Build green

```bash
cd C:/Projects/dkg-v9-mcp-437
pnpm run build
```

**Pass criteria:**
- Turbo emits `Tasks: <N> successful, <N> total`.
- No type errors from `@iarna/toml` integration.
- `node packages/cli/dist/cli.js mcp setup --help` output is unchanged (same flags, same description text — no flag drift from #437 work).

### 1.3 Affected adjacent tests stay green

```bash
cd C:/Projects/dkg-v9-mcp-437
pnpm --filter @origintrail-official/dkg-mcp test
pnpm --filter @origintrail-official/dkg-adapter-autoresearch test
pnpm --filter @origintrail-official/dkg-adapter-openclaw test
```

**Pass criteria:**
- `dkg-mcp` 88/88 (or whatever the current main count is — track from `git log` of recent test-touching commits).
- `dkg-adapter-autoresearch` 37/37.
- `dkg-adapter-openclaw` 808/810 (the 2 pre-existing R7 failures from PR #381 stay; if the count changes, flag — those failures are unrelated to #437 but a new failure post-#437 is a regression vector).

---

## Section 2 — Manual smoke for Codex CLI (TOML)

### 2.1 Pre-conditions

- Real workstation OS (Mac or Windows; not Docker, per PR #381's gate-swap posture).
- A user account WITHOUT a pre-existing `~/.codex/` directory, OR with the dir cleaned via `rm -rf ~/.codex`.
- Codex CLI installed via its documented install path (e.g. the GitHub release tarball or `npm i -g @openai/codex` if that's the published path on the test day; verify the install command at smoke time since CLI tools change).
- Built `dkg` CLI from this branch: `cd C:/Projects/dkg-v9-mcp-437 && pnpm --filter @origintrail-official/dkg build`.

### 2.2 Procedure

```bash
# 1. Confirm pre-state: no Codex CLI config.
ls ~/.codex/ 2>&1   # expect: no such file or directory

# 2. Install Codex CLI per its docs. Verify it created ~/.codex/.
codex --version     # version number; confirms install
ls ~/.codex/        # expect: at least config.toml or a config dir

# 3. Run dkg mcp setup --print-only to see what WOULD be written
#    without mutating any client config. Per team-lead 2026-05-08
#    answer to plan §10 question 5: --print-only emits the canonical
#    block in the right format for each detected client. So when Codex
#    CLI is detected, the print-only output for that client is TOML —
#    NOT generic canonical-JSON. Tighter feedback loop for the smoke
#    tester.
node /abs/path/to/dkg-v9-mcp-437/packages/cli/dist/cli.js mcp setup --print-only

# 4. Run the actual setup (with --yes to skip TTY prompt).
node /abs/path/to/dkg-v9-mcp-437/packages/cli/dist/cli.js mcp setup --yes

# 5. Inspect the written TOML.
cat ~/.codex/config.toml
```

### 2.3 Pass criteria

- Step 4 setup output includes a line referencing Codex CLI (e.g. "Registered Codex CLI → ~/.codex/config.toml").
- `~/.codex/config.toml` contains a `[mcp_servers.dkg]` block.
- Inside that block: `command = "..."` (the resolved absolute `dkg` bin path per F30 from PR #394, OR `node /abs/cli.js` if running in the monorepo) and `args = ["mcp", "serve"]`.
- Other top-level Codex CLI config (anything outside `[mcp_servers.dkg]`) is preserved byte-for-byte. **This is the load-bearing TOML lib check** — see §6 trade-off note.
- Launch Codex CLI; from inside the agent, query `dkg_status`. Expect a 21-tool surface response (the same surface PR #381 validated). If the daemon isn't running, expect a "daemon not reachable" error — that's still a pass for THIS gate (it confirms the MCP wiring; daemon liveness is a separate concern).

### 2.4 Failure modes to flag

- **TOML reformat of unrelated sections.** If the TOML lib touches `[other.section]` blocks (whitespace, key reordering, comment loss in unrelated sections), block. Plan §Verification line 202 explicitly calls this out as the trade-off red line.
- **`mcp_servers.dkg` written under wrong key path.** TOML allows both `[mcp_servers.dkg]` (table syntax) and `mcp_servers = { dkg = {...} }` (inline-table syntax). Per Codex CLI documentation, the table syntax is canonical — block if mcp-lead's serializer emits inline-table form for the `dkg` entry (other sections may differ).
- **Codex CLI doesn't load the entry.** If Codex CLI launches but `dkg_status` errors with "no such tool" or similar, the entry is malformed. Read `~/.codex/config.toml` byte-for-byte against the Codex CLI docs and pin the divergence.

---

## Section 3 — FIX 26 preservation real-world (Codex CLI TOML)

FIX 26 (from PR #394) ensures user-added keys inside the canonical `mcpServers.dkg` / `[mcp_servers.dkg]` block survive a `--force` re-run. The unit tests in §1.1 cover this contract; this section is the real-world smoke against an actual TOML file.

### 3.1 Procedure

```bash
# Pre-populate the TOML with a user key inside the dkg block AND
# an unrelated section that the TOML lib must not touch.
cat > ~/.codex/config.toml <<'EOF'
[mcp_servers.dkg]
command = "stale-old-bin"
args = ["mcp", "serve"]
cwd = "/Users/jurij/projects"
env = { DKG_API = "http://localhost:9300" }

[other.section]
unrelated = true
EOF

# Force re-run.
node /abs/path/to/dkg-v9-mcp-437/packages/cli/dist/cli.js mcp setup --yes --force

# Inspect.
cat ~/.codex/config.toml
```

### 3.2 Pass criteria

- `[mcp_servers.dkg]` `command` is refreshed to the resolved `dkg` bin path (or `node /abs/cli.js` in monorepo mode).
- `[mcp_servers.dkg]` `args = ["mcp", "serve"]` is canonical.
- `[mcp_servers.dkg]` `cwd = "/Users/jurij/projects"` SURVIVES.
- `[mcp_servers.dkg]` `env = { DKG_API = "http://localhost:9300" }` SURVIVES.
- `[other.section]` `unrelated = true` SURVIVES, byte-for-byte.

### 3.3 Failure modes to flag

- **User-added `cwd` / `env` inside `[mcp_servers.dkg]` is dropped.** Block — this is the FIX 26 contract.
- **`[other.section]` is touched** (any whitespace, key-order, or comment change). Block — blast radius beyond the dkg block is a regression.

---

## Section 4 — Cross-platform smoke

Per PR #381's gate posture: real workstation OS, not Docker. Mac + Windows minimum; Linux follows.

### 4.1 macOS

- §2 + §3 procedures run on the dev's primary Mac.
- Verify `~/.codex/config.toml` resolves under `/Users/<name>/.codex/`.
- `dkg` bin via `which dkg` should resolve absolute path (PR #394 F30).

### 4.2 Windows (PowerShell, native — NOT WSL)

- §2 + §3 procedures run on a Windows test box (or VM).
- Verify Codex CLI's Windows-native config path. **Plan question:** Codex CLI on Windows — does it use `%USERPROFILE%\.codex\config.toml` or `%APPDATA%\codex\config.toml`? Smoke this against the real install; document the resolved path; cross-check with `mcp-setup.ts`'s candidate path resolution.
- `dkg.cmd` shim: `where dkg` should resolve the npm-shim path; PR #394 F30 covers this with `where.exe`.

### 4.3 Linux (deferred to release-readiness)

Linux smoke is release-readiness, not pre-merge — same posture as PR #381's deferred Mac+Linux gate. Codex CLI has a well-documented Linux path (`~/.codex/`); the unit tests stub `homedir()` and `platform()` so the per-platform path resolution is contract-pinned. Live Linux smoke catches OS-version-specific edge cases.

---

## Section 5 — Existing-clients regression sweep

The brief calls this out specifically: re-run `dkg mcp setup` against a sandbox config that has all 6 pre-existing clients pre-populated (Cursor, Claude Code, Claude Desktop, Windsurf, VSCode + Copilot Chat, Cline) AND the new Codex CLI client to surface any spurious diff or shape drift.

### 5.1 Procedure

```bash
# Build a sandbox HOME with pre-populated entries for all 7 clients
# (6 existing JSON + 1 new TOML).
SANDBOX=$(mktemp -d)
mkdir -p $SANDBOX/.cursor $SANDBOX/.codex $SANDBOX/.codeium/windsurf
mkdir -p "$SANDBOX/Library/Application Support/Claude"   # Mac path
mkdir -p $SANDBOX/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings

# Pre-populate canonical entries for all 7 (snapshot the post-#394
# canonical shape via `dkg mcp setup --print-only` for the 6 known
# JSON clients; for Codex CLI use the TOML shape from §2). Then
# sandbox-HOME-redirect:
DKG_HOME_OVERRIDE=$SANDBOX node /abs/cli.js mcp setup --yes

# Diff before / after for each file.
diff -u $SANDBOX_BEFORE/.cursor/mcp.json $SANDBOX/.cursor/mcp.json
diff -u $SANDBOX_BEFORE/.claude.json $SANDBOX/.claude.json
diff -u $SANDBOX_BEFORE/.codex/config.toml $SANDBOX/.codex/config.toml
# ... etc. for each of the 7 clients.
```

### 5.2 Pass criteria

- Each `diff -u` between pre and post output is **empty** (no changes when entries are already canonical).
- A second run with `--force` MAY produce diffs limited to the `mcpServers.dkg` / `[mcp_servers.dkg]` block — those are intentional refreshes. Anything outside that block is a regression.

### 5.3 Failure modes to flag

- **Any spurious whitespace diff in a JSON client** (one of the 6 already-shipped). Block — that's a regression in the JSON serializer regress brought in by adding TOML siblings.
- **A JSON-shaped entry rendering through the TOML serializer.** Could happen if the dispatch on `format: 'toml'|'json'` mis-routes. Block.
- **A TOML-shaped entry rendering through the JSON serializer** (the inverse — `~/.codex/config.toml` written as JSON). Block.

---

## Section 6 — WSL implications (Codex CLI only)

The brief asks whether Codex CLI needs an additive Windows-side entry in the WSL block at `mcp-setup.ts:813-867`. The current WSL block adds 5 entries: Claude Desktop, VSCode, Cline, Windsurf, Cursor (all Windows-side).

**My read of the WSL block contract:** the additive entries cover GUI clients that users typically install on Windows even when their dev shell is in WSL. The user runs the GUI on Windows, so the GUI's config lives in `%APPDATA%` or `%USERPROFILE%`; if the WSL shell is the only environment where `dkg mcp setup` is reachable (because that's where the dev installed the dkg CLI), the setup needs to write to both Linux and Windows paths so both surfaces work.

### 6.1 Codex CLI WSL analysis

Codex CLI is a CLI tool, not a GUI. Two scenarios:
- **Dev runs Codex CLI in their WSL shell** (typical for a WSL-first dev). `~/.codex/` is the Linux home. The Linux-side entry in §2 covers this. **No additive Windows-side entry needed.**
- **Dev installed Codex CLI in Windows AND uses WSL for development.** Two parallel installs. The Windows-side install reads `%USERPROFILE%\.codex\config.toml`. If the dev runs `dkg mcp setup` from the WSL shell, the WSL block would need to add Codex CLI to write the Windows-side TOML too.

**Recommendation (confirmed by team-lead 2026-05-08):** **NO additive entry in this PR.** Codex CLI WSL+Windows dual-install is a niche setup (the CLI tool is more commonly installed in just one of WSL or Windows, not both). The Linux-side entry is sufficient for the common case. Document the gap in the README troubleshooting section: "If you run Codex CLI on Windows but `dkg mcp setup` from WSL, manually copy the `[mcp_servers.dkg]` block from `--print-only` output to `%USERPROFILE%\.codex\config.toml`." If the niche-setup demand surfaces post-merge, add it as a follow-up.

### 6.2 What I'd flag if mcp-lead's #107 disagrees

If mcp-lead adds Codex CLI to the WSL block at `mcp-setup.ts:813-867`, it's a defensible choice but introduces an additional `wslpath` round-trip per setup invocation (one extra path resolution per added client). Performance impact is minor (sub-millisecond), but the extra surface area is +1 untested code paths. If the additive entry lands, the unit tests need to cover it with `isWSL()` stubs.

---

## Section 7 — Block-list and red lines

This is the qa-engineer's pre-merge block list. Any of these in the PR's final state blocks PR-open.

### 7.1 Hard blocks

1. **OpenClaw round-trip regression.** Same as PR #381 block-list #1. Run `pnpm --filter @origintrail-official/dkg-adapter-openclaw test` — must show 808/810 (the 2 R7 pre-existing). Any new failure post-#437 is a regression.
2. **Existing 6-client regression.** Re-running setup on a pre-populated config for any of the 6 already-shipped clients changes the entry beyond the documented FIX 22 / FIX 26 boundaries. Section 5's diff sweep catches this.
3. **CLI deep-import regression.** `pnpm --filter @origintrail-official/dkg run build` must stay green. The cli's daemon routes deep-import `@origintrail-official/dkg-mcp/manifest/{publish,fetch,install}` + `client`. Adding TOML libs to the cli's dep tree must not break those imports. (Same block-list item #6 from PR #381.)
4. **TOML reformat blast radius.** Per plan §Verification line 202: comment loss in MCP config files is acceptable; full reformat that touches unrelated `[other.section]` blocks is NOT. mcp-lead's TOML lib choice (`@iarna/toml` per team-lead's 2026-05-08 confirmation) must preserve unrelated sections byte-for-byte. If `@iarna/toml` reformats unrelated sections, block until either (a) the lib is swapped, OR (b) we accept the trade-off and document it explicitly in the README.
5. **Format-dispatch routing bug.** A JSON-shaped entry rendering through the TOML serializer (or vice versa). Section 5.3 catches this. Block.

### 7.2 Soft red lines (file as concerns, not blockers)

- **TOML inline-table vs table-syntax for the dkg entry.** Codex CLI accepts both per TOML spec, but a sub-`mcp_servers.dkg` written as `mcp_servers = { dkg = {...} }` inline-table breaks visual alignment with other Codex CLI servers. Pick one form; document the choice.
- **Existing test count drift.** If `dkg-mcp` 88/88, `dkg-adapter-openclaw` 808/810, etc. counts shift unexpectedly post-#437, flag for inspection. Not a hard block but worth surfacing.
- **WSL niche-setup README documentation.** Per §6.1: if the README isn't updated with the niche-setup gap, file a docs follow-up but don't block PR-open.

---

## Section 8 — Resolved questions (team-lead 2026-05-08 answers, narrowed to Codex-CLI scope)

The original v1 plan §10 had 5 open questions; team-lead answered all 5. Of those, the 3 still relevant to PR #443 (Codex-CLI-only scope):

1. **TOML lib choice** — `@iarna/toml`. Battle-tested, ~150KB, full TOML 1.0. Recommendation stands; mcp-lead may override with rationale. **Status:** confirmed.
2. **WSL block additive entries (Codex CLI)** — NO additive entries. Linux-side install via WSL is the standard install vector. README troubleshooting documents the niche dual-install case. **Status:** confirmed (§6.1 above).
3. **`--print-only` behavior for new candidates** — emits the canonical block in the right format for each detected client. So if Codex CLI is detected, `--print-only` for that client emits TOML, not canonical-JSON. **Status:** confirmed (§2.2 step 3 reflects this).

The 2 questions that ONLY pertained to Continue (YAML lib choice + YAML/JSON precedence) are deferred to the #444 follow-up plan.

---

## Phase 2 — Manual smoke execution (deferred)

This plan documents what to run; Phase 2 actually runs it. Per task brief, Phase 2 is dispatched by team-lead AFTER mcp-lead's #107 lands and the PR-review cycle stabilises. Do NOT run global installs (`npm i -g @openai/codex`) until then. The Phase 2 report will overlay this plan with command-by-command results plus pass/fail per gate.

---

## Sign-off ledger (to be filled in Phase 2)

- [ ] §1.1 unit suite green (~103 tests)
- [ ] §1.2 build green
- [ ] §1.3 adjacent test suites green
- [ ] §2 Codex CLI TOML round-trip
- [ ] §3 FIX 26 TOML preservation
- [ ] §4.1 macOS smoke
- [ ] §4.2 Windows smoke
- [ ] §5 existing-clients regression sweep clean
- [ ] §6 WSL implications documented (no code changes per §6.1 recommendation)
- [ ] §7 block-list none-triggered

When all 10 lines are checked, qa-engineer signs off the Test-plan section of the PR description (per the PR #394 co-author pattern via `github-pr-driver`).
