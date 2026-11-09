import assert from "node:assert/strict";
import test from "node:test";
import { ModelPoolStructuredProvider, StructuredProviderError, type StructuredResearchDesignProvider } from "../index.js";

const input = { system_prompt: "design", model_input: { question: "q" }, profile: "ignored", timeout_ms: 1000 } as never;

test("prefers the last formally successful model on subsequent research turns", async () => {
  const called: string[] = [];
  let failFirst = true;
  const pool = new ModelPoolStructuredProvider({ generateProposal: async ({ profile }) => {
    called.push(profile);
    if ((profile === "first") === failFirst) throw new StructuredProviderError("unavailable", true, "PROVIDER_UNAVAILABLE");
    return { ok: true };
  } }, ["first", "second"]);
  await pool.generateProposal(input);
  await pool.generateProposal(input);
  assert.deepEqual(called, ["first", "second", "second"]);
  failFirst = false;
  await pool.generateProposal(input);
  await pool.generateProposal(input);
  assert.deepEqual(called, ["first", "second", "second", "second", "first", "first"]);
});

test("switches to the next configured model after a provider failure", async () => {
  const called: string[]=[]; let observed: unknown;
  const provider: StructuredResearchDesignProvider={generateProposal:async ({profile})=>{called.push(profile);if(profile==="cheap-a")throw new StructuredProviderError("unavailable",true,"PROVIDER_UNAVAILABLE");return {ok:true};}};
  const pool=new ModelPoolStructuredProvider(provider,["cheap-a","cheap-b"],(attempts)=>{observed=attempts;});
  assert.deepEqual(await pool.generateProposal(input),{ok:true});
  assert.deepEqual(called,["cheap-a","cheap-b"]);
  assert.equal((observed as {provider:string;order:number;model:string;outcome:string;failure_code?:string}[])[0]?.provider, "router");
  assert.equal((observed as {provider:string;order:number;model:string;outcome:string;failure_code?:string}[])[0]?.order, 1);
  assert.equal((observed as {provider:string;order:number;model:string;outcome:string;failure_code?:string}[])[0]?.model, "cheap-a");
  assert.equal((observed as {provider:string;order:number;model:string;outcome:string;failure_code?:string}[])[1]?.order, 2);
});

test("tries every configured Router model when the shared credential is rejected", async () => {
  const called: string[]=[];
  const provider: StructuredResearchDesignProvider={generateProposal:async ({profile})=>{called.push(profile);throw new StructuredProviderError("auth",false,"PROVIDER_AUTHENTICATION_FAILED");}};
  await assert.rejects(
    new ModelPoolStructuredProvider(provider,["cheap-a","cheap-b"]).generateProposal(input),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_AUTHENTICATION_FAILED",
  );
  assert.deepEqual(called,["cheap-a","cheap-b"]);
});

test("deduplicates the configured model order", async () => {
  const called: string[]=[];
  const provider: StructuredResearchDesignProvider={generateProposal:async ({profile})=>{called.push(profile);if(profile==="a")throw new StructuredProviderError("bad",false,"PROVIDER_RESPONSE_INVALID");return {};}};
  await new ModelPoolStructuredProvider(provider,["a","a","b"]).generateProposal(input);
  assert.deepEqual(called,["a","b"]);
});

test("probes each model before sending the formal request and skips hard probe failures", async () => {
  const probed: string[] = [];
  const called: string[] = [];
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile }) => { called.push(profile); return { model: profile }; },
  };
  const probe = {
    check: async (model: string) => {
      probed.push(model);
      if (model === "unavailable") throw new StructuredProviderError("rejected", false, "PROVIDER_REQUEST_REJECTED");
    },
  };
  const pool = new ModelPoolStructuredProvider(provider, ["unavailable", "available"], undefined, undefined, "router", probe);

  assert.deepEqual(await pool.generateProposal(input), { model: "available" });
  assert.deepEqual(probed, ["unavailable", "available"]);
  assert.deepEqual(called, ["available"]);
});

test("treats a transient probe timeout as an ordering hint rather than excluding the model", async () => {
  const called: string[] = [];
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile }) => { called.push(profile); return { model: profile }; },
  };
  const pool = new ModelPoolStructuredProvider(
    provider,
    ["slow-probe", "fast-probe"],
    undefined,
    undefined,
    "router",
    {
      check: async (model) => {
        if (model === "slow-probe") throw new StructuredProviderError("timeout", true, "PROVIDER_TIMEOUT");
      },
    },
  );

  assert.deepEqual(await pool.generateProposal(input), { model: "fast-probe" });
  assert.deepEqual(called, ["fast-probe"]);
});

