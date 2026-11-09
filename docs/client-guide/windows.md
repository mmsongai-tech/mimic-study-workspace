# MIMIC 研究工作台 · Windows 安装和使用指南
# MIMIC Study Workspace · Guide for Windows

> 中文在前，English version below（向下滚动）。
> 本指南给不写代码的使用者：每一步只做一件事，照着复制粘贴即可。
> **推荐使用 Mac**（见解压文件夹里的 `source/docs/client-guide/macos.md`）。Windows 版通过 WSL2（Windows 自带的 Linux 子系统）运行，步骤更多。Windows 版是**试验版**：这些步骤尚未在真实 Windows 电脑上测试，遇到问题请随时反馈，这正是本次测试想发现的。

**排好版的指南（推荐在浏览器里看，不需要 GitHub 账号）：** https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/windows.md （打不开时直接按本文件操作即可，内容相同）

**如果您看到的是纯文本**（满屏的反引号和竖线 | 符号）：每条命令的上一行是三个反引号加 bash（或 powershell、ini），下一行是三个反引号，例如下面三行：

```bash
node -v
```

只复制中间的命令；反引号和 bash、powershell、ini 这些词永远不要复制。正文里用一个反引号括起来的命令（例如 `ollama list`）也一样：只复制反引号中间的文字。下文说的“灰色框”，在排好版的页面上是一个灰色方框，在纯文本里就是这样夹在中间的内容。

---

## 中文版

### 0. 先读这三条

1. **谁可以用：** 只有本人持有 PhysioNet 授权、可以使用 MIMIC-IV 的人。授权按人计算，不能借给别人用。
2. **数据和结果不能外传：** MIMIC-IV 数据、平台生成的结果、报告和结果截图，都**不能**上传到 ChatGPT、Kimi、豆包、DeepSeek 等在线 AI，也不能放进网盘或发到群里。只能给同样持有授权的人看。
3. **这是研究原型：** 结果是观察性数据中的关联，未经临床审核或外部验证，不能用于临床决策。

遇到任何问题，请联系：**Mingming Song（songm0428@gmail.com）**

### 1. 开始之前，检查这些（5 分钟）

| 项目 | 要求 |
|---|---|
| 系统 | Windows 11，或 Windows 10 22H2；需要**管理员权限**。医院统一管理的电脑常常不允许安装 WSL，请用个人电脑 |
| 虚拟化 | 按 `Ctrl + Shift + Esc` 打开任务管理器 → 性能 → CPU，右下方"虚拟化"应为"已启用"。未启用时需要在 BIOS 中打开，请找懂电脑的同事帮忙 |
| 内存 | 至少 16 GB；**推荐 32 GB**。16 GB 的电脑运行大问题时可能内存不足 |
| 硬盘 | 至少 60 GB 可用空间（固态硬盘更好） |
| 数据 | 您自己从 PhysioNet 下载的 `mimic-iv-3.1.zip`（约 10.6 GB）：用您本人的 PhysioNet 授权账号登录 https://physionet.org/content/mimiciv/3.1/ ，在页面下方 Files 里点 “Download the ZIP file” 下载这一个 zip 文件；以前用 wget 下载的文件夹不能用 |
| 时间 | 第一次安装约 2–4 小时，大部分时间是自动下载和编译，可以离开。之后每次启动约 1 分钟 |
| 电源 | 接通电源时电脑"从不"睡眠（设置方法见第 8 步）。电脑睡眠会中断正在运行的分析 |

### 2. 安装 WSL2 和 Ubuntu（约 20 分钟，需要重启）

1. 点开始菜单，输入 `PowerShell`，在"Windows PowerShell"上**点右键 → 以管理员身份运行**。
2. 粘贴下面的命令，按回车：

```powershell
wsl --install -d Ubuntu-24.04
```

如果卡住很久不动（国内网络常见），按 `Ctrl + C` 停止，改用这条：

```powershell
wsl --install --web-download -d Ubuntu-24.04
```

3. 提示重启时重启电脑。
4. 重启后从开始菜单打开 **Ubuntu 24.04**。第一次打开会让您设置用户名（小写英文）和密码。输入密码时屏幕上不显示字符，这是正常的；请记住这个密码。
5. **给 WSL 足够的内存：** 再打开一个普通的 PowerShell 窗口（不需要管理员），粘贴：

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

记事本提示新建文件时选"是"。写入下面两行（16 GB 的电脑写 `12GB`，32 GB 的电脑写 `24GB`），保存并关闭：

```ini
[wsl2]
memory=12GB
```

然后在 PowerShell 中运行下面这条命令，再重新打开 Ubuntu：

```powershell
wsl --shutdown
```

### 3. 认识"Ubuntu 终端"

之后的命令都在 **Ubuntu 24.04** 窗口里运行（开始菜单 → Ubuntu 24.04）：

- 复制本指南灰色框里的命令，在 Ubuntu 窗口里**点右键即可粘贴**，然后按回车。
- **一次只粘贴一个灰色框。** 等到最后一行重新出现您的用户名和电脑名、以 $ 结尾（例如 `xiaoming@DESKTOP-ABC:~/mimic$`），这一步才算结束，再进行下一步。
- 要求输入密码时，输入第 2 步设置的 Ubuntu 密码。

### 4. 国内网络：先设置镜像（在国内请做这一步，约 2 分钟）

