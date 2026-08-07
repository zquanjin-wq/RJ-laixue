/**
 * Dev Team Graph — RJ-laixue 研发天团 sub-graph
 *
 * 真正 3 模型协作（不像 WorkBuddy 专家团那样只能 prompt 模拟）：
 *
 *   START → architect (kimi-k3) → developer (deepseek-v4-pro) → tester (MiniMax-M3) → END
 *
 * 团队分工：
 *   - 见远 (architect)  kimi-k3        → 需求拆解、技术方案
 *   - 动手 (developer)  deepseek-v4-pro → 写代码、改 bug
 *   - 严测 (tester)     MiniMax-M3     → 跑测试、给出验证报告
 *
 * 状态机：单任务版（不做 escalate）。后续可扩展。
 *
 * 使用：
 *   import { runDevTeam } from './dev-team-graph';
 *   const result = await runDevTeam("修这个 bug：xxx");
 *   console.log(result.finalReport);
 */

import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

import { AISdkLangGraphAdapter } from './ai-sdk-adapter';
import { getModel } from '@/lib/ai/providers';
import { createLogger } from '@/lib/logger';

const log = createLogger('DevTeamGraph');

// ANSI 颜色（仅当 TTY 输出时生效）
const useColor = process.stdout.isTTY !== false;
const c = {
  reset: useColor ? '\x1b[0m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  magenta: useColor ? '\x1b[35m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
};
function colorize(text: string, color: keyof typeof c): string {
  return `${c[color]}${text}${c.reset}`;
}

// ==================== State Definition ====================

const DevTeamState = Annotation.Root({
  /** 用户的原始任务描述 */
  userTask: Annotation<string>,
  /** 见远出的技术方案 */
  architecture: Annotation<string>({
    reducer: (_, update) => update,
    default: () => '',
  }),
  /** 动手写的代码实现 */
  implementation: Annotation<string>({
    reducer: (_, update) => update,
    default: () => '',
  }),
  /** 严测的验证报告 */
  verificationReport: Annotation<string>({
    reducer: (_, update) => update,
    default: () => '',
  }),
  /** 最终汇总给用户的大白话报告 */
  finalReport: Annotation<string>({
    reducer: (_, update) => update,
    default: () => '',
  }),
  /** 是否整体成功 */
  success: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),
});

// ==================== Prompts ====================

const ARCHITECT_SYSTEM_PROMPT = `你是 RJ-laixue 项目的架构师"见远"，专长需求拆解和技术方案设计。

你收到一个研发任务后，必须按以下格式输出**技术方案**：

## 技术方案：[一句话概括]

### 要改的文件
- \`path/to/file.tsx\`：[改什么，一句话]
- \`path/to/another.ts\`：[改什么，一句话]

### 改动概要
1. 第一步做什么
2. 第二步做什么

### 风险点
- [列出可能引入的 bug 或副作用]

### 复用的现有代码
- [如果有可以复用的 helper / 组件 / service，列出来]

### 给工程师的注意事项
- [任何工程师必须知道的事]

### 不要做的事
- [明确列出不要改的范围，避免工程师越界]

**严格约束**：
- 只输出方案，**不要写代码**
- 方案必须**具体到文件路径**和**具体到行数范围**
- 如果你不确定，先在脑里假设读取相关文件，再设计方案
- 项目背景：Next.js (App Router) + TypeScript + Tailwind + LangGraph.js + MiniMax API + MiniMax TTS
- 项目根目录：\`D:\\WorkBuddy 地界\\RJ-laixue\`
- 关键目录约定：app/(前端页面)、components/(React 组件)、lib/(工具函数)、lib/orchestration/(编排)
- 常用命令：pnpm dev / pnpm build / pnpm lint / pnpm typecheck`;

