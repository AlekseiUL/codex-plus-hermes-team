import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    timeoutMs?: number | undefined;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Hermes oneshot only talks to api.deepseek.com (and localhost).
    // The host env may carry http_proxy (e.g. Clash) which Python's
    // httpx picks up via trust_env — when the proxy is down the
    // one-shot hangs/backs off. Pin NO_PROXY so DeepSeek + localhost
    // stay direct while the proxy remains available as fallback.
    const childEnv = {
      ...process.env,
      ...(options.env ?? {}),
      NO_PROXY: "api.deepseek.com,127.0.0.1,localhost",
      no_proxy: "api.deepseek.com,127.0.0.1,localhost",
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
          }, options.timeoutMs)
        : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
