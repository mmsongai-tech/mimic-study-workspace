import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { archiveProblem, createQuestionWorkspaceServer, GUIDE_STEPS, portInUseProblem, QuestionRunJobService, workspaceStartedMessage } from "../index.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const startScript = fileURLToPath(new URL("../../../../scripts/start-workspace.sh", import.meta.url));
const setupScript = fileURLToPath(new URL("../../../../scripts/setup-new-machine.sh", import.meta.url));
// Setup runs in the repository folder, so a checkout that already built its own dictionary index reports it as built.
const repoHasIndex = existsSync(fileURLToPath(new URL("../../../../.local/dictionary-index.json", import.meta.url)));
const serverEntrypoint = fileURLToPath(new URL("../../entrypoints/question-workspace-server.ts", import.meta.url));

/** The pinned wording of the Python [todo] (release pilot 1); `found` fills the bracket. */
const pythonTodo = (foundZh: string, foundEn: string): { zh: string; en: string } => ({
  zh: `需要 Python 3.12（${foundZh}；3.13 和 3.14 暂不支持）。Mac：下载并安装 https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg （国内可用 https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-macos11.pkg ），然后打开一个新的终端窗口，重新运行同一条安装命令。Windows（WSL2 Ubuntu 24.04）：sudo apt install -y python3 python3-venv python3-pip`,
  en: `Python 3.12 is needed (${foundEn}; 3.13 and 3.14 are not supported yet). Mac: download and install https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg (in mainland China: https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-macos11.pkg), then open a new Terminal window and run the same setup command again. Windows (WSL2 Ubuntu 24.04): sudo apt install -y python3 python3-venv python3-pip`,
});
/** The pinned feedback line: error lines and the step name only. */
const feedback = {
  zh: "请把最后几行错误文字（通常以 Error 开头）和这一步的名字发给联系人；不要发含有人数或统计数字的行。",
  en: "Send the last few error lines (usually starting with Error) and the name of this step to your contact; leave out lines with patient counts or statistics.",
};

/**
 * A zip (stored, empty members) with the given member names, enough for `unzip -l`. Empty members have CRC 0, so none is computed.
 */
const storedZip = (names: string[]): Buffer => {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const name of names) {
    const file = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12); local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(33, 14);
    central.writeUInt16LE(file.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, file); centrals.push(central, file); offset += local.length + file.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

/**
 * Runs scripts/setup-new-machine.sh with a PATH that holds only bash, the commands the archive check uses and a fake python3 that
 * reports 3.9: node, npm, R and Ollama are absent and the Python is too old, so it installs nothing, builds nothing and never
 * creates .venv. Returns what it printed.
 */
const runSetupScript = async (root: string, archive: string | undefined, extra: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string }> => {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const tool of ["bash", "dirname", "grep", "unzip"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) await symlink(found, join(bin, tool)).catch(() => undefined);
  }
  await writeFile(join(bin, "python3"), '#!/bin/sh\ncase "$1" in --version) echo "Python 3.9.6" ;; *) exit 1 ;; esac\n'); await chmod(join(bin, "python3"), 0o755);
  const env: NodeJS.ProcessEnv = { HOME: root, PATH: bin, PWD: root, ...extra };
  if (archive !== undefined) env.MIMIC_LOCAL_ARCHIVE = archive;
  const result = spawnSync(join(bin, "bash"), [setupScript], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout };
};

/**
 * Runs scripts/start-workspace.sh from `cwd` with a built page stand-in and the given archive (unset when undefined), and returns what it
 * printed. Every archive tested here stops it at the archive check; the model address is a closed port in case it ever went further.
 */
const runStartScript = (cwd: string, staticRoot: string, archive: string | undefined): { status: number | null; stderr: string } => {
  const env: NodeJS.ProcessEnv = { ...process.env, PWD: cwd, QUESTION_WORKSPACE_STATIC_ROOT: staticRoot, MIMIC_LOCAL_MODEL_BASE_URL: "http://127.0.0.1:1/v1" };
  delete env.MIMIC_LOCAL_ARCHIVE;
  if (archive !== undefined) env.MIMIC_LOCAL_ARCHIVE = archive;
  const result = spawnSync("bash", [startScript], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stderr: result.stderr };
};

/** A temporary folder (its real path, so the script and the check name it the same way) with a page stand-in, a zip and an unzipped folder. */
const archiveFixture = async (): Promise<{ root: string; staticRoot: string; zip: string; folder: string }> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "startup-checks-")));
  const staticRoot = join(root, "dist"); await mkdir(staticRoot); await writeFile(join(staticRoot, "index.html"), "<p>page</p>");
  const zip = join(root, "mimic-iv-3.1.zip"); await writeFile(zip, "");
  const folder = join(root, "mimic-iv-3.1"); await mkdir(folder);
  return { root, staticRoot, zip, folder };
};

