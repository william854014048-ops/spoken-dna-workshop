# 项目结构与本地接口

本项目是一个由同一进程提供页面的本地前后端应用，没有公网部署或账号系统。

```text
浏览器
  ├─ 三步页面与左侧 DNA 组合库（localStorage 缓存）
  ├─ 作者素材、组合、文稿版本 → /api/workbench → workbench.json
  ├─ 写作请求 → 本地 /api/writing
  └─ 本地 /api/*
        └─ Python HTTP 服务（127.0.0.1）
              ├─ 配置与 Windows DPAPI
              ├─ 写作接口 → 用户配置的 /chat/completions
              ├─ 用户指定的 DNA 资料目录（dna_store.py）
              ├─ 逐条队列（最多 2 个并发工作任务；每个上游接口单通道）
              ├─ 起零数据 → 视频地址
              ├─ 下载 → FFprobe → FFmpeg 分段音频
              └─ 硅基流动 → 转写文字 → 清理临时媒体
```

## 前端

`index.html` 保留页面布局和元素标识。原内嵌内容按原顺序拆到 `workshop.css`、`workshop-core.js`、`spoken-workshop.js`、`expression-profile.js`。它们目前仍共享浏览器全局状态，以保持既有行为；这次未重写为组件框架。

`local.js` 扩展配置面板和素材导入区：提交分享文案，轮询逐条任务状态，保存可编辑原文并加入既有原稿列表。转写结果不直接创建 DNA。

`library.js` 负责目录配置、磁盘读取、旧缓存合并和保存状态。新增 DNA 必须先写盘成功，才进入库；后续表达规则更新按顺序同步到磁盘。`dna_store.py` 按 `spoken-dna/v1` 格式保存一份 `dna.json`，并生成可读 Markdown 和原稿 JSON。每位博主独立文件夹，`raw` 和 `expressionProfile` 随 DNA 保存。

`settings.js` 把配置区放入原生模态 `dialog`，统一保存写作配置和两类转写凭据。密码框只接收新输入，不接收已保存密钥；写作模块以配置状态判断可用性，经本地 `/api/writing` 调用模型。`folder_picker.py` 在服务端打开系统文件夹选择器，选择结果返回本地页面，取消不改变原目录。

`workflow.js` 在原有分析与核对引擎上组织连续工作台：左侧建立按钮打开原生模态 dialog；右侧只进行 DNA 成稿和去 AI 味。建立窗口关闭后保留未完成的输入与分析。保存 DNA 后将关联转写显示到历史区，再添加作者时新建空白分组。转写状态轮询只在归属区域变化时移动卡片，不打断正在编辑的原稿。作者工作区分别保存文章、输入、分析结果和待保存 profile；转写成功项单条／批量直接入文章库。解析接口提供作者昵称／账号编号时用于分组，没有身份信息则归为待确认；不从标题猜身份。

DNA 模块选择用 `{structure: dnaId, language: dnaId, rhythm: dnaId, detail: dnaId}` 表示，同类天然只有一个来源。新分析的规则带 category，旧规则按文字暂分后沿用既有原文证据校验。生成时逐个读取选定来源的 profile，只纳入该来源被选中的类型；各来源轮流选取原稿示范，最多 6 篇。结构、规则、来源及口述快照一起留存。

三个阶段独立保存，DNA 稿与去 AI 味稿可编辑。清理读取当前稿件而不要求复制，失败保留已有输出；改动后标明清理稿对应旧来源。历史记录保存生成／清理前后版本，文字比较按短稿字符、长稿整句处理，不向 diff 中拼接 HTML。

`workbench_store.py` 将非凭据工作区单独保存为 `workbench.json`，格式 `spoken-dna-workbench/v1`，DNA 库仍由 `DNA/` 读取。保存前递归剔除凭据字段，不重复写 library；最大 16 MB，原子写入并 UTF-8 回读。递增 revision 检查防止旧页面覆盖新版本；损坏文件保留且停止写入。

工作目录的固定结构为 `config.json`（`spoken-dna-config/v1`）、`credentials.dpapi` 和 `DNA/`。项目内只保留工作目录路径指针。连接已有工作目录会读取其配置；创建新工作目录会沿用当前凭据和普通设置。旧 DNA 以复制资料的方式合并，原文件保留，不移动或删除。无关或损坏的同名 config.json 会被拒绝，避免误覆盖。