在 Ubuntu 窗口里依次运行：

```bash
sudo sed -i 's@http://archive.ubuntu.com@https://mirrors.tuna.tsinghua.edu.cn@g; s@http://security.ubuntu.com@https://mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/ubuntu.sources
```

```bash
mkdir -p ~/.config/pip && printf '[global]\nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple\n' > ~/.config/pip/pip.conf
```

```bash
echo 'options(repos = c(CRAN = "https://mirrors.tuna.tsinghua.edu.cn/CRAN/"))' >> ~/.Rprofile
```

运行后没有任何提示（第一条可能先要求输入 Ubuntu 密码），就是成功了。

npm 的镜像在第 5 步装好 Node 之后设置。

AI 模型（约 4.7 GB）从 Ollama 官方下载。如果特别慢或失败，请联系我们获取离线模型文件。

### 5. 安装工具（约 30–60 分钟）

在 Ubuntu 窗口里依次运行：

```bash
sudo apt update && sudo apt install -y build-essential curl git unzip zip python3 python3-venv python3-pip r-base r-base-dev gfortran cmake libnlopt-dev zlib1g-dev libicu-dev libcurl4-openssl-dev libssl-dev libxml2-dev
```

安装 Node.js 22：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

如果上面这条在国内下载失败，改用国内镜像：

```bash
curl -fL https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node.tar.xz && sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
```

国内网络再设置 npm 镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

安装 Ollama（本地 AI 模型程序）：

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

检查版本：

```bash
node -v; python3 --version; Rscript --version; ollama --version
```

正常时应该看到（数字可以比例子更新）：

| 程序 | 正常的样子 |
|---|---|
| Node | `v22.13.0` 或更高，例如 `v22.14.0`（如果是 v23，需要 `v23.4` 或更高） |
| Python | `Python 3.12.x`，例如 `Python 3.12.3`。Ubuntu 24.04 自带 Python 3.12，不需要另外安装；只有 Python 3.12 经过测试，3.13 和 3.14 暂不支持 |
| R | `Rscript (R) version 4.x.x`，4.3 或更高 |
| Ollama | `ollama version is …`（一个版本号） |

显示 `command not found` 或 Ollama 的 `Warning` 时，见第 11 步的常见问题。

### 6. 放好两个文件

1. 在 Ubuntu 窗口里运行下面这条命令。它会建好 `mimic` 文件夹，并在 Windows 的文件资源管理器中打开它：

```bash
mkdir -p ~/mimic && cd ~/mimic && explorer.exe .
```

2. 把两个文件从"下载"文件夹拖进这个资源管理器窗口：
   - **MIMIC 数据文件** `mimic-iv-3.1.zip`：**不要解压，也不要改名。** 文件约 10.6 GB，复制需要几分钟。
   - **平台安装包：** 打开联系人发给您的 GitHub 发布页（Releases）链接（不需要 GitHub 账号），在 Assets 下面下载名字以 `-windows.zip` 结尾的文件。不要点绿色的 Code 按钮，也不要下载 "Source code (zip)"。GitHub 下载很慢时，请向联系人索取国内下载链接。如果您为了读这份指南已经在 Windows 里解压过，也没关系：仍然把下载的那个 zip 文件（不是解压出来的文件夹）拖进来，不用重新下载。
   - 文件一定要放在这个 Linux 文件夹里，不要放在 C 盘：从 C 盘读取数据会慢很多倍。
3. 回到 Ubuntu 窗口，解压平台安装包（只解压这一个；`Zone.Identifier` 之类的附带文件可以忽略）：

```bash
cd ~/mimic && unzip -q mimic-platform-*-windows.zip
```

### 7. 一条命令完成安装（约 1–3 小时，可以离开）

1. 进入平台文件夹（回车后，最后一行应以 `source$` 结尾）：

```bash
cd ~/mimic/mimic-platform-*/source
```

2. 粘贴下面这条命令（它会下载 AI 模型、安装需要的组件，并从数据中建好两个辅助文件）：

```bash
env MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" MODEL=qwen2.5:7b-instruct-q4_K_M BUILD_DERIVED=1 BUILD_INDEX=1 bash scripts/setup-new-machine.sh
```

- 每一项会显示 `[ok]`（完成）或 `[todo]`（还缺什么，以及怎么做）。
- 安装期间接上电源，电脑不要睡眠（见第 8 步的电源设置）。
- **有几段时间屏幕上不会出现新的文字，这是正常的，不要关闭窗口：** 安装 R 包约 10–20 分钟（R 组件在 Linux 上需要编译，第一次可能更久），建衍生变量层约 10–30 分钟，建字典索引约 10 分钟。
- 最后显示 **Ready** 就表示安装成功。
- 有 `[todo]` 时，按提示处理后再粘贴同一条命令；已经建好的数据层和索引不会重建。
- 如果提示 Ollama 没有运行：另开一个 Ubuntu 窗口，运行 `ollama serve` 并保持打开，再回来重新运行。

### 8. 每次使用

1. **运行分析期间电脑不能睡眠：** 打开 设置 → 系统 → 电源（笔记本叫"电源和电池"）→ 展开"屏幕和睡眠"（新版本叫"屏幕、睡眠和休眠超时"），把"接通电源"时的睡眠时间改为"从不"。Windows 10 在 设置 → 系统 → 电源和睡眠。接上电源，不要合上笔记本盖子。
2. 打开 Ubuntu 24.04，进入平台文件夹（最后一行应以 `source$` 结尾）：