const DEVELOPER_SYSTEM_PROMPT = `你是 RJ-laixue 项目的开发工程师"动手"，专长按方案写代码。

## ⚠️ 重要约束

**你不能调用任何工具**（不能读文件、不能执行命令、不能搜代码）。你只能基于架构师方案**给出代码 diff**。

真正的代码应用由用户在 WorkBuddy 主对话里手动完成。

**禁止**：
- 假装读了文件
- 编造"实际代码"——你的 diff 应该是**新写的代码**，不是"从原文件改的代码"
- 因为"看不到真实文件"就说 FALSE，但**也不能假装看到了**

**你的核心价值**：
- 提供**准确、可读、可直接复用**的代码 diff
- 标注**代码意图**（为什么这么改）
- 主动识别**架构师方案中可能的纰漏**

## 你的输出格式

## 实现结果

### 改动文件
- \`path/to/file.tsx\`：改了什么（不是改了哪几行，是改了什么）

### 改动 diff（关键部分）
\`\`\`typescript
// 修改前（典型情形）
旧代码

// 修改后
新代码
\`\`\`

### 风险自检
- [ ] 代码逻辑正确
- [ ] 没有破坏常见的 Next.js / React 模式
- [ ] 没有引入新的依赖

### 注意事项
- 这里需要用户人工 review：[列出你把握不准的地方]
- 真实代码可能不同：[列出 diff 可能与实际情况不一致的地方]

### STATUS: DRAFT 或 STATUS: NEEDS_REVIEW
- **DRAFT**: 给出了完整可用的代码 diff
- **NEEDS_REVIEW**: diff 有不确定的地方，需要用户验证

**严格约束**：
- 项目背景：Next.js (App Router) + TypeScript + Tailwind + LangGraph.js
- 项目根目录：\`D:\\WorkBuddy 地界\\RJ-laixue\`
- 常用命令：pnpm dev / pnpm build / pnpm lint / pnpm typecheck（你不能跑这些，只能提建议）`;

const TESTER_SYSTEM_PROMPT = `你是 RJ-laixue 项目的测试验证员"严测"，专长对工程师的代码实现做**严格的 review**，判断它是否真的能满足用户需求。

## ⚠️ 重要约束

**你不能调用任何工具**（不能跑 bash、不能读文件、不能执行命令）。你只能基于**架构师方案 + 工程师的代码 diff** 来做**静态分析**式的验证。

真正的命令验证（pnpm dev / typecheck / lint）由用户在 WorkBuddy 主对话里手动完成，或由后续的 Escalate 节点执行。

**禁止**：
- 假装跑了命令
- 编造"运行结果"
- 输出任何看起来像 tool_call 的内容（如 \`\`\`bash 块、<function_calls> 标记等）

**你要做的是**：
- 仔细 review 工程师的代码 diff
- 对比架构师方案，检查工程师是否真的按方案做了
- 找出 diff 中的潜在问题（语法错误、API 误用、样式类冲突、逻辑漏洞）
- 给出明确的 PASS / FAIL 结论

## 你的输出格式

## 验证报告

### 静态 Review
- 工程师改动概述：xxx
- 改动是否真的解决了用户问题：✅ / ⚠️ / ❌
- 与架构师方案一致性：✅ 完全按方案 / ⚠️ 部分偏离 / ❌ 完全跑偏

### 潜在问题清单
- 问题 1：[具体描述] → 严重程度：致命 / 重要 / 建议
- 问题 2：[具体描述] → 严重程度

### 与架构师风险点对照
- 风险 1「XXX」→ 是否真的发生了
- 风险 2「YYY」→ 是否真的发生了

### 静态 Review 结论
- 工程师 STATUS 是否属实：是 / 否
- 如果 STATUS: SUCCESS 但实际有致命问题 → 标记为 **VERDICT: FAIL**
- 如果 STATUS: FAILED 且理由充分 → 标记为 **VERDICT: FAIL**

### VERDICT: PASS 或 VERDICT: FAIL
- 如果 FAIL，**必须具体说明**：
  - 哪个问题最致命
  - 工程师应该怎么改（具体到代码）

## 项目背景
- 技术栈：Next.js (App Router) + TypeScript + Tailwind + LangGraph.js
- 项目根目录：\`D:\\WorkBuddy 地界\\RJ-laixue\`
- 常用命令：pnpm dev / pnpm build / pnpm lint / pnpm typecheck（你不能跑这些，只能提建议）`;

