# Sourced by scripts/start-workspace.sh and scripts/setup-new-machine.sh (bash); not run on its own.
#
# The two client-guide steps the scripts send people back to, by name: the step numbers differ between the Mac and the Windows
# guide (docs/client-guide/), so messages never use numbers. GUIDE_STEPS in backend/src/question-workspace/startup-checks.ts holds
# the same names.
install_step_zh="安装指南里“一条命令完成安装”那一步"; install_step_en="the guide's \"Install with one command\" step"
start_step_zh="安装指南里“每次使用”那一步"; start_step_en="the guide's \"Every time you use it\" step"
#
# archive_check PATH STEP
#   Returns 0 when PATH is a readable zip with hosp/ and icu/ folders (the MIMIC-IV archive). Otherwise sets archive_zh and
#   archive_en to the reason and the fix (Chinese, then English) and returns 1. STEP is "install" or "start": the guide step whose
#   whole command the "not set" message tells the user to copy. The unset, missing and folder messages are word for word those of
#   archiveProblem in backend/src/question-workspace/startup-checks.ts (backend/src/question-workspace/tests/startup-checks.test.ts
#   compares them).
#
# The archive must stay the one downloaded zip (it is read with unzip); a folder usually means Safari unzipped it.
archive_check() {
  local archive="$1" step_zh="$start_step_zh" step_en="$start_step_en" members
  if [ "$2" = install ]; then step_zh="$install_step_zh"; step_en="$install_step_en"; fi
  archive_zh=""; archive_en=""
  if [ -z "$archive" ]; then
    archive_zh="没有告诉平台 MIMIC 数据文件在哪里。请复制${step_zh}的整条命令（含 MIMIC_LOCAL_ARCHIVE=…）再运行。"
    archive_en="The platform was not told where the MIMIC data file is. Copy the whole command of $step_en (including MIMIC_LOCAL_ARCHIVE=…) and run it again."
  elif [ ! -e "$archive" ]; then
    archive_zh="找不到文件：$archive。请检查路径（macOS 可把 zip 文件拖进终端窗口得到准确路径）。请确认 mimic-iv-3.1.zip 在个人文件夹的 mimic 文件夹里（Windows：Ubuntu 里的 ~/mimic 文件夹，不是 C 盘），名字没有变成 mimic-iv-3.1 (1).zip。"
    archive_en="File not found: $archive. Check the path (on macOS, drag the zip file into the Terminal window to get the exact path). Make sure mimic-iv-3.1.zip is in the mimic folder of your home folder (Windows: ~/mimic inside Ubuntu, not drive C) and its name has not changed to mimic-iv-3.1 (1).zip."
  elif [ -d "$archive" ]; then
    archive_zh="$archive 是一个文件夹，不是 zip 文件。请保留下载的 mimic-iv-3.1.zip 原样、不要解压（Safari 可能已自动解压），并把路径指向这个 .zip 文件。如果 .zip 已经不在了，请在 Safari → 设置 → 通用 中取消勾选\"下载后打开‘安全的’文件\"，然后重新下载。"
    archive_en="$archive is a folder, not a zip file. Keep the downloaded mimic-iv-3.1.zip zipped (Safari may have unzipped it) and point to the .zip file. If the .zip is gone, turn off Safari → Settings → General → \"Open 'safe' files after downloading\" and download it again."
  elif ! command -v unzip >/dev/null; then
    # Without unzip every archive would look unreadable; name the missing tool instead of the download.
    archive_zh="没有找到 unzip 命令，无法读取 $archive。Windows（WSL2 Ubuntu）请运行：sudo apt install -y unzip ，然后再运行本命令。"
    archive_en="The unzip command is not installed, so $archive cannot be read. On Windows (WSL2 Ubuntu) run: sudo apt install -y unzip , then run this command again."
  elif ! members="$(unzip -l "$archive" 2>/dev/null)"; then
    archive_zh="$archive 不是可读取的 zip 文件（可能没有下载完整）。请从 PhysioNet 重新下载 mimic-iv-3.1.zip。"
    archive_en="$archive is not a readable zip file (the download may be incomplete). Download mimic-iv-3.1.zip from PhysioNet again."
  elif ! printf '%s\n' "$members" | grep -qE '[ /]hosp/' || ! printf '%s\n' "$members" | grep -qE '[ /]icu/'; then
    archive_zh="$archive 里没有 hosp/ 和 icu/ 文件夹，不是 MIMIC-IV 数据包。请使用从 PhysioNet 下载的 mimic-iv-3.1.zip。"
    archive_en="$archive has no hosp/ and icu/ folders, so it is not the MIMIC-IV archive. Use mimic-iv-3.1.zip downloaded from PhysioNet."
  else
    return 0
  fi
  return 1
}
