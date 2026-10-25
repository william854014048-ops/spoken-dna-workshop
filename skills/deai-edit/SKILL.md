---
name: deai-edit
description: 在保留事实、意图、结构和表达 DNA 的前提下，按十一条规则做最小改动；保留前后稿件，不保证检测分数。
---

# 去 AI 味

本 Skill 是口播 DNA 项目内的 AI 任务定义。实际提示词由本地服务 `/api/skills` 读取以下文件，页面刷新后下一次调用生效，不需要重新打包。修改时保留 JSON 输出字段和原文证据校验协议。

- [system.md](system.md)
- [strict.md](strict.md)
- [relaxed.md](relaxed.md)

## 输入与完成判据

输入为当前待清理全文、严格模式和本稿所用的表达规则。输出完整稿件及实际改动的规则计数数组；失败不覆盖前稿。
