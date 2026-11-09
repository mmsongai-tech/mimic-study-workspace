import { pathToFileURL } from "node:url";
import { accessSync, appendFileSync, constants, statSync } from "node:fs";
import {
  createRetryingResearchDesignModelFactory,
  createMeteredModelFetch,
  createUnavailableStructuredProvider,
  FallbackStructuredProvider,
  loadOpenAiApiKey,
  loadRouterApiKey,
  ModelPoolStructuredProvider,
  nodeHttp1Fetch,
  OpenAiCompatibleStructuredProvider,
  PreflightStructuredProvider,
  RouterAvailabilityProbe,
  RouterModelAvailabilityProbe,
  requireRouterBaseUrl,
  resolveBackendRuntimeConfig,
  routerEnvironmentLayer,
  StatusTrackingStructuredProvider,
  SystemStatusService,
  StructuredProviderError,
} from "../runtime/index.js";
import { startWorkspaceApplication } from "./workspace-application.js";
import type {
  StructuredResearchDesignProvider,
  StructuredProviderAttempt,
} from "../runtime/retrying-research-design-model.js";

const DEFAULT_LOCAL_MODEL_BASE_URL = "http://127.0.0.1:11434/v1";

export class SequentialStructuredProvider implements StructuredResearchDesignProvider {
  private attemptHandler: ((attempt: StructuredProviderAttempt) => void) | undefined;
  constructor(
    private readonly providers: StructuredResearchDesignProvider[],
  ) {}

  setAttemptHandler(handler: ((attempt: StructuredProviderAttempt) => void) | undefined): void {
    this.attemptHandler = handler;
    for (const provider of this.providers) provider.setAttemptHandler?.(handler);
  }

  async generateProposal(input: Parameters<StructuredResearchDesignProvider["generateProposal"]>[0]): Promise<unknown> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        return await provider.generateProposal(input);
      } catch (error) {
        lastError = error;
        if (error instanceof StructuredProviderError) {
          if (error.code === "PROVIDER_AUTHENTICATION_FAILED" && provider === this.providers.at(-1)) {
            throw error;
          }
          continue;
        }
        throw error;
      }
    }
    if (lastError instanceof StructuredProviderError) throw lastError;
    if (lastError instanceof Error) throw lastError;
    throw new Error("All configured structured providers failed.");
  }
}

const DEFAULT_DEVELOPMENT_MODEL = "aws/gpt-5.4-mini";

const cliValue = (arguments_: string[], name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};

