# datastructure-agent

**看懂每一步：数据结构与算法可视化学习助手。**

截至2026-10-23，main已合并至PR #33（`1bd0d74`），已接入04的真实二分查找run、03动画/播放、源码高亮与变量，以及05步骤辅导与独立知识卡查询。正常启动后直接访问工作台。06已提供10张自编知识卡和10题，09需求/原型/图表已合并。07已补齐固定过程题、三级提示、错题重练和本机学习记录，可在无模型Key时使用；本地功能检查通过，真实模型效果、真实调研与08独立验收仍待完成。工作台状态和检查见[接入说明](frontend/src/features/workbench/README.md)、[工作台验收](docs/architecture/workbench-check-20261022.md)与[07代码验收](docs/architecture/exercises-check-20261023.md)。

现行实现、最新用户调整和剩余验收统一见[当前项目状态](docs/architecture/current-status.md)。日期命名的旧检查记录保留当时结果，不能直接当成当前界面说明。

## 从哪里开始

1. 先读 [十人分工总表](docs/team/assignments.md)，确认自己对应成员编号。
2. 在 [个人任务单](docs/team/tasks/) 中找到任务、路径、日期和验收条件。
3. 对照 [交付样子与验收示例](docs/team/plan-a-output-spec.md) 确认自己要做成什么样。
4. 按 [Fork / PR 协作规范](CONTRIBUTING.md) 操作。
5. 开发前读 [接口约定](docs/architecture/api-contract.md) 与 [执行状态约定](docs/architecture/trace-contract.md)。

真实姓名、学号和 GitHub 用户名由团队在 [成员登记表](docs/team/roster.md) 填写，目前没有将任务分配给不存在的账号。更新进度用 [任务看板](docs/team/progress.md)。

## 本地启动

安装 Node.js 22.9 或以上版本。首次获取主仓库可使用下面的 PowerShell 命令。队员准备提交功能时仍按 [Fork / PR 协作规范](CONTRIBUTING.md) 建立自己的副本。

```powershell
git clone https://github.com/tw1l1ghtcc/datastructure-agent.git
Set-Location datastructure-agent
```

随后在仓库根目录执行：

```powershell
npm run check
npm start
```

访问 <http://127.0.0.1:3000>。无需安装第三方依赖。

可选配置：

```powershell
Copy-Item .env.example .env
npm start
```

启动及算法/判分接口不需要模型密钥。示例配置默认 AGENT_MOCK=true，优先使用免费开发模板；关闭Mock且配置DEEPSEEK_API_KEY后才调用真实API。当前模型默认 `deepseek-flash`，显式关闭思考模式；旧配置中的 `deepseek-chat` 会自动映射为新模型。已有用户更新后须重启服务，无需重新填写密钥。不要把 `.env` 提交到仓库。模型配置、聊天页、限流与预算说明见[Agent说明](backend/src/agent/README.md)。

启动后，另开一个 PowerShell 窗口检查服务：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

当前预期为 `ok=true`、`stage=scaffold`、`implemented` 包含 `static-page/health/runs/exercises/agent/knowledge`。mode为disabled/mock/deepseek，modelCallsEnabled只在真实模式为true。正式工作台已接入真实动画、源码/变量与辅导，独立聊天页保留；07练习/记录已接入正式工作台；知识接口已支持按问题查询verified知识卡，见[检索说明](backend/src/knowledge/README.md)。检查结束后在运行 `npm start` 的窗口按 Ctrl+C 停止服务。

可在服务运行时验证完整轨迹：

```powershell
$run = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/algorithms/binary-search/runs -ContentType 'application/json' -Body '{"array":[1,3,5,7,9],"target":7}'
$run.steps | Format-Table stepIndex,event,lineId,done,result
Invoke-RestMethod "http://127.0.0.1:3000/api/runs/$($run.runId)/steps/0"
Invoke-RestMethod http://127.0.0.1:3000/api/exercises
```

标准案例为5步、result=3；详细输入上限、返回字段及提示响应见[API契约](docs/architecture/api-contract.md)。

工作台已按用户确认的09原型模式调整：侧栏可收起，代码与白底动画并排，四变量横排，时间轴位于播放栏右侧；步骤辅导放在右下悬浮窗口，知识卡放在独立的“知识与辅导”页面。启动后刷新即可查看；[当前布局与验收截图](docs/architecture/workbench-layout-check-20261023.md)。

聊天已改为直接模型问答：不做知识检索门槛，携带服务端当前/上一步状态、完整展示代码和高亮行。连续追问：同一运行最多参考最近10轮并限制总长度，换运行隔离；提示词采用直白的助教风格，聊天不显示知识卡出处，独立知识卡阅读保留。[实现与本地检查](docs/architecture/agent-direct-chat-check-20261023.md)。真实模型语气效果仍待实测。

