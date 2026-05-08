# Verification plan — issue #437 (Codex CLI TOML + Continue YAML/JSON auto-detect)

**Owner:** `qa-engineer`
**Status:** v1 — Phase 1 plan-draft. Phase 2 manual-smoke execution pending team-lead dispatch after `mcp-lead` lands #107 implementation.
**Date:** 2026-05-08
**Branch:** `feat/mcp-setup-codex-continue` (worktree `C:/Projects/dkg-v9-mcp-437`).
**Issue:** [#437](https://github.com/OriginTrail/dkg/issues/437) — auto-detect Codex CLI (TOML) + Continue (YAML/JSON) in `dkg mcp setup`.
**Scope source:** `C:/Users/jurij/.claude/plans/ethereal-dazzling-scott.md` §Verification.

This plan extends the PR #381/#394 verification posture to two new MCP-aware clients with non-JSON config formats. It documents the pre-merge gate set, the manual-smoke procedure for each format, and the block-list / red-line items that would gate PR-open.

**On the missing PR #394 verification plan:** the brief asked me to write "alongside the existing verification-plan.md" but `agent-docs/dkg-v10-mcp-consolidation/` was never merged to `main` (planning artefacts lived on the consolidation branch only). This file is the first of its kind to land via PR-merge to main. Style mirrors the PR #381 verification-plan that I co-authored on the consolidation branch.

---

## Scope summary

Two new clients added to `detectClients()` in `packages/cli/src/mcp-setup.ts`:

1. **Codex CLI** — config at `~/.codex/config.toml` (TOML format). Block: `[mcp_servers.dkg]` with `command` and `args` keys.
2. **Continue** (VSCode extension) — config at `~/.continue/config.yaml` (YAML format) with JSON fallback at `~/.continue/config.json` when `.yaml` is absent. Block: `mcpServers.dkg` with `command` and `args` keys.

Test count progression expected: **98 (existing) → 104-106 (post-#107)**, +6 to +8 tests covering the two new candidates plus FIX 26 preservation of user-added keys in TOML and YAML.

The implementation reuses the existing `ClientTarget` dispatch shape established in PR #394 phase-1; **no architecture changes**. Per-client format dispatch happens at the read/write boundary via a `format: 'json' | 'toml' | 'yaml'` field on `ClientTarget` (mcp-lead's #107 design).

---

## Section 1 — Pre-merge unit + build gates

### 1.1 Unit suite green

```bash
cd C:/Projects/dkg-v9-mcp-437
pnpm --filter @origintrail-official/dkg exec vitest run mcp-setup.test.ts
```

**Pass criteria:**
- `Tests <N> passed (<N>)` where `N` is between **104 and 106** (98 baseline + 6-8 new).
- `Test Files 1 passed (1)`.
- Exit code 0.

**Coverage expected from the new tests** (per plan §Part 3 + my read of the implementation contract):

- Codex CLI candidate:
  - Detected when `~/.codex/config.toml` exists (or `~/.codex/` dir is present per the existing detection-permissive convention).
  - Writes `[mcp_servers.dkg]` block with `command = "..."` and `args = ["mcp", "serve"]`.
  - Idempotent: re-run leaves the block byte-aligned (or differs only in whitespace within tolerance documented in §6 below).
- Continue YAML candidate:
  - Detected when `~/.continue/config.yaml` exists (or `~/.continue/` dir is present).
  - Writes `mcpServers.dkg` under the YAML root with the canonical command/args shape.
  - Idempotent.
- Continue JSON fallback:
  - When `.yaml` absent and `~/.continue/config.json` is present, write to the JSON file with the canonical shape.
  - When BOTH `.yaml` and `.json` exist, prefer `.yaml` (or document the precedence rule per mcp-lead's choice).
- FIX 26 preservation in TOML:
  - Pre-populate `[mcp_servers.dkg]` with a user-added `cwd = "/somewhere"` key before setup.
  - Run setup `--force`.
  - Confirm `cwd` survives alongside refreshed `command` / `args`.
- FIX 26 preservation in YAML:
  - Pre-populate `mcpServers.dkg` with `env: { FOO: "bar" }` before setup.
  - Run setup `--force`.
  - Confirm `env.FOO` survives alongside refreshed `command` / `args`.
- Any classify-stale tests for the two new formats so the registered/stale/not-registered triage works on TOML and YAML the same as JSON.

**Failure mode signalling:**
- If test count is < 104, the new candidates aren't fully covered; flag for parity with the 6 already-shipped clients (each got ~3-5 tests in PR #394 — Codex CLI + Continue should track similar density).
- If test count is > 106, mcp-lead landed extra cases beyond the plan (likely covering an unforeseen edge case — flag for inspection but not blocking).

### 1.2 Build green

```bash
cd C:/Projects/dkg-v9-mcp-437
pnpm run build
```

**Pass criteria:**
- Turbo emits `Tasks: <N> successful, <N> total`.
- No type errors from `@iarna/toml` or `js-yaml` (or whatever TOML/YAML libs mcp-lead chose) integration.
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
#    without mutating any client config. The print-only output is
#    canonical-JSON; it doesn't include the TOML serialisation.
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

## Section 3 — Manual smoke for Continue YAML

### 3.1 Pre-conditions

- VSCode installed.
- Continue extension installed (latest stable from the VSCode marketplace at smoke time).
- Open VSCode at least once with Continue active so it creates `~/.continue/`.
- Built `dkg` CLI from this branch.

### 3.2 Procedure

```bash
# 1. Confirm Continue's config location and format. Latest Continue
#    docs say YAML is canonical, JSON is legacy.
ls ~/.continue/
cat ~/.continue/config.yaml 2>&1 || cat ~/.continue/config.json 2>&1

# 2. Run dkg mcp setup.
node /abs/path/to/dkg-v9-mcp-437/packages/cli/dist/cli.js mcp setup --yes

# 3. Inspect the written YAML.
cat ~/.continue/config.yaml
```

### 3.3 Pass criteria

- Setup output includes a line referencing Continue (e.g. "Registered Continue → ~/.continue/config.yaml").
- `~/.continue/config.yaml` parses cleanly via `js-yaml` (or `python -c "import yaml; print(yaml.safe_load(open('~/.continue/config.yaml')))"`).
- Top-level `mcpServers.dkg` exists with `command` and `args: ["mcp", "serve"]`.
- All other Continue config (models, slashCommands, contextProviders, etc.) preserved.
- VSCode + Continue picks up the entry. From the Continue chat panel, ask "what tools does dkg expose?" — expect the 21-tool surface. (Continue's MCP integration loads on extension start; may require a VSCode reload window.)

### 3.4 Failure modes to flag

- **YAML lib reformats user comments.** YAML supports `#` comments; `js-yaml` and most YAML libs DROP comments on round-trip. Per plan §Verification line 202, comment loss in MCP config files is acceptable; full reformat that touches unrelated sections is not. Block if the YAML re-write reorders top-level keys or loses non-comment user data.
- **YAML key-quoting drift.** YAML allows `mcpServers` (unquoted) or `"mcpServers"` (quoted); both parse identically but a re-write that flips style on every run produces noisy git diffs in user repos. Document the quoting policy mcp-lead chose; block if the policy is "always re-quote" without explanation.
- **Continue extension doesn't pick up the entry.** Same shape-diagnostic as Codex CLI — read the file and pin the divergence against Continue's documented MCP shape.

---

## Section 4 — Manual smoke for Continue JSON fallback

### 4.1 Pre-conditions

- VSCode + Continue installed, but `~/.continue/config.yaml` deliberately **absent**.
- A pre-populated `~/.continue/config.json` with at least one Continue model entry, no `mcpServers` key yet.

### 4.2 Procedure

```bash
# 1. Set up the pre-state.
rm ~/.continue/config.yaml 2>&1   # ensure absent
ls ~/.continue/                    # expect: config.json present, config.yaml absent
cat ~/.continue/config.json | jq . # confirm valid JSON

# 2. Run dkg mcp setup.
node /abs/path/to/dkg-v9-mcp-437/packages/cli/dist/cli.js mcp setup --yes

# 3. Confirm setup wrote to the JSON, NOT created a new YAML.
ls ~/.continue/                    # config.yaml STILL absent
cat ~/.continue/config.json | jq '.mcpServers.dkg'
```

### 4.3 Pass criteria

- `~/.continue/config.yaml` does NOT exist post-setup. Setup respected the existing JSON fallback rather than upgrading to YAML.
- `~/.continue/config.json` has the new `mcpServers.dkg` entry; existing model entries preserved.
- JSON formatting (indentation, trailing newline) is consistent with the rest of the file (no whitespace whiplash).

### 4.4 Failure modes to flag

- **Setup creates `config.yaml` even though `config.json` exists.** This would be a JSON→YAML migration the user didn't ask for. Block.
- **Setup writes to BOTH `config.json` and a new `config.yaml`.** Worse — two sources of truth for Continue. Block.

---

## Section 5 — FIX 26 preservation real-world

FIX 26 (from PR #394) ensures user-added keys inside the canonical `mcpServers.dkg` / `[mcp_servers.dkg]` block survive a `--force` re-run. The unit tests in §1.1 cover this contract; this section is the real-world smoke against actual TOML / YAML files.

### 5.1 Codex CLI TOML preservation

```bash
# Pre-populate the TOML with a user key inside the dkg block.
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

**Pass criteria:**
- `[mcp_servers.dkg]` `command` is refreshed to the resolved `dkg` bin path (or `node /abs/cli.js` in monorepo mode).
- `[mcp_servers.dkg]` `args = ["mcp", "serve"]` is canonical.
- `[mcp_servers.dkg]` `cwd = "/Users/jurij/projects"` SURVIVES.
- `[mcp_servers.dkg]` `env = { DKG_API = "http://localhost:9300" }` SURVIVES.
- `[other.section]` `unrelated = true` SURVIVES, byte-for-byte.

### 5.2 Continue YAML preservation

```bash
# Pre-populate the YAML with a user key.
cat > ~/.continue/config.yaml <<'EOF'
models:
  - title: "GPT-4"
    provider: openai
mcpServers:
  dkg:
    command: stale-old-bin
    args: ["mcp", "serve"]
    env:
      DKG_API: "http://localhost:9300"
slashCommands:
  - name: "test"
    description: "test command"
EOF

# Force re-run.
node /abs/path/to/dkg-v9-mcp-437/packages/cli/dist/cli.js mcp setup --yes --force

# Inspect.
cat ~/.continue/config.yaml
```

**Pass criteria:**
- `mcpServers.dkg.command` refreshed.
- `mcpServers.dkg.args` canonical.
- `mcpServers.dkg.env.DKG_API` SURVIVES.
- `models[]` SURVIVES (entire array, including `title`, `provider` keys).
- `slashCommands[]` SURVIVES.

### 5.3 Failure modes to flag

- **User-added `cwd` / `env` inside `[mcp_servers.dkg]` is dropped.** Block — this is the FIX 26 contract.
- **`[other.section]` is touched** (any whitespace, key-order, or comment change). Block — blast radius beyond the dkg block is a regression.
- **`models[]` order changed in the YAML re-write.** Block — Continue presents models in array order; reordering breaks user UX silently.

---

## Section 6 — Cross-platform smoke

Per PR #381's gate posture: real workstation OS, not Docker. Mac + Windows minimum; Linux follows.

### 6.1 macOS

- All §2-§5 procedures run on the dev's primary Mac.
- Verify `~/.codex/config.toml` resolves under `/Users/<name>/.codex/`.
- Verify `~/.continue/config.yaml` resolves under `/Users/<name>/.continue/`.
- `dkg` bin via `which dkg` should resolve absolute path (PR #394 F30).

### 6.2 Windows (PowerShell, native — NOT WSL)

- All §2-§5 procedures run on a Windows test box (or VM).
- Verify Codex CLI's Windows-native config path. **Plan question:** Codex CLI on Windows — does it use `%USERPROFILE%\.codex\config.toml` or `%APPDATA%\codex\config.toml`? Smoke this against the real install; document the resolved path; cross-check with `mcp-setup.ts`'s candidate path resolution.
- Continue's Windows-native config path follows VSCode user-settings convention. The existing VSCode candidate in `mcp-setup.ts` resolves `%APPDATA%\Code\User\` for the Copilot Chat case; Continue lives under `%USERPROFILE%\.continue\` per Continue docs (homedir-relative). Verify.
- `dkg.cmd` shim: `where dkg` should resolve the npm-shim path; PR #394 F30 covers this with `where.exe`.

### 6.3 Linux (deferred to release-readiness)

Linux smoke is release-readiness, not pre-merge — same posture as PR #381's deferred Mac+Linux gate. Codex CLI + Continue both have well-documented Linux paths (`~/.codex/`, `~/.continue/`); the unit tests stub `homedir()` and `platform()` so the per-platform path resolution is contract-pinned. Live Linux smoke catches OS-version-specific edge cases.

---

## Section 7 — Existing-clients regression sweep

The brief calls this out specifically: re-run `dkg mcp setup` against a sandbox config that has all 6 pre-existing clients pre-populated (Cursor, Claude Code, Claude Desktop, Windsurf, VSCode + Copilot Chat, Cline) AND the 2 new clients (Codex CLI, Continue) to surface any spurious diff or shape drift.

### 7.1 Procedure

```bash
# Build a sandbox HOME with pre-populated entries for all 8 clients.
SANDBOX=$(mktemp -d)
mkdir -p $SANDBOX/.cursor $SANDBOX/.codex $SANDBOX/.continue $SANDBOX/.codeium/windsurf
mkdir -p "$SANDBOX/Library/Application Support/Claude"   # Mac path
mkdir -p $SANDBOX/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings

# Pre-populate canonical entries for all 8 (snapshot the post-#394
# canonical shape via `dkg mcp setup --print-only` for the 6 known
# JSON clients; for Codex + Continue use the new shapes from §2 + §3).
# Then sandbox-HOME-redirect:
DKG_HOME_OVERRIDE=$SANDBOX node /abs/cli.js mcp setup --yes

# Diff before / after for each file.
diff -u $SANDBOX_BEFORE/.cursor/mcp.json $SANDBOX/.cursor/mcp.json
diff -u $SANDBOX_BEFORE/.claude.json $SANDBOX/.claude.json
# ... etc. for each of the 8 clients.
```

### 7.2 Pass criteria

- Each `diff -u` between pre and post output is **empty** (no changes when entries are already canonical).
- A second run with `--force` MAY produce diffs limited to the `mcpServers.dkg` / `[mcp_servers.dkg]` block — those are intentional refreshes. Anything outside that block is a regression.

### 7.3 Failure modes to flag

- **Any spurious whitespace diff in a JSON client** (one of the 6 already-shipped). Block — that's a regression in the JSON serializer regress brought in by adding TOML/YAML siblings.
- **A JSON-shaped entry rendering through the TOML/YAML serializer.** Could happen if the dispatch on `format: 'toml'|'yaml'|'json'` mis-routes. Block.

---

## Section 8 — WSL implications

The brief asks whether Codex CLI and Continue need additive Windows-side entries in the WSL block at `mcp-setup.ts:813-867`. The current WSL block adds 5 entries: Claude Desktop, VSCode, Cline, Windsurf, Cursor (all Windows-side).

**My read of the WSL block contract:** the additive entries cover GUI clients that users typically install on Windows even when their dev shell is in WSL. The user runs the GUI on Windows, so the GUI's config lives in `%APPDATA%` or `%USERPROFILE%`; if the WSL shell is the only environment where `dkg mcp setup` is reachable (because that's where the dev installed the dkg CLI), the setup needs to write to both Linux and Windows paths so both surfaces work.

### 8.1 Codex CLI WSL analysis

Codex CLI is a CLI tool, not a GUI. Two scenarios:
- **Dev runs Codex CLI in their WSL shell** (typical for a WSL-first dev). `~/.codex/` is the Linux home. The Linux-side entry in §2 covers this. **No additive Windows-side entry needed.**
- **Dev installed Codex CLI in Windows AND uses WSL for development.** Two parallel installs. The Windows-side install reads `%USERPROFILE%\.codex\config.toml`. If the dev runs `dkg mcp setup` from the WSL shell, the WSL block would need to add Codex CLI to write the Windows-side TOML too.

**Recommendation:** **NO additive entry in this PR.** Codex CLI WSL+Windows dual-install is a niche setup (the CLI tool is more commonly installed in just one of WSL or Windows, not both). The Linux-side entry is sufficient for the common case. Document the gap in the README troubleshooting section: "If you run Codex CLI on Windows but `dkg mcp setup` from WSL, manually copy the `[mcp_servers.dkg]` block from `--print-only` output (translated to TOML) to `%USERPROFILE%\.codex\config.toml`." If the niche-setup demand surfaces post-merge, add it as a follow-up.

### 8.2 Continue WSL analysis

Continue is a VSCode extension. Two scenarios:
- **Dev runs VSCode on Windows + WSL Remote.** The Continue extension reads `~/.continue/config.yaml` from the Linux side per WSL Remote convention. Linux-side entry in §3 covers this. **No additive entry needed.**
- **Dev runs native Windows VSCode (no WSL Remote) but does dev work in WSL.** Continue reads `%USERPROFILE%\.continue\config.yaml`. Same niche as Codex CLI #2 above.

**Recommendation:** **NO additive entry in this PR.** Same reasoning as Codex CLI. Document in README troubleshooting.

### 8.3 What I'd flag if mcp-lead's #107 disagrees

If mcp-lead adds Codex CLI / Continue to the WSL block at `mcp-setup.ts:813-867`, it's a defensible choice but introduces additional `wslpath` round-trips per setup invocation (one extra path resolution per added client). Performance impact is minor (sub-millisecond), but the extra surface area is +2 untested code paths. If the additive entries land, the unit tests need to cover them with `isWSL()` stubs.

---

## Section 9 — Block-list and red lines

This is the qa-engineer's pre-merge block list. Any of these in the PR's final state blocks PR-open.

### 9.1 Hard blocks

1. **OpenClaw round-trip regression.** Same as PR #381 block-list #1. Run `pnpm --filter @origintrail-official/dkg-adapter-openclaw test` — must show 808/810 (the 2 R7 pre-existing). Any new failure post-#437 is a regression.
2. **Existing 6-client regression.** Re-running setup on a pre-populated config for any of the 6 already-shipped clients changes the entry beyond the documented FIX 22 / FIX 26 boundaries. Section 7's diff sweep catches this.
3. **CLI deep-import regression.** `pnpm --filter @origintrail-official/dkg run build` must stay green. The cli's daemon routes deep-import `@origintrail-official/dkg-mcp/manifest/{publish,fetch,install}` + `client`. Adding TOML/YAML libs to the cli's dep tree must not break those imports. (Same block-list item #6 from PR #381.)
4. **TOML reformat blast radius.** Per plan §Verification line 202: comment loss in MCP config files is acceptable; full reformat that touches unrelated `[other.section]` blocks is NOT. mcp-lead must pick a TOML lib that preserves unrelated sections byte-for-byte. If the chosen lib reformats unrelated sections, block until either (a) the lib is swapped, OR (b) we accept the trade-off and document it explicitly in the README.
5. **YAML reformat blast radius.** Same as TOML: if the YAML lib reorders top-level keys or loses non-comment user data outside `mcpServers.dkg`, block.
6. **JSON↔YAML migration without user request.** Section 4.4: setup creating `config.yaml` when only `config.json` was present is a silent migration. Block.
7. **Format-dispatch routing bug.** A JSON-shaped entry rendering through the TOML/YAML serializer (or vice versa). Section 7.3 catches this. Block.

### 9.2 Soft red lines (file as concerns, not blockers)

- **YAML quoting policy.** If mcp-lead's serializer flips key-quoting style on every run, it produces noisy diffs in user repos. Document the policy explicitly.
- **TOML inline-table vs table-syntax for the dkg entry.** Codex CLI accepts both per TOML spec, but a sub-`mcp_servers.dkg` written as `mcp_servers = { dkg = {...} }` inline-table breaks visual alignment with other Codex CLI servers. Pick one form; document the choice.
- **Existing test count drift.** If `dkg-mcp` 88/88, `dkg-adapter-openclaw` 808/810, etc. counts shift unexpectedly post-#437, flag for inspection. Not a hard block but worth surfacing.
- **WSL niche-setup README documentation.** Per §8.1 / §8.2: if the README isn't updated with the niche-setup gap, file a docs follow-up but don't block PR-open.

---

## Section 10 — Open questions for team-lead / mcp-lead

1. **TOML lib choice.** Plan §71-106 mentions `@iarna/toml` as a candidate. Confirm mcp-lead's pick. `@iarna/toml` has a known edge case where it serializes datetime values via `Date` round-trip; document if Codex CLI's TOML config has any datetime keys we need to preserve. Otherwise the lib is fine.
2. **YAML lib choice.** Plan §107-146 mentions `js-yaml`. Confirm pick. `js-yaml`'s `safeDump` drops comments; `yaml` (the eemeli/yaml package) has a CST API that preserves comments. Trade-off: comment preservation vs lib weight. Per plan line 202, comment loss is acceptable so `js-yaml` is fine.
3. **Continue YAML/JSON precedence.** When both `~/.continue/config.yaml` AND `~/.continue/config.json` exist, which wins? Plan §Part 2 implies YAML wins (matches Continue's docs); confirm mcp-lead's implementation matches.
4. **WSL block additive entries.** §8 above recommends NO additive entries for Codex CLI + Continue. Confirm with team-lead; if user wants the niche-setup support, it lands here, otherwise README troubleshooting note suffices.
5. **`dkg mcp setup --print-only` output for new candidates.** Does `--print-only` emit the canonical-JSON for each client (current behavior) or per-format (TOML for Codex, YAML for Continue)? My read: stays canonical-JSON (the print-only contract is "what would I write" in a portable form, NOT "what the on-disk format would look like"). Confirm with mcp-lead.

---

## Phase 2 — Manual smoke execution (deferred)

This plan documents what to run; Phase 2 actually runs it. Per task brief, Phase 2 is dispatched by team-lead AFTER mcp-lead's #107 lands. Do NOT run global installs (`npm i -g @openai/codex`, VSCode + Continue extension) until then. The Phase 2 report will overlay this plan with command-by-command results plus pass/fail per gate.

---

## Sign-off ledger (to be filled in Phase 2)

- [ ] §1.1 unit suite green (104-106 tests)
- [ ] §1.2 build green
- [ ] §1.3 adjacent test suites green
- [ ] §2 Codex CLI TOML round-trip
- [ ] §3 Continue YAML round-trip
- [ ] §4 Continue JSON fallback
- [ ] §5.1 FIX 26 TOML preservation
- [ ] §5.2 FIX 26 YAML preservation
- [ ] §6.1 macOS smoke
- [ ] §6.2 Windows smoke
- [ ] §7 existing-clients regression sweep clean
- [ ] §8 WSL implications documented (no code changes if §8.1/§8.2 recommendation accepted)
- [ ] §9 block-list none-triggered

When all 13 lines are checked, qa-engineer signs off the Test-plan section of the PR description (per the PR #394 co-author pattern via `github-pr-driver`).
