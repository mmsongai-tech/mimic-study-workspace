# MIMIC 研究工作台 · MIMIC Study Workspace

> 中文在前，English below.

## 中文

**这是什么：** 一个在您自己电脑上运行的临床研究工具。您用中文或英文提出一个研究问题，平台先把它整理成**分析计划**（人群、暴露、对照、结局和方法），您确认后，它在您自己的 MIMIC-IV 数据副本上完成分析，并生成中英文报告（Word、Markdown 或纯文本）。

- AI 模型在本机运行（Ollama）。
- 数据不会离开您的电脑。
- 平台不调用任何在线 AI 服务。

**谁可以用：** 只有本人持有 PhysioNet 授权、可以使用 MIMIC-IV 的人。本仓库**不含任何 MIMIC 数据**，您需要自备从 PhysioNet 下载的 `mimic-iv-3.1.zip`。

**当前状态：** 研究原型，用于小范围试用（版本见 `package.json`）。结果是观察性数据中的关联，未经临床审核或外部验证，**不能用于临床决策**。

### 安装和使用

推荐使用 **Mac**。请按照对应的指南逐步操作：

- Mac：[docs/client-guide/macos.md](docs/client-guide/macos.md)
- Windows（**试验版**：通过 WSL2 运行，尚未在真实 Windows 电脑上测试）：[docs/client-guide/windows.md](docs/client-guide/windows.md)

需要准备：

- 内存至少 16 GB（Windows 推荐 32 GB），硬盘可用空间 50–60 GB；
- **MIMIC-IV 数据文件 `mimic-iv-3.1.zip`**（约 10.6 GB）：用您本人的 PhysioNet 授权账号登录 [MIMIC-IV 3.1 页面](https://physionet.org/content/mimiciv/3.1/)，在页面下方 Files 里点 “Download the ZIP file” 下载这一个文件。**不要解压，也不要改名**；以前用 wget 下载的文件夹不能用；
- 第一次安装 Mac 约 1–3 小时、Windows 约 2–4 小时，大部分时间可以离开。

请从 GitHub 的 **Releases（发布）页**下载对应系统的安装包（https://github.com/mmsongai-tech/mimic-study-workspace/releases/latest ，不需要 GitHub 账号），不要使用绿色的 Code 按钮。发布页上写明了要下载哪个文件、要准备什么。

### 可以问的问题

本版本接受六类问题。提问页上有每一类的填空格式：

| 类型 | 例如 |
|---|---|
| 用药 vs 不用药 | 在【人群】中，使用【药物】与不使用相比，【结局】有何差异？ |
| 药物 A vs 药物 B | 在【人群】中，使用【药物 A】与使用【药物 B】相比，【结局】有何差异？ |
| 指标与结局 | 在【人群】中，【化验值、生命体征或评分】与【结局】有何关联？ |
| 指标的变化 | 在【人群】中，使用【药物】后【指标】在【时间段】内的变化，与不使用相比有何不同？ |
| 预测 | 在【人群】中，能否用【预测因素】预测【结局】？ |
| 描述 | 描述【人群】的【特征】，（如需分组）按【分组】分组。 |

**本版本暂不支持：** 剂量-反应、亚组或性别是否改变疗效（交互作用）、中介分析。

### 数据规则

平台生成的所有结果都来自 MIMIC-IV，只能与同样持有 PhysioNet 授权的人分享。

不要把以下内容上传到在线 AI 工具、网盘、公开的 issue 或群聊：

- MIMIC 数据；
- 平台生成的结果和报告；
- 结果截图。

反馈问题时，只把错误文字和出问题那一步的名字私下发给联系人；不要发人数、结果数字、报告或结果截图。

---

## English

**What it is:** a clinical research tool that runs on your own computer. You ask a research question in Chinese or English. The platform turns it into an **analysis plan** (population, exposure, comparator, outcome and method). After you confirm the plan, it runs the analysis on your own copy of MIMIC-IV and writes reports in Chinese and English (Word, Markdown or text).

- The AI model runs locally (Ollama).
- No data leaves your computer.
- No online AI service is called.

**Who may use it:** only people who personally hold PhysioNet credentialed access to MIMIC-IV. This repository contains **no MIMIC data**; you need your own `mimic-iv-3.1.zip` from PhysioNet.

**Status:** a research prototype for a small pilot (version in `package.json`). Results are observational associations. They have not been reviewed by clinicians or validated externally, and **must not be used for clinical decisions**.

### Install and use

A **Mac** is recommended. Follow the guide for your system step by step:

- Mac: [docs/client-guide/macos.md](docs/client-guide/macos.md)
- Windows (**experimental**: runs through WSL2, not yet tested on a real Windows PC): [docs/client-guide/windows.md](docs/client-guide/windows.md)

You need:

- 16 GB of memory or more (32 GB recommended on Windows) and 50–60 GB of free disk space;
- **the MIMIC-IV data file `mimic-iv-3.1.zip`** (about 10.6 GB): sign in with your own PhysioNet credentialed account, open the [MIMIC-IV 3.1 page](https://physionet.org/content/mimiciv/3.1/) and, under Files at the bottom, click “Download the ZIP file” to get this single file. **Do not unzip or rename it**; a folder downloaded earlier with wget does not work;
- 1–3 hours for the first installation on a Mac, 2–4 hours on Windows, mostly unattended.

Download the package for your system from the GitHub **Releases** page (https://github.com/mmsongai-tech/mimic-study-workspace/releases/latest , no GitHub account needed), not from the green Code button. The Releases page says which file to download and what to prepare.

### What you can ask

This version accepts six kinds of questions:

- drug vs no drug;
- drug A vs drug B;
- a measurement (lab value, vital sign or score) and an outcome;
- change in a measurement;
- prediction;
- description of a population.

The question page shows a fill-in format for each. **Not in this version:** dose-response, whether a subgroup or sex changes the effect (interaction), and mediation.

### Data rules

Every result is derived from MIMIC-IV and may be shared only with people who hold PhysioNet credentialed access.

Never upload any of the following to online AI tools, cloud drives, public issues or group chats:

- MIMIC data;
- results and reports;
- screenshots of results.

When reporting a problem, send only the error text and the name of the step, privately, to your contact; never patient counts, result numbers, reports or screenshots of results.

---

## For developers / 开发者

- Repository rules: [AGENTS.md](AGENTS.md).
- Scope and standards: [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md), [docs/DELIVERY_PIPELINE.md](docs/DELIVERY_PIPELINE.md) (evidence levels L1–L5), [docs/ENGINEERING_STANDARD.md](docs/ENGINEERING_STANDARD.md).
- Setup details and the run folder layout: [docs/SETUP_NEW_MACHINE.md](docs/SETUP_NEW_MACHINE.md).
- Checks: `npm run typecheck`, `npm test`.
- Backend code is organised by business domain under `backend/src/`, the web app under `frontend/question-workspace-app/`, statistical methods in R under `backend/src/study-analysis/runtimes/r/`.

## License and attribution / 许可与引用

- **Code license:** the code is released under the MIT License ([LICENSE](LICENSE)).
- **Data terms:** MIMIC-IV data is not part of this repository and is governed by the PhysioNet credentialed health data use agreement.
- **Citation:** if you publish work that used this tool, cite MIMIC-IV and PhysioNet as shown on the MIMIC-IV project page at physionet.org.
- **No affiliation:** this project is not affiliated with or endorsed by the MIT Laboratory for Computational Physiology or PhysioNet.
