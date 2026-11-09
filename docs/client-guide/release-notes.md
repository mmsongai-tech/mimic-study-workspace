<!-- The text of the GitHub Release page that the testers' download link opens (gh release create --notes-file). Keep it version-free. -->

## 中文

**MIMIC 研究工作台**是一个在您自己电脑上运行的临床研究工具：用中文或英文提出研究问题，确认分析计划后，它在您自己的 MIMIC-IV 数据上完成分析并生成报告。AI 模型在本机运行，数据不会离开您的电脑。这是研究原型，结果不能用于临床决策。

**谁可以用：** 只有本人持有 PhysioNet 授权、可以使用 MIMIC-IV 的人。授权按人计算，不能借给别人。本软件不含任何 MIMIC 数据。

**下载哪个文件**（在本页下方的 Assets 列表里，不需要 GitHub 账号）：

- Mac（推荐）：名字以 `-macos.zip` 结尾的文件。
- Windows（**试验版**：通过 WSL2 运行，尚未在真实 Windows 电脑上测试）：名字以 `-windows.zip` 结尾的文件。
- 不要下载 "Source code"。GitHub 下载很慢时，请向联系人索取国内下载链接。

**先准备好：**

- Mac 需要 macOS 14（Sonoma）或更新（左上角苹果菜单 → 关于本机 可以看到版本）。
- 内存至少 16 GB（Windows 推荐 32 GB），硬盘可用空间 50–60 GB。
- 电脑开机密码（管理员权限）。医院统一管理的电脑可能装不了软件。
- 您自己从 PhysioNet 下载的 `mimic-iv-3.1.zip`（约 10.6 GB）：用您本人的 PhysioNet 授权账号登录 https://physionet.org/content/mimiciv/3.1/ ，在页面下方 Files 里点 "Download the ZIP file" 下载这一个文件。**永远不要解压它，也不要改名。**

**Mac 用 Safari 下载之前：** 打开 Safari → 设置（旧版 macOS 叫"偏好设置"）→ 通用，取消勾选"下载后打开‘安全的’文件"。否则 Safari 会自动解压下载的文件。

**下载后，打开排好版的安装指南，按步骤操作**（同一份指南也在压缩包里，名为 `START_HERE.md`）：

- Mac：https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/macos.md
- Windows：https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/windows.md

**数据规则：**

- MIMIC 数据、平台的结果、报告和结果截图只能给同样持有 PhysioNet 授权的人看；不要上传到在线 AI（ChatGPT、Kimi、豆包、DeepSeek 等）、网盘或群聊。
- 遇到问题时，只把错误文字和出问题那一步的名字私下发给联系人；不要发人数、结果数字、报告或结果截图。

**联系人：** Mingming Song（songm0428@gmail.com），请单独发邮件。本仓库不接收 Issues，反馈只通过邮件。

在 Windows 上，压缩包里的 `START_HERE.md` 可以右键 → 打开方式 → 记事本 打开；更推荐直接看上面排好版的在线指南。

---

## English

**MIMIC Study Workspace** is a clinical research tool that runs on your own computer: ask a research question in Chinese or English, confirm the analysis plan, and it runs the analysis on your own copy of MIMIC-IV and writes a report. The AI model runs locally and no data leaves your computer. It is a research prototype; results must not be used for clinical decisions.

**Who may use it:** only people who personally hold PhysioNet credentialed access to MIMIC-IV. Access is per person and cannot be shared. This software contains no MIMIC data.

**Which file to download** (in the Assets list further down this page; no GitHub account needed):

- Mac (recommended): the file ending in `-macos.zip`.
- Windows (**experimental**: runs through WSL2, not yet tested on a real Windows PC): the file ending in `-windows.zip`.
- Do not download "Source code". If GitHub is slow, ask your contact for a domestic download link.

**What to prepare:**

- A Mac needs macOS 14 (Sonoma) or newer (Apple menu → About This Mac shows the version).
- 16 GB of memory or more (32 GB recommended on Windows) and 50–60 GB of free disk space.
- The computer's login (administrator) password. Hospital-managed computers may block installs.
- Your own `mimic-iv-3.1.zip` from PhysioNet (about 10.6 GB): sign in with your own credentialed PhysioNet account, open https://physionet.org/content/mimiciv/3.1/ and, under Files at the bottom, click "Download the ZIP file" to get this single file. **Never unzip it and never rename it.**

**Before downloading with Safari on a Mac:** open Safari → Settings (Preferences on older macOS) → General and turn off "Open "safe" files after downloading". Otherwise Safari unzips downloads by itself.

**After downloading, open the formatted guide and follow it step by step** (the same guide is in the zip as `START_HERE.md`):

- Mac: https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/macos.md
- Windows: https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/windows.md

**Data rules:**

- MIMIC data, the platform's results, reports and screenshots of results may be shown only to people who hold PhysioNet credentialed access; never upload them to online AI tools (ChatGPT, Kimi, Doubao, DeepSeek and others), cloud drives or group chats.
- When something goes wrong, send only the error text and the name of the step, privately, to your contact; never patient counts, result numbers, reports or screenshots of results.

**Contact:** Mingming Song (songm0428@gmail.com), by private email. This repository does not take Issues; feedback is by email only.

On Windows, open `START_HERE.md` from the zip with right-click → Open with → Notepad; the formatted online guide above is easier to read.
