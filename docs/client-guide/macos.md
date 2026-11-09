# MIMIC 研究工作台 · Mac 安装和使用指南
# MIMIC Study Workspace · Guide for Mac

> 中文在前，English version below（向下滚动）。
> 本指南给不写代码的使用者：每一步只做一件事，照着复制粘贴即可。推荐使用 Mac；Windows 版见解压文件夹里的 `source/docs/client-guide/windows.md`。

**排好版的指南（推荐在浏览器里看，不需要 GitHub 账号）：** https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/macos.md （打不开时直接按本文件操作即可，内容相同）

**如果您看到的是纯文本**（满屏的反引号和竖线 | 符号）：每条命令的上一行是三个反引号加 bash，下一行是三个反引号，例如下面三行：

```bash
node -v
```

只复制中间那一行命令；反引号和 bash 这个词永远不要复制。正文里用一个反引号括起来的命令（例如 `ollama list`）也一样：只复制反引号中间的文字。下文说的“灰色框”，在排好版的页面上是一个灰色方框，在纯文本里就是这样夹在中间的一行。

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
| 电脑 | Mac（Apple 芯片或 Intel 均可），macOS 14（Sonoma）或更新。查看方法：左上角苹果菜单 → 关于本机 |
| 内存 | 至少 16 GB；运行分析时请关闭其他大型程序。32 GB 更稳 |
| 硬盘 | 至少 50 GB 可用空间 |
| 权限 | 安装软件需要电脑开机密码（管理员权限）。医院统一管理的电脑可能装不了，请先问信息科 |
| 数据 | 您自己从 PhysioNet 下载的 `mimic-iv-3.1.zip`（约 10.6 GB）：用您本人的 PhysioNet 授权账号登录 https://physionet.org/content/mimiciv/3.1/ ，在页面下方 Files 里点 “Download the ZIP file” 下载这一个 zip 文件；以前用 wget 下载的文件夹不能用 |
| 时间 | 第一次安装约 1–3 小时，大部分时间是自动下载和构建，可以离开。之后每次启动约 1 分钟 |
| 网络 | 能上网。国内网络请看第 5 步的镜像设置 |
| 电源 | 安装和运行时接上电源，不要合上笔记本盖子 |

### 2. 认识"终端"

本指南用到 Mac 自带的"终端"（Terminal）程序：

- **打开：** 按 `Command + 空格`，输入"终端"或 `Terminal`，回车。
- **粘贴命令：** 复制本指南灰色框里的命令，在终端窗口里按 `Command + V`，再按回车。**一次只粘贴一个灰色框。**
- 等到最后一行重新出现您的电脑名、以 % 结尾（例如 `xiaoming@MacBook-Pro source %`），这一步才算结束，再进行下一步。
- 输入密码时屏幕上不会显示任何字符，这是正常的。

### 3. 放好两个文件

1. 在访达（Finder）中按 `Shift + Command + H` 打开个人文件夹，按 `Shift + Command + N` 新建一个文件夹，命名为 `mimic`（全小写，不要空格）。
   请不要放在"桌面"或"文稿"里：这两个位置如果开了 iCloud 同步，会把数据传到云端。
2. **MIMIC 数据文件：** 把 `mimic-iv-3.1.zip` 放进 `mimic` 文件夹。
   - **不要解压它，也不要改名。** 平台直接读取这个压缩包。
   - 用 Safari 下载时，Safari 可能自动解压。请先关闭：Safari → 设置（旧版 macOS 叫"偏好设置"）→ 通用 → 取消勾选"下载后打开‘安全的’文件"。如果已经被解压成文件夹，请重新下载压缩包。
