#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
runtime_root="${project_root}/.venv"

# REPORT_PYTHON selects the interpreter when the default cannot create a venv with pip (e.g. some conda builds). The default is
# python3.12 when it is on PATH, else python3: only 3.12 is tested (scripts/setup-new-machine.sh refuses 3.13 and newer).
"${REPORT_PYTHON:-${commands[python3.12]:-python3}}" -m venv "${runtime_root}"
"${runtime_root}/bin/python3" -m pip install -r "${project_root}/requirements-report.txt"
"${runtime_root}/bin/python3" -c 'import docx, PIL, reportlab; print("Report runtime is ready.")'