```bash
cd ~/mimic/mimic-platform-*/source
```

3. 启动：

```bash
MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" bash scripts/start-workspace.sh
```

4. 等窗口里出现下面这一行，再打开浏览器（约 1 分钟）：

   工作台已启动：请在浏览器打开 http://127.0.0.1:9000 。使用期间不要关闭这个窗口，也不要让电脑休眠；用完按 Control + C 停止。

5. 在 Windows 的浏览器（Edge 或 Chrome）打开 **http://127.0.0.1:9000** ，看到"MIMIC 研究工作台"。打不开时改用 **http://localhost:9000** 。右上角可以切换中文和英文。
6. 使用期间**不要关闭这个 Ubuntu 窗口**，分析运行期间也一样。用完后在窗口里按 `Ctrl + C` 停止（上面那一行说的 Control 就是键盘上的 Ctrl 键）。
7. 如果提示 Ollama 没有运行，另开一个 Ubuntu 窗口，运行 `ollama serve` 并保持打开。

### 9. 怎么提问

本版本接受以下**六类**问题。提问页上有这六张卡片，点一下就会把格式填进输入框，把【】里的内容换成您的内容即可。

| 类型 | 格式 |
|---|---|
| 用药 vs 不用药 | 在【人群】中，使用【药物或药物类别】与不使用相比，【结局，如住院死亡】有何差异？ |
| 药物 A vs 药物 B | 在【人群】中，使用【药物 A】与使用【药物 B】相比，【结局】有何差异？ |
| 指标与结局 | 在【人群】中，【化验值、生命体征或评分，如入ICU首24小时乳酸】与【结局】有何关联？ |
| 指标的变化 | 在【人群】中，使用【药物】后【指标，如收缩压】在【时间段】内的变化，与不使用相比有何不同？ |
| 预测 | 在【人群】中，能否用【预测因素，如年龄、乳酸、肌酐】建立一个模型预测【结局】？ |
| 描述 | 描述【人群】的【特征，如年龄、性别、合并症】，（如需分组）按【分组，如性别】分组。 |

**本版本暂不支持：** 剂量-反应、亚组或性别是否改变疗效（交互作用）、中介分析。问题中含有这些部分时，平台会说明哪一部分暂不支持，其余部分会照常分析。只有需要那一部分时，才需要按页面上的原因改写问题后重新提交。

**提问建议：**

- 写清楚人群、药物或指标、结局，最好写上时间（如"入ICU首24小时"）。注意：用药等暴露默认只看最初 24 小时（可以在计划中改为 6–72 小时），写"住院期间"也按 24 小时处理。
- 一次问一个问题。
- 平台读不懂问题时，会请您从六类问题中选一类，再按格式填写。

**提问之后：**

1. 平台先制定**分析计划**。此时只查看数据的汇总情况（如某项化验有多少条记录），还没有挑选病人做分析。通常几分钟；启动后的第一个问题（模型要先加载）或较复杂的问题可能需要 10–15 分钟。
2. **请认真看计划：** 人群、药物、结局是否是您想要的；被翻译或找不到的名词会被标出。
3. 计划页上的时间窗、校正因素和分析方法是给您的选项，默认选的是较稳妥的设计。不确定时保留默认即可。
4. 不需要的分析可以取消勾选，然后点"确认并运行"。确认后可以关闭这个网页，分析会继续；但不要关闭终端窗口，也不要让电脑休眠或关机。（在 Windows 上，终端窗口就是 Ubuntu 窗口。）
5. 分析从几分钟到数小时不等，取决于问题的复杂程度。进度会显示在页面上。

**本次测试请不要勾选"跳过审核"，** 我们希望您看过计划再运行。

### 10. 怎么看结果

- 结果页按分析列出估计值和结果核查，以及患者流程、基线表、图、设计与变量。下载的报告里还有"解读边界"一节，说明结果能读到什么程度。
- 不可靠的估计不会给出数字，只显示原始人数。
- "自动核查通过"只表示计算过程通过了检查，**不代表变量一定选对了。** 请结合计划判断。
- 结果是**相关性**，不是因果，也不是治疗建议。
- 报告可以在页面上下载（中文或英文，Word、Markdown 或纯文本）。

**已知限制：**

- 年龄使用 MIMIC 的锚定年龄（anchor_age），可能与那次住院时的实际年龄相差数岁。
- 尿量为 0 mL 时按缺失处理。
- 部分商品名药物可能匹配不到。
- 预测模型只做了内部验证。
- 数据来自一家医院。

### 11. 常见问题