3. **平台安装包：** 如果您正在读这份文件，说明安装包已经下载并解压过了：把解压出来的整个 `mimic-platform-…-macos` 文件夹拖进 `mimic` 文件夹即可，不用重新下载，下载文件夹里的 zip 可以删除。还没有下载时：打开联系人发给您的 GitHub 发布页（Releases）链接（不需要 GitHub 账号），在 Assets 下面下载名字以 `-macos.zip` 结尾的文件。不要点绿色的 Code 按钮，也不要下载 "Source code (zip)"。把它放进 `mimic` 文件夹，然后**双击解压**。
   - 平台安装包需要解压，MIMIC 数据文件不要解压，请区分这两个文件。
   - GitHub 下载很慢时，请向联系人索取国内下载链接。
4. 解压后得到一个以 `mimic-platform` 开头的文件夹，里面有 `source` 文件夹和本指南。

### 4. 安装四个软件（约 20–30 分钟）

全部从官方网站下载安装包，双击安装。安装时会要求输入电脑开机密码。网页上如果有命令，不要复制，只下载安装包。

| 软件 | 下载地址 | 选择 |
|---|---|---|
| Node.js | https://nodejs.org | 点首页的 "Get Node.js®" 按钮，在下载页点 "macOS Installer (.pkg)"（默认就是 LTS 版本） |
| Python | 直接下载：https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg （国内可用 https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-macos11.pkg ） | **只用 Python 3.12**，见表格下方 |
| R | https://cran.r-project.org/bin/macosx/ | 左上角苹果菜单 → 关于本机：写"芯片 Apple M…"选 `arm64`，写"处理器 Intel…"选 `x86_64` |
| Ollama | https://ollama.com/download | macOS 版：点 "Download manually"（不要复制页面上的命令）。安装后打开它，屏幕顶部菜单栏会出现一个羊驼图标。第一次打开如提示安装命令行工具（command line），请点安装并输入开机密码 |

**Python 只能用 3.12：**

- 只有 Python 3.12 经过测试，推荐使用。上面的链接直接下载 Python 3.12.10 的 Mac 安装包。也可以打开发布页 https://www.python.org/downloads/release/python-31210/ ，在页面下方的文件列表里点 "macOS 64-bit universal2 installer"。
- python.org 首页推荐的 3.13、3.14 暂不支持，请不要用。python.org 上更新的 3.12 版本没有 Mac 安装包，3.12.10 是最后一个有安装包的，所以用它。
- Mac 自带的 Python 太旧，不能用。
- 输入 `python3` 时如果弹出窗口，说需要安装命令行开发者工具，请点"取消"，先按上面的链接装好 Python 3.12。

装完后**关闭终端，再重新打开一个**，然后粘贴下面这条命令检查版本：

```bash
node -v; python3 --version; Rscript --version; ollama --version
```

正常时应该看到（数字可以比例子更新）：

| 程序 | 正常的样子 |
|---|---|
| Node | 只看 v 后面的第一个数字：22（第二个数字至少 13）、24、25、26 或更大都可以，例如 `v22.13.0`、`v24.11.1`、`v26.7.0`（如果是 v23，需要 `v23.4` 或更高） |
| Python | `Python 3.12.x`，例如 `Python 3.12.10` |
| R | `Rscript (R) version 4.x.x`，4.3 或更高 |
| Ollama | `ollama version is …`（一个版本号） |

- 如果 Python 显示 `3.13` 或 `3.14`：按上面的链接安装 3.12，打开一个新的终端窗口，再检查一次，应显示 `Python 3.12.x`。如果仍是 3.13 或 3.14，再运行 `python3.12 --version`：显示 `Python 3.12.x` 也可以继续，安装命令会自动用它。
- 如果 Python 显示 `3.9`：请关闭终端，打开一个新的终端窗口再检查；还不行，请联系我们。
- 显示 `command not found` 或 Ollama 的 `Warning`：见第 10 步的常见问题。

在国内的话，接着做第 5 步设置镜像。

### 5. 国内网络：设置镜像（在国内请做这一步，约 2 分钟）

装好 Node、Python 和 R 之后，在终端里依次运行下面三条命令，各粘贴一次：

```bash
npm config set registry https://registry.npmmirror.com
```

