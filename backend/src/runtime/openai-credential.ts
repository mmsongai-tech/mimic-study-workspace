import { userInfo } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const OPENAI_KEYCHAIN_SERVICE = "com.xiaoming.mimic-research-agent-platform.local.openai-api-key";
type KeychainRunner = (command: string, arguments_: string[], options: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "ignore"] }) => SpawnSyncReturns<string>;

/** Loads the optional OpenAI fallback credential without exposing it to browser code. */
export const loadOpenAiApiKey = (input: { environment?: NodeJS.ProcessEnv; account?: string; platform?: NodeJS.Platform; runner?: KeychainRunner } = {}): string => {
  const environment=input.environment ?? process.env;
  // An explicit opt-out prevents both credential access and startup network probes.
  if (environment.MIMIC_OPENAI_FALLBACK_ACCESS === "disabled") return "";
  const environmentKey=environment.MIMIC_OPENAI_API_KEY ?? environment.OPENAI_API_KEY;
  if(environmentKey?.trim()) return environmentKey.trim();
  if((input.platform ?? process.platform)!=="darwin") return "";
  try { const result=(input.runner ?? spawnSync)("/usr/bin/security",["find-generic-password","-a",input.account ?? userInfo().username,"-s",OPENAI_KEYCHAIN_SERVICE,"-w"],{encoding:"utf8",timeout:5000,stdio:["ignore","pipe","ignore"]}); return result.status===0&&typeof result.stdout==="string"?result.stdout.trim():""; } catch { return ""; }
};