test("the archive check names the fix for an unset path, a missing file and an unzipped folder, and accepts a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "startup-checks-"));
  try {
    const zip = join(root, "mimic-iv-3.1.zip"); await writeFile(zip, "");
    const folder = join(root, "mimic-iv-3.1"); await mkdir(folder);
    // Not set: copy the whole command of the guide step, named (step numbers differ between the Mac and Windows guides).
    const unset = await archiveProblem(undefined);
    assert.deepEqual(unset, {
      zh: "没有告诉平台 MIMIC 数据文件在哪里。请复制安装指南里“每次使用”那一步的整条命令（含 MIMIC_LOCAL_ARCHIVE=…）再运行。",
      en: `The platform was not told where the MIMIC data file is. Copy the whole command of the guide's "Every time you use it" step (including MIMIC_LOCAL_ARCHIVE=…) and run it again.`,
    });
    assert.deepEqual(await archiveProblem(""), unset);
    const unsetAtInstall = await archiveProblem(undefined, "install");
    assert.ok(unsetAtInstall!.zh.includes("请复制安装指南里“一条命令完成安装”那一步的整条命令"), unsetAtInstall!.zh);
    assert.ok(unsetAtInstall!.en.includes(`Copy the whole command of the guide's "Install with one command" step`), unsetAtInstall!.en);
    for (const problem of [unset!, unsetAtInstall!]) { assert.doesNotMatch(`${problem.zh}${problem.en}`, /第 ?\d+ ?步|step \d|bash scripts\//u); }
    const missing = await archiveProblem(join(root, "nowhere.zip"));
    assert.match(missing!.zh, /找不到文件/u); assert.match(missing!.en, /File not found: .*nowhere\.zip/u);
    assert.ok(missing!.zh.endsWith("请确认 mimic-iv-3.1.zip 在个人文件夹的 mimic 文件夹里（Windows：Ubuntu 里的 ~/mimic 文件夹，不是 C 盘），名字没有变成 mimic-iv-3.1 (1).zip。"), missing!.zh);
    assert.ok(missing!.en.endsWith("Make sure mimic-iv-3.1.zip is in the mimic folder of your home folder (Windows: ~/mimic inside Ubuntu, not drive C) and its name has not changed to mimic-iv-3.1 (1).zip."), missing!.en);
    const unzipped = await archiveProblem(folder);
    assert.equal(unzipped!.zh, `${folder} 是一个文件夹，不是 zip 文件。请保留下载的 mimic-iv-3.1.zip 原样、不要解压（Safari 可能已自动解压），并把路径指向这个 .zip 文件。如果 .zip 已经不在了，请在 Safari → 设置 → 通用 中取消勾选"下载后打开‘安全的’文件"，然后重新下载。`);
    assert.equal(unzipped!.en, `${folder} is a folder, not a zip file. Keep the downloaded mimic-iv-3.1.zip zipped (Safari may have unzipped it) and point to the .zip file. If the .zip is gone, turn off Safari → Settings → General → "Open 'safe' files after downloading" and download it again.`);
    assert.equal(await archiveProblem(zip), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scripts/start-workspace.sh prints every archive message of the check word for word, Chinese and English", async () => {
  const { root, staticRoot, folder } = await archiveFixture();
  try {
    const cases: Array<[string, string | undefined]> = [["unset", undefined], ["empty", ""], ["missing", join(root, "nowhere.zip")], ["folder", folder]];
    const seen = new Set<string>();
    for (const [name, archive] of cases) {
      const problem = await archiveProblem(archive);
      assert.ok(problem, name);
      const { status, stderr } = runStartScript(root, staticRoot, archive);
      assert.equal(status, 1, `${name}: ${stderr}`);
      // The same path is given to both, so the messages must match exactly with it.
      assert.ok(stderr.includes(`[停止] ${problem.zh}\n`), `${name}: the script does not print\n${problem.zh}\nit printed\n${stderr}`);
      assert.ok(stderr.includes(`[Stopped] ${problem.en}\n`), `${name}: the script does not print\n${problem.en}\nit printed\n${stderr}`);
      seen.add(archive ? problem.en.replaceAll(archive, "<path>") : problem.en);
    }
    // Unset, missing and folder: every message the check can produce was compared.
    assert.equal(seen.size, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scripts/start-workspace.sh reads a relative archive path from the folder it was started in", async () => {
  const { root, staticRoot, folder } = await archiveFixture();
  try {
    const expected = await archiveProblem(folder);
    for (const relative of ["mimic-iv-3.1", "./mimic-iv-3.1"]) {
      const { status, stderr } = runStartScript(root, staticRoot, relative);
      assert.equal(status, 1, stderr);
      // Found (and recognised as the unzipped folder) under its absolute path, not "file not found" after the script moved to the repository.
      assert.ok(stderr.includes(`[Stopped] ${expected!.en}\n`), `${relative}: ${stderr}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scripts/setup-new-machine.sh names every archive problem with the shared wording, Chinese on the [todo] line and English under it", async () => {
  const { root, staticRoot, zip, folder } = await archiveFixture();
  try {
    const notZip = join(root, "broken.zip"); await writeFile(notZip, "not a zip");
    const otherZip = join(root, "other.zip"); await writeFile(otherZip, storedZip(["data/a.csv"]));
    await writeFile(zip, storedZip(["mimic-iv-3.1/hosp/admissions.csv.gz", "mimic-iv-3.1/icu/icustays.csv.gz"]));
    const hasUnzip = spawnSync("/bin/sh", ["-c", "command -v unzip"]).status === 0;
    const outputs: string[] = [];
    // The messages archiveProblem also gives: compared word for word.
    for (const [name, archive] of [["unset", undefined], ["empty", ""], ["missing", join(root, "nowhere.zip")], ["folder", folder]] as Array<[string, string | undefined]>) {
      const problem = await archiveProblem(archive, "install");
      const { stdout } = await runSetupScript(root, archive); outputs.push(stdout);
      assert.ok(stdout.includes(`  [todo] ${problem!.zh}\n         ${problem!.en}\n`), `${name}: the script does not print\n${problem!.zh}\n${problem!.en}\nit printed\n${stdout}`);
    }
    // The whole install command (BUILD_INDEX=1) with a wrong archive path: the index points to the Data item, not to the command
    // the tester already ran.
    {
      const missing = join(root, "mimic-iv-3.1 (1).zip");
      const problem = await archiveProblem(missing, "install");
      const { stdout } = await runSetupScript(root, missing, { BUILD_DERIVED: "1", BUILD_INDEX: "1" }); outputs.push(stdout);
      assert.ok(stdout.includes(`  [todo] ${problem!.zh}\n         ${problem!.en}\n`), stdout);
      if (!repoHasIndex)
        assert.ok(stdout.includes("  [todo] 字典索引还没有建立：需要先解决上面“数据”一项的问题。\n         The dictionary index is not built: it needs the Data item above fixed first.\n"), stdout);
      assert.doesNotMatch(stdout, /字典索引还没有建立（约 10 分钟|Build the dictionary index once/u);
    }
    if (hasUnzip) {
      // The zip checks exist only in scripts/archive-check.sh: setup and start print the same text.
      for (const [archive, zh, en] of [[notZip, "不是可读取的 zip 文件", "is not a readable zip file"], [otherZip, "里没有 hosp/ 和 icu/ 文件夹", "has no hosp/ and icu/ folders"]] as Array<[string, string, string]>) {
        const { stdout } = await runSetupScript(root, archive); outputs.push(stdout);
        const line = stdout.split("\n").find((text) => text.startsWith(`  [todo] ${archive} `));
        assert.ok(line?.includes(zh), `${archive}: ${stdout}`); assert.ok(stdout.includes(`         ${archive} ${en}`), `${archive}: ${stdout}`);
        const start = runStartScript(root, staticRoot, archive);
        assert.ok(start.stderr.includes(`[停止] ${line!.slice("  [todo] ".length)}\n`), `${archive}: start-workspace.sh printed\n${start.stderr}`);
      }
      const { stdout } = await runSetupScript(root, zip); outputs.push(stdout);
      assert.ok(stdout.includes(`  [ok]   MIMIC-IV 数据包 / archive ${zip}\n`), stdout);
      assert.doesNotMatch(stdout, /没有告诉平台|找不到文件|不是 zip 文件|不是可读取的 zip|hosp\/ 和 icu\//u);
      // Without BUILD_DERIVED and BUILD_INDEX both layers say to copy the whole install command, with the pinned times, and never
      // to copy the dictionary index from someone else (it is derived from MIMIC and not in the package).
      assert.ok(stdout.includes("  [todo] 衍生变量层还没有建立（约 10–30 分钟，只需一次）。请复制安装指南里“一条命令完成安装”那一步的整条命令（含 BUILD_DERIVED=1）再运行；"), stdout);
      if (!repoHasIndex) assert.ok(stdout.includes("  [todo] 字典索引还没有建立（约 10 分钟，只需一次）。请复制安装指南里“一条命令完成安装”那一步的整条命令（含 MIMIC_LOCAL_ARCHIVE=… 和 BUILD_INDEX=1）再运行。"), stdout);
      assert.doesNotMatch(stdout, /从安装包复制|copy \.local\/dictionary-index\.json|在本命令前加 BUILD_/u);
    }
    for (const stdout of outputs) {
      // A Python older than 3.10 is named with the pinned fix; every [todo] line is Chinese and the line under it English.
      const python = pythonTodo("现在是 Python 3.9.6", "found Python 3.9.6");
      assert.ok(stdout.includes(`  [todo] ${python.zh}\n         ${python.en}\n`), stdout);
      // Section headers are Chinese first.
      for (const header of ["1. 工具 / Tools", "2. 软件包 / Packages", "3. 模型 / Model", "4. 数据 / Data", "5. 衍生变量层 / Derived-variable layer（急性肾损伤", "6. 字典索引 / Dictionary index（所有化验项目"]) {
        assert.ok(stdout.includes(`\n${header}`) || stdout.startsWith(header), `${header}\n${stdout}`);
      }
      const lines = stdout.split("\n");
      const todos = lines.flatMap((line, index) => line.startsWith("  [todo] ") ? [index] : []);
      assert.ok(todos.length > 0);
      for (const index of todos) {
        assert.match(lines[index]!, /\p{Script=Han}/u, lines[index]);
        assert.match(lines[index + 1]!, /^ {9}\S/u, lines[index + 1]); assert.doesNotMatch(lines[index + 1]!, /\p{Script=Han}/u, lines[index + 1]);
      }
      assert.match(stdout, new RegExp(`上面有 ${todos.length} 项 \\[todo\\] 需要您处理`, "u"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the workspace server says in both languages that its port is taken, instead of a Node stack", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "startup-port-")));
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as AddressInfo).port;
  try {
    const archive = join(root, "mimic-iv-3.1.zip"); await writeFile(archive, "");
    const env: NodeJS.ProcessEnv = {
      ...process.env, MIMIC_LOCAL_ARCHIVE: archive, QUESTION_WORKSPACE_PORT: String(port), QUESTION_WORKSPACE_HOST: "127.0.0.1",
      QUESTION_WORKSPACE_RUNS_DIR: join(root, "runs"), QUESTION_WORKSPACE_STATIC_ROOT: join(root, "dist"),
    };
    delete env.NODE_TEST_CONTEXT; delete env.QUESTION_WORKSPACE_INVITE_CODE;
    // Started from the temporary folder, so no dictionary index of the repository is loaded.
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), serverEntrypoint], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 30_000);
    const status = await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    clearTimeout(timer);
    const problem = portInUseProblem(port);
    assert.equal(status, 1, stderr);
    assert.ok(stderr.includes(`[停止] ${problem.zh}\n[Stopped] ${problem.en}\n`), stderr);
    assert.match(problem.zh, new RegExp(`^端口 ${port} 已被占用`, "u")); assert.match(problem.en, new RegExp(`^Port ${port} is already in use`, "u"));
    assert.doesNotMatch(stderr, /EADDRINUSE|\n\s+at /u);
    // Testers cannot change the port (the guides name 9000), so it is never suggested.
    assert.doesNotMatch(stderr, /QUESTION_WORKSPACE_PORT/u);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("before the web page is built, / says how to build it in both languages; once built, / serves the page", async () => {
  const root = await mkdtemp(join(tmpdir(), "startup-page-"));
  const staticRoot = join(root, "dist"); await mkdir(staticRoot);
  const jobs = new QuestionRunJobService({ root: join(root, "runs"), launcher: { launch: async () => ({ exit_code: 0, stderr: "" }) } });
  const server = createQuestionWorkspaceServer({ jobs, static_root: staticRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const before = await fetch(`${base}/`);
    assert.equal(before.status, 503);
    assert.match(before.headers.get("content-type") ?? "", /text\/html/u);
    const page = await before.text();
    assert.match(page, /网页还没有构建/u); assert.match(page, /The web page is not built yet/u);
    // It names the guide steps (a layperson cannot put a setup command together) and the product.
    assert.ok(page.includes(`请先完成${GUIDE_STEPS.install.zh}，再按${GUIDE_STEPS.start.zh}重新启动。`), page);
    assert.ok(page.includes(`Complete ${GUIDE_STEPS.install.en} first, then start again with ${GUIDE_STEPS.start.en}.`), page);
    assert.match(page, /<title>MIMIC 研究工作台 \/ MIMIC Study Workspace<\/title>/u); assert.doesNotMatch(page, /bash scripts\//u);
    // Other missing files and the API are unchanged.
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs`)).status, 200);
    await writeFile(join(staticRoot, "index.html"), "<p>workspace</p>");
    const after = await fetch(`${base}/`);
    assert.equal(after.status, 200); assert.equal(await after.text(), "<p>workspace</p>");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("the started line and the port message use the pinned wording, Chinese first", () => {
  assert.deepEqual(workspaceStartedMessage(9000), {
    zh: "工作台已启动：请在浏览器打开 http://127.0.0.1:9000 。使用期间不要关闭这个窗口，也不要让电脑休眠；用完按 Control + C 停止。",
    en: "The workspace is running: open http://127.0.0.1:9000 in your browser. Keep this window open and the computer awake while you use it; press Control + C to stop.",
  });
  assert.deepEqual(portInUseProblem(9000), {
    zh: "端口 9000 已被占用：可能另一个终端窗口里已经在运行工作台。请关闭那个窗口（或在里面按 Control + C）后再启动；找不到时重启电脑。",
    en: "Port 9000 is already in use: the workspace may already be running in another Terminal window. Close that window (or press Control + C in it), then start again; if you cannot find it, restart the computer.",
  });
});

test("once it listens, the workspace server prints its address, then the started line in Chinese and in English, with the real port", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "startup-started-")));
  const archive = join(root, "mimic-iv-3.1.zip"); await writeFile(archive, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env, MIMIC_LOCAL_ARCHIVE: archive, QUESTION_WORKSPACE_PORT: "0", QUESTION_WORKSPACE_HOST: "127.0.0.1",
    QUESTION_WORKSPACE_RUNS_DIR: join(root, "runs"), QUESTION_WORKSPACE_STATIC_ROOT: join(root, "dist"),
  };
  delete env.NODE_TEST_CONTEXT; delete env.QUESTION_WORKSPACE_INVITE_CODE;
  // Started from the temporary folder, so no dictionary index of the repository is loaded. Port 0: the system picks a free one.
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), serverEntrypoint], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  let stdout = ""; let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; if (stdout.includes("press Control + C to stop.\n")) { clearTimeout(timer); resolve(); } });
      void exited.then(() => { clearTimeout(timer); resolve(); });
    });
    const port = Number(/^MIMIC 研究工作台 \/ MIMIC Study Workspace: http:\/\/127\.0\.0\.1:(\d+)\n/u.exec(stdout)?.[1]);
    assert.ok(port > 0, `${stdout}\n${stderr}`);
    const started = workspaceStartedMessage(port);
    assert.equal(stdout, `MIMIC 研究工作台 / MIMIC Study Workspace: http://127.0.0.1:${port}\n${started.zh}\n${started.en}\n`);
  } finally {
    child.kill(); await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("scripts/start-workspace.sh sends people to the install step by name when Node or the web page is missing", async () => {
  const { root } = await archiveFixture();
  try {
    // Node missing: a PATH with only what the script needs before the Node check.
    const bin = join(root, "bin"); await mkdir(bin);
    await symlink(spawnSync("/bin/sh", ["-c", "command -v dirname"], { encoding: "utf8" }).stdout.trim(), join(bin, "dirname"));
    const noNode = spawnSync("/bin/bash", [startScript], { cwd: root, env: { HOME: root, PATH: bin, PWD: root }, encoding: "utf8", timeout: 30_000 });
    assert.equal(noNode.status, 1, noNode.stderr);
    assert.ok(noNode.stderr.includes("[停止] 没有找到 Node。请安装 Node 22.13 或更新版本（Mac：https://nodejs.org；Windows：安装指南里“安装工具”那一步的命令），再重新完成安装指南里“一条命令完成安装”那一步。\n"), noNode.stderr);
    assert.ok(noNode.stderr.includes(`[Stopped] Node is not installed. Install Node 22.13 or newer (Mac: https://nodejs.org; Windows: the command of the guide's "Install the tools" step), then do the guide's "Install with one command" step again.\n`), noNode.stderr);
    // Web page missing.
    const noPage = runStartScript(root, join(root, "not-built"), undefined);
    assert.equal(noPage.status, 1, noPage.stderr);
    assert.ok(noPage.stderr.includes("。请先完成安装指南里“一条命令完成安装”那一步。\n"), noPage.stderr);
    assert.ok(noPage.stderr.includes(`). First complete the guide's "Install with one command" step.\n`), noPage.stderr);
    for (const stderr of [noNode.stderr, noPage.stderr]) assert.doesNotMatch(stderr, /bash scripts\/setup-new-machine\.sh/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * A fake Python for the setup script. `--version` reports VERSION; `-m venv … DIR` makes DIR/bin/python3 a copy of this fake (so the
 * new .venv reports the same version and has pip or not like it); `-m pip` and `-c` succeed; running a script fails with a Python
 * error on stderr. `pip: false` makes `-m pip` fail; `ensurepip: false` makes `-m venv` fail after creating DIR/bin/python3, as
 * Ubuntu's python3 does without python3-venv.
 */
const fakePython = (version: string, { pip = true, ensurepip = true }: { pip?: boolean; ensurepip?: boolean } = {}): string => [
  "#!/bin/sh",
  "case \"$1\" in",
  `  --version) echo "Python ${version}" ;;`,
  "  -m) case \"$2\" in",
  `    venv) for dir; do :; done; /bin/rm -rf "$dir"; /bin/mkdir -p "$dir/bin"; /bin/cp "$0" "$dir/bin/python3"${ensurepip ? "" : "; echo 'The virtual environment was not created successfully because ensurepip is not available.' >&2; exit 1"} ;;`,
  ...(pip ? [] : ["    pip) echo \"$0: No module named pip\" >&2; exit 1 ;;"]),
  "  esac ;;",
  "  -c) ;;",
  "  *) echo 'Traceback (most recent call last):' >&2; echo \"ValueError: fake failure in $1\" >&2; exit 1 ;;",
  "esac",
  "",
].join("\n");

const writeExecutable = async (path: string, text: string): Promise<void> => { await writeFile(path, text); await chmod(path, 0o755); };

/**
 * A copy of the setup script and the helpers it sources in a temporary folder that stands in for the repository, with a PATH of
 * only the commands it uses and the given fake Pythons, so the .venv it creates is never this repository's own. Node, npm and
 * Ollama are absent; R only when `rscript` is given. Returns the folder.
 */
const setupSandbox = async (pythons: Record<string, string>, rscript?: string): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "setup-python-")));
  await mkdir(join(root, "scripts")); await mkdir(join(root, "bin"));
  for (const name of ["setup-new-machine.sh", "archive-check.sh", "python-check.sh"]) await copyFile(join(repositoryRoot, "scripts", name), join(root, "scripts", name));
  for (const name of ["requirements-report.txt", "requirements-derived.txt"]) await copyFile(join(repositoryRoot, name), join(root, name));
  for (const tool of ["dirname", "grep", "unzip", "head", "tail", "mkdir", "cp", "basename"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) await symlink(found, join(root, "bin", tool));
  }
  for (const [command, version] of Object.entries(pythons)) await writeExecutable(join(root, "bin", command), fakePython(version));
  if (rscript) await writeExecutable(join(root, "bin", "Rscript"), rscript);
  return root;
};

const runSandbox = (root: string, extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } => {
  // /bin/bash where it exists: on macOS that is bash 3.2, the bash testers run the script with.
  const bash = existsSync("/bin/bash") ? "/bin/bash" : spawnSync("/bin/sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  const result = spawnSync(bash, [join(root, "scripts", "setup-new-machine.sh")], { cwd: root, env: { HOME: root, PATH: join(root, "bin"), PWD: root, ...extra }, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const venvVersion = (root: string): string => spawnSync(join(root, ".venv", "bin", "python3"), ["--version"], { encoding: "utf8" }).stdout.trim();

test("setup picks python3.12 first, else python3 when it is 3.10-3.12, and refuses 3.13 or newer with the pinned message", async () => {
  const cases: Array<{ name: string; pythons: Record<string, string>; chosen?: string; refused?: [string, string] }> = [
    { name: "Homebrew 3.14 only", pythons: { python3: "3.14.7" }, refused: ["现在是 Python 3.14.7", "found Python 3.14.7"] },
    { name: "3.13 only", pythons: { python3: "3.13.1" }, refused: ["现在是 Python 3.13.1", "found Python 3.13.1"] },
    { name: "no Python", pythons: {}, refused: ["没有找到 Python", "no Python found"] },
    { name: "3.14 and python3.12", pythons: { python3: "3.14.7", "python3.12": "3.12.10" }, chosen: "Python 3.12.10 (python3.12)" },
    { name: "python3.12 only", pythons: { "python3.12": "3.12.10" }, chosen: "Python 3.12.10 (python3.12)" },
    { name: "3.10 as python3", pythons: { python3: "3.10.14" }, chosen: "Python 3.10.14 (python3)" },
    { name: "3.12 as python3", pythons: { python3: "3.12.4" }, chosen: "Python 3.12.4 (python3)" },
  ];
  for (const { name, pythons, chosen, refused } of cases) {
    const root = await setupSandbox(pythons);
    try {
      const { stdout } = runSandbox(root);
      if (refused) {
        const todo = pythonTodo(...refused);
        assert.ok(stdout.includes(`  [todo] ${todo.zh}\n         ${todo.en}\n`), `${name}:\n${stdout}`);
        assert.equal(existsSync(join(root, ".venv")), false, name);
      } else {
        assert.ok(stdout.includes(`  [ok]   ${chosen}\n`), `${name}:\n${stdout}`);
        assert.doesNotMatch(stdout, /需要 Python 3\.12/u, name);
        // The .venv is made by the chosen Python.
        assert.equal(venvVersion(root), chosen!.replace(/ \(.*\)$/u, ""), name);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("setup recreates a .venv whose Python is outside 3.10-3.12 or that has no pip with the chosen Python, and keeps one that is inside", async () => {
  // The install test: a .venv made by Homebrew's 3.14 was reused after Python 3.12 came first on PATH.
  const root = await setupSandbox({ python3: "3.14.7", "python3.12": "3.12.10" });
  try {
    await mkdir(join(root, ".venv", "bin"), { recursive: true });
    await writeExecutable(join(root, ".venv", "bin", "python3"), fakePython("3.14.7")); await writeFile(join(root, ".venv", "built-from-source"), "");
    const { stdout } = runSandbox(root);
    assert.ok(stdout.includes("  重建 .venv（它用的 Python 版本不受支持或已不存在，或它缺少 pip）/ Recreating .venv (its Python version is not supported or is missing, or it has no pip)\n"), stdout);
    assert.equal(venvVersion(root), "Python 3.12.10");
    assert.equal(existsSync(join(root, ".venv", "built-from-source")), false);
    assert.ok(stdout.includes("  [ok]   报告组件 / report runtime (.venv)\n"), stdout);
  } finally { await rm(root, { recursive: true, force: true }); }
  const kept = await setupSandbox({ python3: "3.11.9" });
  try {
    await mkdir(join(kept, ".venv", "bin"), { recursive: true });
    await writeExecutable(join(kept, ".venv", "bin", "python3"), fakePython("3.11.9")); await writeFile(join(kept, ".venv", "packages"), "");
    const { stdout } = runSandbox(kept);
    assert.doesNotMatch(stdout, /重建 \.venv/u);
    assert.ok((await stat(join(kept, ".venv", "packages"))).isFile());
  } finally { await rm(kept, { recursive: true, force: true }); }
  // A supported Python without pip in .venv is recreated too.
  const pipless = await setupSandbox({ "python3.12": "3.12.10" });
  try {
    await mkdir(join(pipless, ".venv", "bin"), { recursive: true });
    await writeExecutable(join(pipless, ".venv", "bin", "python3"), fakePython("3.12.10", { pip: false }));
    const { stdout } = runSandbox(pipless);
    assert.ok(stdout.includes("  重建 .venv（它用的 Python 版本不受支持或已不存在，或它缺少 pip）/ Recreating .venv (its Python version is not supported or is missing, or it has no pip)\n"), stdout);
    assert.ok(stdout.includes("  [ok]   报告组件 / report runtime (.venv)\n"), stdout);
  } finally { await rm(pipless, { recursive: true, force: true }); }
});

test("on Ubuntu without python3-venv, every rerun names python3-venv until it is installed, never the pip mirror", async () => {
  // `python3 -m venv` stops at ensurepip and leaves .venv/bin/python3 without pip; the first run and the rerun must give the same advice.
  const root = await setupSandbox({ "python3.12": "3.12.3" });
  try {
    await writeExecutable(join(root, "bin", "python3.12"), fakePython("3.12.3", { pip: false, ensurepip: false }));
    const venvTodo = "  [todo] Python 虚拟环境 .venv 没有建成（错误信息见上方）。Windows（WSL2 Ubuntu）请运行：sudo apt install -y python3-venv ，然后再运行本命令。\n";
    for (const run of ["first run", "rerun"]) {
      const { stdout, stderr } = runSandbox(root);
      assert.ok(stdout.includes(venvTodo), `${run}:\n${stdout}`);
      assert.match(stderr, /ensurepip is not available/u, run);
      assert.doesNotMatch(stdout, /报告组件|report runtime|pip 镜像|pip mirror/u, `${run}:\n${stdout}`);
    }
    // After `sudo apt install -y python3-venv`.
    await writeExecutable(join(root, "bin", "python3.12"), fakePython("3.12.3"));
    const { stdout } = runSandbox(root);
    assert.doesNotMatch(stdout, /\.venv 没有建成/u);
    assert.ok(stdout.includes("  [ok]   报告组件 / report runtime (.venv)\n"), stdout);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup names the install step when the model is missing, and once everything is in place prints the start command and 127.0.0.1", { skip: spawnSync("/bin/sh", ["-c", "command -v unzip"]).status !== 0 && "unzip is not installed" }, async () => {
  const shim = (text: string): string => `#!/bin/sh\n${text}\n`;
  const root = await setupSandbox({ "python3.12": "3.12.10" }, shim("case \"$1\" in --version) echo 'Rscript (R) version 4.4.1' ;; esac"));
  try {
    // Every tool present and working: only the model and the closing lines are under test.
    const bin = join(root, "bin");
    await writeExecutable(join(bin, "node"), shim("case \"$1\" in -v) echo v22.13.0 ;; esac"));
    await writeExecutable(join(bin, "npm"), shim("exit 0")); await writeExecutable(join(bin, "curl"), shim("exit 0"));
    await symlink(spawnSync("/bin/sh", ["-c", "command -v awk"], { encoding: "utf8" }).stdout.trim(), join(bin, "awk"));
    const models = join(root, "models.txt"); await writeFile(models, "NAME ID SIZE MODIFIED\n");
    await writeExecutable(join(bin, "ollama"), shim(`case "$1" in --version) echo 'ollama version is 0.12.0' ;; list) /bin/cat '${models}' ;; *) exit 1 ;; esac`));
    await mkdir(join(root, "frontend", "question-workspace-app"), { recursive: true });
    const archive = join(root, "mimic-iv-3.1.zip");
    await writeFile(archive, storedZip(["mimic-iv-3.1/hosp/admissions.csv.gz", "mimic-iv-3.1/icu/icustays.csv.gz"]));
    await writeFile(join(root, "mimic-iv-3.1-derived.zip"), "");
    await mkdir(join(root, ".local")); await writeFile(join(root, ".local", "dictionary-index.json"), "{}");
    // The model is missing and MODEL is not set: copy the install step's command (it has MODEL=…), or pull it.
    const missing = runSandbox(root, { MIMIC_LOCAL_ARCHIVE: archive });
    assert.equal(missing.status, 1, missing.stdout);
    const model = "qwen2.5:7b-instruct-q4_K_M";
    assert.ok(missing.stdout.includes(`  [todo] 还没有安装模型 ${model}。请复制安装指南里“一条命令完成安装”那一步的整条命令（含 MODEL=…）再运行，或运行  ollama pull ${model} 。\n         The model ${model} is not installed. Copy the whole command of the guide's "Install with one command" step (including MODEL=…) and run it again, or run  ollama pull ${model} .\n`), missing.stdout);
    assert.doesNotMatch(missing.stdout, /在本命令前加 MODEL|set MODEL=/u);
    // Everything in place: the start command and the address of the server's started line; localhost only as the WSL2 fallback.
    await writeFile(models, `NAME ID SIZE MODIFIED\n${model} 0a1b2c 4.7GB now\n`);
    const ready = runSandbox(root, { MIMIC_LOCAL_ARCHIVE: archive });
    assert.equal(ready.status, 0, ready.stdout);
    const awake = process.platform === "darwin" ? "caffeinate -i env " : "";
    assert.ok(ready.stdout.includes(`\n  ${awake}MIMIC_LOCAL_ARCHIVE="${archive}" bash scripts/start-workspace.sh\n\n等出现“工作台已启动”这一行后，在浏览器打开 http://127.0.0.1:9000 / When "The workspace is running" appears, open http://127.0.0.1:9000\n`), ready.stdout);
    const wsl = existsSync("/proc/version") && /microsoft/iu.test(readFileSync("/proc/version", "utf8"));
    assert.equal(ready.stdout.includes("打不开时改用 http://localhost:9000 / If it does not open, use http://localhost:9000\n"), wsl, ready.stdout);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup announces the long silent steps with their times and, when one fails, shows the error and asks only for error lines", { skip: spawnSync("/bin/sh", ["-c", "command -v unzip"]).status !== 0 && "unzip is not installed" }, async () => {
  const rscript = ["#!/bin/sh", "case \"$1\" in --version) echo 'Rscript (R) version 4.4.1' ;; *) echo 'trying URL https://example.invalid/glmnet.tgz' ; echo 'Error: package glmnet could not be installed' >&2; exit 1 ;; esac", ""].join("\n");
  const root = await setupSandbox({ "python3.12": "3.12.10" }, rscript);
  try {
    const archive = join(root, "mimic-iv-3.1.zip");
    await writeFile(archive, storedZip(["mimic-iv-3.1/hosp/admissions.csv.gz", "mimic-iv-3.1/icu/icustays.csv.gz"]));
    const { stdout } = runSandbox(root, { MIMIC_LOCAL_ARCHIVE: archive, BUILD_DERIVED: "1", BUILD_INDEX: "1" });
    // One line before each long step, Chinese first, with the pinned time.
    assert.ok(stdout.includes("  正在安装 R 包（约 10–20 分钟，期间没有新文字，这是正常的，请不要关闭窗口）… / Installing R packages (about 10–20 minutes, with no new text meanwhile; this is normal, keep the window open)…\n"), stdout);
    assert.ok(stdout.includes("  正在建立衍生变量层（约 10–30 分钟，"), stdout); assert.ok(stdout.includes("/ Building the derived-variable layer (about 10–30 minutes,"), stdout);
    assert.ok(stdout.includes("  正在建立字典索引（约 10 分钟，"), stdout); assert.ok(stdout.includes("/ Building the dictionary index (about 10 minutes,"), stdout);
    // R: its error is shown, then rerun the same command, then the feedback line; no Rscript command to type.
    assert.ok(stdout.includes(`Error: package glmnet could not be installed\n  [todo] R 包没有装好（错误信息见上方）。请检查网络，然后重新运行同一条安装命令。如果再次失败：${feedback.zh}\n`), stdout);
    assert.ok(stdout.includes(`         The R packages did not install (see the error above). Check the network, then run the same setup command again. If it fails again: ${feedback.en}\n`), stdout);
    // Derived layer: its error lines, then close other programs and rerun, then the pinned feedback line instead of "send us this output".
    assert.match(stdout, /ValueError: fake failure in scripts\/derived\/build_derived\.py\n  \[todo\] 衍生变量层没有建成/u);
    assert.ok(stdout.includes(`  [todo] 衍生变量层没有建成（错误信息见上方）。多数是内存不够：请关闭其他大型程序，然后重新运行同一条安装命令。如果再次失败：${feedback.zh}\n         The derived layer did not build (see the error above). Usually memory ran out: close other large programs, then run the same setup command again. If it fails again: ${feedback.en}\n`), stdout);
    // Dictionary index: the last lines of its error, then rerun, then the feedback line; no .venv command to type.
    assert.match(stdout, /ValueError: fake failure in scripts\/build-dictionary-index\.py\n  \[todo\] 字典索引没有建成/u);
    assert.ok(stdout.includes(`  [todo] 字典索引没有建成（错误信息见上方）。请重新运行同一条安装命令。如果再次失败：${feedback.zh}\n         The dictionary index did not build (see the error above). Run the same setup command again. If it fails again: ${feedback.en}\n`), stdout);
    assert.doesNotMatch(stdout, /请把这段输出发给我们|Send us this output|Rscript scripts\/|\.venv\/bin\/python3 scripts\/|从安装包复制/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