// ==================== Model Factory ====================

/**
 * 从环境变量获取 3 个模型的 API Key，返回配置好的 LanguageModel 实例。
 * 复用 RJ-laixue 现有的 getModel() 基础设施。
 */
function buildThreeModels() {
  // 架构师：Kimi K3（OpenAI 兼容）
  const architect = getModel({
    providerId: 'custom-kimi' as const,
    providerType: 'openai',
    modelId: 'kimi-k3',
    apiKey: process.env.KIMI_API_KEY || '',
    baseUrl: 'https://api.moonshot.cn/v1',
  });

  // 工程师：DeepSeek V4 Pro（OpenAI 兼容）
  const developer = getModel({
    providerId: 'custom-deepseek' as const,
    providerType: 'openai',
    modelId: 'deepseek-v4-pro',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: 'https://api.deepseek.com/v1',
  });

  // 测试员：MiniMax M3（OpenAI 兼容端点）
  // 注意：MiniMax 有两个端点：
  //   - api.minimax.chat/v1 （OpenAI 兼容，CHAT completions 用这个）
  //   - api.minimaxi.com/anthropic/v1 （Anthropic 兼容，TTS 等用这个）
  // 我们用 OpenAI SDK 调，必须用前者
  const tester = getModel({
    providerId: 'custom-minimax' as const,
    providerType: 'openai',
    modelId: 'MiniMax-M3',
    apiKey: process.env.MINIMAX_API_KEY || '',
    baseUrl: 'https://api.minimax.chat/v1',
  });

  return {
    architect: new AISdkLangGraphAdapter(architect.model),
    developer: new AISdkLangGraphAdapter(developer.model),
    tester: new AISdkLangGraphAdapter(tester.model),
  };
}

// ==================== Node Functions ====================

async function architectNode(
  state: typeof DevTeamState.State,
): Promise<Partial<typeof DevTeamState.State>> {
  log.info('[DevTeam] 1/3 见远（架构师）开始分析...');
  console.log(colorize('\n🎯 见远（Kimi K3）正在思考...\n', 'cyan'));

  const { architect } = buildThreeModels();
  const messages = [
    new SystemMessage(ARCHITECT_SYSTEM_PROMPT),
    new HumanMessage(`用户任务：\n\n${state.userTask}`),
  ];

  // 流式输出：边生成边打印
  let architecture = '';
  for await (const chunk of architect.streamGenerate(messages)) {
    if (chunk.type === 'delta' && chunk.content) {
      process.stdout.write(chunk.content);
      architecture += chunk.content;
    } else if (chunk.type === 'done') {
      architecture = chunk.content;
    }
  }
  process.stdout.write('\n');

  log.info('[DevTeam] 见远输出方案长度:', architecture.length);

  return { architecture };
}

async function developerNode(
  state: typeof DevTeamState.State,
): Promise<Partial<typeof DevTeamState.State>> {
  log.info('[DevTeam] 2/3 动手（工程师）开始实现...');
  console.log(colorize('\n💻 动手（DeepSeek V4 Pro）正在写代码...\n', 'magenta'));

  const { developer } = buildThreeModels();
  const messages = [
    new SystemMessage(DEVELOPER_SYSTEM_PROMPT),
    new HumanMessage(
      `用户原始任务：\n${state.userTask}\n\n` +
      `架构师方案：\n${state.architecture}\n\n` +
      `请按架构师方案实现代码。`,
    ),
  ];

  let implementation = '';
  for await (const chunk of developer.streamGenerate(messages)) {
    if (chunk.type === 'delta' && chunk.content) {
      process.stdout.write(chunk.content);
      implementation += chunk.content;
    } else if (chunk.type === 'done') {
      implementation = chunk.content;
    }
  }
  process.stdout.write('\n');

  log.info('[DevTeam] 动手输出实现长度:', implementation.length);

  return { implementation };
}

