# Running the platform on a new Windows computer (WSL2 + Ubuntu) / 在新的 Windows 电脑上运行（WSL2 + Ubuntu）

The platform runs inside WSL2 (a Linux system built into Windows). Everything below happens in one Ubuntu terminal except step 1; the web page is opened in the normal Windows browser.
平台在 WSL2（Windows 自带的 Linux 子系统）里运行。除第 1 步外，下面的命令都在 Ubuntu 终端里执行；网页用 Windows 上的普通浏览器打开。

These steps were written for Windows 10 22H2 / Windows 11 with Ubuntu 24.04 in WSL2. They have not been run on a Windows machine by the authors (the platform was built and tested on macOS and in fresh Linux-style checkouts); report anything that does not work.
本说明按 Windows 10 22H2 / Windows 11 + WSL2 中的 Ubuntu 24.04 编写，作者没有在 Windows 上实际跑过（平台在 macOS 和全新克隆中测试过），遇到问题请记录下来。

**Data / 数据：** this package contains no MIMIC data. You need your own `mimic-iv-3.1.zip` from PhysioNet (credentialed access). Do not upload it, or anything derived from it, to online AI services: the PhysioNet data use agreement does not allow it. 本包不含 MIMIC 数据，请自备；不要上传到在线 AI 服务。

## What the computer needs / 硬件要求

| Item | Minimum | Better |
|---|---|---|
| Windows | 10 22H2 or 11, administrator rights, virtualization on in BIOS | Windows 11 |
| Memory | 16 GB (give WSL at least 12 GB) | 32 GB or more |
| Disk | 40 GB free inside WSL (archive 10.6 GB, derived layer, runs, packages) | SSD with 80 GB free |
| Model | 8 GB of free memory for the 7B model | an NVIDIA GPU with 16–24 GB for a 14B–32B model |

## 1. Install WSL2 and Ubuntu (Windows PowerShell as administrator) / 安装 WSL2

```powershell
wsl --install -d Ubuntu-24.04
```
Restart when asked, open "Ubuntu 24.04" from the Start menu and create a Linux user name and password.

Give WSL enough memory: create the file `%UserProfile%\.wslconfig` (for example `C:\Users\<you>\.wslconfig`) with
```ini
[wsl2]
memory=12GB
processors=8
```
(more memory if the computer has it), then run `wsl --shutdown` in PowerShell and open Ubuntu again. An analysis holds one full scan of a large MIMIC table in memory, so less than 12 GB may crash the run.

With an NVIDIA GPU: install the normal Windows NVIDIA driver only; do not install a GPU driver inside Ubuntu. WSL2 uses the Windows driver.

## 2. Install the tools (Ubuntu terminal) / 安装工具

```bash
sudo apt update
sudo apt install -y build-essential curl git unzip zip python3 python3-venv python3-pip \
  r-base r-base-dev gfortran cmake libnlopt-dev zlib1g-dev libicu-dev \
  libcurl4-openssl-dev libssl-dev libxml2-dev
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
# Ollama (local language model server)
curl -fsSL https://ollama.com/install.sh | sh
```
Check: `node -v` (22.13 or newer), `R --version` (4.3 or newer), `python3 --version` (3.12; Ubuntu 24.04 has it), `ollama --version`.
If `ollama list` says it cannot connect, start the server in a second Ubuntu terminal with `ollama serve` and leave it open.

## 3. Put the package and the data inside Linux / 把包和数据放进 Linux

Keep everything in the Linux file system (`~/...`), not under `/mnt/c/...`: reading the 10 GB archive from the Windows drive is many times slower.

```bash
mkdir -p ~/mimic && cd ~/mimic
# copy the files in from Windows, for example from Downloads:
cp /mnt/c/Users/<you>/Downloads/mimic-platform-*-windows.zip .
cp /mnt/c/Users/<you>/Downloads/mimic-iv-3.1.zip .          # your own credentialed copy
unzip mimic-platform-*-windows.zip
cd mimic-platform-*-windows/source
```

## 4. Install the platform / 安装平台

```bash
export MIMIC_LOCAL_ARCHIVE=~/mimic/mimic-iv-3.1.zip
bash scripts/setup-new-machine.sh                               # lists what is still missing as [todo]
MODEL=qwen2.5:7b-instruct-q4_K_M bash scripts/setup-new-machine.sh   # also pulls the baseline model
BUILD_DERIVED=1 bash scripts/setup-new-machine.sh               # builds the derived layer once (about 15 minutes)
BUILD_INDEX=1 bash scripts/setup-new-machine.sh                 # builds the dictionary index once (one pass over the large tables)
```
Run the script again until it prints "Ready". On Linux the R packages are compiled from source (the `gfortran`, `cmake` and `libnlopt-dev` above are for glmnet and the mixed-model packages that `mediation` needs), which can take 20–40 minutes the first time. They go into your personal R library (`~/R/...`) when the system one is not writable, so no `sudo` is needed.

## 5. Start and use it / 启动和使用

```bash
bash scripts/start-workspace.sh        # keep this terminal open
```
Open http://localhost:9000 in the Windows browser (WSL2 forwards localhost). In a second Ubuntu terminal:
```bash
cd ~/mimic/mimic-platform-*-windows/source
export MIMIC_LOCAL_ARCHIVE=~/mimic/mimic-iv-3.1.zip
bash scripts/check-new-machine.sh                  # tests, setup state, a planning check; RUN_ONE=1 also answers one question
```
Planning usually takes a few minutes; the first question after starting (the model has to load) or a complex one can take 10–15 minutes.

To use a larger model: `ollama pull <model>` and start the workspace with `MIMIC_LOCAL_MODEL_PROFILE=<model> bash scripts/start-workspace.sh`.

## Known differences on Windows / Windows 上要注意的

- Line endings: do not open and save the scripts with a Windows editor that converts them to CRLF; a shell script with CRLF fails with `$'\r': command not found`. If it happens: `sudo apt install -y dos2unix && dos2unix scripts/*.sh`.
- If the browser cannot reach `localhost:9000`, run `wsl --shutdown` in PowerShell, open Ubuntu again and restart the workspace. The server listens on 127.0.0.1 only, so the WSL network address does not work.
- Sleep or hibernate stops WSL; a run in progress is then marked failed and can be started again.