## 服务端

`server.py` 只使用 Python 标准库。当前体量保留为一个文件，内部按配置、链接处理、媒体处理、任务队列、HTTP 接口分区；没有为拆文件增加框架或运行依赖。

静态资源使用白名单。`data/`、源码、环境文件、凭据和日志不通过网页暴露。服务限制本机 Host / Origin；写操作需要 `X-Spoken-DNA: local`，不开放跨域调用。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 服务状态与进程标识 |
| `GET /api/config` | 配置状态；不返回密钥值 |
| `PUT /api/config` | 统一保存写作配置、两类转写凭据，或清除保存的三项密钥 |
| `POST /api/workspace/choose` | 打开系统目录选择器；选择后连接统一工作目录，取消不更改 |
| `POST /api/writing` | 使用工作目录内已保存的写作 Key 和模型调用接口 |
| `GET /api/library` | 从配置目录读取全部 DNA；未配置时返回提醒状态 |
| `GET /api/workbench` | 读取作者素材、组合、文稿版本与 revision |
| `PUT /api/workbench` | 保存工作区及 revision，目录／版本冲突返回 409 |
| `PUT /api/library/config` | 旧版目录设置兼容接口；新界面使用系统选择器连接统一工作目录 |
| `PUT /api/library` | 写入一份 `dna`，保留原稿与表达规则 |
| `POST /api/library/open` | 在 Windows 文件管理器中打开已配置目录 |
| `GET /api/jobs` | 每条任务、状态、标题与原文 |
| `POST /api/jobs` | 提交 `{"text":"分享文案或多个链接"}` |
| `PUT /api/jobs/{id}` | 保存 `title` 和 `transcript`；保留初始转写 |
| `POST /api/jobs/{id}/retry` | 单独重试失败项 |
| `POST /api/jobs/clear` | 清理已结束记录；不改浏览器原稿库 |
| `POST /api/shutdown` | 停止服务，等在途请求结束或超时后清理退出 |

任务依次为 `pending → parsing → downloading → extracting → transcribing → success`，任一步失败进入 `failed`。遇到 429 进入 `rate_limited`，共享通道等待后自动重试，不重复处理已完成音频段。默认语音接口单通道、至少间隔 6 秒，解析接口至少间隔 1 秒；数值是本地保护策略，不是假设用户账号额度。自动重试遵守 `Retry-After` 或递增等待，最多 4 次。重复链接归一化后跳过；某条失败不会中断整个批次。重启不会自动重发尚未完成的付费请求，而是保留为可手动重试的失败项。

DNS 校验允许已知视频 CDN 域名使用 `198.18.0.0/15` Fake-IP 映射，保持真实私网、回环、非 HTTP 地址及重定向检查。DNS 失败有单独错误，不再一律误报为私网地址。

## 配置读取

优先使用本项目已保存的凭据；允许复用环境变量或显式选择的环境文件。密钥名为 `ISTERO_API_TOKEN` / `ISTERO_TOKEN`、`SILICONFLOW_API_KEY`。

首次启动允许从项目 `.env.local`、`SPOKEN_DNA_ENV_FILE` 或旧设置读取已有转写凭据。连接统一工作目录后，凭据转为该目录内的 Windows 加密文件，不再依赖外部环境文件。语音识别模型在后端固定为 SenseVoiceSmall，不接受配置覆盖。

## 当前边界

页面沿用原有颜色、字体、卡片与按钮；布局按用户要求改为左侧 DNA 库与三步主流程。保持原生前端与 Python 标准库，无新增运行依赖。表达分析仍要求原文证据，用户事实与意图保持优先；不同作者的结构与表达习惯可按类型组合。

## 项目 Skill 与样式分支

`skills/dna-extract`、`skills/dna-compose`、`skills/deai-edit` 各含 SKILL.md 和任务提示词 Markdown。`GET /api/skills` 只加载固定白名单文件，缺失或空文件明确报错，不回退到旧提示词。任务规则编辑后刷新生效，提取缓存带规则版本。文件不是可执行脚本，不从原稿中的指令载入 Skill。

液态玻璃分支基于交互版本，只在 HTML 增加样式引用并增加独立 CSS；服务预留此静态资源地址，原风格分支请求该不存在资源会返回 404。视觉回归使用同一份演示数据，验证两个分支控件文字与主要元素坐标尺寸一致。
