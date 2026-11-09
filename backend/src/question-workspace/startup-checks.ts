import { stat } from "node:fs/promises";

/** A start-up message for the terminal, Chinese first. */
export interface StartupMessage { zh: string; en: string }

/**
 * A reason the workspace cannot start, Chinese first. The archive messages are word for word those of scripts/archive-check.sh,
 * which scripts/start-workspace.sh and scripts/setup-new-machine.sh print.
 */
export type StartupProblem = StartupMessage;

/**
 * The client-guide steps that messages send people back to, by name: the step numbers differ between the Mac and the Windows
 * guide (docs/client-guide/), so messages never use numbers. scripts/archive-check.sh holds the same names.
 */
export const GUIDE_STEPS = {
  install: { zh: "安装指南里“一条命令完成安装”那一步", en: `the guide's "Install with one command" step` },
  start: { zh: "安装指南里“每次使用”那一步", en: `the guide's "Every time you use it" step` },
} as const satisfies Record<string, StartupMessage>;

/**
 * Why the MIMIC-IV archive path cannot be used, or undefined when it names a file. The archive must stay one unmodified
 * zip (it is read with `unzip`); a folder usually means the browser unzipped the download. `step` is the guide step whose whole
 * command the "not set" message tells the user to copy.
 */
export const archiveProblem = async (path: string | undefined, step: keyof typeof GUIDE_STEPS = "start"): Promise<StartupProblem | undefined> => {
  if (!path) return {
    zh: `没有告诉平台 MIMIC 数据文件在哪里。请复制${GUIDE_STEPS[step].zh}的整条命令（含 MIMIC_LOCAL_ARCHIVE=…）再运行。`,
    en: `The platform was not told where the MIMIC data file is. Copy the whole command of ${GUIDE_STEPS[step].en} (including MIMIC_LOCAL_ARCHIVE=…) and run it again.`,
  };
  const info = await stat(path).catch(() => undefined);
  if (!info) return {
    zh: `找不到文件：${path}。请检查路径（macOS 可把 zip 文件拖进终端窗口得到准确路径）。请确认 mimic-iv-3.1.zip 在个人文件夹的 mimic 文件夹里（Windows：Ubuntu 里的 ~/mimic 文件夹，不是 C 盘），名字没有变成 mimic-iv-3.1 (1).zip。`,
    en: `File not found: ${path}. Check the path (on macOS, drag the zip file into the Terminal window to get the exact path). Make sure mimic-iv-3.1.zip is in the mimic folder of your home folder (Windows: ~/mimic inside Ubuntu, not drive C) and its name has not changed to mimic-iv-3.1 (1).zip.`,
  };
  if (info.isDirectory()) return {
    zh: `${path} 是一个文件夹，不是 zip 文件。请保留下载的 mimic-iv-3.1.zip 原样、不要解压（Safari 可能已自动解压），并把路径指向这个 .zip 文件。如果 .zip 已经不在了，请在 Safari → 设置 → 通用 中取消勾选"下载后打开‘安全的’文件"，然后重新下载。`,
    en: `${path} is a folder, not a zip file. Keep the downloaded mimic-iv-3.1.zip zipped (Safari may have unzipped it) and point to the .zip file. If the .zip is gone, turn off Safari → Settings → General → "Open 'safe' files after downloading" and download it again.`,
  };
  return undefined;
};

/**
 * Printed instead of a Node stack when the workspace port is taken (EADDRINUSE). Testers cannot change the port: the guides and
 * the started line name 127.0.0.1:9000.
 */
export const portInUseProblem = (port: number): StartupProblem => ({
  zh: `端口 ${port} 已被占用：可能另一个终端窗口里已经在运行工作台。请关闭那个窗口（或在里面按 Control + C）后再启动；找不到时重启电脑。`,
  en: `Port ${port} is already in use: the workspace may already be running in another Terminal window. Close that window (or press Control + C in it), then start again; if you cannot find it, restart the computer.`,
});

/** Printed once the server listens, with the port it really listens on: where to open it, and how to keep it running. */
export const workspaceStartedMessage = (port: number): StartupMessage => ({
  zh: `工作台已启动：请在浏览器打开 http://127.0.0.1:${port} 。使用期间不要关闭这个窗口，也不要让电脑休眠；用完按 Control + C 停止。`,
  en: `The workspace is running: open http://127.0.0.1:${port} in your browser. Keep this window open and the computer awake while you use it; press Control + C to stop.`,
});

/** Shown at / when the web page has not been built, instead of a JSON 404. */
export const PAGE_NOT_BUILT = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MIMIC 研究工作台 / MIMIC Study Workspace</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.6">
<h1>网页还没有构建 / The web page is not built yet</h1>
<p>请先完成${GUIDE_STEPS.install.zh}，再按${GUIDE_STEPS.start.zh}重新启动。</p>
<p>Complete ${GUIDE_STEPS.install.en} first, then start again with ${GUIDE_STEPS.start.en}.</p>
</body></html>
`;
