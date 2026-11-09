# Set up the question workspace on a new machine / 在新机器上安装和运行

From downloading the code to reading the reports. Tested on macOS from a fresh clone (setup script, planning a question,
running an analysis and writing the reports). Linux uses the same steps. On Windows use WSL2 with Ubuntu: the scripts are
bash and the report runtime expects `.venv/bin/python3`.
从下载代码到读到报告的全部步骤。已在 macOS 上从全新克隆测试（安装脚本、规划问题、运行分析、生成报告）；Linux 步骤相同；Windows 请用 WSL2（Ubuntu）。

**Privacy / 隐私：** this repository contains no MIMIC data and no credentials. MIMIC-IV needs PhysioNet credentialed access; the
results the workspace writes are derived from MIMIC and may only go to people with their own credentialed access.
本仓库不含 MIMIC 数据和任何凭据。MIMIC-IV 需要 PhysioNet 授权；工作区生成的结果由 MIMIC 派生，只能给同样获得授权的人。

## 1. What you need / 需要什么

| Item | Minimum | Better |
|---|---|---|
| Disk | 25 GB free (the archive is 10.6 GB, the derived layer 65 MB, runs add a few GB) | SSD with 50 GB free |
| Memory | 16 GB | 32 GB or more (the archive scan holds a lot in memory) |
| Model memory | 8 GB for the 7B baseline | 24 GB GPU memory for a 32B model (about 20 GB at 4-bit) |
| Software | Node 22.13+, Python 3.12 (3.10 and 3.11 accepted; 3.13 and newer refused), R 4.3+, Ollama | Same |
| Data | `mimic-iv-3.1.zip` from PhysioNet (credentialed) | Same |