```bash
python3 -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

```bash
echo 'options(repos = c(CRAN = "https://mirrors.tuna.tsinghua.edu.cn/CRAN/"))' >> ~/.Rprofile
```

运行后没有任何提示，或只显示一行 `Writing to …`，就是成功了。

AI 模型（约 4.7 GB）从 Ollama 官方下载。如果特别慢或失败，请联系我们获取离线模型文件。

### 6. 一条命令完成安装（约 1–2 小时，可以离开）

1. 进入平台文件夹：在终端输入 `cd`，再输入一个空格，然后从访达把 `source` 文件夹拖进终端窗口，按回车。回车后，最后一行应以 `source %` 结尾；不是的话，请重做这一步。
2. 粘贴下面这条命令（它会下载 AI 模型、安装需要的组件，并从数据中建好两个辅助文件）：

```bash
caffeinate -i env MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" MODEL=qwen2.5:7b-instruct-q4_K_M BUILD_DERIVED=1 BUILD_INDEX=1 bash scripts/setup-new-machine.sh
```

- 开头的 `caffeinate -i` 让 Mac 在安装期间不休眠。请接上电源，不要合上笔记本盖子。
- 每一项会显示 `[ok]`（完成）或 `[todo]`（还缺什么，以及怎么做）。
- **有几段时间屏幕上不会出现新的文字，这是正常的，不要关闭窗口：** 安装 R 包约 10–20 分钟，建衍生变量层约 10–30 分钟，建字典索引约 10 分钟。
- 最后显示 **Ready** 就表示安装成功。
- 有 `[todo]` 时，按提示处理后再粘贴同一条命令；已经建好的数据层和索引不会重建。

### 7. 每次使用

1. 打开 Ollama，确认菜单栏有羊驼图标。
2. 接上电源。分析运行期间**不要合上笔记本盖子**，也不要关闭终端窗口。
3. 打开终端，用第 6 步的方法 `cd` 进入 `source` 文件夹（最后一行应以 `source %` 结尾）。
4. 粘贴（开头的 `caffeinate -i` 让 Mac 在使用期间不休眠）：

```bash
caffeinate -i env MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" bash scripts/start-workspace.sh
```

5. 等终端里出现下面这一行，再打开浏览器（约 1 分钟）：

   工作台已启动：请在浏览器打开 http://127.0.0.1:9000 。使用期间不要关闭这个窗口，也不要让电脑休眠；用完按 Control + C 停止。

6. 在浏览器打开 **http://127.0.0.1:9000** ，看到"MIMIC 研究工作台"。右上角可以切换中文和英文。
7. 使用期间**不要关闭这个终端窗口**。用完后在终端按 `Control + C` 停止；最后一行重新以 `source %` 结尾，就表示已经停止。

### 8. 怎么提问

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
4. 不需要的分析可以取消勾选，然后点"确认并运行"。确认后可以关闭这个网页，分析会继续；但不要关闭终端窗口，也不要让电脑休眠或关机。
5. 分析从几分钟到数小时不等，取决于问题的复杂程度。进度会显示在页面上。

**本次测试请不要勾选"跳过审核"，** 我们希望您看过计划再运行。

### 9. 怎么看结果

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

### 10. 常见问题

| 看到的情况 | 原因 | 怎么办 |
|---|---|---|
| 页面说"本地模型没有响应" | Ollama 没打开，或模型没下载 | 打开 Ollama；在终端运行 `ollama list`，确认列表中有 `qwen2.5:7b-instruct-q4_K_M` |
| 启动时提示数据文件找不到，或"是一个文件夹" | 路径不对，或压缩包被解压了 | 确认 `~/mimic/mimic-iv-3.1.zip` 存在且没有被解压 |
| 浏览器打不开 127.0.0.1:9000 | 终端窗口被关了，或启动出错 | 回到第 7 步重新启动，等终端出现"工作台已启动"这一行再打开浏览器；没出现就看终端里的提示 |
| 运行时显示"出错"或 exit 1 | 多数是内存不够 | 关闭其他程序后重新运行这个问题 |
| 电脑休眠或合上盖子后，分析中断或显示可能已停止 | 休眠会停止分析 | 接上电源、不要合盖，按第 7 步重新启动，再重新运行这个问题 |
| 问题只做了一部分 | 有一部分属于本版本暂不支持的类型，或 MIMIC 中没有对应数据 | 看页面上的说明 |
| 安装时出现 `[todo]` | 某个组件还没装好 | 按那一行的提示处理，再运行第 6 步的命令 |
| 安装时 `[todo]` 说需要 Python 3.12 | 现在用的是 3.13、3.14，或太旧的版本 | 按第 4 步的链接安装 Python 3.12，打开一个新的终端窗口，再运行第 6 步的同一条命令 |
| 安装时 `[todo]` 说衍生变量层没有建成 | 多数是内存不够 | 关闭其他大型程序，再运行第 6 步的同一条命令。还不行，按第 11 步反馈：只发最后几行错误文字，不发含人数或统计数字的行 |
| `command not found: node`（或 `python3`、`Rscript`、`ollama`） | 这个程序没装好，或终端是装软件之前打开的 | 按第 4 步安装；装完关闭终端，打开一个新的终端窗口再试 |
| `scripts/…: No such file or directory`（前面是 `scripts/…`） | 终端不在 `source` 文件夹里 | 按第 6 步第 1 点重新 `cd` 进入 `source`（最后一行应以 `source %` 结尾），再粘贴命令 |
| 输入 `python3` 时弹出窗口，说需要安装命令行开发者工具 | Mac 自带的 python3 只是一个占位，Python 3.12 还没装 | 点"取消"，先按第 4 步的链接安装 Python 3.12，再打开一个新的终端窗口 |
| `ollama --version` 显示 `Warning: could not connect to a running Ollama instance` | Ollama 程序没有打开 | 打开 Ollama（菜单栏出现羊驼图标）后再检查一次 |
| 终端显示 `npm warn` 等警告 | 正常的提示信息 | 可以忽略，只要最后显示 Ready |
| 终端显示 `[notice] A new release of pip is available` | pip 的版本提示 | 可以忽略，不要运行它建议的命令；只要最后显示 Ready |
| 启动时提示端口 9000 已被占用 | 已经有一个工作台在运行 | 关闭另一个正在运行工作台的终端窗口（或在那里按 `Control + C`）；找不到时重启电脑 |

### 11. 反馈问题

请单独发邮件（私信）给：**Mingming Song（songm0428@gmail.com）**。不要发到群里或公开的地方。

**只发错误文字和这一步的名字：** 请把最后几行错误文字（通常以 Error 开头）和这一步的名字发给联系人；不要发含有人数或统计数字的行。

- 步骤的名字就是本指南的小标题，例如"一条命令完成安装"或"每次使用"。
- 请复制粘贴文字，不要截图。

**也请写上：**

- 版本号：见解压文件夹里 `MANIFEST.txt` 的第一行。
- 您的 Mac 型号和内存大小。
- 网络环境：国内或国外，有没有使用代理。

**请不要发：** 人数、结果数字、结果表格、估计值、报告，或结果截图。安装时衍生变量层和字典索引打印的计数行也来自 MIMIC，同样不要发。

### 12. 数据安全

- 建议打开 FileVault（系统设置 → 隐私与安全性 → 向下滚动到 FileVault）。
- 不要把 `mimic` 文件夹放进 iCloud、网盘或共享文件夹。
- `mimic-iv-3.1-derived.zip`、`source/.local` 文件夹里的内容都来自 MIMIC，规则与原始数据相同。
- **下载的报告和结果截图同样属于 MIMIC 结果：** 报告会下载到"下载"文件夹，截图会保存在桌面。请把它们移到 `mimic` 文件夹；不要用已开启云同步的 WPS（WPS 云文档）或 Word（OneDrive 自动保存）打开，先关闭云同步；测试结束后删除。
- 不要把结果粘贴到 Ollama 程序自带的聊天窗口，也不要在那里登录 ollama.com 使用在线模型。
- 测试结束后，可以删除 `source/.local/question-workspace/runs` 里的运行结果（`.local` 是隐藏文件夹：在访达里按 `Command + Shift + .` 显示）；更简单的做法是按第 13 步删除整个 `mimic-platform-…` 文件夹。

### 13. 更新和卸载

- **更新：**
  1. 下载新版本的安装包，解压到 `mimic` 文件夹。
  2. 如需保留旧结果，在终端运行 `cp -R ~/mimic/旧版本文件夹/source/.local ~/mimic/新版本文件夹/source/`（把两个文件夹名换成实际名字；`.local` 是隐藏文件夹，访达里看不到）。
  3. 再运行一次第 6 步的命令。
- **卸载：**
  1. 删除 `mimic-platform` 开头的文件夹。
  2. 在终端运行 `ollama rm qwen2.5:7b-instruct-q4_K_M` 删除模型。
  3. 不再需要数据时，删除 `mimic-iv-3.1.zip` 和 `mimic-iv-3.1-derived.zip`。
  4. 删除"下载"文件夹和桌面上的报告和结果截图。
  5. 第 5 步设置的镜像会一直保留。不再需要时，依次运行下面三条命令删除（没有设置过就不用运行）：

```bash
npm config delete registry
```

```bash
python3 -m pip config unset global.index-url
```

```bash
sed -i '' '/mirrors.tuna.tsinghua.edu.cn/d' ~/.Rprofile
```

### 14. 名词解释

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

**Formatted guide (best read in a browser; no GitHub account needed):** https://github.com/mmsongai-tech/mimic-study-workspace/blob/main/docs/client-guide/macos.md (if it does not open, follow this file; the content is the same)

**If you see plain text** (many backticks and | signs): each command has a line with three backticks and the word bash above it and a line with three backticks below it, like these three lines:

```bash
node -v
```

Copy only the command line in between; never copy the backticks or the word bash. The same goes for a command inside single backticks in the text (for example `ollama list`): copy only what is between them. A "grey box" below is a grey box on the formatted page, and such a line in between in plain text.

### 0. Read these three rules first

1. **Who may use it:** only people who personally hold PhysioNet credentialed access to MIMIC-IV. Access is per person and cannot be shared.
2. **Data and results stay private:** never upload MIMIC-IV data, results, reports or screenshots of results to online AI tools (ChatGPT, Kimi, Doubao, DeepSeek and others), cloud drives or group chats. Share them only with credentialed people.
3. **Research prototype:** results are observational associations. They have not been reviewed by clinicians or validated externally, and must not be used for clinical decisions.

Contact for any problem: **Mingming Song (songm0428@gmail.com)**

### 1. Before you start (5 minutes)

| Item | Requirement |
|---|---|
| Computer | A Mac with Apple silicon or Intel, macOS 14 (Sonoma) or newer (Apple menu → About This Mac) |
| Memory | 16 GB minimum, with other large programs closed while analyses run; 32 GB is better |
| Disk | 50 GB free |
| Permissions | Installing programs needs the Mac's login (administrator) password. Hospital-managed computers may block installs; ask your IT department first |
| Data | Your own `mimic-iv-3.1.zip` from PhysioNet (about 10.6 GB): sign in with your own credentialed PhysioNet account, open https://physionet.org/content/mimiciv/3.1/ and, under Files at the bottom, click "Download the ZIP file" to get this single zip; a folder downloaded earlier with wget does not work |
| Time | First installation 1–3 hours, mostly unattended downloads and builds; about 1 minute to start afterwards |
| Network | Internet access. In mainland China, see the mirrors in step 5 |
| Power | Keep the Mac plugged in and the lid open while installing and running |

### 2. The Terminal

- **Open it:** press `Command + Space`, type `Terminal`, press Return.
- **Run a command:** copy one grey box at a time, paste it with `Command + V` and press Return.
- Wait until the last line again shows your computer's name and ends with % (for example `xiaoming@MacBook-Pro source %`); only then is the step finished.
- Passwords are not shown while you type; that is normal.

### 3. Put the two files in place

1. In Finder, press `Shift + Command + H`, then `Shift + Command + N` to create a folder, and name it `mimic` (lower case, no spaces). Do not put it on the Desktop or in Documents: with iCloud sync on, those folders upload to the cloud.
2. **The MIMIC data file:** put `mimic-iv-3.1.zip` into `mimic`.
   - **Do not unzip it and do not rename it.**
   - In Safari, turn off Settings (Preferences on older macOS) → General → "Open "safe" files after downloading". If it was unzipped, download the zip again.
3. **The platform package:** if you are reading this file, the package is already downloaded and unzipped: drag the whole unzipped `mimic-platform-…-macos` folder into `mimic`; no need to download it again, and the zip in Downloads can be deleted. If you have not downloaded it yet: open the GitHub Releases link your contact sent you (no GitHub account needed) and, under Assets, download the file ending in `-macos.zip`. Do not use the green Code button or "Source code (zip)". Put it into `mimic` and **double-click it to unzip**.
   - Unzip this one; keep the MIMIC file zipped.
   - If GitHub is slow, ask your contact for a domestic download link.
4. You get a folder starting with `mimic-platform`, containing `source` and this guide.

### 4. Install four programs (20–30 minutes)

Download each installer from the official site and double-click it. Installing asks for the Mac's login password. If a page shows commands, do not copy them; download the installer only.

| Program | Where | Which |
|---|---|---|
| Node.js | https://nodejs.org | Click "Get Node.js®" on the home page, then "macOS Installer (.pkg)" on the download page (the LTS version is the default) |
| Python | Direct download: https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg (in mainland China: https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-macos11.pkg ) | **Python 3.12 only**; see below the table |
| R | https://cran.r-project.org/bin/macosx/ | Apple menu → About This Mac: "Chip Apple M…" → `arm64`; "Processor Intel…" → `x86_64` |
| Ollama | https://ollama.com/download | macOS: click "Download manually" (do not copy the command on the page). Open it once; a llama icon appears in the menu bar. If it offers to install the command line tool on first start, click Install and enter the login password |

**Python must be 3.12:**

- Only Python 3.12 is tested and recommended. The link above downloads the Python 3.12.10 installer for Mac. You can also open the release page https://www.python.org/downloads/release/python-31210/ and click "macOS 64-bit universal2 installer" in the file list near the bottom.
- 3.13 and 3.14, which the python.org home page offers, are not supported yet; do not use them. The newer 3.12 releases on python.org have no Mac installer; 3.12.10 is the last one with one, so use it.
- The Python that comes with macOS is too old.
- If typing `python3` opens a window asking to install the command line developer tools, click Cancel and install Python 3.12 from the link above first.

Close the Terminal, open a new one, and check:

```bash
node -v; python3 --version; Rscript --version; ollama --version
```

What "OK" looks like (your numbers may be newer than the examples):

| Program | OK |
|---|---|
| Node | Look at the first number after v: 22 (with the second number at least 13), 24, 25, 26 or higher, for example `v22.13.0`, `v24.11.1`, `v26.7.0` (on v23, `v23.4` or newer) |
| Python | `Python 3.12.x`, for example `Python 3.12.10` |
| R | `Rscript (R) version 4.x.x`, 4.3 or newer |
| Ollama | `ollama version is …` (a version number) |

- If Python shows `3.13` or `3.14`: install 3.12 from the link above, open a new Terminal window and check again; it should show `Python 3.12.x`. If it still shows 3.13 or 3.14, run `python3.12 --version`: if that shows `Python 3.12.x` you can continue, because the install command uses it automatically.
- If Python shows `3.9`: close the Terminal, open a new Terminal window and check again; if it persists, contact us.
- For `command not found` or an Ollama `Warning`, see step 10.

In mainland China, continue with step 5.

### 5. Mirrors for mainland China (about 2 minutes)

After installing Node, Python and R, run each command once:

```bash
npm config set registry https://registry.npmmirror.com
```

```bash
python3 -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