| 看到的情况 | 原因 | 怎么办 |
|---|---|---|
| 页面说"本地模型没有响应" | Ollama 没有运行，或模型没下载 | 另开 Ubuntu 窗口运行 `ollama serve`；运行 `ollama list`，确认列表中有 `qwen2.5:7b-instruct-q4_K_M` |
| 启动时提示数据文件找不到，或"是一个文件夹" | 路径不对，或压缩包被解压了 | 确认 `~/mimic/mimic-iv-3.1.zip` 存在（`ls ~/mimic`）且没有被解压 |
| 浏览器打不开 127.0.0.1:9000 | Ubuntu 窗口被关了，或启动出错 | 回到第 8 步重新启动，等窗口出现"工作台已启动"这一行再打开浏览器（也可以试 localhost:9000）；没出现就看窗口里的提示。还不行就在 PowerShell 运行 `wsl --shutdown`，重新打开 Ubuntu 再启动 |
| `$'\r': command not found` | 脚本被 Windows 编辑器改了换行格式 | 不要用 Windows 的编辑器打开脚本。运行 `sudo apt install -y dos2unix && dos2unix scripts/*.sh` |
| 运行时显示"出错"或 exit 1 | 多数是内存不够 | 关闭其他程序后重新运行；16 GB 电脑可能需要换到内存更大的电脑 |
| 电脑睡眠后分析失败 | 睡眠会停止 WSL | 按第 8 步关闭睡眠，然后重新运行这个问题 |
| 问题只做了一部分 | 有一部分属于本版本暂不支持的类型，或 MIMIC 中没有对应数据 | 看页面上的说明 |
| 安装时出现 `[todo]` | 某个组件还没装好 | 按那一行的提示处理，再运行第 7 步的命令 |
| 安装时 `[todo]` 说衍生变量层没有建成 | 多数是内存不够 | 检查第 2 步的内存设置，关闭其他程序，再运行第 7 步的命令。还不行，按第 12 步反馈：只发最后几行错误文字，不发含人数或统计数字的行 |
| `command not found`，前面是 `node`、`python3`、`Rscript` 或 `ollama` | 这个程序没装好 | 重新运行第 5 步里对应的安装命令，再检查版本 |
| `scripts/…: No such file or directory`（前面是 `scripts/…`） | 窗口不在 `source` 文件夹里 | 先运行第 7 步第 1 点的 `cd` 命令（最后一行应以 `source$` 结尾），再粘贴命令 |
| `ollama --version` 显示 `Warning: could not connect to a running Ollama instance` | Ollama 没有运行 | 另开一个 Ubuntu 窗口运行 `ollama serve` 并保持打开，再检查一次 |
| `npm warn` 等警告 | 正常的提示信息 | 可以忽略，只要最后显示 Ready |
| 终端显示 `[notice] A new release of pip is available` | pip 的版本提示 | 可以忽略，不要运行它建议的命令；只要最后显示 Ready |
| 启动时提示端口 9000 已被占用 | 已经有一个工作台在运行 | 关闭另一个正在运行工作台的 Ubuntu 窗口（或在那里按 `Ctrl + C`）；找不到时重启电脑 |

### 12. 反馈问题

请单独发邮件（私信）给：**Mingming Song（songm0428@gmail.com）**。不要发到群里或公开的地方。

**只发错误文字和这一步的名字：** 请把最后几行错误文字（通常以 Error 开头）和这一步的名字发给联系人；不要发含有人数或统计数字的行。

- 步骤的名字就是本指南的小标题，例如"一条命令完成安装"或"每次使用"。
- 请复制粘贴文字（在 Ubuntu 窗口里选中文字后按 `Ctrl + Shift + C` 复制），不要截图。

**也请写上：**

- 版本号：见解压文件夹里 `MANIFEST.txt` 的第一行。
- Windows 版本、内存大小。
- 网络环境：国内或国外，有没有使用代理。

**请不要发：** 人数、结果数字、结果表格、估计值、报告，或结果截图。安装时衍生变量层和字典索引打印的计数行也来自 MIMIC，同样不要发。

### 13. 数据安全

- 建议打开 BitLocker（设备加密）：设置 → 隐私和安全性 → 设备加密。
- 不要把 `mimic` 文件夹复制到 OneDrive、网盘或共享文件夹。
- `mimic-iv-3.1-derived.zip`、`source/.local` 文件夹里的内容都来自 MIMIC，规则与原始数据相同。
- **下载的报告和结果截图同样属于 MIMIC 结果：** 报告会下载到"下载"文件夹，截图常保存在桌面或"图片 → 屏幕截图"，而 OneDrive 可能会自动备份桌面、文档和图片文件夹。请把它们移到 `mimic` 文件夹（在 Ubuntu 窗口运行 `cd ~/mimic && explorer.exe .` 可以打开它）；不要用已开启云同步的 WPS（WPS 云文档）或 Word（OneDrive 自动保存）打开，先关闭云同步；测试结束后删除。
- 不要把结果粘贴到 Ollama 的聊天窗口（如果另外装了 Ollama 程序），也不要登录 ollama.com 使用在线模型。
- 测试结束后，可以删除 `source/.local/question-workspace/runs` 里的运行结果（`.local` 是隐藏文件夹，用 `ls -a` 才能看到）；更简单的做法是按“更新和卸载”那一步删除整个 `mimic-platform-…` 文件夹。

### 14. 更新和卸载

- **更新：**
  1. 把新版本安装包放进 `~/mimic`，用完整文件名解压，例如 `unzip -q mimic-platform-0.1.0-pilot.2-windows.zip`（文件夹里有两个安装包时，不能用 `*`）。
  2. 如需保留旧结果，运行 `cp -R ~/mimic/旧版本文件夹/source/.local ~/mimic/新版本文件夹/source/`（把两个文件夹名换成实际名字）。
  3. 删除旧版本文件夹（否则第 7、8 步的 `mimic-platform-*` 会匹配到两个文件夹）。
  4. 再运行一次第 7 步的命令。
