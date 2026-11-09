import assert from "node:assert/strict";
import test from "node:test";
import { entryCarriesRequest, uncoveredWords } from "../match-fidelity.js";

test("a qualifier the concept does not name is reported, a measurement or time word is not", () => {
  assert.deepEqual(uncoveredWords(["type 2 myocardial infarction"], ["Myocardial infarction", "heart attack"]), ["type", "2"]);
  assert.deepEqual(uncoveredWords(["sepsis with myocardial injury"], ["Sepsis"]), ["myocardial", "injury"]);
  assert.deepEqual(uncoveredWords(["C-reactive protein to albumin ratio"], ["Albumin"]), ["c", "reactive", "protein", "ratio"]);
  assert.deepEqual(uncoveredWords(["Hemoglobin A1c"], ["Hemoglobin"]), ["a1c"]);
  assert.deepEqual(uncoveredWords(["serum albumin level"], ["Albumin"]), []);
  assert.deepEqual(uncoveredWords(["28-day mortality"], ["All-cause death", "mortality"]), []);
  assert.deepEqual(uncoveredWords(["Statin use during hospitalization"], ["Statins"]), []);
  assert.deepEqual(uncoveredWords(["hydrocortisone dose"], ["Hydrocortisone"]), []);
  assert.deepEqual(uncoveredWords(["In-hospital mortality rate"], ["In-hospital mortality"]), []);
  assert.deepEqual(uncoveredWords(["heart failure incidence"], ["Heart failure"]), []);
});

test("one of the requested forms covering the concept is enough, and Han text is not judged", () => {
  assert.deepEqual(uncoveredWords(["心衰住院", "heart failure"], ["Heart failure"]), []);
  assert.deepEqual(uncoveredWords(["心肌梗死"], ["Myocardial infarction"]), []);
});

test("a dictionary entry must carry most of what was asked", () => {
  assert.equal(entryCarriesRequest(["type 2 myocardial infarction"], "Myocardial infarction type 2"), true);
  assert.equal(entryCarriesRequest(["type 2 myocardial infarction"], "ST elevation (STEMI) myocardial infarction of anterior wall"), false);
  assert.equal(entryCarriesRequest(["acute kidney injury"], "Acute kidney failure"), true);
  assert.equal(entryCarriesRequest(["albumin infusion"], "Albumin 25%"), true);
  assert.equal(entryCarriesRequest(["anion gap"], "Calculated Total CO2"), false);
});

test("a request is judged by the researcher's words, not by a shorter label the model made of them", () => {
  assert.deepEqual(uncoveredWords(["Sepsis with myocardial injury", "Sepsis"], ["Sepsis"]), ["myocardial", "injury"]);
  assert.equal(entryCarriesRequest(["Sepsis with myocardial injury", "Sepsis"], "Sepsis, unspecified organism"), false);
  assert.deepEqual(uncoveredWords(["败血症合并心肌损伤", "sepsis"], ["Sepsis"]), [], "a Chinese request can only be judged by its English label");
});

test("the verb and the noun of one action carry each other: ventilated, ventilation, ventilating", () => {
  assert.deepEqual(uncoveredWords(["invasively ventilated"], ["Invasive mechanical ventilation"]), ["invasively"]);
  assert.deepEqual(uncoveredWords(["ventilation"], ["Mechanically ventilated patient"]), []);
  assert.deepEqual(uncoveredWords(["ventilated patients"], ["Invasive mechanical ventilation"]), []);
});
