/**
 * @openmaic/* 包解析不变量（2026-07-28，B2.2 TypeError 的回归哨兵）。
 *
 * 事故背景：tsconfig paths 曾把 `@openmaic/storage` 指到 `dist/index.d.ts`
 * （纯类型声明）。tsc 因此有类型，但 Turbopack/webpack 打包也跟随 paths，
 * 运行时拿到的是零导出模块——`new BrowserDocumentStore()` 变成
 * `TypeError: (void 0) is not a constructor`，且只在开启开关的 Preview 暴露。
 *
 * 由此固化为两条配置不变量：
 * 1. tsconfig paths 中任何 `@openmaic/*` 条目不得指向 `.d.ts`（指 source，
 *    与 `@openmaic/dsl` 一致）；
 * 2. 凡是 paths 指向 source 的 `@openmaic/*` 包，next.config.ts 的
 *    `turbopack.resolveAlias` 必须有指向其 `dist/index.js` 的别名
 *    （Turbopack 生产构建不会把 source 里的 `.js` 兄弟导入重映射到 `.ts`，
 *    见 docs/reports/2026-07-27-vercel-turbopack-dsl-build-fix.md）。
 *
 * 注意：这是对配置文本的轻量断言（next.config.ts 以文本方式检查），
 * 故意保持简单——它的职责是在有人再次引入同类不对称时立刻红灯。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
// tsconfig.json 是 JSONC（允许注释）；去注释后再 parse。两种注释都只匹配
// 行首（允许前导空白），避免误伤字符串内容（如 "@/*": ["./*"]）。
const tsconfigRaw = readFileSync(resolve(root, 'tsconfig.json'), 'utf8');
const tsconfigStripped = tsconfigRaw
  .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^\s*\/\/.*$/gm, '');
const tsconfig = JSON.parse(tsconfigStripped) as {
  compilerOptions?: { paths?: Record<string, string[]> };
};
const nextConfigText = readFileSync(resolve(root, 'next.config.ts'), 'utf8');

function openmaicPaths(): Record<string, string> {
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const result: Record<string, string> = {};
  for (const [specifier, targets] of Object.entries(paths)) {
    if (!specifier.startsWith('@openmaic/')) continue;
    expect(targets).toHaveLength(1);
    result[specifier] = targets[0];
  }
  return result;
}

describe('@openmaic/* 包解析不变量', () => {
  it('tsconfig paths 不得指向 .d.ts（打包器会跟随并拿到零导出模块）', () => {
    for (const [specifier, target] of Object.entries(openmaicPaths())) {
      expect(
        target.endsWith('.d.ts'),
        `${specifier} -> ${target} 指向类型声明文件；应指向 source（如 ./packages/.../src/index.ts）`,
      ).toBe(false);
    }
  });

  it('paths 指向 source 的包必须在 turbopack.resolveAlias 中有 dist 别名', () => {
    for (const [specifier, target] of Object.entries(openmaicPaths())) {
      if (!target.endsWith('/src/index.ts')) continue;
      const distAlias = `./packages/${specifier}/dist/index.js`;
      expect(
        nextConfigText,
        `${specifier} 的 tsconfig paths 指向 source，但 next.config.ts 缺少 ` +
          `turbopack.resolveAlias 条目 '${specifier}': '${distAlias}'`,
      ).toContain(`'${specifier}': '${distAlias}'`);
    }
  });
});
