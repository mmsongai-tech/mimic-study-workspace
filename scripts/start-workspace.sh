#!/usr/bin/env bash
# Starts the MIMIC Study Workspace (the question workspace) on http://127.0.0.1:9000 with the model and archive you choose.
#   MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip MIMIC_LOCAL_MODEL_PROFILE=qwen2.5:32b-instruct-q4_K_M bash scripts/start-workspace.sh
# Results and reports are written to QUESTION_WORKSPACE_RUNS_DIR (default .local/question-workspace/runs).
# It first checks Node, the web page, the archive and the model, and stops with the fix (Chinese, then English).
set -eu
# A relative archive path names a file from the folder the script was started in; make it absolute before moving to the repository.
case "${MIMIC_LOCAL_ARCHIVE:-}" in ""|/*) ;; *) export MIMIC_LOCAL_ARCHIVE="$PWD/${MIMIC_LOCAL_ARCHIVE#./}" ;; esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$root"
export MIMIC_LOCAL_MODEL_PROFILE="${MIMIC_LOCAL_MODEL_PROFILE:-qwen2.5:7b-instruct-q4_K_M}"
export MIMIC_LOCAL_MODEL_BASE_URL="${MIMIC_LOCAL_MODEL_BASE_URL:-http://127.0.0.1:11434/v1}"
stop() { printf '\n[停止] %s\n[Stopped] %s\n\n' "$1" "$2" >&2; exit 1; }
# The archive checks and the guide step names are shared with scripts/setup-new-machine.sh (scripts/archive-check.sh). Messages
# send people to a step of the guide by name, never to a command they would have to put together themselves.
. scripts/archive-check.sh

# Node 22.13 or newer, and 23.4 or newer on Node 23: the workspace imports node:sqlite, which earlier versions keep behind
# --experimental-sqlite. package.json "engines" states the same.
command -v node >/dev/null || stop "没有找到 Node。请安装 Node 22.13 或更新版本（Mac：https://nodejs.org；Windows：安装指南里“安装工具”那一步的命令），再重新完成${install_step_zh}。" \
  "Node is not installed. Install Node 22.13 or newer (Mac: https://nodejs.org; Windows: the command of the guide's \"Install the tools\" step), then do $install_step_en again."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24 ? 0 : 1)' \
  || stop "Node 版本是 $(node -v)，需要 22.13 或更新版本（Node 23 需要 23.4 或更新）。Mac 请从 https://nodejs.org 安装新版本；Windows 请重新运行安装指南里“安装工具”那一步的 Node 命令。" "Node is $(node -v); 22.13 or newer is needed (Node 23 needs 23.4 or newer). Mac: install a newer version from https://nodejs.org; Windows: run the Node command of the guide's \"Install the tools\" step again."

page="${QUESTION_WORKSPACE_STATIC_ROOT:-frontend/question-workspace/dist}/index.html"
[ -f "$page" ] || stop "网页还没有构建（缺少 $page）。请先完成${install_step_zh}。" "The web page is not built ($page is missing). First complete $install_step_en."

archive="${MIMIC_LOCAL_ARCHIVE:-}"
archive_check "$archive" start || stop "$archive_zh" "$archive_en"

# The model service answers at the configured base URL and lists the configured model. The local model is never reached
# through a proxy: http_proxy/https_proxy/all_proxy are often set (for example in mainland China) and would intercept it.
model="$MIMIC_LOCAL_MODEL_PROFILE"; base="${MIMIC_LOCAL_MODEL_BASE_URL%/}"
models="$(curl -sf --noproxy '*' --max-time 10 "$base/models" 2>/dev/null)" || stop "Ollama 没有运行：连接不上本地模型服务（$base）。Mac：打开 Ollama 应用；Windows：另开一个 Ubuntu 窗口运行 ollama serve 并保持打开。然后重新启动。" \
  "Ollama is not running: the local model service ($base) is not reachable. Mac: open the Ollama app; Windows: run ollama serve in a second Ubuntu window and leave it open. Then start again."
printf '%s' "$models" | node -e 'let ids = []; try { ids = (JSON.parse(require("fs").readFileSync(0, "utf8")).data ?? []).map(({ id }) => id); } catch {} const want = process.argv[1]; process.exit(ids.includes(want) || ids.includes(`${want}:latest`) ? 0 : 1)' "$model" \
  || stop "Ollama 里没有模型 $model。请运行：ollama pull $model ，下载完成后重新启动。" "The model $model is not installed in Ollama. Run: ollama pull $model , then start again."

echo "模型 / Model: $model   数据 / Archive: $archive"
exec node --import tsx backend/src/entrypoints/question-workspace-server.ts
