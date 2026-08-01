import type { BridgeConfig, TeamAgent, AskAgentInput, AskAgentResult, SideEffectPolicy } from "../types.js";
import { runCommand } from "../command.js";
import { describeSideEffectPolicy, resolveSideEffectPolicy } from "../policy.js";
import { getConfiguredAgent } from "../registry.js";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

function latestActiveSessionId(): string | null {
  // Resolve the most recently active, still-open Hermes session from
  // HERMES_HOME/runtime-data/state.db so one-shots answer with real
  // conversation context via `--resume <id>` (same behavior as the
  // Athena /hermes/ask backend). Read-only; session is never written.
  const home = process.env.HERMES_HOME || join(homedir(), ".hermes");
  const dbPath = join(home, "runtime-data", "state.db");
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT id FROM sessions WHERE ended_at IS NULL AND archived = 0 ORDER BY started_at DESC LIMIT 1"
        )
        .get() as { id?: string } | undefined;
      return row?.id ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

type ProfileListRow = {
  profile: string;
  model?: string | undefined;
  gateway?: string | undefined;
};

export class HermesCliProvider {
  constructor(private readonly config: BridgeConfig) {}

  async health() {
    const result = await runCommand(this.config.hermes.command, ["--version"], {
      cwd: this.config.hermes.defaultCwd,
      timeoutMs: 15_000
    });

    return {
      ok: result.code === 0,
      command: this.config.hermes.command,
      version: result.stdout.trim() || result.stderr.trim(),
      stderr: result.stderr.trim() || undefined
    };
  }

  async discoverAgents(): Promise<TeamAgent[]> {
    if (!this.config.discovery.enabled) {
      return [];
    }

    const result = await runCommand(this.config.hermes.command, ["profile", "list"], {
      cwd: this.config.hermes.defaultCwd,
      timeoutMs: 30_000
    });

    if (result.code !== 0) {
      return [];
    }

    return parseProfileList(result.stdout)
      .filter((row) => this.shouldIncludeProfile(row))
      .map((row) => ({
        profile: row.profile,
        displayName: row.profile,
        role: "hermes_profile",
        description: row.gateway ? `Hermes profile (${row.gateway})` : "Hermes profile",
        capabilities: [],
        disabled: false,
        metadata: {
          model: row.model,
          gateway: row.gateway,
          source: "hermes profile list"
        }
      }));
  }

  async askAgent(input: AskAgentInput): Promise<AskAgentResult> {
    const agent = getConfiguredAgent(this.config, input.profile);
    const cwd = input.cwd ?? agent?.cwd ?? this.config.hermes.defaultCwd;
    const toolsets = input.toolsets ?? agent?.toolsets ?? this.config.hermes.defaultToolsets;
    const sideEffectPolicy = resolveSideEffectPolicy(
      input.sideEffectPolicy,
      this.config.safety.defaultSideEffectPolicy
    );
    const prompt = buildSpecialistPrompt(input.profile, input.prompt, sideEffectPolicy);

    const args = [
      this.config.hermes.profileFlag,
      input.profile,
      ...(toolsets.length > 0 ? ["--toolsets", toolsets.join(",")] : []),
      "--oneshot",
      prompt,
      // Pin model/provider when configured. Order matters: the prompt
      // must immediately follow --oneshot (Hermes CLI parses it as a
      // value-taking option). Without a pin, a profile without an
      // explicit model falls back to a recommended model that may route
      // to a provider with no payment method (e.g. Zen gateway) and the
      // oneshot fails with 401.
      ...(this.config.hermes.model ? ["--model", this.config.hermes.model] : []),
      ...(this.config.hermes.provider ? ["--provider", this.config.hermes.provider] : []),
      // Resume the caller's live Hermes session so the one-shot answers
      // with real conversation context, not in a vacuum.
      ...(latestActiveSessionId() ? ["--resume", latestActiveSessionId()!] : [])
    ];

    const result = await runCommand(this.config.hermes.command, args, {
      cwd,
      timeoutMs: input.timeoutMs ?? this.config.hermes.timeoutMs,
      env: {
        HERMES_ACCEPT_HOOKS: "1"
      }
    });

    if (result.code !== 0) {
      throw new Error(
        `Hermes profile ${input.profile} failed with code ${result.code}.\n${result.stderr.trim()}`
      );
    }

    return {
      profile: input.profile,
      text: result.stdout.trim(),
      sideEffectPolicy,
      stderr: result.stderr.trim() || undefined
    };
  }