- **卸载：** 在 Ubuntu 窗口删除 `~/mimic` 中不需要的文件。要删除整个 Ubuntu（包括里面的全部文件），可在 PowerShell 运行 `wsl --unregister Ubuntu-24.04`，**此操作无法恢复**。
  - 同时删除"下载"文件夹、桌面和"图片 → 屏幕截图"里的报告和结果截图。
  - 第 4、5 步设置的镜像会一直保留在 Ubuntu 里；删除整个 Ubuntu 时会一起删除。保留 Ubuntu 但不再需要镜像时，依次运行下面三条命令（没有设置过就不用运行）：

```bash
npm config delete registry
```

```bash
python3 -m pip config unset global.index-url
```

```bash
sed -i '/mirrors.tuna.tsinghua.edu.cn/d' ~/.Rprofile
```

Ubuntu 软件源的镜像（第 4 步第一条命令）不影响使用，可以保留。

### 15. 名词解释

| 名词 | 意思 |
|---|---|
| 分析计划 | 平台把问题翻译成人群、暴露、对照、结局和方法，运行前请您确认 |
| 暴露 | 要比较的因素，例如是否用药 |
| 结局 | 关心的结果，例如住院死亡 |
| OR / HR | 比值比 / 风险比，大于 1 表示风险更高，小于 1 表示更低 |
| RR（相对风险） | 暴露组的发生率除以对照组的发生率，大于 1 表示风险更高，小于 1 表示更低 |
| 风险差 | 两组发生率相减的差，0 表示没有差别 |
| AUC | 预测模型区分"会发生"和"不会发生"的能力，越接近 1 越好，0.5 相当于随机猜 |
| P 值 / 校正后 P | P 值：如果两组其实没有差别，碰巧看到这么大差别的可能性，越小越不像偶然。校正后 P：同时做多个比较时，为减少偶然"阳性"而调整过的 P 值 |
| 位置差（Hodges-Lehmann 中位数差） | 两组数值（例如住院天数）典型相差多少，适合不呈正态分布的数据 |
| 校正 | 在比较时考虑年龄、病情等差异 |
| 置信区间 | 估计值的不确定范围 |

---

## English version

**A Mac is recommended** (see `source/docs/client-guide/macos.md` in the unzipped folder). On Windows the platform runs inside WSL2, the Linux system built into Windows, and needs more steps. The Windows version is **experimental**: these steps have not yet been tested on a real Windows PC; please report anything that goes wrong, because that is what this test is for.

**Formatted guide (best read in a browser; no GitHub account needed):** https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/windows.md (if it does not open, follow this file; the content is the same)

**If you see plain text** (many backticks and | signs): each command has a line with three backticks and the word bash (or powershell, ini) above it and a line with three backticks below it, like these three lines:

```bash
node -v
```

Copy only the command in between; never copy the backticks or the words bash, powershell or ini. The same goes for a command inside single backticks in the text (for example `ollama list`): copy only what is between them. A "grey box" below is a grey box on the formatted page, and such lines in between in plain text.

### 0. Read these three rules first

1. **Who may use it:** only people who personally hold PhysioNet credentialed access to MIMIC-IV. Access is per person and cannot be shared.
2. **Data and results stay private:** never upload MIMIC-IV data, results, reports or screenshots of results to online AI tools (ChatGPT, Kimi, Doubao, DeepSeek and others), cloud drives or group chats. Share them only with credentialed people.
3. **Research prototype:** results are observational associations. They have not been reviewed by clinicians or validated externally, and must not be used for clinical decisions.

Contact for any problem: **Mingming Song (songm0428@gmail.com)**

### 1. Before you start (5 minutes)

| Item | Requirement |
|---|---|
| System | Windows 11 or Windows 10 22H2 with **administrator rights**. Hospital-managed PCs often block WSL; use a personal computer |
| Virtualization | Task Manager (`Ctrl + Shift + Esc`) → Performance → CPU must show "Virtualization: Enabled". If it is disabled it must be turned on in the BIOS; ask someone who knows computers |
| Memory | 16 GB minimum; **32 GB recommended**. Large questions may run out of memory on 16 GB |
| Disk | 60 GB free, SSD preferred |
| Data | Your own `mimic-iv-3.1.zip` from PhysioNet (about 10.6 GB): sign in with your own credentialed PhysioNet account, open https://physionet.org/content/mimiciv/3.1/ and, under Files at the bottom, click "Download the ZIP file" to get this single zip; a folder downloaded earlier with wget does not work |
| Time | First installation 2–4 hours, mostly unattended; about 1 minute to start afterwards |
| Power | The PC must never sleep when plugged in (how: step 8). Sleep interrupts a running analysis |

### 2. Install WSL2 and Ubuntu (about 20 minutes, one restart)

1. Open the Start menu, type `PowerShell`, right-click "Windows PowerShell" → **Run as administrator**.
2. Paste and press Enter:

```powershell
wsl --install -d Ubuntu-24.04
```

If it stays stuck for a long time (common on mainland-China networks), press `Ctrl + C` and use:

```powershell
wsl --install --web-download -d Ubuntu-24.04
```

3. Restart when asked.
4. Open **Ubuntu 24.04** from the Start menu and choose a user name (lower case) and a password. Nothing is shown while you type the password; remember it.
5. **Give WSL enough memory:** in a normal PowerShell window, paste:

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

