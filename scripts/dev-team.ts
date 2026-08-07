/**
 * Dev Team CLI — RJ-laixue 研发天团命令行入口
 *
 * 跑这个脚本就可以让团队协作处理一个任务：
 *
 *   pnpm dev-team "修这个 bug：xxx"
 *   pnpm dev-team "在课程页加一个导出按钮"
 *
 * 输出：
 *   - 控制台打印每个角色的输出（彩色）
 *   - 把完整报告保存到 dev-team-output/<timestamp>.md
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 加载 .env.local 或 .env 中的环境变量（Node 22+ 自带）
const { existsSync } = require('node:fs') as typeof import('node:fs');
try {
  if (existsSync('.env.local')) {
    process.loadEnvFile('.env.local');
  }
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
} catch {
  // 兼容老版本 Node
}

import { runDevTeam } from '../lib/orchestration/dev-team-graph';

// ANSI 颜色
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function printRoleHeader(role: string, model: string, emoji: string) {
  const line = '═'.repeat(70);
  console.log('\n' + colorize(line, 'cyan'));
  console.log(colorize(`  ${emoji}  ${role} · ${model}`, 'bold'));
  console.log(colorize(line, 'cyan'));
}

function checkEnvVars() {
  const required = {
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    console.error(colorize('\n❌ 缺少必要的 API Key:', 'red'));
    for (const key of missing) {
      console.error(colorize(`   - ${key}`, 'red'));
    }
    console.error(
      colorize(
        '\n请在 .env.local 文件里设置这些变量（参考下方说明）。\n',
        'yellow',
      ),
    );
    process.exit(1);
  }
}

async function main() {
  const task = process.argv.slice(2).join(' ').trim();

  if (!task) {
    console.error(colorize('用法：pnpm dev-team "你的任务描述"', 'yellow'));
    console.error(colorize('示例：pnpm dev-team "修复登录页样式问题"', 'dim'));
    process.exit(1);
  }

  console.log(colorize('\n🚀 RJ-laixue 研发天团启动', 'bold'));
  console.log(colorize(`任务：${task}\n`, 'dim'));

  checkEnvVars();

  console.log(colorize('📋 团队成员：', 'bold'));
  console.log(colorize('   1️⃣  见远    (Kimi K3)         → 架构师', 'blue'));
  console.log(colorize('   2️⃣  动手    (DeepSeek V4 Pro)  → 开发工程师', 'magenta'));
  console.log(colorize('   3️⃣  严测    (MiniMax M3)      → 测试验证员', 'green'));

  const startTime = Date.now();

  try {
    const result = await runDevTeam(task);

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

    // sub-graph 已经流式输出了 3 个角色的内容，这里只打印最终结论
    // （如果要复读，请直接读 dev-team-output/<时间戳>.md）

    // 最终结论
    console.log('\n' + '═'.repeat(70));
    if (result.success) {
      console.log(colorize('  ✅ 整体通过 — 团队已交付可用实现', 'green'));
    } else {
      console.log(colorize('  ⚠️  存在问题 — 见严测报告中的失败原因', 'yellow'));
    }
    console.log(colorize(`  ⏱️  耗时 ${totalSeconds} 秒`, 'dim'));
    console.log('═'.repeat(70) + '\n');

    // 保存完整报告到文件
    const outputDir = join(process.cwd(), 'dev-team-output');
    mkdirSync(outputDir, { recursive: true });

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const outputPath = join(outputDir, `${timestamp}.md`);
    writeFileSync(outputPath, result.finalReport, 'utf-8');

    console.log(colorize(`📄 完整报告已保存到：${outputPath}`, 'cyan'));
    console.log(colorize(`💰 预计消耗：3 个模型各 1 次调用（详见 API 后台）\n`, 'dim'));
  } catch (error) {
    console.error(colorize('\n❌ 团队协作失败：', 'red'));
    if (error instanceof Error) {
      console.error(colorize(error.message, 'red'));
      if (error.stack) {
        console.error(colorize('\n' + error.stack, 'dim'));
      }
    } else {
      console.error(colorize(String(error), 'red'));
    }
    process.exit(1);
  }
}

main();