  async createKanbanTask(input: {
    title: string;
    body: string;
    assignee?: string | undefined;
    parent?: string | undefined;
    priority?: string | undefined;
    workspace?: string | undefined;
    idempotencyKey?: string | undefined;
  }) {
    if (!this.config.kanban.enabled) {
      throw new Error("Kanban support is disabled. Set kanban.enabled: true in the bridge config.");
    }

    const args = [
      ...this.profilePrefixArgs(this.config.kanban.dispatcherProfile),
      "kanban",
      ...(this.config.kanban.board ? ["--board", this.config.kanban.board] : []),
      "create",
      input.title,
      "--body",
      input.body,
      "--workspace",
      input.workspace ?? this.config.kanban.workspace,
      "--created-by",
      this.config.kanban.createdBy,
      "--json",
      ...(input.assignee ? ["--assignee", input.assignee] : []),
      ...(input.parent ? ["--parent", input.parent] : []),
      ...(input.priority ? ["--priority", input.priority] : []),
      ...(input.idempotencyKey ? ["--idempotency-key", input.idempotencyKey] : []),
      ...(this.config.kanban.maxRuntime ? ["--max-runtime", this.config.kanban.maxRuntime] : [])
    ];

    const result = await runCommand(this.config.hermes.command, args, {
      cwd: this.config.hermes.defaultCwd,
      timeoutMs: 30_000
    });

    if (result.code !== 0) {
      throw new Error(`Hermes kanban create failed.\n${result.stderr.trim()}`);
    }

    return safeJson(result.stdout);
  }

  async getKanbanTask(taskId: string) {
    if (!this.config.kanban.enabled) {
      throw new Error("Kanban support is disabled. Set kanban.enabled: true in the bridge config.");
    }

    const args = [
      ...this.profilePrefixArgs(this.config.kanban.dispatcherProfile),
      "kanban",
      ...(this.config.kanban.board ? ["--board", this.config.kanban.board] : []),
      "show",
      taskId,
      "--json"
    ];

    const result = await runCommand(this.config.hermes.command, args, {
      cwd: this.config.hermes.defaultCwd,
      timeoutMs: 30_000
    });

    if (result.code !== 0) {
      throw new Error(`Hermes kanban show failed.\n${result.stderr.trim()}`);
    }

    return safeJson(result.stdout);
  }

  async getKanbanRuns(taskId: string) {
    if (!this.config.kanban.enabled) {
      throw new Error("Kanban support is disabled. Set kanban.enabled: true in the bridge config.");
    }

    const args = [
      ...this.profilePrefixArgs(this.config.kanban.dispatcherProfile),
      "kanban",
      ...(this.config.kanban.board ? ["--board", this.config.kanban.board] : []),
      "runs",
      taskId,
      "--json"
    ];

    const result = await runCommand(this.config.hermes.command, args, {
      cwd: this.config.hermes.defaultCwd,
      timeoutMs: 30_000
    });

    if (result.code !== 0) {
      throw new Error(`Hermes kanban runs failed.\n${result.stderr.trim()}`);
    }

    return safeJson(result.stdout);
  }

  private shouldIncludeProfile(row: ProfileListRow): boolean {
    const prefix = this.config.discovery.profilePrefix;
    if (prefix && !row.profile.startsWith(prefix)) return false;
    if (!this.config.discovery.includeStopped && row.gateway === "stopped") return false;
    return true;
  }

  private profilePrefixArgs(profile?: string) {
    return profile ? [this.config.hermes.profileFlag, profile] : [];
  }
}

export function parseProfileList(output: string): ProfileListRow[] {
  const rows: ProfileListRow[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/[◆│┃┆]/g, " ").trim();
    if (!line || line.startsWith("Profile") || line.startsWith("─")) continue;

    const parts = line.split(/\s{2,}|\t+/).map((item) => item.trim()).filter(Boolean);
    const [profile, model, gateway] = parts;
    if (!profile || profile === "Profile") continue;
    if (profile.includes("─")) continue;

    rows.push({ profile, model, gateway });
  }

  return rows;
}

function buildSpecialistPrompt(profile: string, task: string, sideEffectPolicy: SideEffectPolicy) {
  return [
    `You are being consulted through Codex + Hermes Team as Hermes profile \`${profile}\`.`,
    "",
    "Answer as a specialist. Be concise, concrete, and useful to a coding assistant that will synthesize the final answer.",
    `Side-effect policy: ${sideEffectPolicy}`,
    describeSideEffectPolicy(sideEffectPolicy),
    "If the task needs another specialist, say who should be consulted and why.",
    "",
    "Task:",
    task
  ].join("\n");
}

function safeJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return { raw: output.trim() };
  }
}