**Python:** only Python 3.12 is tested and recommended. The setup script uses `python3.12` when it is on PATH, else `python3`
when that is 3.10–3.12, and otherwise stops with the installer link; it creates `.venv` with that Python and recreates a `.venv`
whose Python is outside 3.10–3.12 or that has no pip (on Python 3.14, pandas 2.2.3 built from source against numpy 2 crashed the derived layer). On a
Mac install https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg (mainland China:
https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-macos11.pkg; release page
https://www.python.org/downloads/release/python-31210/, button "macOS 64-bit universal2 installer"): 3.12.10 is the last 3.12
release with a Mac installer. WSL2 Ubuntu 24.04 already has Python 3.12. The other Python scripts in `scripts/` that this guide
runs with `python3` (`export-variable-definitions.py`, `regression-planning.py`) use the standard library only; the dictionary
index and the derived layer need `.venv/bin/python3`.
**Python：** 只测试并推荐 Python 3.12。安装脚本优先用 PATH 上的 `python3.12`，否则在 `python3` 为 3.10–3.12 时用它，其他情况停下并给出安装包链接；
`.venv` 用选中的 Python 创建，`.venv` 的 Python 不在 3.10–3.12 或缺少 pip 时会重建。Mac 请安装上面的 3.12.10 安装包（3.12 系列最后一个有 Mac 安装包的版本）；WSL2 Ubuntu 24.04 自带 Python 3.12。

The analysis itself (the archive scan and R) is the same on every machine and takes about 10 minutes per question; a stronger
GPU only makes the language-model steps (framing, mapping) faster and, with a larger model, better.
分析本身（扫描压缩包和 R）在每台机器上一样，每题约 10 分钟；更强的 GPU 只让语言模型步骤（拆题、映射）更快，换更大模型还会更准。

## 2. Get the code / 获取代码

```bash
git clone <repository-or-repo.bundle> mimic-research-agent-platform
cd mimic-research-agent-platform
git checkout feature/general-question-pipeline
```

If you received an evaluation kit zip, `git clone repo.bundle mimic-research-agent-platform` does the same.

## 3. Install / 安装

```bash
MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip bash scripts/setup-new-machine.sh
```

It checks Node, Python, R and Ollama, installs the npm packages, builds the web page, creates `.venv` for the Word/PDF report
runtime, installs the R packages, checks the model and the archive, and lists what is still missing ("[todo]"). Run it again
after fixing each item. To also download a model:

```bash
MODEL=qwen2.5:32b-instruct-q4_K_M bash scripts/setup-new-machine.sh
```

Approximate memory for 4-bit models: 7B 6–8 GB (the default `qwen2.5:7b-instruct-q4_K_M`), 14B 12–16 GB, 32B 24–32 GB; check the real
usage on your machine with `ollama ps`.

### The derived-variable layer / 推导变量层

Acute kidney injury, eGFR, readmission, SOFA, organ-support durations and variability are computed once from the archive into
`<archive name>-derived.zip` next to it ([DERIVED_VARIABLES.md](DERIVED_VARIABLES.md)). Build it once (about 15 minutes; needs `pandas` and `numpy`, which the setup script installs into `.venv`):

```bash
BUILD_DERIVED=1 MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip bash scripts/setup-new-machine.sh
```

### The dictionary index / 字典索引

The Variables page, the checks of a new definition and the automatic proposals (a narrower definition drafted from the dictionary when a term only partly matches, or matches nothing) read `.local/dictionary-index.json`: names, row counts and sampled distributions of every laboratory item, chart item, drug label and ICD code. It holds aggregate counts only. Build it once from the archive (one pass over the large tables, so allow time), or copy it from the package of the first machine (credentialed readers only):

```bash
BUILD_INDEX=1 MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip bash scripts/setup-new-machine.sh
```

Without it, those features answer "not available" and every other question runs.
没有它时，“变量”页和自动提出候选定义不可用，其余照常运行。

Without the derived layer, a question that needs one of these variables stops with a clear message; every other question runs. The file is derived from MIMIC-IV and follows the same access rules as the archive.
急性肾损伤、eGFR、再入院、SOFA、器官支持时长和变异性从压缩包一次性算出，存为压缩包旁边的 `<压缩包名>-derived.zip`；不建时，需要这些变量的问题会明确报错，其余问题照常运行。

## 4. Start / 启动

```bash
MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip \
MIMIC_LOCAL_MODEL_PROFILE=qwen2.5:32b-instruct-q4_K_M \
bash scripts/start-workspace.sh
```

Open http://127.0.0.1:9000. Ollama must be running (`ollama serve`; the desktop app starts it). Optional variables:
`QUESTION_WORKSPACE_RUNS_DIR` (where runs are stored), `QUESTION_WORKSPACE_PORT`, `QUESTION_WORKSPACE_INVITE_CODE`.

## 5. Ask a question and read the output / 提问并查看输出

1. Type a research question (Chinese or English) and press the button. The platform frames it, maps every variable to MIMIC
   fields and shows a **plan**: population, exposure, comparator, outcome, method, assumptions. Nothing has touched patient data yet.
2. Read the plan. Anything the model translated or could not find is marked; a question MIMIC cannot answer is stopped with the
   reason. Change options if needed and confirm. (Or submit with `auto_confirm` through the API for batch runs.)
3. The analysis runs: about 10 minutes per question (one run at a time). Progress is shown; a waiting run can be cancelled.
4. Read the results page: per aim, the estimate with its checks, "how far to read it", patient flow, Table 1, figures and the design.
   Estimates that cannot be trusted show raw counts instead of a number.
5. Download the reports from the page (`中文/EN` × `.docx/.md/.txt`) or find them in the run folder.

A run folder (`QUESTION_WORKSPACE_RUNS_DIR/<run id>/`) holds:

| File | What it is |
|---|---|
| `report.zh.docx`, `report.en.docx` (+ `.md`, `.txt`) | The full reports |
| `run.json` | Every result, check and decision of the run (aggregate only) |
| `locked-plan.json` | The confirmed plan, including the full code and drug lists |
| `analyses/<plan>/…` | Figures and `result.json` per analysis |
| `plan-draft.json` | The plan as first drafted |

Full variable definitions (every ICD code, drug label and item id) of a run:

```bash
python3 scripts/export-variable-definitions.py <run folder>
```

## 6. Check that the installation works / 检查安装是否正常

```bash
python3 scripts/regression-planning.py --out /tmp/regression --only T1,P2     # plans two questions, compares with the snapshot
npm test                                                                       # about 830 tests, a few minutes
bash scripts/check-new-machine.sh                                              # setup state, tests and a planning check in one go (RUN_ONE=1 also answers one question)
```

On a new machine the first planning of a question with many aims can take 15 to 30 minutes because the model's translations and the mapping evidence are not cached yet; the script waits 15 minutes per question by default, so pass `--timeout 5400` the first time. In a fresh clone with empty caches every question matched the snapshot (0 worse).

`regression-planning.py` without `--only` plans every regression question (the planning batch, plus any extra question set placed beside it); it
exits with status 1 when a question got worse than `backend/src/validation-fixtures/planning-batch/snapshot.json`. When you test
another model, compare the output with the snapshot and with the 7B baseline in `questions.json`.
To accept a better outcome as the new reference, add `--update`.

## 7. Trying a different model / 换模型试用

Only the model changes; the methods, rules and numbers do not. Pull the model with Ollama, start the workspace with
`MIMIC_LOCAL_MODEL_PROFILE=<name>`, then run the regression planning set (`regression-planning.py`, section 6) and compare the plans
with the snapshot. A larger model reduces how often a plan needs correcting; it does not replace the plan confirmation step.

## 8. Problems and fixes / 常见问题

| Message or sign | Cause | Fix |
|---|---|---|
| `[todo] Ollama is not running` | The model server is not started | `ollama serve` (or open the Ollama app) |
| `[todo] model … is not installed` | Model not pulled | `ollama pull <model>` |
| Run fails at once with "Set MIMIC_LOCAL_ARCHIVE" | The path is not set for the server | Start with `MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip` |
| "Expected exactly one archive member" | The zip is not the official MIMIC-IV 3.1 layout | Use the unmodified PhysioNet zip |
| R step fails with a missing package | R package not installed | `Rscript scripts/install-r-packages.R` |
| Reports have no Word file | `.venv` missing | `bash scripts/setup-new-machine.sh` |
| Planning takes many minutes | A question with dozens of analyses maps every variable | Wait; a 28-analysis question can take 15 minutes with the 7B model |
| Port 9000 busy | Another workspace is running | Set `QUESTION_WORKSPACE_PORT` |

The held-out literature questions are in the repository: `backend/src/validation-fixtures/heldout-literature*/` (the frozen questions in
`benchmark.json`, described in each folder's `README.md`).