Answer "Yes" to create the file. Write these two lines (`12GB` on a 16 GB PC, `24GB` on a 32 GB PC), then save and close:

```ini
[wsl2]
memory=12GB
```

Then run this command in PowerShell, and open Ubuntu again:

```powershell
wsl --shutdown
```

### 3. The Ubuntu window

All further commands run in the **Ubuntu 24.04** window.

- Copy one grey box at a time.
- **Right-click** in the Ubuntu window to paste it, then press Enter.
- Wait until the last line again shows your user and computer name and ends with $ (for example `xiaoming@DESKTOP-ABC:~/mimic$`); only then is the step finished and you can paste the next box.
- When asked for a password, use the Ubuntu password from step 2.

### 4. Mirrors for mainland China (about 2 minutes)

```bash
sudo sed -i 's@http://archive.ubuntu.com@https://mirrors.tuna.tsinghua.edu.cn@g; s@http://security.ubuntu.com@https://mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/ubuntu.sources
```

```bash
mkdir -p ~/.config/pip && printf '[global]\nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple\n' > ~/.config/pip/pip.conf
```

```bash
echo 'options(repos = c(CRAN = "https://mirrors.tuna.tsinghua.edu.cn/CRAN/"))' >> ~/.Rprofile
```

No output (the first one may ask for your Ubuntu password first) means it worked.

The npm mirror is set after Node is installed in step 5. The AI model (about 4.7 GB) downloads from Ollama; if that is very slow or fails, ask us for an offline copy.

### 5. Install the tools (30–60 minutes)

```bash
sudo apt update && sudo apt install -y build-essential curl git unzip zip python3 python3-venv python3-pip r-base r-base-dev gfortran cmake libnlopt-dev zlib1g-dev libicu-dev libcurl4-openssl-dev libssl-dev libxml2-dev
```

Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

If that fails in mainland China, use the domestic mirror instead:

```bash
curl -fL https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node.tar.xz && sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
```

In mainland China, set the npm mirror:

```bash
npm config set registry https://registry.npmmirror.com
```

Ollama (the local AI model program):

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Check:

```bash
node -v; python3 --version; Rscript --version; ollama --version
```

What "OK" looks like (your numbers may be newer than the examples):

| Program | OK |
|---|---|
| Node | `v22.13.0` or newer, for example `v22.14.0` (on v23, `v23.4` or newer) |
| Python | `Python 3.12.x`, for example `Python 3.12.3`. Ubuntu 24.04 comes with Python 3.12, so nothing else is needed; only Python 3.12 is tested, and 3.13 and 3.14 are not supported yet |
| R | `Rscript (R) version 4.x.x`, 4.3 or newer |
| Ollama | `ollama version is …` (a version number) |

For `command not found` or an Ollama `Warning`, see step 11.

### 6. Put the two files in place

1. This creates the `mimic` folder and opens it in Windows File Explorer:

```bash
mkdir -p ~/mimic && cd ~/mimic && explorer.exe .
```

2. Drag both files from Downloads into that Explorer window:
   - **The MIMIC data file** `mimic-iv-3.1.zip`: **do not unzip it and do not rename it.** Copying 10.6 GB takes a few minutes.
   - **The platform package** ending in `-windows.zip`: open the GitHub Releases link your contact sent you (no GitHub account needed) and download it under Assets. Do not use the green Code button or "Source code (zip)". If GitHub is slow, ask your contact for a domestic link. If you already unzipped it in Windows to read this guide, that is fine: still drag the downloaded zip file (not the unzipped folder) in; no need to download it again.
   - Keep both inside this Linux folder, not on drive C: reading the data from drive C is many times slower.
3. Back in Ubuntu, unzip the platform package only. Extra `Zone.Identifier` files can be ignored.

```bash
cd ~/mimic && unzip -q mimic-platform-*-windows.zip
```

### 7. Install with one command (1–3 hours, unattended)

1. Go to the platform folder (afterwards the last line should end with `source$`):

```bash
cd ~/mimic/mimic-platform-*/source
```

2. Paste:

```bash
env MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" MODEL=qwen2.5:7b-instruct-q4_K_M BUILD_DERIVED=1 BUILD_INDEX=1 bash scripts/setup-new-machine.sh
```

- Each item shows `[ok]` or `[todo]` with what to do.
- Keep the PC plugged in and awake while installing (power setting: step 8).
- **For some stretches no new text appears; that is normal, do not close the window:** R packages take about 10–20 minutes (on Linux they are compiled, so the first time can take longer), the derived layer about 10–30 minutes and the dictionary index about 10 minutes.
- **Ready** at the end means success.
- After fixing a `[todo]`, paste the same command again.
- If it says Ollama is not running, open a second Ubuntu window, run `ollama serve`, leave it open, and run the command again.

### 8. Every time you use it

1. **The PC must not sleep while an analysis runs:** open Settings → System → Power (on laptops "Power & battery") → expand "Screen and sleep" (newer versions: "Screen, sleep, & hibernate timeouts") and set the sleep time for "plugged in" to "Never". On Windows 10 it is Settings → System → Power & sleep. Keep it plugged in and do not close the laptop lid.
2. Open Ubuntu 24.04 and go to the platform folder (the last line should end with `source$`):

```bash
cd ~/mimic/mimic-platform-*/source
```

3. Start:

```bash
MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" bash scripts/start-workspace.sh
```

