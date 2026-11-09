# Sourced by scripts/setup-new-machine.sh (bash, including the bash 3.2 of macOS); not run on its own.
#
# Only Python 3.12 is tested and recommended. 3.10 and 3.11 are accepted; 3.13 and newer are refused: on Python 3.14, pandas 2.2.3
# built from source against numpy 2 crashed the derived layer with a segmentation fault.
#
# python_minor COMMAND      prints "MAJOR.MINOR" of COMMAND's Python (from `COMMAND --version`); prints nothing and returns 1 when
#                           COMMAND does not run or does not report a Python version.
# python_supported COMMAND  returns 0 when COMMAND runs Python 3.10, 3.11 or 3.12.
# python_pick               sets python_command to python3.12 when it is on PATH and runs, else to python3 when that is 3.10-3.12,
#                           and returns 0; otherwise leaves python_command empty and returns 1. When python3.12 is not chosen,
#                           python_found is what python3 reports ("Python 3.14.7"), or empty when there is no working python3.
#                           python3 is not run at all when python3.12 is chosen (on a Mac without the command line developer
#                           tools, the system python3 opens an install dialog).
python_minor() {
  local text pattern='^Python ([0-9]+)\.([0-9]+)'
  text="$("$1" --version 2>&1)" || return 1
  [[ $text =~ $pattern ]] || return 1
  printf '%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
}

python_supported() {
  case "$(python_minor "$1")" in 3.10|3.11|3.12) return 0 ;; *) return 1 ;; esac
}

python_pick() {
  local text pattern='^Python [0-9][0-9.]*'
  python_command=""; python_found=""
  if command -v python3.12 >/dev/null && python_supported python3.12; then python_command=python3.12; return 0; fi
  if command -v python3 >/dev/null; then
    text="$(python3 --version 2>&1)"
    [[ $text =~ $pattern ]] && python_found="${BASH_REMATCH[0]}"
  fi
  if [ -n "$python_found" ] && python_supported python3; then python_command=python3; fi
  [ -n "$python_command" ]
}
