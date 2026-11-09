#!/usr/bin/env bash
# Prepares this repository on a fresh macOS or Linux machine (on Windows use WSL2 with Ubuntu).
# Checks the tools, installs the packages, builds the web page and checks the model, and tells you what is still missing:
# every [todo] line says in Chinese what is missing and how to fix it, and the line under it says the same in English.
# It never downloads MIMIC data and never writes credentials. Safe to run again.
#
#   MODEL=qwen2.5:32b-instruct-q4_K_M bash scripts/setup-new-machine.sh      # also pulls that model with Ollama
#   MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip bash scripts/setup-new-machine.sh
set -u
# A relative archive path names a file from the folder the script was started in; make it absolute before moving to the repository.
case "${MIMIC_LOCAL_ARCHIVE:-}" in ""|/*) ;; *) export MIMIC_LOCAL_ARCHIVE="$PWD/${MIMIC_LOCAL_ARCHIVE#./}" ;; esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$root"
. scripts/archive-check.sh
. scripts/python-check.sh
todo=0
say() { printf '%s\n' "$*"; }
good() { say "  [ok]   $*"; }
# fix CHINESE ENGLISH: one item the user has to act on, Chinese first (the same style as scripts/start-workspace.sh).
fix() { say "  [todo] $1"; say "         $2"; todo=$((todo + 1)); }
rerun="然后再运行本命令"; rerun_en="then run this command again"
# On Windows the tools are installed inside Ubuntu by the commands of the guide's "Install the tools" step, not from the Mac download sites.
tools_step_zh="Windows（WSL2）：重新运行安装指南里“安装工具”那一步里对应的命令，$rerun。"
tools_step_en="Windows (WSL2): run the matching command of the guide's \"Install the tools\" step again, $rerun_en."
# pip and the derived-layer packages come from PyPI; in mainland China the guide's mirror step must be done first.
mirror_zh="中国大陆请先完成安装指南里“国内网络”那一步的镜像设置"; mirror_en="in mainland China first do the guide's \"Mirrors for mainland China\" step"
# What testers send when a step fails: the error lines and the step name only, never counts or results (the client guides say the same).
feedback_zh="请把最后几行错误文字（通常以 Error 开头）和这一步的名字发给联系人；不要发含有人数或统计数字的行。"
feedback_en="Send the last few error lines (usually starting with Error) and the name of this step to your contact; leave out lines with patient counts or statistics."
# Printed before a step that runs for many minutes without output, so that nobody closes the window thinking it froze.
wait_line() { say "  $1… / $2…"; }
# pip's "new release available" notice tells people to run a command they do not need (and that fails on Homebrew's Python).
export PIP_DISABLE_PIP_VERSION_CHECK=1

say "1. 工具 / Tools"
# Node 22.13 or newer, and 23.4 or newer on Node 23: the workspace imports node:sqlite, which earlier versions keep behind
# --experimental-sqlite (package.json "engines" states the same).
if command -v node >/dev/null && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24 ? 0 : 1)'; then good "Node $(node -v)"
else
  found=""; found_en=""; if command -v node >/dev/null; then found="（现在是 $(node -v)）"; found_en=" (found $(node -v))"; fi
  fix "需要 Node 22.13 或更新版本$found（Node 23 需要 23.4 或更新）。Mac：从 https://nodejs.org 安装，打开一个新的终端窗口，$rerun。$tools_step_zh" \
    "Node 22.13 or newer is needed$found_en (Node 23 needs 23.4 or newer). Mac: install it from https://nodejs.org, open a new Terminal window, $rerun_en. $tools_step_en"
fi
# Python: only 3.12 is tested. python3.12 on PATH first, else python3 when it is 3.10-3.12; 3.13 and newer are refused
# (scripts/python-check.sh). The Python that comes with macOS is 3.9, and Homebrew's python3 is often 3.13 or 3.14.
python_ok=""
if python_pick; then python_ok=1; good "$("$python_command" --version 2>&1) ($python_command)"
else
  if [ -n "$python_found" ]; then found="现在是 $python_found"; found_en="found $python_found"; else found="没有找到 Python"; found_en="no Python found"; fi
  fix "需要 Python 3.12（$found；3.13 和 3.14 暂不支持）。Mac：下载并安装 https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg （国内可用 https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-macos11.pkg ），然后打开一个新的终端窗口，重新运行同一条安装命令。Windows（WSL2 Ubuntu 24.04）：sudo apt install -y python3 python3-venv python3-pip" \
    "Python 3.12 is needed ($found_en; 3.13 and 3.14 are not supported yet). Mac: download and install https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg (in mainland China: https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-macos11.pkg), then open a new Terminal window and run the same setup command again. Windows (WSL2 Ubuntu 24.04): sudo apt install -y python3 python3-venv python3-pip"
fi
if command -v Rscript >/dev/null; then good "$(Rscript --version 2>&1 | head -1)"
else fix "没有找到 R。Mac：从 https://cran.r-project.org 安装 R 4.3 或更新版本，打开一个新的终端窗口，$rerun。$tools_step_zh" "R is not installed. Mac: install R 4.3 or newer from https://cran.r-project.org, open a new Terminal window, $rerun_en. $tools_step_en"; fi
if command -v ollama >/dev/null; then good "Ollama $(ollama --version 2>&1 | tail -1)"
else fix "没有找到 Ollama。Mac：从 https://ollama.com 安装并打开 Ollama，$rerun。$tools_step_zh" "Ollama is not installed. Mac: install it from https://ollama.com and open it, $rerun_en. $tools_step_en"; fi

say "2. 软件包 / Packages"
if command -v npm >/dev/null; then
  wait_line "正在安装 npm 包并构建网页（通常几分钟，期间可能没有新文字，这是正常的，请不要关闭窗口）" \
    "Installing the npm packages and building the web page (usually a few minutes, possibly with no new text meanwhile; this is normal, keep the window open)"
  npm ci --silent && good "npm 包 / root npm packages" \
    || fix "npm 包没有装好（错误信息见上方）。请检查网络，$rerun。" "npm ci failed in the repository root (see the error above). Check the network, $rerun_en."
  (cd frontend/question-workspace-app && npm ci --silent && npm run build --silent >/dev/null) && good "网页已构建 / web page built (frontend/question-workspace/dist)" \
    || fix "网页没有构建成功（错误信息见上方）。请检查网络，$rerun。" "The web page did not build (see the error above). Check the network, $rerun_en."
fi
# .venv holds the report runtime and the derived-layer packages. A .venv whose Python is outside 3.10-3.12 or gone (for example one
# made by Homebrew's Python 3.14 or by the macOS Python 3.9), or that has no pip, is recreated with the Python chosen above. No pip:
# on WSL2 Ubuntu without python3-venv, `python3 -m venv` stops at ensurepip and leaves a .venv with Python but without pip; reused,
# it would fail every rerun at the report runtime with the network advice instead of the python3-venv one.
venv_ready() { [ -x .venv/bin/python3 ] && python_supported .venv/bin/python3 && .venv/bin/python3 -m pip --version >/dev/null 2>&1; }
venv_ok=""
if [ -n "$python_ok" ]; then
  if venv_ready; then venv_ok=1
  else
    [ -e .venv ] && say "  重建 .venv（它用的 Python 版本不受支持或已不存在，或它缺少 pip）/ Recreating .venv (its Python version is not supported or is missing, or it has no pip)"
    if "$python_command" -m venv --clear .venv && venv_ready; then venv_ok=1
    else fix "Python 虚拟环境 .venv 没有建成（错误信息见上方）。Windows（WSL2 Ubuntu）请运行：sudo apt install -y python3-venv ，$rerun。" \
      "The Python environment .venv could not be created (see the error above). On Windows (WSL2 Ubuntu) run: sudo apt install -y python3-venv , $rerun_en."; fi
  fi
fi
if [ -n "$venv_ok" ]; then
  .venv/bin/python3 -m pip install --quiet -r requirements-report.txt && .venv/bin/python3 -c 'import docx, PIL, reportlab' && good "报告组件 / report runtime (.venv)" \
    || fix "报告组件（Word/PDF）没有装好（错误信息见上方）。请检查网络；$mirror_zh，$rerun。" \
      "The report runtime (Word/PDF) did not install (see the error above). Check the network; $mirror_en, $rerun_en."
fi
# R prints pages of download and compiler text, so it is kept back and only its last lines are shown when the install fails.
if command -v Rscript >/dev/null; then
  wait_line "正在安装 R 包（约 10–20 分钟，期间没有新文字，这是正常的，请不要关闭窗口）" \
    "Installing R packages (about 10–20 minutes, with no new text meanwhile; this is normal, keep the window open)"
  if r_output="$(Rscript scripts/install-r-packages.R 2>&1)"; then good "R 包 / R packages"
  else
    printf '%s\n' "$r_output" | tail -n 20
    fix "R 包没有装好（错误信息见上方）。请检查网络，然后重新运行同一条安装命令。如果再次失败：$feedback_zh" \
      "The R packages did not install (see the error above). Check the network, then run the same setup command again. If it fails again: $feedback_en"
  fi
fi

say "3. 模型 / Model"
model="${MODEL:-${MIMIC_LOCAL_MODEL_PROFILE:-qwen2.5:7b-instruct-q4_K_M}}"
if command -v ollama >/dev/null; then
  # Never through a proxy: http_proxy/https_proxy/all_proxy (often set in mainland China) would intercept the local model.
  if ! curl -s --noproxy '*' http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    fix "Ollama 没有运行。请打开 Ollama 应用（或在另一个终端窗口运行 ollama serve），$rerun。" "Ollama is not running. Open the Ollama app (or run ollama serve in another Terminal window), $rerun_en."
  elif ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$model"; then good "模型 / model $model"
  elif [ -n "${MODEL:-}" ]; then ollama pull "$model" && good "已下载 / pulled $model" \
    || fix "模型 $model 没有下载成功（错误信息见上方）。请检查网络，$rerun。" "The model $model could not be pulled (see the error above). Check the network, $rerun_en."
  else fix "还没有安装模型 $model。请复制${install_step_zh}的整条命令（含 MODEL=…）再运行，或运行  ollama pull $model 。" \
    "The model $model is not installed. Copy the whole command of $install_step_en (including MODEL=…) and run it again, or run  ollama pull $model ."; fi
fi

say "4. 数据 / Data"
archive_ok=""
# The same checks and wording as scripts/start-workspace.sh (scripts/archive-check.sh). The archive is the one downloaded
# mimic-iv-3.1.zip (PhysioNet credentialed access); it is not part of this repository and never downloaded here.
if archive_check "${MIMIC_LOCAL_ARCHIVE:-}" install; then archive_ok=1; good "MIMIC-IV 数据包 / archive $MIMIC_LOCAL_ARCHIVE"
else fix "$archive_zh" "$archive_en"; fi

# pandas and numpy for the derived layer and the dictionary index, from requirements-derived.txt: installed at most once per run,
# with pip's errors shown. The first caller that finds them missing reports the pip failure, a later one points to it.
derived_packages_state=""
derived_packages() {
  if [ -z "$derived_packages_state" ]; then
    if .venv/bin/python3 -m pip install --quiet -r requirements-derived.txt; then derived_packages_state=ok
    else
      derived_packages_state=failed
      fix "pandas 和 numpy 没有装好（错误信息见上方）。请检查网络；$mirror_zh，$rerun。" \
        "pandas and numpy did not install (see the error above). Check the network; $mirror_en, $rerun_en."
      return 1
    fi
  fi
  [ "$derived_packages_state" = ok ] && return 0
  fix "这一项需要先装好上面的 pandas 和 numpy。" "This item needs pandas and numpy above first."; return 1
}
needs_python_zh="先处理上面 Python 那一项，然后重新运行同一条命令，这一项会自动完成"; needs_python_en="completes by itself once the Python item above is fixed and the same command is run again"

say "5. 衍生变量层 / Derived-variable layer（急性肾损伤、eGFR、再入院、SOFA、器官支持 / acute kidney injury, eGFR, readmission, SOFA, organ support）"
if [ -n "$archive_ok" ]; then
  derived="${MIMIC_LOCAL_ARCHIVE%.zip}-derived.zip"
  if [ -f "$derived" ]; then good "衍生变量层 / derived layer $derived"
  elif [ -n "${BUILD_DERIVED:-}" ] && [ -z "$venv_ok" ]; then fix "衍生变量层还没有建立：$needs_python_zh。" "The derived layer is not built: it $needs_python_en."
  elif [ -n "${BUILD_DERIVED:-}" ]; then
    if derived_packages; then
      wait_line "正在建立衍生变量层（约 10–30 分钟，期间可能很久没有新文字，这是正常的，请不要关闭窗口）" \
        "Building the derived-variable layer (about 10–30 minutes, possibly with no new text for a long time; this is normal, keep the window open)"
      # Its normal output (event counts per family) is not shown; its error text is kept back and only its last lines are shown on failure.
      if derived_errors="$(.venv/bin/python3 scripts/derived/build_derived.py --archive "$MIMIC_LOCAL_ARCHIVE" --out .local/derived 2>&1 >/dev/null)" \
        && cp .local/derived/"$(basename "$derived")" "$derived"; then good "已建立 / built $derived"
      else
        printf '%s\n' "$derived_errors" | tail -n 20
        fix "衍生变量层没有建成（错误信息见上方）。多数是内存不够：请关闭其他大型程序，然后重新运行同一条安装命令。如果再次失败：$feedback_zh" \
          "The derived layer did not build (see the error above). Usually memory ran out: close other large programs, then run the same setup command again. If it fails again: $feedback_en"
      fi
    fi
  else fix "衍生变量层还没有建立（约 10–30 分钟，只需一次）。请复制${install_step_zh}的整条命令（含 BUILD_DERIVED=1）再运行；在此之前，需要衍生变量的问题会停下并说明原因。" \
    "Build the derived layer once (about 10–30 minutes): copy the whole command of $install_step_en (including BUILD_DERIVED=1) and run it again (questions that need a derived variable stop with a message until then)."; fi
fi

say "6. 字典索引 / Dictionary index（所有化验项目、药品名称和编码的名称、数量和分布，供“变量”页面和定义核查使用 / names, counts and distributions of every laboratory item, drug label and code; used by the Variables page and the definition checks）"
index=".local/dictionary-index.json"
if [ -f "$index" ]; then good "字典索引 / dictionary index $index"
elif [ -n "$archive_ok" ] && [ -n "${BUILD_INDEX:-}" ] && [ -z "$venv_ok" ]; then fix "字典索引还没有建立：$needs_python_zh。" "The dictionary index is not built: it $needs_python_en."
elif [ -n "$archive_ok" ] && [ -n "${BUILD_INDEX:-}" ]; then
  if derived_packages; then
    wait_line "正在建立字典索引（约 10 分钟，期间可能很久没有新文字，这是正常的，请不要关闭窗口）" \
      "Building the dictionary index (about 10 minutes, possibly with no new text for a long time; this is normal, keep the window open)"
    # Its summary and its per-chunk progress lines are not shown; only the last lines of its error text are, on failure.
    if mkdir -p .local && index_errors="$(.venv/bin/python3 scripts/build-dictionary-index.py --archive "$MIMIC_LOCAL_ARCHIVE" --out "$index" 2>&1 >/dev/null)"; then
      good "已建立 / built $index"
    else
      printf '%s\n' "$index_errors" | tail -n 20
      fix "字典索引没有建成（错误信息见上方）。请重新运行同一条安装命令。如果再次失败：$feedback_zh" \
        "The dictionary index did not build (see the error above). Run the same setup command again. If it fails again: $feedback_en"
    fi
  fi
# BUILD_INDEX is set (the whole install command was run) but the archive check failed: the cause is the Data item, not a missing word.
elif [ -n "${BUILD_INDEX:-}" ]; then fix "字典索引还没有建立：需要先解决上面“数据”一项的问题。" "The dictionary index is not built: it needs the Data item above fixed first."
else fix "字典索引还没有建立（约 10 分钟，只需一次）。请复制${install_step_zh}的整条命令（含 MIMIC_LOCAL_ARCHIVE=… 和 BUILD_INDEX=1）再运行。没有它时\"变量\"页面和自动定义建议不可用，其余功能照常。" \
  "Build the dictionary index once (about 10 minutes): copy the whole command of $install_step_en (including MIMIC_LOCAL_ARCHIVE=… and BUILD_INDEX=1) and run it again (without it the Variables page and automatic definition proposals are off, and everything else runs)."; fi

say ""
if [ "$todo" -eq 0 ]; then
  # The start command carries the archive path, quoted so it can be pasted as it is. On a Mac it keeps the computer awake
  # (caffeinate), as the "Every time you use it" step of the Mac guide does.
  case "$MIMIC_LOCAL_ARCHIVE" in *[\"\$\`\\]*) quoted="$(printf '%q' "$MIMIC_LOCAL_ARCHIVE")" ;; *) quoted="\"$MIMIC_LOCAL_ARCHIVE\"" ;; esac
  awake=""; case "${OSTYPE:-}" in darwin*) awake="caffeinate -i env " ;; esac
  say "安装完成 / Ready. Setup is complete."
  say "启动工作台 / Start the workspace:"
  say ""
  say "  ${awake}MIMIC_LOCAL_ARCHIVE=$quoted bash scripts/start-workspace.sh"
  say ""
  # The same address as the started line of the server and both client guides. In WSL2 the Windows guide names localhost as the
  # fallback (WSL2 forwards it to the server's 127.0.0.1).
  say "等出现“工作台已启动”这一行后，在浏览器打开 http://127.0.0.1:9000 / When \"The workspace is running\" appears, open http://127.0.0.1:9000"
  grep -qi microsoft /proc/version 2>/dev/null && say "打不开时改用 http://localhost:9000 / If it does not open, use http://localhost:9000"
else say "上面有 $todo 项 [todo] 需要您处理；处理后再运行同一条命令，已经完成的数据和索引不会重建。/ $todo item(s) above need your action; run the same command again afterwards (the data layer and index already built are not rebuilt)."; fi
exit "$todo"
