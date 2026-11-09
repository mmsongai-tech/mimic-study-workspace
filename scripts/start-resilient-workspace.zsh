#!/bin/zsh
set -u

project_root="${0:A:h:h}"
restart_delay=1
child_pid=""
stopping=0

stop_workspace() {
  stopping=1
  if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
    kill -TERM "${child_pid}" 2>/dev/null || true
  fi
}

trap stop_workspace INT TERM
cd "${project_root}"

while (( stopping == 0 )); do
  node --import tsx backend/src/entrypoints/router-server.ts "$@" &
  child_pid=$!
  wait "${child_pid}"
  exit_code=$?
  child_pid=""
  if (( stopping != 0 )); then
    break
  fi
  print -u2 -- "Workspace process stopped with code ${exit_code}; restarting in ${restart_delay}s."
  sleep "${restart_delay}"
  if (( restart_delay < 30 )); then
    restart_delay=$(( restart_delay * 2 ))
    (( restart_delay > 30 )) && restart_delay=30
  fi
done