export const startRouterServer = async (arguments_: string[] = [], environment: NodeJS.ProcessEnv = process.env) => {
  const modelAccessEnabled = environment.MIMIC_MODEL_ACCESS === "enabled";
  const apiKey = modelAccessEnabled ? loadRouterApiKey({ environment }) : undefined;
  const configuredOpenAiApiKey = modelAccessEnabled ? loadOpenAiApiKey({ environment }) : "";
  const openAiModel: string = environment.MIMIC_OPENAI_FALLBACK_MODEL ?? "gpt-4o-mini";
  const model = environment.OPENROUTER_MODEL ?? DEFAULT_DEVELOPMENT_MODEL;
  const routerReasoningEffort = environment.MIMIC_ROUTER_REASONING_EFFORT;
  if (routerReasoningEffort !== undefined && routerReasoningEffort !== "low" && routerReasoningEffort !== "medium" && routerReasoningEffort !== "high" && routerReasoningEffort !== "xhigh") {
    throw new Error("MIMIC_ROUTER_REASONING_EFFORT must be low, medium, high or xhigh.");
  }
  const models = (environment.OPENROUTER_MODELS ?? model).split(",").map((candidate) => candidate.trim()).filter(Boolean);
  const retryMaxAttempts = Number(environment.MIMIC_MODEL_RETRY_MAX_ATTEMPTS ?? "3");
  const modelTimeoutMs = Number(environment.MIMIC_MODEL_TIMEOUT_MS ?? environment.DESIGN_MODEL_TIMEOUT_MS ?? "30000");
  const modelMaxOutputTokens = Number(environment.MIMIC_MODEL_MAX_OUTPUT_TOKENS ?? "4000");
  const hostValue = cliValue(arguments_, "--host");
  const portValue = cliValue(arguments_, "--port");
  const databaseValue = cliValue(arguments_, "--database");
  const localArchivePath = environment.MIMIC_LOCAL_ARCHIVE;
  const reportPythonBinary = environment.MIMIC_REPORT_PYTHON_BINARY;
  if (!localArchivePath) {
    throw new Error("MIMIC_LOCAL_ARCHIVE is required. The product backend does not fall back to synthetic data.");
  }
  try {
    accessSync(localArchivePath, constants.R_OK);
    if (!statSync(localArchivePath).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("MIMIC_LOCAL_ARCHIVE must reference a readable local archive file. The product backend was not started.");
  }
  const config = resolveBackendRuntimeConfig({
    environment: {
      research_design: {
        model: { profile: model, timeout_ms: modelTimeoutMs, max_output_tokens: modelMaxOutputTokens, retry_max_attempts: retryMaxAttempts },
        local: {
          enabled: environment.MIMIC_LOCAL_MODEL_ENABLED === "enabled",
          profile: environment.MIMIC_LOCAL_MODEL_PROFILE?.trim() || "disabled",
          base_url: environment.MIMIC_LOCAL_MODEL_BASE_URL?.trim() || DEFAULT_LOCAL_MODEL_BASE_URL,
        },
        ...routerEnvironmentLayer(environment),
      },
      ...(reportPythonBinary ? { report_exports: { python_binary: reportPythonBinary } } : {}),
      generated_analysis: { enabled: environment.MIMIC_ENABLE_GENERATED_ANALYSIS === "1" },
      clinical_database: {
        enabled: environment.MIMIC_ENABLE_CLINICAL_DATABASE === "1",
        local_evidence_scan_timeout_ms: Number(environment.MIMIC_LOCAL_EVIDENCE_SCAN_TIMEOUT_MS ?? "300000"),
        local_evidence_max_member_bytes: Number(environment.MIMIC_LOCAL_EVIDENCE_MAX_MEMBER_BYTES ?? "750000000"),
      },
    },
    cli: {
      server: { ...(hostValue ? { host: hostValue } : {}), ...(portValue ? { port: Number(portValue) } : {}) },
      storage: { ...(databaseValue ? { database_path: databaseValue } : {}) },
    },
  });
  const localModelEnabled = config.research_design.local.enabled && config.research_design.local.profile !== "disabled";
  const localModelProfile = localModelEnabled ? config.research_design.local.profile : undefined;
  const localModelBaseUrl = config.research_design.local.base_url;
  // A router is used only when model access is enabled and a key is present; then its address must be configured (no default host).
  const routerBaseUrl = apiKey ? requireRouterBaseUrl(config) : "";
  const systemStatus = new SystemStatusService([
    { id: "workspace", label: "本地工作台", state: "ready", summary: "静态页面和本地 API 已装载" },
    { id: "storage", label: "本地存储", state: "ready", summary: "SQLite 会话与证据存储已装载" },
    apiKey || localModelEnabled
      ? {
        id: "research_design_model",
        label: "研究设计模型",
        state: "unknown",
        summary: localModelEnabled
          ? apiKey
            ? `本地优先模型已配置，Router 待命（${models.join(" → ")}）；等待首次请求`
            : `本地模型已配置（${localModelProfile}）；等待首次请求`
          : `Router 已显式开启，等待首次请求（${models.join(" → ")}）`,
      }
      : modelAccessEnabled
        ? { id: "research_design_model", label: "研究设计模型", state: "degraded", summary: "Router 未配置", failure_stage: "configuration", reason: "项目 Router Key 未配置。", next_action: "运行 npm run router:setup 后重新使用模型启动脚本；本地页面和已有流程仍可使用。" }
        : { id: "research_design_model", label: "研究设计模型", state: "disabled", summary: "模型调用已关闭；本次后端不会产生模型费用" },
    { id: "research_design_validation", label: "研究方案校验", state: "unknown", summary: "等待首次模型方案进行结构与业务规则校验" },
    { id: "statistical_runtime", label: "统计运行时", state: "unknown", summary: "R 将在执行分析时验证" },
    { id: "report_runtime", label: "报告运行时", state: "unknown", summary: "Python 将在导出报告时验证" },
    { id: "local_mimic_archive", label: "本地 MIMIC-IV 数据", state: "ready", summary: "本地只读完整档案已接入动态变量映射与聚合证据验证" },
    config.generated_analysis.enabled && apiKey
      ? { id: "generated_analysis", label: "受控通用分析", state: "unknown", summary: "已启用；仅在显式确认后调用低成本模型并隔离执行" }
      : { id: "generated_analysis", label: "受控通用分析", state: "disabled", summary: "默认关闭；现有模板与页面不受影响" },
  ]);
  let openAiApiKey = "";
  if (configuredOpenAiApiKey) {
    const timeoutMs = Number(environment.MIMIC_OPENAI_KEY_CHECK_TIMEOUT_MS ?? "2000");
    const requestSignal = new AbortController();
    const timer = setTimeout(() => requestSignal.abort(), timeoutMs);
    try {
      const probe = await nodeHttp1Fetch("https://api.openai.com/v1/models", {
        method: "GET",
        headers: { authorization: `Bearer ${configuredOpenAiApiKey}` },
        signal: requestSignal.signal,
      });
      if (probe.status === 200) {
        openAiApiKey = configuredOpenAiApiKey;
        if (apiKey) systemStatus.set({ id: "research_design_model", label: "研究设计模型", state: "unknown", summary: `Router 已显式开启；OpenAI 备用 Key 已在启动时加载并通过零推理鉴权（${openAiModel}）` });
      }
      else if (apiKey) {
        systemStatus.set({
          id: "research_design_model",
          label: "研究设计模型",
          state: "unknown",
          summary: "启动时读取的 OpenAI 备用凭证未通过鉴权检查；本次后端不启用 fallback 兜底。",
          failure_stage: "authentication_openai",
          reason: `OpenAI /v1/models 返回 ${probe.status}，未达到可用条件。`,
          next_action: "替换 OpenAI 备用 Key 后重启后端。若仍需授权 fallback，请先校验 Key 可用性。",
        });
      }
    } catch {
      if (configuredOpenAiApiKey && apiKey) {
        systemStatus.set({
          id: "research_design_model",
          label: "研究设计模型",
          state: "unknown",
          summary: "启动时读取的 OpenAI 备用凭证检查失败；本次后端不启用 fallback 兜底。",
          failure_stage: "configuration",
          reason: "备用 Key 检查期间无法连接到 OpenAI。",
          next_action: "确认网络与 DNS 后，提供可用 Key 并重启。",
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const localProvider = localModelEnabled && localModelProfile ? new OpenAiCompatibleStructuredProvider({
    base_url: localModelBaseUrl,
    max_output_tokens: config.research_design.model.max_output_tokens,
    provider: "local",
  }) : undefined;
  const localPoolProvider = localProvider
    ? new ModelPoolStructuredProvider(localProvider, [localModelProfile ?? ""], undefined, undefined, "local")
    : undefined;
  const routerProvider = apiKey ? new PreflightStructuredProvider(new OpenAiCompatibleStructuredProvider({
    base_url: routerBaseUrl,
    api_key: apiKey,
    max_output_tokens: config.research_design.model.max_output_tokens,
    provider: "router",
    ...(routerReasoningEffort ? { reasoning_effort: routerReasoningEffort } : {}),
    ...(environment.MIMIC_MODEL_METRICS_PATH ? { fetch: createMeteredModelFetch({
      fetch: nodeHttp1Fetch,
      provider: "router",
      record: (metric) => appendFileSync(environment.MIMIC_MODEL_METRICS_PATH!, `${JSON.stringify(metric)}\n`, { mode: 0o600 }),
    }) } : {}),
  }), new RouterAvailabilityProbe({
    base_url: routerBaseUrl,
    api_key: apiKey,
    timeout_ms: Number(environment.MIMIC_ROUTER_PREFLIGHT_TIMEOUT_MS ?? "1500"),
  })) : createUnavailableStructuredProvider();
  const routerModelProbe = apiKey ? new RouterModelAvailabilityProbe({
    base_url: routerBaseUrl,
    api_key: apiKey,
    timeout_ms: Number(environment.MIMIC_ROUTER_MODEL_PROBE_TIMEOUT_MS ?? "5000"),
  }) : undefined;
  const routerPoolProvider = apiKey ? new ModelPoolStructuredProvider(routerProvider, models, (attempts) => {
    const successful = attempts.find(({ outcome }) => outcome === "succeeded");
    if (successful) {
      systemStatus.set({
        id: "research_design_model",
        label: "研究设计模型",
        state: "ready",
        summary: `Router 请求成功（${successful.model}；尝试 ${attempts.length} 个模型）`,
      });
    }
  }, undefined, "router", routerModelProbe) : createUnavailableStructuredProvider();
  const primaryProvider = localPoolProvider
    ? (apiKey ? new SequentialStructuredProvider([localPoolProvider, routerPoolProvider]) : localPoolProvider)
    : routerPoolProvider;
  const fallbackProvider = openAiApiKey
    ? new FallbackStructuredProvider(
      primaryProvider,
      {
        provider: new OpenAiCompatibleStructuredProvider({
          base_url: "https://api.openai.com/v1",
          api_key: openAiApiKey,
          max_output_tokens: config.research_design.model.max_output_tokens,
          provider: "openai",
        }),
        model: openAiModel,
      },
      (fallbackModel) => systemStatus.set({
        id: "research_design_model",
        label: "研究设计模型",
        state: "unknown",
        summary: `Router 不可用，正在使用已授权 OpenAI 备用（${fallbackModel}）`,
      }),
    )
    : primaryProvider;
  const provider = new StatusTrackingStructuredProvider(fallbackProvider, systemStatus);
  return startWorkspaceApplication({
    config,
    modelFactory: createRetryingResearchDesignModelFactory(provider),
    systemStatus,
    localArchivePath,
    ...(config.generated_analysis.enabled && apiKey ? {
      guardedPlanner: {
        base_url: routerBaseUrl,
        api_key: apiKey,
        model,
      },
    } : {}),
    ...(apiKey ? { mappingPlanner: { base_url: routerBaseUrl, api_key: apiKey, model, models } } : {}),
  });
};

const main = async (): Promise<void> => {
  const runtime = await startRouterServer(process.argv.slice(2));
  process.stdout.write(`MIMIC research workspace listening at ${runtime.origin}\n`);
  const shutdown = async (): Promise<void> => { await runtime.close(); process.exitCode = 0; };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Router-backed server failed to start."}\n`); process.exitCode = 1; });
}
