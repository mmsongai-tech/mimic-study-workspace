import assert from "node:assert/strict";
import test from "node:test";
import { loadOpenAiApiKey, OPENAI_KEYCHAIN_SERVICE } from "../index.js";

test("explicit fallback opt-out ignores environment keys and never reads Keychain", () => {
  for (const credentials of [{}, { MIMIC_OPENAI_API_KEY: "synthetic-project-key" }, { OPENAI_API_KEY: "synthetic-official-key" }]) {
    let called = false;
    const key = loadOpenAiApiKey({
      environment: { ...credentials, MIMIC_OPENAI_FALLBACK_ACCESS: "disabled" },
      platform: "darwin",
      runner: () => { called = true; throw new Error("Keychain must not be accessed"); },
    });
    assert.equal(key, "");
    assert.equal(called, false);
  }
});

test("loads the project-scoped OpenAI key without exposing it in arguments",()=>{let arguments_:string[]=[];const key=loadOpenAiApiKey({environment:{},platform:"darwin",account:"researcher",runner:(_command,args)=>{arguments_=args;return {status:0,stdout:"secret\n"} as never;}});assert.equal(key,"secret");assert.deepEqual(arguments_,["find-generic-password","-a","researcher","-s",OPENAI_KEYCHAIN_SERVICE,"-w"]);assert.ok(!arguments_.includes("secret"));});

test("does not access Keychain when the fallback was not given an environment key on another platform",()=>{let called=false;assert.equal(loadOpenAiApiKey({environment:{},platform:"linux",runner:()=>{called=true;return {} as never;}}),"");assert.equal(called,false);});
