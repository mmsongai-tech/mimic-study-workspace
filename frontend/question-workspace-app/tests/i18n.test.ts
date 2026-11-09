/**
 * Page wording contract. The app has no test runner of its own, so this runs with the root's Node runner:
 *   node --import tsx --test frontend/question-workspace-app/tests/*.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXAMPLES, I18N, keepOpenHints, type Lang } from "../src/lib/i18n.ts";
import { VARIABLES_TEXT } from "../src/features/variables/variables-i18n.ts";

const LANGS: Lang[] = ["zh", "en"];

/** Every key path of a dictionary, with a marker for arrays (their length) and functions (their arity). */
const shape = (value: unknown, path = ""): string[] => {
  if (typeof value === "function") return [`${path}()${value.length}`];
  if (Array.isArray(value)) return [`${path}[${value.length}]`, ...value.flatMap((item, index) => shape(item, `${path}[${index}]`))];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => shape(item, `${path}.${key}`));
  return [path];
};

/** Every string a dictionary shows (function entries called with sample arguments). */
const strings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [String(value(...Array.from({ length: value.length }, () => "x")))];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
};

test("zh and en dictionaries have the same keys, list lengths and function arities", () => {
  assert.deepEqual(shape(I18N.en), shape(I18N.zh));
});

test("without an invite code the plan and running pages say the page may be closed but the terminal may not", () => {
  const zh = keepOpenHints(I18N.zh, false);
  const en = keepOpenHints(I18N.en, false);
  for (const hint of [zh.review, zh.running]) {
    assert.ok(hint.includes("确认后可以关闭这个网页，分析会继续；但不要关闭终端窗口，也不要让电脑休眠或关机。"), hint);
    assert.ok(!hint.includes("邀请码"), hint);
  }
  for (const hint of [en.review, en.running]) {
    assert.ok(hint.includes("After confirming you can close this page and the analysis continues; but keep the terminal window open and do not let the computer sleep or shut down."), hint);
    assert.ok(!/invite/iu.test(hint), hint);
  }
});

test("with an invite code the hints keep the tab open and never say the page may be closed", () => {
  for (const lang of LANGS) {
    const hints = keepOpenHints(I18N[lang], true);
    for (const hint of [hints.review, hints.running]) {
      assert.ok(lang === "zh" ? hint.includes("邀请码") && hint.includes("保持此标签页打开") : /invite code/u.test(hint) && /keep this tab open/u.test(hint), hint);
      assert.ok(!hint.includes("可以关闭这个网页") && !hint.includes("you can close this page"), hint);
    }
  }
});

test("no page text says heartbeat, and a stall points to the guide's every-use step by name", () => {
  for (const lang of LANGS) assert.ok(!strings(I18N[lang]).some((text) => /心跳|heartbeat/iu.test(text)), lang);
  assert.ok(I18N.zh.stalledHint.includes("安装指南里“每次使用”那一步"));
  assert.ok(I18N.en.stalledHint.includes(`the guide's "Every time you use it" step`));
});

test("waiting times on the page are the measured ones", () => {
  assert.ok(I18N.zh.preparing.includes("通常几分钟；启动后的第一个问题（模型要先加载）或较复杂的问题可能需要 10–15 分钟。"));
  assert.ok(I18N.en.preparing.includes("Usually a few minutes; the first question after starting (the model has to load) or a complex one can take 10–15 minutes."));
  assert.ok(I18N.zh.cover.how[2]?.[1].includes("从几分钟到数小时不等，取决于问题的复杂程度。"));
  assert.ok(I18N.en.cover.how[2]?.[1].includes("from a few minutes to several hours, depending on the question."));
});

test("the question box placeholder is the first example, in one of the six formats", () => {
  assert.equal(I18N.zh.askPlaceholder, `例如：${EXAMPLES.zh[0]}`);
  assert.equal(I18N.en.askPlaceholder, `For example: ${EXAMPLES.en[0]}`);
});

test("page messages name the guide's install step, not a command", () => {
  assert.ok(VARIABLES_TEXT.zh.unavailable.includes("安装指南里“一条命令完成安装”那一步"));
  assert.ok(VARIABLES_TEXT.en.unavailable.includes(`the guide's "Install with one command" step`));
  for (const lang of LANGS) assert.ok(!/npm run|variables:index/u.test(VARIABLES_TEXT[lang].unavailable), lang);
});

test("the how-it-works page (linked from the cover and the sidebar) uses the local-install wording, Chinese first", () => {
  const page = readFileSync(new URL("../public/how-it-works.html", import.meta.url), "utf8");
  assert.match(page, /<html lang="zh-CN">/u);
  for (const stale of ["心跳", "托管", "提取分析队列", "词表和句式", "邀请您的人", "自己的运行", "所有运行"]) assert.ok(!page.includes(stale), stale);
  assert.ok(page.includes("确认后可以关闭这个网页，分析会继续；但不要关闭终端窗口，也不要让电脑休眠或关机。"));
  assert.ok(page.includes("After confirming you can close this page and the analysis continues; but keep the terminal window open and do not let the computer sleep or shut down."));
  assert.ok(page.includes("从几分钟到数小时不等，取决于问题的复杂程度。"));
  assert.ok(page.includes("这一步还不挑选病人做分析"));
  assert.ok(page.includes("不要发人数、结果数字、报告或结果截图"));
  assert.ok(page.includes("never patient counts, result numbers, reports or screenshots of results"));
  // Chinese first: each block's Chinese comes before its English.
  assert.ok(page.indexOf("访问与数据") < page.indexOf("Access and data"));
  assert.ok(page.indexOf("有问题请只把出错的文字") < page.indexOf("If something goes wrong"));
});

test("history and re-analysis wording does not use 运行 as a noun or say re-analyse twice", () => {
  assert.equal(I18N.zh.noRuns, "暂无记录");
  assert.equal(I18N.en.noRuns, "Nothing yet");
  assert.ok(!I18N.zh.reanalyseHint.includes("会重新分析一次，"), I18N.zh.reanalyseHint);
  assert.ok(!I18N.zh.whatWasAnalysedHint.includes("：会重新分析一次"), I18N.zh.whatWasAnalysedHint);
});
