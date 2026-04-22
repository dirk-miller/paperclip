import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_ENDPOINTS, isThirdPartyModel, resolveProviderLabel } from "../index.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildPaperclipEnv,
  readPaperclipRuntimeSkillEntries,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";
import { isBedrockModelId } from "./models.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

// ----------------------------------------------------------------------------
// Per-agent worktree provisioning (freemymemories/local-customizations)
// WORKTREE_PATCH_V1 through V3 — see CUSTOMIZATIONS.md for patch lineage.
//
// When adapterConfig.worktreeEnabled === true, the adapter provisions a
// fresh git worktree per wake, pre-sets git identity, and (on session exit)
// pushes the branch + opens a PR. Cleans up the worktree/branch when the
// task reaches a terminal state. WORKTREE_PATCH_V3: fails loud on uncommitted
// work at session exit — adapter does not auto-commit.
// ----------------------------------------------------------------------------

interface WorktreeConfig {
  enabled: boolean;
  agentSlug: string;
  agentName: string;
  gitEmail: string;
  primaryRepo: string;
  secondaryRepo: string | null;
  primaryBase: string;
  secondaryBase: string | null;
  autoMergeLabel: string;
}

interface ProvisionedWorktree {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  base: string;
  isPrimary: boolean;
}

interface WorktreeProvisionResult {
  config: WorktreeConfig;
  primary: ProvisionedWorktree;
  secondary: ProvisionedWorktree | null;
  sessionCwd: string;
  envAdditions: Record<string, string>;
  stableKey: string;
  isEphemeral: boolean;
  taskId: string | null;
  lockPath: string;
  ghPat: string;
}

function parseWorktreeConfig(config: Record<string, unknown>): WorktreeConfig | null {
  const enabled = asBoolean(config.worktreeEnabled, false);
  if (!enabled) return null;
  const agentSlug = asString(config.agentSlug, "").trim();
  const primaryRepo = asString(config.primaryRepo, "").trim();
  if (!agentSlug || !primaryRepo) return null;
  return {
    enabled: true,
    agentSlug,
    agentName: asString(config.agentName, agentSlug),
    gitEmail: asString(config.gitEmail, `${agentSlug}@freemymemories.com`),
    primaryRepo,
    secondaryRepo: asString(config.secondaryRepo, "").trim() || null,
    primaryBase: asString(config.primaryBase, "master"),
    secondaryBase: asString(config.secondaryBase, "").trim() || null,
    autoMergeLabel: asString(config.autoMergeLabel, "auto-merge:approved"),
  };
}

function sanitizeBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function runGit(repoOrWkt: string, args: string[], allowFail = false): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", ["-C", repoOrWkt, ...args], { encoding: "utf-8" });
  const ok = res.status === 0;
  if (!ok && !allowFail) {
    // caller decides; we don't throw here
  }
  return { ok, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

function ensureWorktree(
  repo: string,
  branch: string,
  worktreePath: string,
  primaryBase: string,
): { reused: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const list = runGit(repo, ["worktree", "list", "--porcelain"], true);
  let registered = false;
  if (list.ok) {
    let canonicalTarget = worktreePath;
    try { canonicalTarget = fsSync.realpathSync(worktreePath); } catch { canonicalTarget = worktreePath; }
    const lines = list.stdout.split("\n");
    registered = lines.some((l) => {
      if (!l.startsWith("worktree ")) return false;
      const p = l.slice("worktree ".length).trim();
      if (p === worktreePath || p === canonicalTarget) return true;
      try { return fsSync.realpathSync(p) === canonicalTarget; } catch { return false; }
    });
  }
  if (registered) {
    const cur = runGit(worktreePath, ["branch", "--show-current"], true);
    if (!cur.ok) throw new Error(`Worktree at ${worktreePath} is registered but 'git branch --show-current' failed: ${cur.stderr}`);
    if (cur.stdout !== branch) throw new Error(`Worktree at ${worktreePath} is on branch "${cur.stdout}", expected "${branch}". Manual intervention required.`);
    const status = runGit(worktreePath, ["status", "--porcelain"], true);
    if (status.ok && status.stdout.length > 0) {
      throw new Error(`Worktree at ${worktreePath} has uncommitted changes from prior wake:\n${status.stdout}\nResolve manually (commit, discard, or escalate) before next wake.`);
    }
    const fetch = runGit(repo, ["fetch", "origin", primaryBase], true);
    if (!fetch.ok) warnings.push(`fetch origin ${primaryBase} failed (non-fatal): ${fetch.stderr}`);
    const pull = runGit(worktreePath, ["pull", "--ff-only", "origin", branch], true);
    if (!pull.ok) warnings.push(`pull --ff-only origin ${branch} skipped: ${pull.stderr || "no remote ref"}`);
    return { reused: true, warnings };
  }
  if (runGit(repo, ["rev-parse", "--verify", `refs/heads/${branch}`], true).ok) {
    runGit(repo, ["branch", "-D", branch], true);
  }
  runGit(repo, ["fetch", "origin", primaryBase], true);
  const add = runGit(repo, ["worktree", "add", "-b", branch, worktreePath, `origin/${primaryBase}`], true);
  if (!add.ok) throw new Error(`Failed to create worktree at ${worktreePath} on origin/${primaryBase}: ${add.stderr}`);
  return { reused: false, warnings };
}

async function provisionWorktrees(
  wkCfg: WorktreeConfig,
  taskId: string | null,
  runtimeSessionParams: Record<string, unknown>,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
  ghPat: string,
): Promise<WorktreeProvisionResult | null> {
  const priorKey = typeof runtimeSessionParams.worktreeKey === "string" && runtimeSessionParams.worktreeKey.trim().length > 0
    ? runtimeSessionParams.worktreeKey.trim() : "";
  const isEphemeral = !(taskId && taskId.trim().length > 0) && !priorKey;
  const stableKey = (taskId && taskId.trim().length > 0 ? taskId.trim() : "") || priorKey || `ephemeral-${Date.now()}`;
  const branch = sanitizeBranchName(`${wkCfg.agentSlug}-${stableKey}`);
  if (!branch) {
    await onLog("stderr", `[paperclip-worktree] Could not derive a branch name from slug="${wkCfg.agentSlug}" taskId="${taskId}"; aborting.\n`);
    return null;
  }
  const worktreesRoot = path.join(os.homedir(), ".paperclip-worktrees");
  await fs.mkdir(worktreesRoot, { recursive: true });
  const primaryPath = path.join(worktreesRoot, branch);
  const secondaryBranch = wkCfg.secondaryRepo ? `${branch}-ios` : null;
  const secondaryPath = wkCfg.secondaryRepo ? path.join(worktreesRoot, `${branch}-ios`) : null;

  let primaryEnsured: { reused: boolean; warnings: string[] };
  try {
    primaryEnsured = ensureWorktree(wkCfg.primaryRepo, branch, primaryPath, wkCfg.primaryBase);
  } catch (err) {
    await onLog("stderr", `[paperclip-worktree] ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
  for (const w of primaryEnsured.warnings) await onLog("stdout", `[paperclip-worktree] ${w}\n`);
  await onLog("stdout", primaryEnsured.reused
    ? `[paperclip-worktree] Reusing worktree ${primaryPath} on branch ${branch}\n`
    : `[paperclip-worktree] Provisioned NEW worktree ${primaryPath} on branch ${branch}\n`);

  // Concurrent-wake lock
  const lockPath = path.join(primaryPath, ".paperclip-wake.lock");
  try {
    try {
      const existing = await fs.readFile(lockPath, "utf-8");
      const match = existing.match(/pid=(\d+)/);
      const pid = match ? parseInt(match[1], 10) : NaN;
      let alive = false;
      if (Number.isFinite(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      if (alive) {
        await onLog("stderr", `[paperclip-worktree] Another wake is in progress (lock: ${existing.trim()}); refusing to spawn.\n`);
        return null;
      }
      await fs.rm(lockPath, { force: true });
    } catch { /* No prior lock — good. */ }
    await fs.writeFile(lockPath, `pid=${process.pid}\nstarted=${new Date().toISOString()}\nbranch=${branch}\n`, { flag: "wx" });
  } catch (err) {
    await onLog("stderr", `[paperclip-worktree] Lock write failed for ${lockPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }

  let secondary: ProvisionedWorktree | null = null;
  if (wkCfg.secondaryRepo && secondaryPath && secondaryBranch) {
    const base = wkCfg.secondaryBase || "main";
    try {
      const secEnsured = ensureWorktree(wkCfg.secondaryRepo, secondaryBranch, secondaryPath, base);
      for (const w of secEnsured.warnings) await onLog("stdout", `[paperclip-worktree] (secondary) ${w}\n`);
      await onLog("stdout", secEnsured.reused
        ? `[paperclip-worktree] Reusing secondary worktree ${secondaryPath} on branch ${secondaryBranch}\n`
        : `[paperclip-worktree] Provisioned NEW secondary worktree ${secondaryPath} on branch ${secondaryBranch}\n`);
      secondary = { repoRoot: wkCfg.secondaryRepo, worktreePath: secondaryPath, branch: secondaryBranch, base, isPrimary: false };
    } catch (err) {
      await onLog("stderr", `[paperclip-worktree] Secondary worktree ensure failed: ${err instanceof Error ? err.message : String(err)}. Proceeding without secondary.\n`);
    }
  }

  const sessionCwd = path.join(primaryPath, "_workspaces", wkCfg.agentSlug);
  try { await fs.mkdir(sessionCwd, { recursive: true }); } catch { /* fall back to worktree root */ }

  const envAdditions: Record<string, string> = {
    GIT_AUTHOR_NAME: wkCfg.agentName,
    GIT_COMMITTER_NAME: wkCfg.agentName,
    GIT_AUTHOR_EMAIL: wkCfg.gitEmail,
    GIT_COMMITTER_EMAIL: wkCfg.gitEmail,
    PAPERCLIP_WORKTREE: primaryPath,
    PAPERCLIP_IOS_WORKTREE: secondary ? secondary.worktreePath : "",
    PAPERCLIP_AGENT_SLUG: wkCfg.agentSlug,
    PAPERCLIP_PRIMARY_REPO: wkCfg.primaryRepo,
    PAPERCLIP_SECONDARY_REPO: wkCfg.secondaryRepo || "",
  };
  if (ghPat) {
    envAdditions.GH_TOKEN = ghPat;
  }

  await onLog("stdout", `[paperclip-worktree] Provisioned branch="${branch}" primary=${primaryPath}${secondary ? ` secondary=${secondary.worktreePath}` : ""} cwd=${sessionCwd}\n`);
  return {
    config: wkCfg,
    primary: { repoRoot: wkCfg.primaryRepo, worktreePath: primaryPath, branch, base: wkCfg.primaryBase, isPrimary: true },
    secondary,
    sessionCwd,
    envAdditions,
    stableKey,
    isEphemeral,
    taskId,
    lockPath,
    ghPat,
  };
}

async function fetchTaskStatus(
  taskId: string,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<string | null> {
  const apiUrl = (process.env.PAPERCLIP_API_URL || "").trim();
  const apiKey = (process.env.PAPERCLIP_API_KEY || "").trim();
  if (!apiUrl || !apiKey) {
    await onLog("stdout", `[paperclip-worktree] Skipping task-status fetch: PAPERCLIP_API_URL/KEY not set in adapter env.\n`);
    return null;
  }
  const res = spawnSync("curl", ["-sS", "--max-time", "10", "-H", `Authorization: Bearer ${apiKey}`, `${apiUrl}/api/issues/${encodeURIComponent(taskId)}`], { encoding: "utf-8" });
  if (res.status !== 0 || !res.stdout) {
    await onLog("stderr", `[paperclip-worktree] task-status fetch failed (exit ${res.status}): ${(res.stderr || "").trim()}\n`);
    return null;
  }
  try {
    const parsed = JSON.parse(res.stdout.replace(/[\x00-\x1f]/g, " ")) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : null;
  } catch { return null; }
}

async function postTaskComment(
  taskId: string,
  body: string,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<boolean> {
  const apiUrl = (process.env.PAPERCLIP_API_URL || "").trim();
  const apiKey = (process.env.PAPERCLIP_API_KEY || "").trim();
  if (!apiUrl || !apiKey) {
    await onLog("stderr", `[paperclip-worktree] Skipping fail-loud comment: PAPERCLIP_API_URL/KEY not set.\n`);
    return false;
  }
  const res = spawnSync("curl", ["-sS", "--max-time", "10", "-X", "POST", "-H", `Authorization: Bearer ${apiKey}`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ body }), `${apiUrl}/api/issues/${encodeURIComponent(taskId)}/comments`], { encoding: "utf-8" });
  if (res.status !== 0) {
    await onLog("stderr", `[paperclip-worktree] fail-loud comment post failed (exit ${res.status}): ${(res.stderr || "").trim()}\n`);
    return false;
  }
  await onLog("stdout", `[paperclip-worktree] Posted fail-loud comment on issue ${taskId}.\n`);
  return true;
}

async function finalizeWorktree(
  wkt: ProvisionedWorktree,
  wkCfg: WorktreeConfig,
  opts: { cleanup: boolean; removeClaudeSessionDir: boolean; taskId: string | null },
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
  ghPat: string,
): Promise<void> {
  try {
    // WORKTREE_PATCH_V3: fail-loud on uncommitted work
    const statusRes = runGit(wkt.worktreePath, ["status", "--porcelain"], true);
    const statusLines = statusRes.ok ? statusRes.stdout.trim().split("\n").filter((l) => l.length > 0) : [];
    if (statusLines.length > 0) {
      const displayLines = statusLines.slice(0, 30);
      const truncatedNote = statusLines.length > 30 ? `\n  ... (and ${statusLines.length - 30} more)` : "";
      await onLog("stderr", `[paperclip-worktree] FAIL-LOUD: ${wkt.branch} has uncommitted work at session exit. Adapter will not auto-commit; preserving worktree for next wake.\n${displayLines.map((l) => `  ${l}`).join("\n")}${truncatedNote}\n`);
      opts.cleanup = false;
      opts.removeClaudeSessionDir = false;
      if (opts.taskId) {
        const commentBody = [
          `### ⚠️ Adapter fail-loud: uncommitted work at session exit`,
          ``,
          `The \`${wkCfg.agentName}\` session on this issue exited with uncommitted or untracked files in its worktree. The adapter is not auto-committing — commits are an intentional author act and must be made by the agent via \`git add\` + \`git commit\` + the \`pr\` skill's appropriate flow.`,
          ``,
          `**Files not committed** (\`git status --porcelain\` output):`,
          ``,
          "```",
          displayLines.join("\n") + truncatedNote,
          "```",
          ``,
          `**Worktree preserved at:** \`${wkt.worktreePath}\`  **Branch:** \`${wkt.branch}\``,
          ``,
          `**Action required on next wake:** commit the files, load \`pr\` skill → Flow 3 (vault) or Flow 1 (iOS code). Or \`git clean -fdx\` to discard.`,
          ``,
          `This comment is posted by the Paperclip \`claude_local\` adapter's fail-loud safety net (WORKTREE_PATCH_V3).`,
        ].join("\n");
        await postTaskComment(opts.taskId, commentBody, onLog);
      } else {
        await onLog("stderr", `[paperclip-worktree] No taskId available; skipping Paperclip comment. Files remain stranded in ${wkt.worktreePath}.\n`);
      }
    }

    // Detect commits: compare HEAD to origin/<base>
    const headRes = runGit(wkt.worktreePath, ["rev-parse", "HEAD"], true);
    const baseRes = runGit(wkt.repoRoot, ["rev-parse", `origin/${wkt.base}`], true);
    const hasCommits = headRes.ok && baseRes.ok && headRes.stdout.length > 0 && headRes.stdout !== baseRes.stdout;

    if (hasCommits) {
      const push = runGit(wkt.worktreePath, ["push", "origin", wkt.branch], true);
      if (!push.ok) {
        await onLog("stderr", `[paperclip-worktree] Push failed for ${wkt.branch}: ${push.stderr}\n`);
      } else {
        await onLog("stdout", `[paperclip-worktree] Pushed ${wkt.branch} to origin.\n`);
        const remote = runGit(wkt.worktreePath, ["remote", "get-url", "origin"], true);
        const ownerRepo = remote.ok ? parseGitHubOwnerRepo(remote.stdout) : null;
        if (!ownerRepo) {
          await onLog("stderr", `[paperclip-worktree] Could not parse owner/repo from remote "${remote.stdout}"; skipping PR creation.\n`);
        } else {
          const ghEnv: NodeJS.ProcessEnv = { ...process.env };
          if (ghPat) ghEnv.GH_TOKEN = ghPat;
          const existingRes = spawnSync("gh", ["pr", "list", "--repo", `${ownerRepo.owner}/${ownerRepo.repo}`, "--head", wkt.branch, "--state", "open", "--json", "number", "--limit", "1"], { encoding: "utf-8", cwd: wkt.worktreePath, env: ghEnv });
          let existingPrNumber: number | null = null;
          if (existingRes.status === 0 && existingRes.stdout) {
            try {
              const parsed = JSON.parse(existingRes.stdout) as Array<{ number: number }>;
              if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.number === "number") existingPrNumber = parsed[0].number;
            } catch { /* Malformed JSON — fall through */ }
          }
          if (existingPrNumber !== null) {
            await onLog("stdout", `[paperclip-worktree] PR already exists on ${wkt.branch} (#${existingPrNumber}), skipping create.\n`);
          } else {
            const subj = runGit(wkt.worktreePath, ["log", "-1", "--pretty=%s", `origin/${wkt.base}..HEAD`], true);
            const firstSubj = subj.ok && subj.stdout.length > 0 ? subj.stdout.split("\n")[0] : `${wkCfg.agentName}: ${wkt.branch}`;
            const title = firstSubj.length > 200 ? firstSubj.slice(0, 197) + "..." : firstSubj;
            const prBody = [
              `⚠️ This PR was created by the Paperclip adapter on session exit because no PR was opened during the agent session. Review context may be incomplete. Check the assigned issue for full context.`,
              "", "---", "",
              `Automated PR from \`${wkCfg.agentName}\` session.`,
              "", `- Branch: \`${wkt.branch}\``, `- Base: \`${wkt.base}\``, `- Worktree: \`${wkt.worktreePath}\``, "",
              `Adapter-created on session exit. Label \`${wkCfg.autoMergeLabel}\` applied for the DIY auto-merge workflow.`,
            ].join("\n");
            const ghRes = spawnSync("gh", ["pr", "create", "--repo", `${ownerRepo.owner}/${ownerRepo.repo}`, "--base", wkt.base, "--head", wkt.branch, "--title", title, "--body", prBody, "--label", wkCfg.autoMergeLabel], { encoding: "utf-8", cwd: wkt.worktreePath, env: ghEnv });
            if (ghRes.status === 0) {
              await onLog("stdout", `[paperclip-worktree] Opened PR on ${ownerRepo.owner}/${ownerRepo.repo}: ${(ghRes.stdout || "").trim()}\n`);
            } else {
              await onLog("stderr", `[paperclip-worktree] gh pr create failed (exit ${ghRes.status}): ${(ghRes.stderr || "").trim()}\n`);
            }
          }
        }
      }
    } else {
      await onLog("stdout", `[paperclip-worktree] No commits on ${wkt.branch}; skipping push + PR.\n`);
    }
  } catch (err) {
    await onLog("stderr", `[paperclip-worktree] finalize error for ${wkt.branch}: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    if (opts.cleanup) {
      const rm = runGit(wkt.repoRoot, ["worktree", "remove", wkt.worktreePath, "--force"], true);
      if (!rm.ok) await onLog("stderr", `[paperclip-worktree] worktree remove warning for ${wkt.worktreePath}: ${rm.stderr}\n`);
      runGit(wkt.repoRoot, ["branch", "-D", wkt.branch], true);
      if (opts.removeClaudeSessionDir) {
        const slug = "-" + wkt.worktreePath.replace(/[^A-Za-z0-9]/g, "-");
        const projectDir = path.join(os.homedir(), ".claude", "projects", slug);
        try {
          await fs.rm(projectDir, { recursive: true, force: true });
          await onLog("stdout", `[paperclip-worktree] Removed Claude Code session dir ${projectDir}\n`);
        } catch (err) {
          await onLog("stderr", `[paperclip-worktree] Claude session dir cleanup warning for ${projectDir}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    } else {
      await onLog("stdout", `[paperclip-worktree] Keeping worktree ${wkt.worktreePath} for subsequent wake (task not terminal).\n`);
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

  // Read GitHub PAT from macOS keychain if keychainService is configured
  const keychainService = asString(config.keychainService, "").trim();
  let ghPat = "";
  if (keychainService) {
    const keychainResult = spawnSync("security", ["find-generic-password", "-s", keychainService, "-w"], { encoding: "utf-8" });
    if (keychainResult.status === 0 && keychainResult.stdout) {
      ghPat = keychainResult.stdout.trim();
    }
  }

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    resolvedCommand,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  let cwd = runtimeConfig.cwd;

  // --- Pre-spawn: per-agent worktree provisioning (Layer 5) -----------------
  let worktreeResult: WorktreeProvisionResult | null = null;
  try {
    const wkCfg = parseWorktreeConfig(config);
    if (wkCfg) {
      const taskId =
        (typeof context.taskId === "string" && context.taskId.trim()) ||
        (typeof context.issueId === "string" && context.issueId.trim()) ||
        null;
      worktreeResult = await provisionWorktrees(wkCfg, taskId, parseObject(runtime.sessionParams), onLog, ghPat);
      if (worktreeResult) {
        cwd = worktreeResult.sessionCwd;
        for (const [k, v] of Object.entries(worktreeResult.envAdditions)) env[k] = v;
      }
    }
  } catch (err) {
    await onLog("stderr", `[paperclip-worktree] Pre-spawn provisioning threw: ${err instanceof Error ? err.message : String(err)}. Falling back to default cwd/env.\n`);
    worktreeResult = null;
  }

  // Auto-inject provider env vars for third-party models (e.g., MiniMax)
  const isThirdParty = model ? isThirdPartyModel(model) : false;
  const providerLabel = isThirdParty ? resolveProviderLabel(model) : "anthropic";
  if (isThirdParty) {
    const providerUrl = PROVIDER_ENDPOINTS[model];
    if (providerUrl && !env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = providerUrl;
    if (!env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = model;
    if (!env.ANTHROPIC_DEFAULT_SONNET_MODEL) env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    if (!env.ANTHROPIC_DEFAULT_OPUS_MODEL) env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    if (!env.ANTHROPIC_DEFAULT_HAIKU_MODEL) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    if (!env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (!env.API_TIMEOUT_MS) env.API_TIMEOUT_MS = "3000000";
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const claudeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveClaudeDesiredSkillNames(config, claudeSkillEntries));
  // When instructionsFilePath is configured, build a stable content-addressed
  // file that includes both the file content and the path directive, so we only
  // need --append-system-prompt-file (Claude CLI forbids using both flags together).
  let combinedInstructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective =
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
      combinedInstructionsContents = instructionsContent + pathDirective;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const promptBundle = await prepareClaudePromptBundle({
    companyId: agent.companyId,
    skills: claudeSkillEntries.filter((entry) => desiredSkillNames.has(entry.key)),
    instructionsContents: combinedInstructionsContents,
    onLog,
  });
  const effectiveInstructionsFilePath = promptBundle.instructionsFilePath ?? undefined;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    hasMatchingPromptBundle &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (
    runtimeSessionId &&
    runtimeSessionCwd.length > 0 &&
    path.resolve(runtimeSessionCwd) !== path.resolve(cwd)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  if (runtimeSessionId && runtimePromptBundleKey.length > 0 && runtimePromptBundleKey !== promptBundle.bundleKey) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}" and will not be resumed with "${promptBundle.bundleKey}".\n`,
    );
  }
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Check for workspace-local skills directory (agent-specific skills).
  // Done here (async, before buildClaudeArgs) so the sync arrow function can use the result.
  const hasWorkspaceSkills = await (async () => {
    try { return (await fs.stat(path.join(cwd, ".claude", "skills"))).isDirectory(); } catch { return false; }
  })();

  const buildClaudeArgs = (
    resumeSessionId: string | null,
    attemptInstructionsFilePath: string | undefined,
  ) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose", "--setting-sources", "user,project,local"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    // For Bedrock: only pass --model when the ID is a Bedrock-native identifier
    // (e.g. "us.anthropic.*" or ARN). Anthropic-style IDs like "claude-opus-4-6" are invalid
    // on Bedrock, so skip them and let the CLI use its own configured model.
    if (model && (!isBedrockAuth(effectiveEnv) || isBedrockModelId(model))) {
      args.push("--model", model);
    }
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // On resumed sessions the instructions are already in the session cache;
    // re-injecting them via --append-system-prompt-file wastes 5-10K tokens
    // per heartbeat and the Claude CLI may reject the combination outright.
    if (attemptInstructionsFilePath && !resumeSessionId) {
      args.push("--append-system-prompt-file", attemptInstructionsFilePath);
    }
    args.push("--add-dir", promptBundle.addDir);
    // If the workspace has a local .claude/skills/ directory, expose it as a
    // second --add-dir so workspace-scoped skills load automatically without
    // requiring vault-level registration. (fcc9c25f)
    if (hasWorkspaceSkills) {
      args.push("--add-dir", cwd);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const attemptInstructionsFilePath = resumeSessionId ? undefined : effectiveInstructionsFilePath;
    const args = buildClaudeArgs(resumeSessionId, attemptInstructionsFilePath);
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Claude prompt bundle ${promptBundle.bundleKey}.`);
    }
    if (attemptInstructionsFilePath && !resumeSessionId) {
      commandNotes.push(
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      );
    }
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command: resolvedCommand,
        cwd,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        promptBundleKey: promptBundle.bundleKey,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        // WORKTREE_PATCH_V2: persist the worktree key so the next wake
        // on this runtime session reuses the same worktree path.
        ...(worktreeResult ? { worktreeKey: worktreeResult.stableKey } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: providerLabel,
      biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : providerLabel,
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }
    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    // --- Post-completion: worktree push + PR + conditional cleanup (Layer 5)
    // Always runs (regardless of exit code). Never throws.
    if (worktreeResult) {
      let cleanup = worktreeResult.isEphemeral;
      if (!worktreeResult.isEphemeral && worktreeResult.taskId) {
        const status = await fetchTaskStatus(worktreeResult.taskId, onLog);
        if (status === "done" || status === "cancelled") {
          cleanup = true;
          await onLog("stdout", `[paperclip-worktree] Task ${worktreeResult.taskId} is ${status}; cleaning up worktree + branch + Claude session dir.\n`);
        } else {
          await onLog("stdout", `[paperclip-worktree] Task ${worktreeResult.taskId} status=${status ?? "unknown"}; preserving worktree for next wake.\n`);
        }
      }
      try {
        await finalizeWorktree(worktreeResult.primary, worktreeResult.config, { cleanup, removeClaudeSessionDir: cleanup, taskId: worktreeResult.taskId }, onLog, worktreeResult.ghPat);
        if (worktreeResult.secondary) {
          await finalizeWorktree(worktreeResult.secondary, worktreeResult.config, { cleanup, removeClaudeSessionDir: false, taskId: worktreeResult.taskId }, onLog, worktreeResult.ghPat);
        }
      } catch (err) {
        await onLog("stderr", `[paperclip-worktree] Post-completion error (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
      }
      // Always release the wake lock.
      try { await fs.rm(worktreeResult.lockPath, { force: true }); } catch { /* ignore */ }
    }
  }
}
