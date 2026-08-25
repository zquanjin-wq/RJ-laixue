/**
 * scripts/runtime-observation-summary.ts
 *
 * 生产 shadow 七天观察期只读汇总脚本 CLI 入口。
 *
 * 用法：npx tsx scripts/runtime-observation-summary.ts <log-file.jsonl>
 *
 * 约束：不连接 Vercel、不连接生产数据库、不修改任何文件/环境变量。
 */

import { summarizeLogs, formatReport } from './runtime-observation-lib';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/runtime-observation-summary.ts <log-file.jsonl>');
    process.exit(1);
  }
  const filePath = args[0];
  const report = await summarizeLogs(filePath);
  console.log(formatReport(report));
}

// 仅直接执行时进入 CLI（导入时自动跳过）
const isDirectEntry = process.argv[1] && (
  process.argv[1].endsWith('runtime-observation-summary.ts') ||
  process.argv[1].endsWith('runtime-observation-summary.js')
);
if (isDirectEntry) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(2);
  });
}