```bash
echo 'options(repos = c(CRAN = "https://mirrors.tuna.tsinghua.edu.cn/CRAN/"))' >> ~/.Rprofile
```

No output, or a single `Writing to …` line, means it worked.

The AI model (about 4.7 GB) downloads from Ollama. If that is very slow or fails, ask us for an offline copy.

### 6. Install with one command (1–2 hours, unattended)

1. Type `cd` and a space, drag the `source` folder from Finder into the Terminal window, and press Return. The last line should now end with `source %`; if not, do this again.
2. Paste:

```bash
caffeinate -i env MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" MODEL=qwen2.5:7b-instruct-q4_K_M BUILD_DERIVED=1 BUILD_INDEX=1 bash scripts/setup-new-machine.sh
```

- `caffeinate -i` keeps the Mac awake. Keep it plugged in with the lid open.
- Each item shows `[ok]` or `[todo]` with what to do.
- **For some stretches no new text appears; that is normal, do not close the window:** R packages take about 10–20 minutes, the derived layer about 10–30 minutes and the dictionary index about 10 minutes.
- **Ready** at the end means success.
- After fixing a `[todo]`, paste the same command again; the data layer and index already built are not rebuilt.

### 7. Every time you use it

1. Open Ollama (llama icon in the menu bar).
2. Plug in the charger. While an analysis runs, **do not close the lid** and keep the Terminal window open.
3. Open Terminal and `cd` into `source` as in step 6 (the last line should end with `source %`).
4. Paste (`caffeinate -i` keeps the Mac awake while you use it):

