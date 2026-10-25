---
name: dna-compose
description: 读取已选的各类 DNA，将用户真实口述整理为稿件并核对事实和意图；参考作者的观点、事实不迁入用户文稿。
---

# 按 DNA 成稿

本 Skill 是口播 DNA 项目内的 AI 任务定义。实际提示词由本地服务 `/api/skills` 读取以下文件，页面刷新后下一次调用生效，不需要重新打包。修改时保留 JSON 输出字段和原文证据校验协议。

- [system.md](system.md)
- [intent.md](intent.md)
- [compose.md](compose.md)
- [review.md](review.md)
- [skip.md](skip.md)

## 输入与完成判据

输入包括用户原话、补充、时长和按类型去重的 DNA 来源。先识别表达类型，再按所选规则成稿，最后独立对照原话检查新增事实。缺必要材料时最多问两题。
