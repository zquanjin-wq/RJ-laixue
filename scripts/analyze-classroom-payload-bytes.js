#!/usr/bin/env node
/**
 * 一次性诊断脚本：分析 /api/courses POST payload 的体积分布。
 * 任务卡 P0-3 步骤 2："新建课程为什么 payload 这么大？"
 *
 * 注意：这是只读诊断，不修改任何代码，不调用任何 API。
 * 模拟一个 maxed-out payload 按字段统计字节。
 */

const fs = require('node:fs');
const path = require('node:path');

// 模拟一个真实大小场景的 stage document（基于 schema）:
// - 8 个 scene（典型 30 分钟课件）
// - 每个 scene 有完整 outline + actions + actions 文本
// - **关键**：模拟内联 base64 资产（音频/图片/whiteboard）
function mockStageDocument() {
  // 一段 100KB 的虚构 base64 音频（模拟 80 秒 TTS 单声道 MP3）
  const fakeAudioBase64 = 'A'.repeat(100 * 1024);
  // 一段 50KB 的虚构 base64 图片（模拟 PDF 内联图）
  const fakeImageBase64 = 'B'.repeat(50 * 1024);
  // 一段 30KB 的 whiteboard 快照
  const fakeWhiteboard = { shapes: 'C'.repeat(30 * 1024) };

  return {
    stage: {
      id: 'stage-test',
      name: '测试课程',
      description: 'P0-3 payload 诊断',
      createdAt: 0,
      updatedAt: 0,
      agentIds: ['agent-1', 'agent-2'],
      // RJ-laixue 扩展
      teacherVoiceConfig: { providerId: 'minimax-tts', voiceId: 'female-yujie', modelId: 'speech-2.8-hd' },
    },
    scenes: Array.from({ length: 8 }, (_, i) => ({
      id: `scene-${i}`,
      stageId: 'stage-test',
      order: i,
      title: `第 ${i + 1} 节`,
      // RJ 扩展
      seq: i,
      // 可能的内联音频（最危险）
      audio: fakeAudioBase64,
      // 可能的内联图片
      image: fakeImageBase64,
      actions: [
        {
          id: `action-${i}-1`,
          type: 'speech',
          text: '这里是一段教学音频旁白，假设是 TTS 生成的文本。'.repeat(20),
          // 内联 base64 音频（最常见大体积来源）
          audioUrl: `data:audio/mp3;base64,${fakeAudioBase64}`,
        },
      ],
    })),
    whiteboard: fakeWhiteboard,
    history: [
      // 编辑历史快照（潜在大字段）
      { ts: 0, snapshot: fakeWhiteboard },
      { ts: 1, snapshot: fakeWhiteboard },
    ],
  };
}

const doc = mockStageDocument();

function sizeOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const stageSize = sizeOf(doc.stage);
const scenesSize = sizeOf(doc.scenes);
const whiteboardSize = sizeOf(doc.whiteboard);
const historySize = sizeOf(doc.history);
const totalSize = sizeOf(doc);

console.log('=== /api/courses POST payload 体积分布（模拟 8 scene 课程）===');
console.log(`总计:        ${(totalSize / 1024).toFixed(1)} KB (${totalSize} bytes)`);
console.log(`stage:       ${(stageSize / 1024).toFixed(1)} KB`);
console.log(`scenes (8):  ${(scenesSize / 1024).toFixed(1)} KB`);
console.log(`  └─ 每 scene 平均: ${(scenesSize / 8 / 1024).toFixed(1)} KB`);
console.log(`whiteboard:  ${(whiteboardSize / 1024).toFixed(1)} KB`);
console.log(`history:     ${(historySize / 1024).toFixed(1)} KB`);
console.log();
console.log('=== 假设 Vercel 4.5MB 限制 ===');
console.log(`当前模拟:    ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`限制:        4.50 MB`);
console.log(`超限倍数:    ${(totalSize / (4.5 * 1024 * 1024)).toFixed(2)}x`);
console.log();

// 模拟真实场景下的细分
console.log('=== 关键观察：base64 资产内联是大头 ===');
const singleAudioInline = 100 * 1024 * 8;  // 8 个 scene 各 100KB 音频
const singleImageInline = 50 * 1024 * 8;  // 8 ��� scene 各 50KB 图片
console.log(`音频 base64 (8 × 100KB): ${(singleAudioInline / 1024).toFixed(1)} KB (${(singleAudioInline / totalSize * 100).toFixed(0)}%)`);
console.log(`图片 base64 (8 × 50KB):  ${(singleImageInline / 1024).toFixed(1)} KB (${(singleImageInline / totalSize * 100).toFixed(0)}%)`);
console.log(`如果音频/图片直传 Supabase Storage，只存 URL:`);
const urlsOnly = 8 * 100; // 8 个 URL 字符串
console.log(`  → ${urlsOnly} bytes (节省 ${(((singleAudioInline + singleImageInline - urlsOnly) / totalSize) * 100).toFixed(0)}%)`);