```bash
caffeinate -i env MIMIC_LOCAL_ARCHIVE="$HOME/mimic/mimic-iv-3.1.zip" bash scripts/start-workspace.sh
```

5. Wait for this line in the Terminal before you open the browser (about 1 minute):

   The workspace is running: open http://127.0.0.1:9000 in your browser. Keep this window open and the computer awake while you use it; press Control + C to stop.

6. Open **http://127.0.0.1:9000** in your browser. The language switch is at the top right.
7. **Keep the Terminal window open** while you work, and press `Control + C` in it to stop; when the last line ends with `source %` again, it has stopped.

### 8. How to ask

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
4. Untick analyses you do not need, then press "Confirm and run". After confirming you can close this page and the analysis continues; but keep the terminal window open and do not let the computer sleep or shut down.
5. An analysis takes from a few minutes to several hours, depending on the question. Progress is shown on the page.

**For this test, please do not tick "Skip review".**

### 9. Reading the results

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

### 10. Problems and fixes

| What you see | Cause | Fix |
|---|---|---|
| "The local model did not respond" | Ollama is closed or the model is missing | Open Ollama; `ollama list` must show `qwen2.5:7b-instruct-q4_K_M` |
| Start-up says the data file is missing or is a folder | Wrong path, or the zip was unzipped | Check that `~/mimic/mimic-iv-3.1.zip` exists and is still a zip |
| The browser cannot open 127.0.0.1:9000 | The Terminal window was closed or start-up failed | Start again (step 7) and wait for the "The workspace is running" line before opening the browser; if it does not appear, read the Terminal message |
| A run shows an error or "exit 1" | Usually not enough memory | Close other programs and run the question again |
| After the Mac slept or the lid was closed, the analysis stopped or shows it may have stopped | Sleep stops the analysis | Plug in, keep the lid open, start again (step 7) and run the question again |
| Only part of a question was analysed | That part is a kind this version does not support, or MIMIC lacks the data | Read the explanation on the page |
| `[todo]` during installation | A component is missing | Follow that line, then rerun step 6 |
| A `[todo]` says Python 3.12 is needed | You have 3.13, 3.14 or an older version | Install Python 3.12 from the link in step 4, open a new Terminal window and run the same step 6 command again |
| A `[todo]` says the derived layer did not build | Usually not enough memory | Close other large programs and run the same step 6 command again. If it still fails, report it as in step 11: only the last error lines, no lines with patient counts or statistics |
| `command not found: node` (or `python3`, `Rscript`, `ollama`) | The program is not installed, or the Terminal was opened before you installed it | Install it (step 4); then close the Terminal and open a new window |
| `scripts/…: No such file or directory` (preceded by `scripts/…`) | The Terminal is not in the `source` folder | `cd` into `source` again as in step 6, item 1 (the last line should end with `source %`), then paste the command |
| Typing `python3` opens a window asking to install the command line developer tools | The python3 that comes with macOS is only a placeholder; Python 3.12 is not installed yet | Click Cancel, install Python 3.12 from the link in step 4, then open a new Terminal window |
| `ollama --version` shows `Warning: could not connect to a running Ollama instance` | The Ollama app is not open | Open Ollama (llama icon in the menu bar) and check again |
| `npm warn` messages | Normal notices | Ignore them if the script ends with Ready |
| `[notice] A new release of pip is available` | A pip version notice | Ignore it and do not run the command it suggests; what matters is that the script ends with Ready |
| Start-up says port 9000 is already in use | Another workspace is running | Close the other Terminal window that runs the workspace (or press `Control + C` there); if you cannot find it, restart the Mac |

