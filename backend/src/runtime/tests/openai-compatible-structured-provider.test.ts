import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleStructuredProvider, StructuredProviderError } from "../index.js";
import { completeAssociationProposal } from "../../research-design/tests/model-fixtures.js";

const proposal = completeAssociationProposal();

const completeProposalWithCandidateSpec = () => {
  const result = completeAssociationProposal();
  const candidateSpec: Record<string, unknown> = { schema_version: "1.0.0", intent_family: "association" };
  for (const operation of result.spec_patch) {
    if ((operation.op === "add" || operation.op === "replace") && operation.path.split("/").length === 2) {
      candidateSpec[operation.path.slice(1)] = structuredClone(operation.value);
    }
  }
  result.candidate_spec = candidateSpec as unknown as NonNullable<typeof result.candidate_spec>;
  return result;
};

const completeChineseProposal = () => {
  const result = completeProposalWithCandidateSpec();
  result.assistant_message = "研究问题已整理为关联性研究。";
  result.intent_assessment.reason = "该问题询问一个因素与结局之间的关联。";
  const candidate = result.candidate_spec;
  if (!candidate) throw new Error("The fixture must include a candidate spec.");
  candidate.title = "住院人群关联性研究";
  candidate.research_question = "入科后年龄与院内死亡是否相关";
  candidate.population = { description: "符合条件的成年住院患者" };
  candidate.index_time = { event: "住院入科", selection_rule: "首次符合条件的入科记录" };
  candidate.exposure_or_predictors = [{ name: "年龄", role: "exposure", operational_definition: "记录的入科年龄" }];
  candidate.outcome = { name: "院内死亡", role: "outcome", operational_definition: "住院期间记录的死亡结局" };
  candidate.estimand = {
    target_population: "符合条件的成年住院患者",
    exposure_contrast: "年龄较高者与年龄较低者比较",
    outcome_measure: "住院期间死亡",
    summary_measure: "风险比",
  };
  return result;
};

test("sends a compact versioned contract with JSON mode without leaking the key", async () => {
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1/",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async (input, init) => {
      capturedUrl = String(input);
      captured ??= init;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.generateProposal({
    system_prompt: "system",
    model_input: {
      request: { message: "question", client_request_id: "request-1", allow_openai_fallback: true },
      current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
    },
    profile: "low-cost-model",
    timeout_ms: 1_000,
  });
  assert.deepEqual(result, proposal);
  assert.equal(capturedUrl, "https://router.invalid/v1/chat/completions");
  assert.equal((captured?.headers as Record<string, string>).authorization, "Bearer test-secret");
  assert.doesNotMatch(JSON.stringify(captured?.body), /test-secret/u);
  const body = JSON.parse(String(captured?.body)) as {
    max_tokens: number;
    temperature?: number;
    response_format: { type: string; json_schema?: { strict: boolean; schema: { properties: Record<string, unknown>; required: string[]; $defs: { question: { allOf: Array<Record<string, unknown>> } } } } };
    messages: Array<{ content: string }>;
  };
  assert.equal(body.response_format.type, "json_object");
  assert.ok(body.response_format.json_schema === undefined);
  assert.equal(body.max_tokens, 1_200);
  assert.equal(body.temperature, undefined);
  const userMessage = JSON.parse(body.messages[1]?.content ?? "{}") as {
    model_input?: unknown;
    output_language?: string;
    output_contract?: { schema?: { $ref?: string; $defs?: Record<string, unknown> }; instruction?: string };
  };
  assert.ok(userMessage.model_input);
  assert.doesNotMatch(JSON.stringify(userMessage.model_input), /allow_openai_fallback/u);
  assert.equal(userMessage.output_language, "en");
  assert.ok(userMessage.output_contract || userMessage.model_input);
  assert.equal(userMessage.output_contract?.schema?.$ref, "#/$defs/proposal");
  assert.ok(userMessage.output_contract?.schema?.$defs?.["study-spec"]);
  assert.match(userMessage.output_contract?.instruction ?? "", /Every continuation must include all required proposal root fields/u);
  assert.ok(Buffer.byteLength(JSON.stringify(userMessage.output_contract)) < 18000);
});

test("accepts a schema-valid proposal in an exact data envelope without a repair request", async () => {
  const requests: RequestInit[] = [];
  const proposal = completeProposalWithCandidateSpec();
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async (_input, init) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ data: proposal }) } }] }), { status: 200 });
    },
  });

  const result = await provider.generateProposal({
    system_prompt: "system",
    model_input: { request: { message: "question", client_request_id: "wrapped-proposal" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } },
    profile: "model",
    timeout_ms: 1_000,
  });

  assert.deepEqual(result, proposal);
  assert.equal(requests.length, 1);
});

