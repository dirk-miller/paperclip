# Paperclip Local Customizations

Our fork carries 18 commits beyond upstream. Each is load-bearing; losing any could silently break a production feature. This file is the single source of truth for what we patch and why.

**Branch:** `freemymemories/local-customizations-new`
**Upstream base:** `v2026.416.0`
**Regenerate:** `git log --pretty="%H %s" v2026.416.0..HEAD`
**Last verified:** 2026-04-22 (rebase from v2026.318.0 → v2026.416.0)

## What changed from the previous branch (freemymemories/local-customizations)

The prior branch forked from `v2026.318.0`. The new upstream `v2026.416.0` is 1094 commits ahead. Several patches became **natively absorbed** by the upstream:

| Old patch | Status in v2026.416.0 |
|---|---|
| dedup window 30s (71c41b0d) | Absorbed: "coalesce" system replaced dedup window concept entirely |
| JWT inline mutilation fix (0a87720c) | Absorbed: `buildWakeText()` no longer inlines JWT |
| zombie checkout lock adopt (69512e21) | Absorbed: `isTerminalOrMissingHeartbeatRun` + `adoptStaleCheckoutRun` natively present |
| tasks:reassign_any code patch (1c87432c) | Absorbed: `canCreateAgentsLegacy()` covers CEO + canCreateAgents. **Data fix applied**: EM + CTO granted `canCreateAgents: true` via Paperclip UI |
| canReassignAny UI toggle (dcdb5793) | Absorbed with 1c87432c |
| plugin tool dispatch workerManager key (9527fa37) | Absorbed: `plugin-tool-registry.ts` natively uses `dbId`; `pluginDbId?: string` at line 115 |
| tsx watch --ignore flags (f7621e7a) | Adapted: moved to `server/src/dev-watch-ignore.ts` (new upstream uses dev-watch.ts not tsx watch --ignore) |

## LaunchAgent startup guards

The LaunchAgent plist at `~/Library/LaunchAgents/com.openclaw.paperclip.plist` runs canary checks before starting Paperclip. If any guarded patch is missing, the server refuses to boot. Currently guarded (8 checks):

| Guard | Patch commit | File | Marker |
|---|---|---|---|
| wakeOnComment | bcde46dc | server/src/services/heartbeat.ts | `wakeOnComment` |
| supportsLocalAgentJwt | c0ee13e3 | server/src/adapters/registry.ts | `supportsLocalAgentJwt: true` |
| activity.logged emit | 4021698e | server/src/services/activity-log.ts | `eventType: "activity.logged"` |
| pluginDbId signature | *native in v2026.416.0* | server/src/services/plugin-tool-registry.ts | `pluginDbId?: string` |
| dev-runner-paths exists | 30b157df | scripts/dev-runner-paths.mjs | (file presence) |
| heartbeat plugin-event emit | b0ac4242 | server/src/services/heartbeat.ts | `emitRunStatusPluginEvent` |
| plugin-registry scope filter | 95588eed | server/src/services/plugin-registry.ts | `SCOPE_FILTER_PATCH_V1` |
| agent plugin access | bc972f3e | server/src/routes/plugins.ts | `AGENT_PLUGIN_ACCESS_PATCH_V1` |

> **Note on pluginDbId guard**: The plist guard checks `plugin-tool-registry.ts` (not `plugin-tool-dispatcher.ts` as in the prior branch). In v2026.416.0 the type signature moved to `plugin-tool-registry.ts` line 115.

Post-rebase: verify every row in the tables below is still present. Patches marked HIGH reversion risk MUST be re-guarded in the plist before Paperclip is started.

## Patches by subsystem

### Heartbeat & Wake Control

| Commit | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| bcde46dc | feat: add runtimeConfig.heartbeat.wakeOnComment | server/src/services/heartbeat.ts | Stops unconditional assignee wake on every comment; reviewers can approve without burning a full adapter session on the submitter | HIGH | Candidate for upstream PR |
| 4793be05 | fix: wake template differentiates assignment vs mention workflows | server/src/services/heartbeat.ts | Without this, mention wakes on in_review/in_progress issues always fail the hardcoded checkout gate; agents reject legitimate mention work requests | HIGH | Candidate for upstream PR |