4. Wait for this line in the window before you open the browser (about 1 minute):

   The workspace is running: open http://127.0.0.1:9000 in your browser. Keep this window open and the computer awake while you use it; press Control + C to stop.

5. Open **http://127.0.0.1:9000** in Edge or Chrome on Windows. If it does not open, use **http://localhost:9000**. The language switch is at the top right.
6. **Keep the Ubuntu window open** while you work and while an analysis runs; press `Ctrl + C` in it to stop (the Control in the line above is the Ctrl key).
7. If it says Ollama is not running, run `ollama serve` in a second Ubuntu window and leave it open.

### 9. How to ask

This version accepts **six kinds** of questions. The question page shows them as cards; click one to put its format into the box, then replace the 【】 blanks.

| Kind | Format |
|---|---|
| Drug vs no drug | In 【population】, how does 【outcome, e.g. in-hospital death】 differ with versus without 【drug or drug class】? |
| Drug A vs drug B | In 【population】, how does 【outcome】 differ with 【drug A】 versus 【drug B】? |
| Measure and outcome | In 【population】, how is 【lab value, vital sign or score, e.g. lactate in the first 24 hours in the ICU】 associated with 【outcome】? |
| Change in a measure | In 【population】, how does the change in 【measure, e.g. systolic blood pressure】 over 【time period】 after 【drug】 differ from patients without it? |
| Prediction | In 【population】, can 【predictors, e.g. age, lactate, creatinine】 predict 【outcome】? |
| Description | Describe 【characteristics, e.g. age, sex, comorbidities】 of 【population】, optionally by 【grouping, e.g. sex】. |

**Not in this version:**

- dose-response;
- whether a subgroup or sex changes the effect (interaction);
- mediation.

When a question includes one of these, the platform says which part it cannot do, and the rest is analysed as usual. Rewrite and resubmit the question, following the reason on the page, only if you need that part.

**Tips:**

- State the population, the drug or measurement, the outcome, and ideally the time window (for example "in the first 24 hours in the ICU"). Note: drugs and other exposures default to the first 24 hours (adjustable to 6–72 hours in the plan), and "during the hospital stay" is also read as 24 hours.
- Ask one question at a time.
- If the platform cannot read a question, it asks you to pick one of the six kinds and fill in its format.

**After you ask:**

1. The platform drafts an **analysis plan**. At this point it only looks at summaries of the data (such as how many records a lab test has); it has not selected patients for analysis yet. Usually a few minutes; the first question after starting (the model has to load) or a complex one can take 10–15 minutes.
2. **Read the plan:** check that the population, drugs and outcome are what you meant. Translated or unmatched terms are marked.
3. The time windows, adjustment and method are choices for you. The defaults are the safer design; keep them if unsure.
4. Untick analyses you do not need, then press "Confirm and run". After confirming you can close this page and the analysis continues; but keep the terminal window open and do not let the computer sleep or shut down. (On Windows the terminal window is the Ubuntu window.)
5. An analysis takes from a few minutes to several hours, depending on the question. Progress is shown on the page.

**For this test, please do not tick "Skip review".**

### 10. Reading the results

- The results page shows, per analysis, the estimate and its checks, the patient flow, Table 1, figures, and the design and variables. The downloaded report also has a "How far to read it" section.
- Estimates that cannot be trusted show raw counts instead of a number.
- "Automatic checks passed" means the computation passed its checks. **It does not confirm that the variables were right.**
- Results are associations, not causes or treatment advice.
- Download reports from the page (Chinese or English; Word, Markdown or text).

**Known limits:**

- Age is MIMIC's anchor age (anchor_age), which can differ by a few years from the age at that admission.
- A urine output of 0 mL is treated as missing.
- Some brand-name drugs may not be matched.
- Prediction models are validated internally only.
- The data come from one hospital.

### 11. Problems and fixes

| What you see | Cause | Fix |
|---|---|---|
| "The local model did not respond" | Ollama is not running or the model is missing | Run `ollama serve` in a second Ubuntu window; `ollama list` must show `qwen2.5:7b-instruct-q4_K_M` |
| Start-up says the data file is missing or is a folder | Wrong path, or the zip was unzipped | Check with `ls ~/mimic` that `mimic-iv-3.1.zip` is there and still a zip |
| The browser cannot open 127.0.0.1:9000 | The Ubuntu window was closed or start-up failed | Start again (step 8) and wait for the "The workspace is running" line before opening the browser (also try localhost:9000); if it does not appear, read the message. If it still fails, run `wsl --shutdown` in PowerShell, reopen Ubuntu and start again |
| `$'\r': command not found` | A Windows editor changed a script's line endings | Do not edit scripts in Windows editors; run `sudo apt install -y dos2unix && dos2unix scripts/*.sh` |
| A run shows an error or "exit 1" | Usually not enough memory | Close other programs and run it again; a 16 GB PC may not be enough for large questions |
| A run failed after the PC slept | Sleep stops WSL | Turn sleep off as in step 8 and run the question again |
| Only part of a question was analysed | That part is a kind this version does not support, or MIMIC lacks the data | Read the explanation on the page |
| `[todo]` during installation | A component is missing | Follow that line, then rerun step 7 |
| A `[todo]` says the derived layer did not build | Usually not enough memory | Check the memory setting from step 2, close other programs and run the step 7 command again. If it still fails, report it as in step 12: only the last error lines, no lines with patient counts or statistics |
| `command not found` after `node`, `python3`, `Rscript` or `ollama` | The program is not installed | Run its install command from step 5 again, then check the versions |
| `scripts/…: No such file or directory` (preceded by `scripts/…`) | The window is not in the `source` folder | Run the `cd` command of step 7, item 1 first (the last line should end with `source$`), then paste the command |
| `ollama --version` shows `Warning: could not connect to a running Ollama instance` | Ollama is not running | Run `ollama serve` in a second Ubuntu window, leave it open and check again |
| `npm warn` messages | Normal notices | Ignore them if the script ends with Ready |
| `[notice] A new release of pip is available` | A pip version notice | Ignore it and do not run the command it suggests; what matters is that the script ends with Ready |
| Start-up says port 9000 is already in use | Another workspace is running | Close the other Ubuntu window that runs the workspace (or press `Ctrl + C` there); if you cannot find it, restart the PC |