async function testerNode(
  state: typeof DevTeamState.State,
): Promise<Partial<typeof DevTeamState.State>> {
  log.info('[DevTeam] 3/3 严测（测试员）开始验证...');
  console.log(colorize('\n🔍 严测（MiniMax M3）正在做静态 Review...\n', 'green'));

  const { tester } = buildThreeModels();
  const messages = [
    new SystemMessage(TESTER_SYSTEM_PROMPT),
    new HumanMessage(
      `用户原始任务：\n${state.userTask}\n\n` +
      `架构师方案：\n${state.architecture}\n\n` +
      `工程师实现：\n${state.implementation}\n\n` +
      `请验证实现是否符合方案 + 是否真解决用户问题。`,
    ),
  ];

  let verificationReport = '';
  for await (const chunk of tester.streamGenerate(messages)) {
    if (chunk.type === 'delta' && chunk.content) {
      process.stdout.write(chunk.content);
      verificationReport += chunk.content;
    } else if (chunk.type === 'done') {
      verificationReport = chunk.content;
    }
  }
  process.stdout.write('\n');

  log.info('[DevTeam] 严测输出报告长度:', verificationReport.length);

  // 简易成功判断：报告里包含 "VERDICT: PASS"
  const success = /VERDICT:\s*PASS/i.test(verificationReport);

  return { verificationReport, success };
}

async function summarizeNode(
  state: typeof DevTeamState.State,
): Promise<Partial<typeof DevTeamState.State>> {
  log.info('[DevTeam] 汇总最终报告...');

  const finalReport = `# RJ-laixue 研发天团 · 任务汇总

## 用户任务
${state.userTask}

---

## 1️⃣ 见远（Kimi K3）· 技术方案
${state.architecture}

---

## 2️⃣ 动手（DeepSeek V4 Pro）· 实现结果
${state.implementation}

---

## 3️⃣ 严测（MiniMax M3）· 验证报告
${state.verificationReport}

---

## ✅ 最终结论
${state.success ? '**整体通过** — 团队已交付可用实现。' : '**存在问题** — 见严测报告中的失败原因。'}
`;

  return { finalReport };
}

// ==================== Graph Construction ====================

function buildGraph() {
  const workflow = new StateGraph(DevTeamState)
    .addNode('architect', architectNode)
    .addNode('developer', developerNode)
    .addNode('tester', testerNode)
    .addNode('summarize', summarizeNode)
    .addEdge(START, 'architect')
    .addEdge('architect', 'developer')
    .addEdge('developer', 'tester')
    .addEdge('tester', 'summarize')
    .addEdge('summarize', END);

  return workflow.compile();
}

// ==================== Public API ====================

export interface DevTeamResult {
  userTask: string;
  architecture: string;
  implementation: string;
  verificationReport: string;
  finalReport: string;
  success: boolean;
}

/**
 * 跑一次 RJ-laixue 研发天团协作。
 *
 * @param userTask 用户任务描述（一段话）
 * @returns 团队产出的完整报告
 *
 * @example
 * ```ts
 * const result = await runDevTeam('修复登录页样式问题');
 * console.log(result.finalReport);
 * ```
 */
export async function runDevTeam(userTask: string): Promise<DevTeamResult> {
  log.info('[DevTeam] 开始协作任务:', userTask.slice(0, 80));
  const graph = buildGraph();
  const result = await graph.invoke({ userTask });

  return {
    userTask: result.userTask,
    architecture: result.architecture,
    implementation: result.implementation,
    verificationReport: result.verificationReport,
    finalReport: result.finalReport,
    success: result.success,
  };
}
