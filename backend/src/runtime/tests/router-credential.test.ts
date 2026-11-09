import assert from "node:assert/strict";
import test from "node:test";
import { loadRouterApiKey, ROUTER_KEYCHAIN_SERVICE } from "../router-credential.js";

test("prefers a project-specific environment key without invoking Keychain", () => {
  let calls = 0;
  const key = loadRouterApiKey({
    environment: { MIMIC_ROUTER_API_KEY: " environment-key " },
    runner: () => { calls += 1; throw new Error("must not run"); },
  });
  assert.equal(key, "environment-key");
  assert.equal(calls, 0);
});

test("loads the project-specific macOS Keychain item without passing a secret", () => {
  let arguments_: string[] = [];
  const key = loadRouterApiKey({
    environment: {},
    account: "local-user",
    platform: "darwin",
    runner: (_command, inputArguments) => {
      arguments_ = inputArguments;
      return { status: 0, signal: null, output: [], pid: 1, stdout: "virtual-key\n", stderr: "" };
    },
  });
  assert.equal(key, "virtual-key");
  assert.deepEqual(arguments_, ["find-generic-password", "-a", "local-user", "-s", ROUTER_KEYCHAIN_SERVICE, "-w"]);
  assert.doesNotMatch(JSON.stringify(arguments_), /virtual-key/u);
});

test("fails closed when no supported credential source is available", () => {
  assert.equal(loadRouterApiKey({ environment: {}, platform: "linux" }), "");
});