### 12. Feedback

Send it privately, by email, to: **Mingming Song (songm0428@gmail.com)**. Do not post it in a group chat or anywhere public.

**Send only the error text and the step name:** Send the last few error lines (usually starting with Error) and the name of this step to your contact; leave out lines with patient counts or statistics.

- The step name is the heading in this guide, for example "Install with one command" or "Every time you use it".
- Copy and paste the text (in the Ubuntu window, select it and press `Ctrl + Shift + C`); do not send screenshots.

**Also include:**

- the version (first line of `MANIFEST.txt`);
- your Windows version and memory;
- your network (mainland China or not, proxy or not).

**Never send** patient counts, result numbers, result tables, estimates, reports or screenshots of results. The count lines that setup prints while building the derived layer and the dictionary index also come from MIMIC; do not send them either.

### 13. Keeping data safe

- We recommend turning on BitLocker (device encryption): Settings → Privacy & security → Device encryption.
- Do not copy the `mimic` folder to OneDrive, a cloud drive or a shared folder.
- `mimic-iv-3.1-derived.zip` and `source/.local` hold MIMIC-derived content, under the same rules as the data.
- **Downloaded reports and screenshots of results are MIMIC results too:** reports download to Downloads, screenshots are often saved on the Desktop or in Pictures → Screenshots, and OneDrive may back up the Desktop, Documents and Pictures folders. Move them into the `mimic` folder (run `cd ~/mimic && explorer.exe .` in Ubuntu to open it); do not open them in WPS (WPS cloud documents) or Word (OneDrive autosave) while cloud sync is on, turn the sync off first; delete them after the test.
- Never paste results into an Ollama chat window (if you also installed the Ollama app), and do not sign in to ollama.com to use online models.
- After the test, you may delete `source/.local/question-workspace/runs` (`.local` is hidden; `ls -a` shows it); simpler, delete the whole `mimic-platform-…` folder as in the "Updating and uninstalling" step.

### 14. Updating and uninstalling

- **Update:**
  1. Unzip the new package in `~/mimic` by its full name, e.g. `unzip -q mimic-platform-0.1.0-pilot.2-windows.zip` (with two packages in the folder, `*` does not work).
  2. To keep earlier results, run `cp -R ~/mimic/<old folder>/source/.local ~/mimic/<new folder>/source/`.
  3. Delete the old version's folder, so that `mimic-platform-*` matches one folder only.
  4. Rerun step 7.
- **Uninstall:** delete what you no longer need from `~/mimic` in Ubuntu. To remove Ubuntu and everything in it, run `wsl --unregister Ubuntu-24.04` in PowerShell. **This cannot be undone.**
  - Also delete reports and screenshots of results from Downloads, the Desktop and Pictures → Screenshots.
  - The mirror settings from steps 4 and 5 stay inside Ubuntu; removing Ubuntu removes them too. To keep Ubuntu but remove the mirrors, run these three commands one at a time (skip them if you never set the mirrors):

```bash
npm config delete registry
```

```bash
python3 -m pip config unset global.index-url
```

```bash
sed -i '/mirrors.tuna.tsinghua.edu.cn/d' ~/.Rprofile
```

The Ubuntu package mirror (the first command of step 4) does no harm and can stay.

### 15. Terms

| Term | Meaning |
|---|---|
| Analysis plan | The question translated into population, exposure, comparator, outcome and method; you confirm it before it runs |
| Exposure | What is compared, e.g. receiving a drug or not |
| Outcome | The result of interest, e.g. in-hospital death |
| OR / HR | Odds ratio / hazard ratio; above 1 means higher risk, below 1 lower |
| RR (relative risk) | The rate in the exposed group divided by the rate in the comparison group; above 1 means higher risk, below 1 lower |
| Risk difference | The rate in one group minus the rate in the other; 0 means no difference |
| AUC | How well a prediction model separates patients with and without the outcome; closer to 1 is better, 0.5 is a coin toss |
| P value / adjusted P | P value: if the groups did not really differ, the chance of seeing a difference this large anyway; the smaller, the less likely it is chance. Adjusted P: a P value corrected for making several comparisons at once, to reduce chance "positives" |
| Location shift (Hodges-Lehmann median difference) | How far apart two groups' values (for example length of stay) typically are; suited to data that are not normally distributed |
| Adjustment | Taking differences such as age or severity into account |
| Confidence interval | The uncertainty range of an estimate |
