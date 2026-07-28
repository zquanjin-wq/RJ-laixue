# B2.2 完工报告：DocumentStore 双读比对（影子校验）

> 日期：2026-07-28
> 结论：**B2.2 代码验证通过**——DocumentStore 影子复制与双读指纹比对在真实课程、
> 真实数据源上达成 `match`。历史 Dexie 全量验证仍按门禁留待离线工具执行（见第 5 节）。

## 1. 安全边界（全程未变）

- 课堂课程文档的活跃来源始终是既有 Dexie 主路径；影子路径只读、异步、
  空闲时执行，任何失败静默回退，不阻断课程加载；
- 开关 `NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE` / `NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK`
  仅配置于 Vercel Preview，Production 未开启；
- 未向生产 Supabase 写入任何 DocumentStore 数据，未改写用户 Dexie 主数据。

## 2. 故障链与修复（三层根因，逐层实证）

| # | 现象 | 根因 | 修复 | 证据 |
|---|---|---|---|---|
| 1 | `document_parity / read_failure / TypeError` | tsconfig paths 将 `@openmaic/storage` 指向 `dist/index.d.ts`（零运行时导出），Turbopack 运行时 `new BrowserDocumentStore()` 抛 `(void 0) is not a constructor`；bridge/parity 同点失败，影子库恒为空 | `ac3ab6bd`：paths→src + `turbopack.resolveAlias`→dist（复刻 dsl `eab76ae0` 先例），新增配置哨兵测试防复发 | Preview Console 正文 + 修复后 TypeError 消失 |
| 2 | `document_bridge / failure / validation` | DSL `validateScene` 只拥有 slide/quiz；RJ `validateSceneExtended` 未按上游注入点契约放行自有种类 | `b69f1b9d`+`9ed4c89d`：吞掉 RJ 注册种类（interactive/pbl）的 unknown-kind 判别错误，RJ 内容校验 fail-loud（https url 或非空 html；projectConfig 对象）；`DOCUMENT_BRIDGE_VERSION` bump b2.2 使失败课程自动重试 | 真实课程探针：`txo6PVFVnx` 8 场景全过、bridge migrated + parity match |
| 3 | `1I_kD25GX1` 仍 validation | 场景 actions 数组混入 `{"type":"text"}` 伪动作——智能体文本片段误分类的生成链路脏数据，非任何一方的合法动作类型 | **不修校验器**（不给生成 bug 发通行证）。拍板①+③：源头修数据 + 生成链路立案（见 `2026-07-28-agent-text-action-leak.md`） | 探针逐字段定位到 scene `f2uC_5h8tlhYjy8_twk5Y` 的 actions[10] |

## 3. Preview 实测证据（2026-07-28，测试账号 d7274fee）

```text
document_bridge  outcome: success   bridgeVersion: b2.2
document_parity  outcome: match     source: legacy_dexie     ×4
document_parity  outcome: match     source: cloud_hydration  ×2
document_parity  outcome: missing_document  courseId: 1I_kD25GX1（第 3 层根因，已解释）
```

- `legacy_dexie` 源的 match 证明 Dexie 加载路径的影子复制与比对成立；
- `cloud_hydration` 源的 match 证明云端课程 JSON 路径成立；
- 唯一非 match 事件有明确、已测试的解释（生成链路脏数据，见第 4 节）。

## 4. 已知例外与后续

- **`1I_kD25GX1`**：actions 含 1 条伪 `"text"` 动作。按拍板执行源头数据修复
  （规格见 bug 立案文档）后重新打开课程验证 match。注意：生产 origin 的
  历史 Dexie 副本仍携带该脏数据，云端修复前该课程的 `legacy_dexie` 源会继续
  报 validation——这是 fail-loud 的正确行为，诊断中可按 courseId 识别。
- **widened-kind 覆盖广度**：本轮实测确认含 interactive 场景的课程
  （txo6PVFVnx）match；pbl 课程尚未遇到真实样本（harness 已有合成用例覆盖）。
  后续遇到 pbl 真实课程时用探针复验即可，无需改代码。

## 5. B2.3 切流前置条件（门禁，未变）

1. ~~Preview 至少两门云课程 `match`~~ ✅（本轮 6 个 match，双源）；
2. **历史 Dexie 全量离线验证**：用 `tests/document-bridge/real-course.probe.test.ts`
   （`COURSE_JSON` 驱动）/后续批量脚本，对测试账号生产 origin 的 Dexie 导出
   全量跑 bridge+parity，全部 match 或逐门有已测试解释——Codex 分工第 2 项
   （设计见 `2026-07-28-b2-widened-kind-and-offline-validation-decision.md` 第 2 节）；
3. 例外课程 `1I_kD25GX1` 完成数据修复并复测 match；
4. kill switch（双开关）保持已测状态；
5. 满足 1-4 后才评审 DocumentStore 主读写切换（B2.3）；RuntimeStore 与
   服务端持久化 adapter 按独立路线图推进（另行拍板）。

## 6. 本阶段产出清单

| 提交 | 内容 |
|---|---|
| `b697f853` | DocumentStore×RJ round-trip harness（真实 store × 真实校验器 × RJ 文档形状） |
| `ac3ab6bd` | 修复 @openmaic/storage 运行时解析（paths/resolveAlias）+ 配置哨兵测试 |
| `87150783` | 真实课程探针（COURSE_JSON 驱动）+ A/B/C 拍板文档 |
| `b69f1b9d` / `9ed4c89d` | widened-kind 放行（方案 A）+ 测试 + bridge 版本 bump |

测试基线：document-bridge 套件 17 项 + 哨兵 2 项全绿；真实课程探针
（txo6PVFVnx 完整 8 场景）migrated + match；`tsc --noEmit` 通过。