### Governance & Security

| Commit | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| 0bab77b2 | fix: block non-owner agents from changing assigneeAgentId | server/src/routes/issues.ts | Without this, stale deferred agent runs can override CEO reassignments — broken governance model. Passes `canCreateAgentsLegacy()` check for EM+CTO (requires data fix below) | HIGH | Candidate for upstream PR |
| 6597419f | feat: allow CEO-role and canCreateAgents agents to manage cross-agent routines | server/src/routes/routines.ts | `assertCanManageCompanyRoutine` threw 403 for non-self routines; CEO + canCreateAgents agents now pass | MEDIUM | Candidate for upstream PR |
| ef4ac02c | fix: always use agent_home workspace | server/src/services/heartbeat.ts | Prevents agents loading wrong identity on cross-agent issues. Without this, cross-project wake uses that project's workspace directory with the wrong CLAUDE.md/SOUL.md | HIGH | Local policy, not upstreamable |

**Required data fix** (applied 2026-04-22): Engineering Manager (`e2d4de68`) and CTO (`ec18b822`) must have `canCreateAgents: true` in Paperclip. Without this, `canCreateAgentsLegacy()` returns false for them and the 0bab77b2 non-owner guard 403s their legitimate pipeline management. Applied via `PATCH /agents/:id/permissions` with `{canCreateAgents: true, canAssignTasks: true}`.

### Agent Adapters

| Commit | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| c0ee13e3 | fix: restore supportsLocalAgentJwt: true for openclaw_gateway | server/src/adapters/registry.ts | v2026.416.0 has `supportsLocalAgentJwt: false` for openclaw_gateway only; other adapters already `true` natively. Without this, agents cannot authenticate with Paperclip API | HIGH | Not upstreamable (local gateway identity) |
| 66803861 | feat(claude-local): add --setting-sources and workspace-local --add-dir | packages/adapters/claude-local/src/server/execute.ts | `--setting-sources user,project,local` loads workspace .claude/CLAUDE.md in SDK mode. `--add-dir cwd` when `<cwd>/.claude/skills/` exists loads workspace-local skills | HIGH | Candidate for upstream PR |
| 222b0dd0 | feat(claude-local): add MiniMax M2.7 models + provider routing | packages/adapters/claude-local/src/index.ts, src/server/execute.ts | `PROVIDER_ENDPOINTS`, `isThirdPartyModel()`, `resolveProviderLabel()` for non-Anthropic model routing; injects `ANTHROPIC_BASE_URL` + API key overrides for MiniMax | HIGH | Candidate for upstream PR (generalized) |
| 6e0d29cf | feat(claude-local): per-agent worktree provisioning + PR on session exit (WORKTREE_PATCH_V1-V3) | packages/adapters/claude-local/src/server/execute.ts | When `adapterConfig.worktreeEnabled: true`: (a) provisions `~/.paperclip-worktrees/<slug>-<taskId>/` branched from `origin/<primaryBase>`, (b) overrides cwd to `<wkt>/_workspaces/<slug>/`, (c) injects GH_TOKEN/git identity env, PAPERCLIP_WORKTREE/PAPERCLIP_IOS_WORKTREE/PAPERCLIP_AGENT_SLUG, (d) on exit pushes branch + opens PR with `auto-merge:approved` label if commits exist (detects existing PR before creating), (e) always cleans up. Stable worktree per (agent, task) for session-resume. `.paperclip-wake.lock` prevents concurrent wakes. Supports optional `secondaryRepo` for engineering agents | HIGH | Not upstreamable (FreeMyMemories-specific policy) |

### Plugin & Orchestration

