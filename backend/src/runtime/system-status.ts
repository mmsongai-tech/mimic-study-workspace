import type { StructuredResearchDesignProvider } from "./retrying-research-design-model.js";
import { StructuredProviderError } from "./retrying-research-design-model.js";

export type CapabilityState = "ready" | "degraded" | "disabled" | "unknown";
export interface CapabilityStatus { id: string; label: string; state: CapabilityState; summary: string; failure_stage?: string; reason?: string; next_action?: string; checked_at: string }
export interface SystemStatusReport { schema_version: "1.0.0"; status: "ready" | "degraded"; capabilities: CapabilityStatus[] }

export class SystemStatusService {
  private readonly capabilities = new Map<string, CapabilityStatus>();
  constructor(initial: Omit<CapabilityStatus, "checked_at">[], private readonly now: () => Date = () => new Date()) { for (const item of initial) this.set(item); }
  set(item: Omit<CapabilityStatus, "checked_at">): void { this.capabilities.set(item.id, { ...item, checked_at: this.now().toISOString() }); }
  report(): SystemStatusReport {
    const capabilities = [...this.capabilities.values()];
    return { schema_version: "1.0.0", status: capabilities.some(({ state }) => state === "degraded") ? "degraded" : "ready", capabilities };
  }
}

// Maps an internal provider identity to the safe, user-visible label. Never
// hard-code "Router" here: a local or OpenAI-fallback attempt must be labeled
// as such, or operators cannot trust the status panel to reflect reality.
const providerLabel = (provider?: string): string =>
  provider === "local" ? "本地模型" : provider === "openai" ? "OpenAI 备用" : provider === "router" ? "Router" : "模型服务";

const providerFailure = (error: unknown): Omit<CapabilityStatus, "checked_at"> => {
  const code = error instanceof StructuredProviderError ? error.code : "PROVIDER_UNAVAILABLE";
  const provider = error instanceof StructuredProviderError ? error.provider : "router";
  const label = providerLabel(provider);
  const common = { id: "research_design_model", label: "研究设计模型", state: "degraded" as const };
  if (code === "PROVIDER_AUTHENTICATION_FAILED" && provider === "openai") {
    return { ...common, summary: "OpenAI 备用鉴权失败", failure_stage: "authentication_openai", reason: "OpenAI 拒绝了当前备用 Key。", next_action: "请在凭证管理中更新可用的 OpenAI Key，并使用已授权入口重试。" };
  }
  switch (code) {
    case "PROVIDER_NOT_CONFIGURED": return { ...common, summary: `${label} 未配置`, failure_stage: "configuration", reason: `项目 ${label} Key 未配置。`, next_action: "运行 npm run router:setup 后重启；本地页面和已有合成流程仍可使用。" };
    case "PROVIDER_AUTHENTICATION_FAILED": return { ...common, summary: `${label} 鉴权失败`, failure_stage: "authentication", reason: `${label} 拒绝了当前凭证。`, next_action: "检查 Key 是否有效以及是否有模型访问权限。" };
    case "PROVIDER_RATE_LIMITED": return { ...common, summary: `${label} 请求受限`, failure_stage: "rate_limit", reason: `${label} 返回限流响应。`, next_action: "稍后重试，或检查账户额度和限流设置。" };
    case "PROVIDER_TIMEOUT": return { ...common, summary: `${label} 请求超时`, failure_stage: "request", reason: `${label} 未在配置的时间内响应。`, next_action: `检查公司网络、代理和 ${label} 服务状态后重试。` };
    case "PROVIDER_REQUEST_REJECTED": return { ...common, summary: `${label} 拒绝请求`, failure_stage: "request", reason: `${label} 返回了不可重试的请求错误。`, next_action: "检查模型名称、账户权限和请求兼容性。" };
    case "PROVIDER_RESPONSE_INVALID": return { ...common, summary: `${label} 响应无效`, failure_stage: "response", reason: `${label} 返回的内容无法解析为研究设计。`, next_action: "重试；若持续发生，请检查模型的结构化输出兼容性。" };
    case "PROVIDER_RESPONSE_TRUNCATED": return { ...common, summary: `${label} 输出被截断`, failure_stage: "response", reason: "模型输出超过了研究方案的输出上限，未形成完整结构。", next_action: "使用支持足够输出长度的候选模型重试；系统不会执行被截断的方案。" };
    case "PROVIDER_PREFLIGHT_FAILED": return { ...common, summary: `${label} 快速检查未通过`, failure_stage: "preflight", reason: `正式模型请求前的 ${label} 可用性检查未通过。`, next_action: `稍后重试；若持续发生，请检查 ${label} 网络、凭证和模型服务状态。` };
    default: return { ...common, summary: `${label} 模型暂不可用`, failure_stage: "provider", reason: "快速可用性检查通过后，实际模型请求仍未成功。", next_action: `稍后重试；若持续发生，请检查模型路由、模型名称和 ${label} 服务状态。` };
  }
};

export class StatusTrackingStructuredProvider implements StructuredResearchDesignProvider {
  // Tracks which underlying provider (router / local / openai) actually served the
  // most recent attempt, so a success summary never claims "Router" for a local run.
  private lastSucceededProvider: string | undefined;

  constructor(private readonly provider: StructuredResearchDesignProvider, private readonly status: SystemStatusService) {
    this.provider.setAttemptHandler?.((attempt) => {
      if (attempt.outcome === "succeeded") this.lastSucceededProvider = attempt.provider;
    });
  }
  setAttemptHandler(handler?: Parameters<NonNullable<StructuredResearchDesignProvider["setAttemptHandler"]>>[0]): void {
    this.provider.setAttemptHandler?.((attempt) => {
      if (attempt.outcome === "succeeded") this.lastSucceededProvider = attempt.provider;
      handler?.(attempt);
    });
  }
  async generateProposal(input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): Promise<unknown> {
    try {
      const proposal = await this.provider.generateProposal(input);
      const label = providerLabel(this.lastSucceededProvider);
      this.status.set({ id: "research_design_model", label: "研究设计模型", state: "ready", summary: `${label} 请求成功` });
      return proposal;
    } catch (error) { this.status.set(providerFailure(error)); throw error; }
  }
}

export const createUnavailableStructuredProvider = (): StructuredResearchDesignProvider => ({
  async generateProposal() { throw new StructuredProviderError("The research-design provider is not configured.", false, "PROVIDER_NOT_CONFIGURED"); },
});
