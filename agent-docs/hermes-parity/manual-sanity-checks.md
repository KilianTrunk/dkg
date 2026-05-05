# Hermes Parity — Manual Sanity Checks (Live Daemon)

**Owner:** qa-engineer (drives runs).
**Companion to:** `packages/node-ui/e2e/specs/hermes-connect.spec.ts` (CI Playwright cases H-AC-06 / H-AC-11 with API route interception).
**When run:** during release-readiness verdict (`agent-docs/hermes-parity/release-readiness.md`).

---

## Why a manual companion exists

Per `execution-plan.md` §4 last paragraph: "If the e2e harness is too brittle for CI, downgrade to manual sanity check and document — don't get stuck on infrastructure."

The CI Playwright spec covers the click-to-state-transition flow with intercepted `/api/local-agent-integrations/*` routes — fast, deterministic, and gives signal on UI regressions. The checks below cover what the route interception cannot: the live daemon path including real `runHermesSetup` invocation, real `restoreHermesProfile` on disconnect, real DKG memory slot persistence across the disconnect/reconnect cycle, and real Hermes gateway health probing.

Run these by hand against a clean tmp `~/.dkg` and a clean tmp `HERMES_HOME`. Capture the output excerpts in `release-readiness.md` per acceptance row.

---

## H-AC-06 (live) — Fresh user end-to-end

**Pre-conditions:**

- Tmp `~/.dkg` (no existing `config.json`).
- Tmp `HERMES_HOME` with a `config.yaml` that has `memory.provider: redis` (any non-DKG provider) so the replace-by-default path is exercised.
- `dkg` CLI installed via `npm i -g @origintrail-official/dkg` from the parity branch build.
- Hermes gateway accessible at `http://127.0.0.1:8642` (stub or real).

**Steps:**

1. `dkg init` → expect `~/.dkg/config.json` written.
2. `dkg hermes setup --hermes-home <tmp> --memory-mode primary`:
   - Daemon should start (no `--no-start`).
   - Faucet should run on the first three wallets (no `--no-fund`).
   - `<HERMES_HOME>/config.yaml.bak.<unix-ts-ms>` should appear (replace-with-backup).
   - Setup state should record `priorMemoryProvider: { provider: 'redis', configBackupPath, capturedAt }`.
3. Open Node UI in a browser (`dkg ui open` or browse to `http://127.0.0.1:5173/ui/`).
4. Right panel → Hermes tab should show **Chat ready** without further action.
5. Type a message in the Hermes chat input and send → assistant reply should round-trip through the daemon stream.

**Pass criteria:**

- All filesystem mutations from step 2 are present and only present (no extras).
- Step 4 reaches `chat_ready` within ~10s of UI open.
- Step 5 message round-trips successfully.

---

## H-AC-11 (live) — Existing user clicks Connect Hermes from UI

**Pre-conditions:**

- A user has already run `dkg init` + `dkg start` previously.
- Tmp `HERMES_HOME` with `config.yaml` that has `memory.provider: openai-memory` (a different non-DKG provider, to verify capture-and-restore works for arbitrary prior providers).
- `dkg start` daemon running.
- Hermes gateway NOT yet started (so the first health probe fails and the Connect path triggers setup, not the short-circuit).

**Steps:**

1. Confirm `~/.dkg/config.json` exists from prior `dkg init`.
2. Confirm Hermes integration is NOT in `~/.dkg/config.json`'s `localAgentIntegrations.hermes` (or `enabled: false`).
3. Open Node UI → right panel → "Connect Another Agent" → click **Connect Hermes**.
4. Notice should read verbatim: `"Hermes setup started. This chat tab will come online automatically once Hermes finishes setting up."`
5. Hermes tab should transition to `connecting` immediately, then to `chat_ready` once setup completes (~30-60s for a real adapter install).
6. Verify `<HERMES_HOME>/config.yaml.bak.<unix-ts-ms>` exists with the original `openai-memory` config.
7. Verify `<HERMES_HOME>/.dkg-adapter-hermes/setup-state.json` has `priorMemoryProvider.provider === 'openai-memory'`.
8. Send a chat message → assistant replies via daemon stream.

**Pass criteria:**

- Notice copy is verbatim per step 4.
- Backup + state capture from steps 6-7 are correct.
- Chat round-trip succeeds.

---

## Disconnect → Restore (live) — companion to H-AC-37 + H-AC-47b

**Pre-conditions:** Run H-AC-11 first so a Hermes integration with captured prior provider exists.

**Steps:**

1. Note the current Hermes chat session URI (e.g. via `dkg query` for `urn:dkg:chat:session:hermes:dkg-ui:*`). Record the message count.
2. Right panel → Hermes tab → **Disconnect**.
3. Verify `<HERMES_HOME>/config.yaml` now has `memory.provider: openai-memory` restored (NOT DKG, NOT empty).
4. Verify the chat session URI from step 1 still exists in DKG and the message count is unchanged (chat history preserved).
5. Right panel → "Connect Another Agent" → re-click **Connect Hermes** → confirm the integration goes back to `chat_ready` and the previous chat history is browseable.

**Pass criteria:**

- Step 3 prior-provider line is restored verbatim.
- Step 4 chat history is intact.
- Step 5 reconnect works without losing history.

---

## Restore failure (live) — companion to H-AC-47b

**Pre-conditions:** Run H-AC-11 first so a backup file exists. Then manually delete the backup file at `<HERMES_HOME>/config.yaml.bak.*` to force the restore-failure path.

**Steps:**

1. Right panel → Hermes tab → **Disconnect**.
2. The Hermes integration should still transition to disconnected (the disconnect itself succeeds).
3. The "Connect Another Agent" → Hermes tile should show a warning chip with text containing `"Hermes provider restore failed"` (or similar — exact text comes from `restoreHermesProfile`'s `restoreError`).
4. Verify `<HERMES_HOME>/config.yaml` is in whatever state the surgical restore left it (may be partial — that's the documented behavior; backup-file is the safety net which we deliberately removed).

**Pass criteria:**

- Step 2: integration is disconnected, not stuck in error.
- Step 3: warning chip is visible and carries the restore-failure text.
- Disconnect is NOT rolled back.

---

## --no-start / --no-fund / --dry-run live verification (companion to H-AC-12 / H-AC-16 / H-AC-21)

These flag-semantics rows are unit-tested in `cli/test/hermes-setup-orchestration.test.ts` with DI stubs. The live verification is the third gate-criterion in `test-matrix.md`'s "Test execution gates" section:

```
3. --dry-run E2E sanity check passed by hand: run dkg hermes setup --dry-run
   against a tmp HERMES_HOME containing config.yaml: memory.provider: redis;
   diff find $TMP -newer <pre-snapshot> returns empty (no new files including
   no config.yaml.bak.*).
```

Run that diff after each commit to S2/S4 and capture the output in `release-readiness.md`.