test("formally tries transiently unavailable models when every probe is inconclusive", async () => {
  const called: string[] = [];
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile }) => { called.push(profile); return { model: profile }; },
  };
  const pool = new ModelPoolStructuredProvider(
    provider,
    ["first", "second"],
    undefined,
    undefined,
    "router",
    { check: async () => { throw new StructuredProviderError("timeout", true, "PROVIDER_TIMEOUT"); } },
  );

  assert.deepEqual(await pool.generateProposal(input), { model: "first" });
  assert.deepEqual(called, ["first"]);
});

test("gives probe-passing models the main budget while reserving rescue windows", async () => {
  const timeouts: number[] = [];
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile, timeout_ms }) => { timeouts.push(timeout_ms); return { model: profile }; },
  };
  const pool = new ModelPoolStructuredProvider(
    provider,
    ["passed", "inconclusive-a", "inconclusive-b"],
    undefined,
    undefined,
    "router",
    {
      check: async (model) => {
        if (model !== "passed") throw new StructuredProviderError("timeout", true, "PROVIDER_TIMEOUT");
      },
    },
  );

  assert.deepEqual(await pool.generateProposal({ system_prompt: "design", model_input: {} as never, profile: "ignored", timeout_ms: 10_000 }), { model: "passed" });
  assert.ok((timeouts[0] ?? 0) >= 5_000);
});

test("continues probing after a probe passes but the formal model request fails", async () => {
  const probed: string[] = [];
  const called: string[] = [];
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile }) => {
      called.push(profile);
      if (profile === "first") throw new StructuredProviderError("invalid", false, "PROVIDER_RESPONSE_INVALID");
      return { model: profile };
    },
  };
  const pool = new ModelPoolStructuredProvider(
    provider,
    ["first", "second"],
    undefined,
    undefined,
    "router",
    { check: async (model) => { probed.push(model); } },
  );

  assert.deepEqual(await pool.generateProposal(input), { model: "second" });
  assert.deepEqual(probed, ["first", "second"]);
  assert.deepEqual(called, ["first", "second"]);
});

test("shares the request timeout across the model pool instead of granting it to every model", async () => {
  const timeouts: number[] = [];
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile, timeout_ms }) => {
      timeouts.push(timeout_ms);
      if (profile === "first") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new StructuredProviderError("timeout", true, "PROVIDER_TIMEOUT");
      }
      return { ok: true };
    },
  };
  const pool = new ModelPoolStructuredProvider(provider, ["first", "second"]);

  assert.deepEqual(await pool.generateProposal({
    system_prompt: "design",
    model_input: { question: "q" } as never,
    profile: "ignored",
    timeout_ms: 2_000,
  }), { ok: true });
  assert.equal(timeouts.length, 2);
  assert.ok((timeouts[0] ?? 0) <= 1_000);
  assert.ok((timeouts[1] ?? 0) < 2_000);
});

test("reports a usable-response failure when earlier models responded invalidly and the last model timed out", async () => {
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile }) => {
      throw new StructuredProviderError(
        profile === "last" ? "timeout" : "invalid",
        profile === "last",
        profile === "last" ? "PROVIDER_TIMEOUT" : "PROVIDER_RESPONSE_INVALID",
      );
    },
  };

  await assert.rejects(
    new ModelPoolStructuredProvider(provider, ["first", "last"]).generateProposal(input),
    (error: unknown) => error instanceof StructuredProviderError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("probes the complete pool before sharing the remaining formal-request budget across eligible models", async () => {
  const events: string[] = [];
  const timeouts: number[] = [];
  const provider: StructuredResearchDesignProvider = {
    generateProposal: async ({ profile, timeout_ms }) => {
      events.push(`formal:${profile}`);
      timeouts.push(timeout_ms);
      return { ok: true };
    },
  };
  const pool = new ModelPoolStructuredProvider(
    provider,
    ["available-a", "unavailable", "available-b"],
    undefined,
    undefined,
    "router",
    {
      check: async (model) => {
        events.push(`probe:${model}`);
        if (model === "unavailable") throw new StructuredProviderError("timeout", true, "PROVIDER_TIMEOUT");
      },
    },
  );

  assert.deepEqual(await pool.generateProposal({ system_prompt: "design", model_input: {} as never, profile: "ignored", timeout_ms: 3_000 }), { ok: true });
  assert.deepEqual(events.slice(0, 3), ["probe:available-a", "probe:unavailable", "probe:available-b"]);
  assert.equal(events[3], "formal:available-a");
  assert.ok((timeouts[0] ?? 0) > 1_000);
});
