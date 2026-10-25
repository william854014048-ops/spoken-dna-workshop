# 项目结构与本地接口

本项目是一个由同一进程提供页面的本地前后端应用，没有公网部署或账号系统。

```text
浏览器
  ├─ 页面、原稿、DNA、文稿与备份（localStorage）
  ├─ 写作模型调用 → 用户配置的 /chat/completions
  └─ 本地 /api/*
        └─ Python HTTP 服务（127.0.0.1）
              ├─ 配置与 Windows DPAPI
              ├─ 逐条队列（最多 2 个并发工作任务）
              ├─ 起零数据 → 视频地址
              ├─ 下载 → FFprobe → FFmpeg 分段音频
              └─ 硅基流动 → 转写文字 → 清理临时媒体
```

## 前端

`index.html` 保留页面布局和元素标识。原内嵌内容按原顺序拆到 `workshop.css`、`workshop-core.js`、`spoken-workshop.js`、`expression-profile.js`。它们目前仍共享浏览器全局状态，以保持既有行为；这次未重写为组件框架。

`local.js` 扩展配置面板和素材导入区：提交分享文案，轮询逐条任务状态，保存可编辑原文并加入既有原稿列表。转写结果不直接创建 DNA。

## 服务端

`server.py` 只使用 Python 标准库。当前体量保留为一个文件，内部按配置、链接处理、媒体处理、任务队列、HTTP 接口分区；没有为拆文件增加框架或运行依赖。

静态资源使用白名单。`data/`、源码、环境文件、凭据和日志不通过网页暴露。服务限制本机 Host / Origin；写操作需要 `X-Spoken-DNA: local`，不开放跨域调用。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 服务状态与进程标识 |
| `GET /api/config` | 配置状态；不返回密钥值 |
| `PUT /api/config` | 保存／清除两类转写凭据及模型设置 |
| `GET /api/jobs` | 每条任务、状态、标题与原文 |
| `POST /api/jobs` | 提交 `{"text":"分享文案或多个链接"}` |
| `PUT /api/jobs/{id}` | 保存 `title` 和 `transcript`；保留初始转写 |
| `POST /api/jobs/{id}/retry` | 单独重试失败项 |
| `POST /api/jobs/clear` | 清理已结束记录；不改浏览器原稿库 |
| `POST /api/shutdown` | 停止服务，等在途请求结束或超时后清理退出 |

任务依次为 `pending → parsing → downloading → extracting → transcribing → success`，任一步失败进入 `failed`。重复链接归一化后跳过；某条失败不会中断整个批次。重启不会自动重发尚未完成的付费请求，而是保留为可手动重试的失败项。

## 配置读取

优先使用本项目已保存的凭据；允许复用环境变量或显式选择的环境文件。密钥名为 `ISTERO_API_TOKEN` / `ISTERO_TOKEN`、`SILICONFLOW_API_KEY`。

默认环境文件为项目内 `.env.local`。可用环境变量 `SPOKEN_DNA_ENV_FILE` 选择其他已有文件；本机设置中的 `externalEnvFile` 也可保留已有配置的路径。路径设置保存在 Git 忽略的 `data/settings.json`，公共源码不绑定作者电脑目录。保存／清除页面配置后，不再自动复用旧配置。

## 当前边界

源码整理解决了单文件过大、机器路径绑定和新用户运行说明问题。后续只有在明确需求出现时，再拆服务模块或引入前端组件；本版本没有改动页面风格、分析标准和写作业务规则。
