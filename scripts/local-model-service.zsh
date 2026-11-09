#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
shared_dir="${MIMIC_LOCAL_MODEL_DATA_DIR:-${HOME}/.mimic/local-model-service}"
state_file="${MIMIC_LOCAL_MODEL_STATE:-${shared_dir}/state.json}"
models_dir="${MIMIC_LOCAL_MODELS_DIR:-${HOME}/.mimic/local-models}"
pid_file="${MIMIC_LOCAL_MODEL_PID_FILE:-${state_file:h}/local-model-service.pid}"
base_url="${MIMIC_LOCAL_MODEL_BASE_URL:-http://127.0.0.1:11434/v1}"
default_model="${MIMIC_LOCAL_MODEL_DEFAULT:-llama3.1:8b-instruct-q4_K_M}"
menu_prompt="\n本地模型服务菜单（单模型策略，按次切换）\n1) 查看已下载模型\n2) 下载模型（先确认模型/许可证/大小）\n3) 启动本地服务\n4) 停止本地服务\n5) 切换默认模型（不下载）\n6) 健康检查\nq) 退出\n"

models_dir="${models_dir:A}"
state_file="${state_file:A}"
if [[ "${models_dir}" == "${repo_root}" || "${models_dir}" == "${repo_root}"/* || "${state_file}" == "${repo_root}" || "${state_file}" == "${repo_root}"/* ]]; then
  print -u2 -- "模型文件、缓存和服务状态必须位于仓库外公共目录。"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  print -u2 -- "缺少 jq；请先安装 (brew install jq)。"
  exit 1
fi

mkdir -p "${state_file:h}" "${models_dir}"

ensure_ollama() {
  if ! command -v ollama >/dev/null 2>&1; then
    print -u2 -- "未检测到 ollama 命令。请先安装本地服务/模型运行器（例如 brew install ollama）。"
    return 1
  fi
}

load_state() {
  if [[ -f "${state_file}" ]]; then
    jq -c . "${state_file}"
  else
    print -- '{"selected_model":"'"${default_model}"'","model_base_url":"'"${base_url}"'","approved":[]}'
  fi
}

save_state() {
  local selected_model="$1"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat >| "${state_file}" <<JSON
{
  "selected_model": "${selected_model}",
  "model_base_url": "${base_url}",
  "updated_at": "${now}"
}
JSON
}

list_downloaded() {
  print -- "已下载模型："
  if ollama list >/tmp/local-model-list.$$; then
    cat /tmp/local-model-list.$$ | awk 'NR>1 {print $1" "$2}'
    rm -f /tmp/local-model-list.$$
  else
    rm -f /tmp/local-model-list.$$
    print -- "无法读取 Ollama 模型清单。"
  fi
}

download_model() {
  local model_name="$1"
  local license_hint="Llama 3.1 Community License"
  local disk_hint="约 4.9 GiB（运行器缓存可能额外占用空间）"
  local approve

  case "${model_name}" in
    "") model_name="${default_model}";;
  esac

  if [[ "${model_name}" != "${default_model}" ]]; then
    print -u2 -- "首轮基准仅允许批准候选：${default_model}；不会自动下载其他模型。"
    return 1
  fi

  print -- "准备下载首轮 7B/8B 4-bit 基准候选：${model_name}"

  print -- "确认下载以下内容："
  print -- "  模型: ${model_name}"
  print -- "  许可证声明: ${license_hint}"
  print -- "  预估占用: ${disk_hint}"
  print -n "确认后将仅下载单一模型并写入 ${models_dir}（输入 yes 同意）："
  read -r approve
  if [[ "${approve}" != "yes" ]]; then
    print -- "已取消下载。"
    return
  fi

  ensure_ollama
  print -- "开始下载（无自动批量）：${model_name}"
  OLLAMA_MODELS="${models_dir}" ollama pull "${model_name}"
  print -- "下载完成。"
}

start_service() {
  local state selected
  state=$(load_state)
  selected=$(print "${state}" | jq -r '.selected_model // empty')
  if [[ -z "${selected}" ]]; then
    print -u2 -- "未设置默认模型。请先切换模型。"
    return
  fi
  ensure_ollama
  list_downloaded | grep -q "^${selected}" || {
    print -u2 -- "默认模型未在本地：${selected}"
    return
  }
  if [[ -f "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
    print -- "服务已在运行 (pid $(cat "${pid_file}"))。"
    return
  fi
  OLLAMA_MODELS="${models_dir}" nohup ollama serve >"${state_file:h}/local-model-service.log" 2>&1 &
  print "$!" >"${pid_file}"
  print -- "本地服务已启动（pid $!)，监听: ${base_url}"
  print -- "前端可设置：MIMIC_LOCAL_MODEL_ENABLED=enabled"
  print -- "        MIMIC_LOCAL_MODEL_PROFILE=${selected}"
  print -- "        MIMIC_LOCAL_MODEL_BASE_URL=${base_url}"
}

stop_service() {
  if [[ -f "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
    kill "$(cat "${pid_file}")"
    rm -f "${pid_file}"
    print -- "已停止本地服务。"
    return
  fi
  print -- "未检测到由本脚本启动的本地服务；不会触碰其他项目的 ollama 进程。"
}

switch_model() {
  local state current options=()
  local selected index
  state=$(load_state)
  current=$(print "${state}" | jq -r '.selected_model // "'"${default_model}"'"')
  options=($(ollama list | awk 'NR>1 {print $1}'))
  if (( ${#options} == 0 )); then
    print -u2 -- "未检测到可切换模型；请先下载。"
    return
  fi
  print -- "当前默认: ${current}"
  local idx=1
  for model in "${options[@]}"; do
    print -- "  ${idx}) ${model}"
    idx=$((idx + 1))
  done
  print -n "输入序号切换模型："
  read -r selected
  if [[ -z "${selected}" ]]; then
    return
  fi
  if ! [[ ${selected} == <-> ]] || (( selected < 1 || selected > ${#options[@]} )); then
    print -u2 -- "输入无效。"
    return
  fi
  save_state "${options[$((selected - 1))]}"
  print -- "默认模型已切换为：${options[$((selected - 1))]}"
}

health_check() {
  if curl -fsS "${base_url%/}/models" >/tmp/local-model-health.$$; then
    if jq -e '.data | type == "array"' /tmp/local-model-health.$$ >/dev/null 2>&1; then
      print -- "健康检查通过：${base_url} 可访问。"
    else
      print -u2 -- "返回内容不符合预期。"
    fi
    rm -f /tmp/local-model-health.$$
  else
    rm -f /tmp/local-model-health.$$
    print -u2 -- "健康检查失败：${base_url} 不可达。"
  fi
}

while true; do
  print -- "${menu_prompt}"
  print -n "请选择: "
  read -r choice
  case "${choice}" in
    1) list_downloaded ;;
    2)
      print -n "请输入模型名（留空则用默认）："
      read -r model_name
      download_model "${model_name}"
      ;;
    3) start_service ;;
    4) stop_service ;;
    5) switch_model ;;
    6) health_check ;;
    q|Q) print -- "退出"; break ;;
    *) print -u2 -- "无效选项" ;;
  esac
  print

done
