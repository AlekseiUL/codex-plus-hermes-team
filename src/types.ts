import { z } from "zod";

export const SideEffectPolicySchema = z.enum([
  "advice_only",
  "read_only",
  "local_files_allowed",
  "external_side_effects_need_approval",
  "external_side_effects_allowed"
]);

export type SideEffectPolicy = z.infer<typeof SideEffectPolicySchema>;
export const DEFAULT_SIDE_EFFECT_POLICY: SideEffectPolicy = "advice_only";

export const AgentSchema = z.object({
  profile: z.string().min(1),
  id: z.string().optional(),
  displayName: z.string().optional(),
  role: z.string().optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  toolsets: z.array(z.string()).optional(),
  disabled: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const BridgeConfigSchema = z.object({
  hermes: z
    .object({
      command: z.string().default("hermes"),
      profileFlag: z.string().default("--profile"),
      defaultCwd: z.string().optional(),
      timeoutMs: z.number().int().positive().default(600_000),
      defaultToolsets: z.array(z.string()).default([]),
      model: z.string().optional(),
      provider: z.string().optional()
    })
    .default({
      command: "hermes",
      profileFlag: "--profile",
      timeoutMs: 600_000,
      defaultToolsets: []
    }),
  discovery: z
    .object({
      enabled: z.boolean().default(true),
      profilePrefix: z.string().optional(),
      includeStopped: z.boolean().default(true)
    })
    .default({
      enabled: true,
      includeStopped: true
    }),
  routing: z
    .object({
      defaultProfiles: z.array(z.string()).default([]),
      maxPanelAgents: z.number().int().positive().max(12).default(4)
    })
    .default({
      defaultProfiles: [],
      maxPanelAgents: 4
    }),
  kanban: z
    .object({
      enabled: z.boolean().default(false),
      board: z.string().optional(),
      dispatcherProfile: z.string().optional(),
      workspace: z.string().default("scratch"),
      createdBy: z.string().default("codex-plus-hermes-team"),
      maxRuntime: z.string().optional()
    })
    .default({
      enabled: false,
      workspace: "scratch",
      createdBy: "codex-plus-hermes-team"
    }),
  safety: z
    .object({
      defaultSideEffectPolicy: SideEffectPolicySchema.default(DEFAULT_SIDE_EFFECT_POLICY)
    })
    .default({
      defaultSideEffectPolicy: DEFAULT_SIDE_EFFECT_POLICY
    }),
  agents: z.array(AgentSchema).default([])
});

export type TeamAgent = z.infer<typeof AgentSchema>;
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export type AskAgentInput = {
  profile: string;
  prompt: string;
  sideEffectPolicy?: SideEffectPolicy | undefined;
  cwd?: string | undefined;
  toolsets?: string[] | undefined;
  timeoutMs?: number | undefined;
};

export type AskAgentResult = {
  profile: string;
  text: string;
  sideEffectPolicy?: SideEffectPolicy | undefined;
  stderr?: string | undefined;
};

export type RouteDecision = {
  selected: TeamAgent[];
  confidence: number;
  why: string[];
  routeMode: "matched" | "default_profiles" | "first_available";
  scores: Array<{
    profile: string;
    score: number;
    matched: string[];
    confidence: number;
    why: string[];
    selected: boolean;
  }>;
};
