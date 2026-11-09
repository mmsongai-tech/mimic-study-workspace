import assert from "node:assert/strict";
import test from "node:test";
import { containsWords } from "../index.js";

test("matches alias words as whole words in order", () => {
  assert.equal(containsWords("end stage liver disease", "age"), false, "cirrhosis synonyms must not match Age");
  assert.equal(containsWords("beta adrenergic blocking agent", "age"), false);
  assert.equal(containsWords("average heart rate", "heart rate"), true);
  assert.equal(containsWords("patient age at admission", "age"), true);
  assert.equal(containsWords("in hospital mortality", "hospital mortality"), true);
  assert.equal(containsWords("mortality in hospital", "hospital mortality"), false);
});

test("dictionary labels match search words as whole words or long word starts", async () => {
  const { LocalArchiveMimicTerminologySearchClient } = await import("../index.js");
  const contains = LocalArchiveMimicTerminologySearchClient.containsPhrase;
  assert.equal(contains("nystatin oral suspension", "statin"), false, "statins must not find nystatin");
  assert.equal(contains("atorvastatin", "statin"), false);
  assert.equal(contains("metoprolol tartrate", "metoprolol"), true);
  assert.equal(contains("metoprolol", "metoprol"), true, "truncated labels still match");
  assert.equal(contains("*nf* benazepril", "benazepril"), true);
  assert.equal(contains("amlodipine-benazepril", "amlodipine"), true);
  assert.equal(contains("hydrocortisone na succ.", "hydrocortisone"), true);
  assert.equal(contains("beta-adrenergic blocking agent", "age"), false);
  assert.equal(contains("lactate", "lactat"), true);
});