### 11. Feedback

Send it privately, by email, to: **Mingming Song (songm0428@gmail.com)**. Do not post it in a group chat or anywhere public.

**Send only the error text and the step name:** Send the last few error lines (usually starting with Error) and the name of this step to your contact; leave out lines with patient counts or statistics.

- The step name is the heading in this guide, for example "Install with one command" or "Every time you use it".
- Copy and paste the text; do not send screenshots.

**Also include:**

- the version (first line of `MANIFEST.txt`);
- your Mac model and memory;
- your network (mainland China or not, proxy or not).

**Never send** patient counts, result numbers, result tables, estimates, reports or screenshots of results. The count lines that setup prints while building the derived layer and the dictionary index also come from MIMIC; do not send them either.

### 12. Keeping data safe

- We recommend turning on FileVault (System Settings → Privacy & Security → scroll down to FileVault).
- Do not put the `mimic` folder in iCloud, a cloud drive or a shared folder.
- `mimic-iv-3.1-derived.zip` and `source/.local` hold MIMIC-derived content, under the same rules as the data.
- **Downloaded reports and screenshots of results are MIMIC results too:** reports download to Downloads and screenshots are saved on the Desktop. Move them into the `mimic` folder; do not open them in WPS (WPS cloud documents) or Word (OneDrive autosave) while cloud sync is on, turn the sync off first; delete them after the test.
- Never paste results into the Ollama app's own chat window, and do not sign in to ollama.com there to use online models.
- After the test, you may delete `source/.local/question-workspace/runs` (`.local` is a hidden folder: press `Command + Shift + .` in Finder to show it); simpler, delete the whole `mimic-platform-…` folder as in step 13.

### 13. Updating and uninstalling

- **Update:**
  1. Unzip the new package into `mimic`.
  2. To keep earlier results, run `cp -R ~/mimic/<old folder>/source/.local ~/mimic/<new folder>/source/` (`.local` is hidden in Finder).
  3. Run step 6 again.
- **Uninstall:**
  1. Delete the `mimic-platform` folder.
  2. Run `ollama rm qwen2.5:7b-instruct-q4_K_M` to remove the model.
  3. When you no longer need the data, delete `mimic-iv-3.1.zip` and `mimic-iv-3.1-derived.zip`.
  4. Delete reports and screenshots of results from Downloads and the Desktop.
  5. The mirror settings from step 5 stay. To remove them, run these three commands one at a time (skip them if you never set the mirrors):

```bash
npm config delete registry
```

```bash
python3 -m pip config unset global.index-url
```

```bash
sed -i '' '/mirrors.tuna.tsinghua.edu.cn/d' ~/.Rprofile
```

### 14. Terms

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