| Commit | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| b0ac4242 | feat: emit agent.run.* plugin events on run status transitions | server/src/services/heartbeat.ts | Wires `setHeartbeatPluginEventBus` + `emitRunStatusPluginEvent`; `setRunStatus()` forwards started/finished/failed/cancelled to plugin event bus. Also emits at claim site (queued→running). Without this, plugins subscribed to agent.run.* never fire | HIGH | Candidate for upstream PR |
| 4021698e | fix: emit activity.logged for every activity_log row | server/src/services/activity-log.ts | Prior emit was gated on `PLUGIN_EVENT_SET.has(input.action)`; no caller passes `action="activity.logged"` so event was never emitted. Plugins subscribing to activity.logged received nothing | HIGH | Candidate for upstream PR |
| 95588eed | feat: honor scopeKind + scopeId in plugin-registry.listEntities | server/src/services/plugin-registry.ts | Pre-patch, `listEntities` dropped `scopeKind`/`scopeId` filters silently — only `pluginId`/`entityType`/`externalId` applied. Cross-scope data leakage. Guarded by `SCOPE_FILTER_PATCH_V1` | HIGH | Candidate for upstream PR |
| bc972f3e | feat: allow agent keys to call plugin tool execute endpoint (AGENT_PLUGIN_ACCESS_PATCH_V1 + PLUGIN_RUNCONTEXT_AUTOINJECT_V1) | server/src/routes/plugins.ts | Pre-patch, `assertBoard(req)` at execute route rejected every agent JWT with 403. Agents need to call plugin tools (cos_* tools). Also auto-injects runContext fields from auth token so agents don't need to pass them manually | HIGH | Candidate for upstream PR |

### CI & Dev Experience

| Commit | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| 4db73f4f | ci: fail PR check on uncommitted changes | .github/workflows/pr-policy.yml | Catches agents ending sessions with uncommitted worktree contamination before merge | MEDIUM | Candidate for upstream PR |
| 30b157df | fix(dev): ignore iCloud + OS metadata in dev-runner watch paths | scripts/dev-runner-paths.mjs | Our version is a superset of the upstream v2026.416.0 file (which only had test-dir ignores). Adds: `.DS_Store`, `*.icloud`, `._*`, `.Spotlight-*`, `.Trashes`, `.git/`, `node_modules/`, `dist/` to prevent false-positive restarts | MEDIUM | Not upstreamable (iCloud-specific) |
| 63fb0bcb | fix(dev): add iCloud + OS metadata patterns to tsx watch ignore list | server/src/dev-watch-ignore.ts | Adaptation of old `f7621e7a` (was in `server/package.json` tsx --ignore flags). New upstream uses `dev-watch.ts` which calls `resolveServerDevWatchIgnorePaths()` from this file | MEDIUM | Not upstreamable (iCloud-specific) |
| e9e8de15 | fix(dev): only set PAPERCLIP_UI_DEV_MIDDLEWARE in dev mode | scripts/dev-runner.mjs | `PAPERCLIP_UI_DEV_MIDDLEWARE: "true"` was unconditional; moved inside `if (mode === "dev")` block. Watch mode uses pre-built `ui/dist/` | MEDIUM | Not upstreamable (iCloud-specific) |

### Dependency Upgrades (non-upstream patches)

| Change | Applied | Reason |
|---|---|---|
| `hermes-paperclip-adapter: ^0.2.0 → ^0.3.0` (server, ui, root) | fde0b1e2 | v0.2.0 missing `detectModel` export required by `server/src/adapters/registry.ts` in v2026.416.0 |

## Dependencies (npm patches)

- `patches/embedded-postgres@18.1.0-beta.16.patch` — LC_MESSAGES locale fix. Applied via pnpm patch mechanism. Version unchanged from prior branch.

## Rebase procedure

When rebasing to a new upstream version:

1. Create new branch: `git checkout -b freemymemories/local-customizations-v<date> v<new-upstream>`
2. Apply each patch via direct edit (not cherry-pick) — adapt to new system's patterns
3. Check the OBSOLETE table: for each old patch, verify the upstream absorbed it natively before skipping
4. After all patches applied: verify 8 LaunchAgent guard markers (table above)
5. Run LaunchAgent reload: `launchctl unload ~/Library/LaunchAgents/com.openclaw.paperclip.plist; launchctl load ~/Library/LaunchAgents/com.openclaw.paperclip.plist; sleep 10; curl -s http://localhost:3100/api/health`
6. Guard defeat test: temporarily corrupt one guarded marker in a scratch file; confirm LaunchAgent prints FATAL and refuses to boot; restore
7. Upgrade adapter packages if new upstream changed their required versions
8. Apply required data fixes (see per-patch notes above)
9. Update this file to document the new patch set