test("normalizes transient Router failures", async () => {
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async () => new Response("busy", { status: 429 }),
  });
  await assert.rejects(
    () => provider.generateProposal({ system_prompt: "system", model_input: {} as never, profile: "model", timeout_ms: 1_000 }),
    (error: unknown) => error instanceof StructuredProviderError && error.transient,
  );
});

test("falls back to plain mode after a gateway rejects JSON mode", async () => {
  const responseFormats: Array<string | undefined> = [];
  const validProposal = completeProposalWithCandidateSpec();
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
      responseFormats.push(body.response_format?.type);
      return responseFormats.length === 1
        ? new Response("gateway rejected schema", { status: 422 })
        : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }), { status: 200 });
    },
  });
  const result = await provider.generateProposal({
    system_prompt: "system",
    model_input: { request: { message: "question", client_request_id: "fallback-test" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } },
    profile: "model",
    timeout_ms: 1_000,
  });
  assert.deepEqual(result, validProposal);
  assert.deepEqual(responseFormats, ["json_object", undefined]);
});

test("retains the model-visible contract when a gateway requires plain mode", async () => {
  const formats: Array<string | undefined> = [];
  const validProposal = completeProposalWithCandidateSpec();
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1", api_key: "test-secret", max_output_tokens: 1_200,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
      formats.push(body.response_format?.type);
      return formats.length === 1 ? new Response("unsupported", { status: 422 }) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }), { status: 200 });
    },
  });
  const result = await provider.generateProposal({ system_prompt: "system", model_input: { request: { message: "question", client_request_id: "plain-fallback" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } }, profile: "model", timeout_ms: 1_000 });
  assert.deepEqual(result, validProposal);
  assert.deepEqual(formats, ["json_object", undefined]);
});

test("does not resend a request with weaker formats after a provider 5xx", async () => {
  let requestCount = 0;
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async () => {
      requestCount += 1;
      return new Response("provider unavailable", { status: 502 });
    },
  });

  await assert.rejects(
    () => provider.generateProposal({
      system_prompt: "system",
      model_input: { request: { message: "question", client_request_id: "provider-5xx" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } },
      profile: "model",
      timeout_ms: 1_000,
    }),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(requestCount, 1);
});

test("repairs a schema-invalid proposal before returning it", async () => {
  const invalid = structuredClone(completeAssociationProposal()) as unknown as Record<string, unknown>;
  invalid.candidate_spec = { schema_version: "1.0.0", unexpected: true };
  const repaired = completeProposalWithCandidateSpec();
  const requests: Array<{ body: Record<string, unknown> }> = [];
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const reply = requests.length === 1 ? invalid : repaired;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.generateProposal({
    system_prompt: "system",
    model_input: {
      request: { message: "question", client_request_id: "request-2" },
      current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
    },
    profile: "model",
    timeout_ms: 1_000,
  });
  assert.deepEqual(result, repaired);
  assert.equal(requests.length, 2);
  assert.equal((requests[1]?.body as { messages?: Array<{ content?: string }> }).messages?.length, 4);
  const repairRequest = JSON.parse((requests[1]?.body as { messages?: Array<{ content?: string }> }).messages?.[3]?.content ?? "{}") as {
    repair_request?: boolean;
    validation_errors?: string[];
    invalid_output?: Record<string, unknown>;
  };
  assert.equal(repairRequest.repair_request, true);
  assert.ok((repairRequest.validation_errors ?? []).length > 0);
  assert.equal(repairRequest.invalid_output, undefined);
  assert.deepEqual(JSON.parse((requests[1]?.body as { messages?: Array<{ content?: string }> }).messages?.[2]?.content ?? "null"), invalid);
});

test("rejects a schema-invalid proposal after the bounded repair also fails", async () => {
  const invalid = structuredClone(completeAssociationProposal()) as unknown as Record<string, unknown>;
  invalid.candidate_spec = { schema_version: "1.0.0", unexpected: true };
  let requests = 0;
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    () => provider.generateProposal({
      system_prompt: "system",
      model_input: {
        request: { message: "question", client_request_id: "request-invalid-after-repair" },
        current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
      },
      profile: "model",
      timeout_ms: 1_000,
    }),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
  assert.equal(requests, 2);
});

