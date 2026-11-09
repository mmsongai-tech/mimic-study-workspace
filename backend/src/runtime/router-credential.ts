import { userInfo } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const ROUTER_KEYCHAIN_SERVICE = "com.xiaoming.mimic-research-agent-platform.local.router-api-key";

type KeychainRunner = (
  command: string,
  arguments_: string[],
  options: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "ignore"] },
) => SpawnSyncReturns<string>;

export const loadRouterApiKey = (input: {
  environment?: NodeJS.ProcessEnv;
  account?: string;
  platform?: NodeJS.Platform;
  runner?: KeychainRunner;
} = {}): string => {
  const environment = input.environment ?? process.env;
  const environmentKey = environment.MIMIC_ROUTER_API_KEY ?? environment.OPENROUTER_API_KEY;
  if (environmentKey?.trim()) return environmentKey.trim();
  if ((input.platform ?? process.platform) !== "darwin") return "";
  const runner = input.runner ?? spawnSync;
  try {
    const result = runner(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        input.account ?? userInfo().username,
        "-s",
        ROUTER_KEYCHAIN_SERVICE,
        "-w",
      ],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  } catch {
    return "";
  }
};