侧栏五项为独立页面：课程目录（`/#catalog`）、算法工作台（`/#workbench`）、知识与辅导（`/#knowledge`）、过程练习（`/#practice`）、错题与记录（`/#records`）。课程目录按原型展示8个章节和40个规划单元，可展开查看；目前仅二分查找接入工作台，其余标“待开发”。品牌标志也可返回目录，默认启动仍进入算法工作台。支持直接打开、刷新及浏览器前进后退。切换页面保留运行、聊天草稿/历史及练习内容，离开工作台暂停播放；记录中的“重练此题”会切到练习页。对话球只保留步骤聊天，已移除“步骤问答”和“知识卡”选项卡。[页面拆分检查与截图](docs/architecture/learning-pages-check-20261023.md)。

## 开发检查

日常运行npm run check、npm test；引擎/接口完整检查运行npm run test:backend，资料校验运行npm run check:content。浏览器回归需要本机Playwright及Edge，命令、覆盖范围和证据入口见[测试说明](tests/README.md)。这些脚本保留用于08独立复核和后续修复回归。

## 09原型预览

在仓库根目录另开PowerShell窗口执行：

```powershell
node docs/prototype/preview.mjs
```

访问 <http://127.0.0.1:3099/docs/prototype/index.html>，可浏览目录、工作台、知识/辅导、练习和记录五页。运行方法、截图和标志见[原型说明](docs/prototype/README.md)。这是设计原型：使用本地引擎、模拟run标识及独立记录空间，不是生产API联调结果；生产服务仍使用 `npm start`。按Ctrl+C停止预览。

## 本次第一次作业

- 2026-10-22：原定完成主要材料及二分查找小样例并冻结范围；实际已交付内容及待补证据见当前状态。
- 2026-10-23～24答辩前：预留约一天半用于修复、复测、检查和演练，不增加新功能；具体时长以实际答辩时段为准。
- 2026-10-24：选题答辩（演讲 10 分钟＋答辩 6 分钟）。
- 2026-10-25：提交团队博客。

完整成品验收日期尚未公布。第一次作业不是完整软件最终验收；需要真实调研、需求分析、代表性 Agent 任务及定制前后对比。

本次样例计划：二分查找完整执行、输入修改、单步控制、代码与变量联动、真实 Agent 步骤问答、固定过程题和本机记录。采用本机演示＋录屏备份。

## 正式版目标

覆盖 408 数据结构知识范围并复核官方大纲。知识、出处、例题/练习按覆盖表验收。重点动画：二分查找、链表插入删除、二叉树遍历、BFS/DFS、快速排序、归并排序、KMP、Dijkstra/Floyd。

账号、跨设备同步、管理后台和自由拖拽绘图预留。[范围与决策记录](docs/product/scope.md)

## 目录

```text
frontend/              HTML、CSS、浏览器 JavaScript
backend/src/           Node.js 服务、算法、状态、Agent 与检索模块
shared/                共享数据格式、样例、C/C++ 展示代码目录
content/               知识卡、题目、出处、覆盖表
tests/                 可重复运行的单元、接口及浏览器回归
docs/team/             十人分工、登记、个人任务单
docs/architecture/     模块边界、接口、状态约定
docs/product/          范围、需求v0.9、覆盖规划与设计核验
docs/prototype/        五页交互原型、截图与项目标志
docs/research/         访谈与试用模板
docs/evaluation/       三案例对比方案和结果模板
docs/presentation/     PPT、演示脚本和团队博客模板
scripts/               仓库静态检查
.github/               PR 模板和任务 Issue 模板
```

`shared/examples/` 是人工协议示例，`content/exercises/binary-search-oracle.json` 是人工预期，均不是真实引擎输出或模型效果证据。已登记10名成员，真实访谈和效果结果仍待补。本批内容经用户确认采用项目自编，不要求教材具体章节/页码，也不声称完成教材核验；来源决定见[范围记录](docs/product/scope.md)。

## 材料入口

- [接口对齐清单](docs/architecture/contract-alignment.md)：负责人、待确认事项和确认依据。
- [集成与验收清单](docs/team/integration-checklist.md)：17日、19日联调及22日冻结检查。
- [日程](docs/team/schedule.md)：10月22日完成，23日至24日答辩前修复、复测与演练。
- [需求分析v0.9](docs/product/requirements.md)：09已交可审阅版，真实调研、课程规范及跨成员确认仍待补。
- [原型、截图与标志](docs/prototype/README.md)、[思维导图与领域模型](docs/architecture/diagrams/README.md)：09设计成果，10可引用并保留设计标签。
- [覆盖规划](docs/product/coverage-plan.md)：40项逐项规划，待06/相关成员复核，不代表全部内容或动画已完成。
- [访谈与试用](docs/research/README.md)：成员07组织。
- [测试与效果对比](docs/evaluation/README.md)：成员08核验。
- [PPT、博客与演示](docs/presentation/README.md)：成员10汇总。