test("carries the inferred Chinese output language through initial generation and schema repair", async () => {
  const invalid = structuredClone(completeAssociationProposal()) as unknown as Record<string, unknown>;
  invalid.candidate_spec = { schema_version: "1.0.0", unexpected: true };
  const requests: Array<{ messages?: Array<{ content?: string }> }> = [];
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    () => provider.generateProposal({
      system_prompt: "system",
      model_input: {
        request: { message: "入科后年龄与院内死亡是否相关", client_request_id: "request-zh-1" },
        current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
      },
      profile: "model",
      timeout_ms: 1_000,
    }),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_RESPONSE_INVALID",
  );

  assert.equal(requests.length, 2);
  const initialInput = JSON.parse(requests[0]?.messages?.[1]?.content ?? "{}") as {
    output_language?: string;
    language_requirement?: string;
  };
  assert.equal(initialInput.output_language, "zh-CN");
  assert.match(initialInput.language_requirement ?? "", /面向用户.*中文/u);
  const repairInput = JSON.parse(requests[1]?.messages?.[3]?.content ?? "{}") as {
    output_language?: string;
    instruction?: string;
  };
  assert.equal(repairInput.output_language, "zh-CN");
  assert.match(repairInput.instruction ?? "", /自然语言文本必须使用中文/u);
});

test("repairs schema-valid English prose before accepting a Chinese research-design response", async () => {
  const english = completeProposalWithCandidateSpec();
  const chinese = completeChineseProposal();
  const requests: Array<{ messages?: Array<{ content?: string }> }> = [];
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> });
      const reply = requests.length === 1 ? english : chinese;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await provider.generateProposal({
    system_prompt: "system",
    model_input: {
      request: { message: "入科后年龄与院内死亡是否相关", client_request_id: "request-zh-2" },
      current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
    },
    profile: "model",
    timeout_ms: 1_000,
  });

  assert.deepEqual(result, chinese);
  assert.equal(requests.length, 2);
  const repairInput = JSON.parse(requests[1]?.messages?.[3]?.content ?? "{}") as {
    validation_errors?: string[];
  };
  assert.ok(repairInput.validation_errors?.some((issue) => issue.includes("must use Chinese")));
});

test("rejects a schema-valid proposal when Chinese prose remains English after repair", async () => {
  const english = completeProposalWithCandidateSpec();
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(english) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  await assert.rejects(
    () => provider.generateProposal({
      system_prompt: "system",
      model_input: {
        request: { message: "入科后年龄与院内死亡是否相关", client_request_id: "request-zh-3" },
        current_spec: { schema_version: "1.0.0", intent_family: "undetermined" },
      },
      profile: "model",
      timeout_ms: 1_000,
    }),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("classifies non-DOM AbortError instances as provider timeouts", async () => {
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 1_200,
    fetch: async () => { throw aborted; },
  });

  await assert.rejects(
    () => provider.generateProposal({ system_prompt: "system", model_input: { request: { message: "question", client_request_id: "abort-test" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } }, profile: "model", timeout_ms: 1_000 }),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_TIMEOUT",
  );
});

test("accepts a fenced JSON object from a plain-mode compatible provider", async () => {
  const validProposal = completeProposalWithCandidateSpec();
  let calls = 0;
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1", api_key: "test-secret", max_output_tokens: 1_200,
    fetch: async () => ++calls < 2
      ? new Response("unsupported", { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(validProposal)}\n\`\`\`` } }] }), { status: 200 }),
  });
  assert.deepEqual(await provider.generateProposal({ system_prompt: "system", model_input: { request: { message: "question", client_request_id: "fenced-json" }, current_spec: { schema_version: "1.0.0", intent_family: "undetermined" } }, profile: "model", timeout_ms: 1_000 }), validProposal);
});

test("classifies a length-truncated structured response separately from malformed output", async () => {
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 4_000,
    fetch: async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "{\"assistant_message\":" } }],
    }), { status: 200 }),
  });

  await assert.rejects(
    provider.generateProposal({ system_prompt: "system", model_input: {} as never, profile: "model", timeout_ms: 1_000 }),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_RESPONSE_TRUNCATED",
  );
});

test("accepts a compact patch-only response for clarification answers", async () => {
  const patchOnlyProposal = {
    assistant_message: "The clarification answer was applied.",
    intent_assessment: {
      recommended_intent: "treatment_effect",
      confidence: "high",
      reason: "The research purpose is unchanged.",
      alternative_intents: [],
      clarification_required: false,
      clarifying_question: null,
    },
    spec_patch: [{ op: "replace", path: "/index_time", value: { event: "First eligible admission", selection_rule: "Use the first eligible admission" } }],
    assumptions: [],
    clarifying_questions: [],
    suggestions: [],
    warnings: [],
    readiness: "candidate_ready",
  };
  const provider = new OpenAiCompatibleStructuredProvider({
    base_url: "https://router.invalid/v1",
    api_key: "test-secret",
    max_output_tokens: 4_000,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(patchOnlyProposal) } }] }), { status: 200 }),
  });

  assert.deepEqual(await provider.generateProposal({
    system_prompt: "system",
    model_input: { request: { answers: { time_zero: "First eligible admission" }, client_request_id: "patch-only" }, current_spec: { schema_version: "1.0.0", intent_family: "treatment_effect" } } as never,
    profile: "model",
    timeout_ms: 1_000,
  }), patchOnlyProposal);
});
