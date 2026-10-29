# Agent 服务（成员05）

本模块已实现：真实页面步骤/源码上下文、最多10轮服务端问答历史、直接DeepSeek调用、自然助教提示词、显式Mock、聊天界面、限流用量和预算预留。聊天不读取、匹配或引用知识卡；知识卡阅读及查询接口独立保留。

## 启动

Node >=22.9，使用内置 fetch，无新增运行依赖。根目录复制 `.env.example` 为 `.env`，运行 `npm start`。

- `AGENT_MOCK=true`：显式开发模板，优先级高于 Key，绝不调用模型；响应标注 Mock，费用0。
- `AGENT_MOCK=false` 且配置 `DEEPSEEK_API_KEY`：调用真实 DeepSeek，可能产生费用。
- 未开 Mock 且无 Key：503 MODEL_NOT_CONFIGURED。
- `DEEPSEEK_MODEL` 配置模型，默认 `deepseek-flash`；`MODEL_TIMEOUT_MS` 包括响应头与正文，默认15000ms。失败502、超时504，不阻断算法及题库接口，不假称已自动降级。
- API地址固定为官方HTTPS端点，旧的 MODEL_API_KEY/MODEL_NAME/MODEL_API_BASE 变量不再使用。
- 2026-10-29迁移：官方已停用`deepseek-chat`，当前使用`deepseek-flash`。已有`.env`若仍填`deepseek-chat`，运行时自动映射为新模型；其他显式模型名仍按配置使用，不修改密钥。修改后重启服务。
- 请求显式设置`thinking.type=disabled`，保持普通步骤问答的响应方式，避免新模型默认思考占用1024-token输出上限及15秒等待时间；三级提示仍控制解释深度。
- 模型与思考模式依据[官方模型文档](https://api-docs.deepseek.com/quick_start/pricing/)及[思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)。迁移不内置新价格；费用仍须按实际账户、时段和缓存情况核对配置。

先通过04的创建运行接口取得真实 runId，再访问 `/src/features/agent/chat.html?runId=实际runId&stepIndex=1`。步骤索引从0计数。聊天页可输入问题、选择三级提示、查看原运行/步骤归属；失败重试使用原问题/运行/步骤/级别快照，切换输入不会改写历史回答的归属。

## 接口与用量

`POST /api/agent/explain` 输入 `{runId,stepIndex,question,hintLevel,sessionId?,conversationId?,turnId?}`。question最多2000字符，参数严格校验，状态只来自服务端，不采用客户端伪造变量。sessionId仅用于展示统计，不是权限或限流身份。

成功返回 `{runId,stepIndex,hintLevel,answer,stepRefs,sourceRefs,knowledgeUsed,retrieval,usage}`。stepRefs来自真实运行；为兼容旧消费者，sourceRefs固定为空、knowledgeUsed=false、retrieval.method=none/status=disabled。真实模式下有效问题在参数、运行及额度检查后直接调用模型；没有关键词或知识资料不可用也不会拦截聊天。真实 usage包含模型、tokens、elapsedMs、cost/CNY及估算说明；上游未给完整用量或未配置价格时保留null，不能当成免费。输入/输出单价必须依据实际模型和账户核对后填入环境变量，代码不内置未核实价格。

`GET /api/agent/usage?sessionId=...` 返回本次服务进程、北京时间当日、同socket来源与session的请求次数、失败数、累计耗时、tokensUsed/costUsed。出现未知调用时累计值为null；页面与POST使用相同session。统计重启清零，**预算预留不会随统计清零**。

## 限流与预算

- 限流默认开启：同socket来源每60秒20次。忽略客户端session、User-Agent、x-forwarded-for；切换run不会刷新来源额度。当前没有可信反向代理配置，部署在代理后会共享代理来源额度，需部署时明确代理信任策略。
- 调用模型前同步预留预算及token额度，阻止并发重复使用剩余额度；独立于分钟限流保存日token累计。默认每来源每日100万token、全服务每日5元、项目测试累计30元。
- 金额预留采用 `MODEL_CALL_RESERVE_CNY`（默认0.05元）与根据配置单价/输入上界计算的金额中较大者。得到已知用量与配置单价后按估算金额结算；未知用量、未知价格、失败及进程中断保留预留额，避免错误释放为0。
- 预留/结算写入 `data/private/agent-budget.json`（已由既有gitignore排除），重启保留。此文件只含额度与来源哈希，不含Key或学生问题。写入失败时关闭模型调用并返回503 BUDGET_UNAVAILABLE。
- 这是**单进程本地估算额度控制，不是服务商账单封顶**。多进程/多实例需要统一的事务存储；不支持共享同一ledger文件并发运行多个服务。账单以服务商记录为准。不要删除ledger来掩盖已用额度。

## 验证与剩余工作

```powershell
npm run check
node --test tests/knowledge-retrieval.test.mjs tests/agent-explain.test.mjs tests/agent-provider.test.mjs tests/agent-real-mode.test.mjs
```

测试仅使用显式加载的本地模型桩和虚拟Key，不访问付费模型。浏览器检查脚本为 `tests/agent-chat.browser.mjs`，需要本地可用的 Playwright 和 Edge；可用 `TEST_PLAYWRIGHT_MODULE` 指定已安装模块的入口绝对路径，然后运行 `node tests/agent-chat.browser.mjs`。

聊天已通过共享panel接入当前主分支正式工作台，自动同步当前run/步骤；剩余：仓库中仍缺08独立验收及3组真实模型定制对比证据。不得将本地桩测试当成真实模型效果验收。上述证据按已有分工补齐，不能将代码已接入等同于效果验收已通过。

## 连续追问与提示词

前端只提交随机conversationId与turnId，历史由服务端保存；同一运行的步骤切换保留会话，换运行隔离。最多10轮、8000字符，1小时无活动过期、200个会话上限，重启清空；此功能不是账号或跨设备聊天存储。失败重试复用原ID；同会话并发409，成功结果在保留窗口内幂等重放。

模型直接理解本轮问题和最多10轮历史，不做关键词或省略句分类。prompt包含当前数组/目标/事件/变量、上一步快照、完整展示代码及高亮lineId/sourceVersion。页面事实以服务端状态为准，模型可运用通用算法知识；不伪造教材或知识卡出处。失败不进入历史；成功回复即使knowledgeUsed=false也会进入会话。

原口语兜底step-question.js及知识卡输出规则已移除。输出只做空值/长度处理，空回复返回502可重试；限流、预算、超时和幂等控制保持。问答失败不影响动画/练习。

当前流程与本地检查见[直接模型问答检查](../../../docs/architecture/agent-direct-chat-check-20261023.md)。旧十轮检查记录是检索仍在聊天中时的历史结果。
