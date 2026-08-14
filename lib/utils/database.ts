import Dexie, { type EntityTable } from 'dexie';
import type {
  Scene,
  SceneType,
  SceneContent,
  Whiteboard,
  VideoManifest,
  GeneratedAgentConfig,
} from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type {
  SessionType,
  SessionStatus,
  SessionConfig,
  ToolCallRecord,
  ToolCallRequest,
} from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import type { VoiceDesign } from '@/lib/audio/voice-design';
import type { UIMessage } from 'ai';
import type { AgentEditSessionRecord } from '@/lib/agent/client/agent-edit-session-types';
import { createLogger } from '@/lib/logger';

const log = createLogger('Database');

/**
 * Legacy Snapshot type for undo/redo functionality
 * Used by useSnapshotStore
 */
export interface Snapshot {
  id?: number;
  index: number;
  slides: Scene[];
}

/**
 * MAIC Local Database
 *
 * Uses IndexedDB to store all user data locally
 * - Does not delete expired data; all data is stored permanently
 * - Uses a fixed database name
 * - Supports multi-course management
 */

// ==================== Database Table Type Definitions ====================

/**
 * Stage table - Course basic info
 */
export interface StageRecord {
  id: string; // Primary key
  name: string;
  description?: string;
  createdAt: number; // timestamp
  updatedAt: number; // timestamp
  languageDirective?: string;
  style?: string;
  currentSceneId?: string;
  agentIds?: string[]; // Agent IDs selected at creation time
  videoManifest?: VideoManifest; // Generated video request manifest; non-indexed
  interactiveMode?: boolean; // Interactive Mode flag; non-indexed
  taskEngineMode?: boolean; // Vocational Task Engine flag; non-indexed
  generatedAgentConfigs?: GeneratedAgentConfig[]; // Editor-authored agent roster snapshot
  /** The course-authoritative AI teacher voice. Persisted locally and in cloud. */
  teacherVoiceConfig?: {
    providerId: string;
    voiceId: string;
    modelId?: string;
  };
  /** Scene order trust flag (added in v15).
   *  - `true`  : this stage's scene `seq` is authoritative; loadStageData
   *              uses prefer='auto' (trust seq).
   *  - `false` / undefined : legacy state. loadStageData must run
   *              prefer='createdAt' to recover real order, then set
   *              this flag to true so subsequent reads trust seq.
   *  v15 migration sets this to true for all existing stages because v14
   *  already recovered their seq using prefer='createdAt'. */
  sceneOrderTrusted?: boolean;
  /** Timestamp of last successful seq recovery (preferred='createdAt').
   *  Useful for ops debugging. Optional. */
  sceneOrderRepairedAt?: number;
}

/**
 * Scene table - Scene/page data
 */
export interface SceneRecord {
  id: string; // Primary key
  stageId: string; // Foreign key -> stages.id
  type: SceneType;
  title: string;
  order: number; // Display order (legacy — DO NOT trust for display; use seq)
  /** Monotonic insertion sequence assigned at save time. Sort by this for
   *  display order. Always equals array index on save. Survives bulkPut
   *  re-keying and gives a stable, trustworthy ordering even when the legacy
   *  `order` field has been corrupted by imports / pre-rebalance writes. */
  seq: number;
  content: SceneContent; // Stored as JSON
  actions?: Action[]; // Stored as JSON
  whiteboard?: Whiteboard[]; // Stored as JSON
  createdAt: number;
  updatedAt: number;
}

/**
 * AudioFile table - Audio files (TTS)
 */
export interface AudioFileRecord {
  id: string; // Primary key (audioId)
  /** Owning course. Absent only on legacy cache records. */
  stageId?: string;
  blob: Blob; // Audio binary data
  duration?: number; // Duration (seconds)
  format: string; // mp3, wav, etc.
  text?: string; // Corresponding text content
  voice?: string; // Voice used
  createdAt: number;
  ossKey?: string; // Full CDN URL for this audio blob
}

/**
 * ImageFile table - Image files
 */
export interface ImageFileRecord {
  id: string; // Primary key
  blob: Blob; // Image binary data
  filename: string; // Original filename
  mimeType: string; // image/png, image/jpeg, etc.
  size: number; // File size (bytes)
  createdAt: number;
}

/**
 * ChatSession table - Chat session data
 */
export interface ChatSessionRecord {
  id: string; // PK (session id)
  stageId: string; // FK -> stages.id
  type: SessionType;
  title: string;
  status: SessionStatus;
  messages: UIMessage[]; // JSON-safe serialized messages
  config: SessionConfig;
  toolCalls: ToolCallRecord[];
  pendingToolCalls: ToolCallRequest[];
  createdAt: number;
  updatedAt: number;
  sceneId?: string;
  lastActionIndex?: number;
}

/**
 * PlaybackState table - Playback state snapshot (at most one per stage)
 *
 * R2.1 A1（2026-07-31）：新增可选字段 sceneId / capturedAt / completed。
 * 非索引字段，Dexie 无需 version bump；旧行读出为 undefined，按语义降级。
 * A2 字段（runtimeShadowEventId / shadowPending）待 A1 验收后再加。
 */
export interface PlaybackStateRecord {
  stageId: string; // PK
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  updatedAt: number;
  /** 稳定场景标识——恢复定位主键（sceneIndex 只作辅助校验） */
  sceneId?: string;
  /** ISO 时间戳，快照捕获时刻（A2 起作为「最新」的唯一判据） */
  capturedAt?: string;
  /** 播完标记：不参与本地续播；A2 影子写成功后才物理删除（R2.1 §3.4） */
  completed?: boolean;
  /** A2：影子写幂等锚点——每次业务落盘生成的新 UUID，随快照同一次 put 持久化 */
  runtimeShadowEventId?: string;
  /** A2：结构化 pending（非松散布尔）。发送成功后只能条件清除：
   *  仅当数据库当前 eventId === 已发送 eventId 时清除（R2.1 §4.3） */
  shadowPending?: { eventId: string; capturedAt: string };
  /** R3.1：completed 行的 set_status outbox entry ID，用于清理时校验 succeededEntries */
  r3OutboxStatusEntryId?: string;
}

/**
 * StageOutlines table - Persisted outlines for resume-on-refresh
 */
export interface StageOutlinesRecord {
  stageId: string; // Primary key (FK -> stages.id)
  outlines: SceneOutline[];
  // True once generation finished for this stage. Gates resume-on-mount so an
  // edited (e.g. slide-deleted) finished deck is not treated as "interrupted"
  // and regenerated. Optional for backward compat with pre-existing records.
  generationComplete?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * MediaFile table - AI-generated media files (images/videos)
 */
export interface MediaFileRecord {
  id: string; // Compound key: `${stageId}:${elementId}`
  stageId: string; // FK → stages.id
  type: 'image' | 'video';
  blob: Blob; // Media binary
  mimeType: string; // image/png, video/mp4
  size: number;
  poster?: Blob; // Video thumbnail blob
  prompt: string; // Original prompt (for retry)
  params: string; // JSON-serialized generation params
  error?: string; // If set, this is a failed task (blob is empty placeholder)
  errorCode?: string; // Structured error code (e.g. 'CONTENT_SENSITIVE')
  ossKey?: string; // Full CDN URL for this media blob
  posterOssKey?: string; // Full CDN URL for the poster blob
  createdAt: number;
}

/**
 * GeneratedAgent table - AI-generated agent profiles
 */
export interface GeneratedAgentRecord {
  id: string; // PK: agent ID (e.g. "gen-abc123")
  stageId: string; // FK -> stages.id
  name: string;
  role: string; // 'teacher' | 'assistant' | 'student'
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voiceDesign?: VoiceDesign; // 3-layer vocal descriptor for auto voice
  createdAt: number;
}

/**
 * VoiceProfile table - Browser-local TTS voice profiles
 */
export interface VoiceProfileRecord {
  id: string;
  providerId: string;
  kind: 'prompt' | 'clone';
  name: string;
  voicePrompt?: string;
  promptText?: string;
  referenceAudio?: Blob;
  referenceAudioName?: string;
  referenceAudioMimeType?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Cached reference clip for a registered auto voice (any TTS provider). The
 * clip is the source of truth; the deterministic `voiceId` is its key, enabling
 * register-on-invalid re-registration after backend GC/restart.
 */
export interface AutoVoiceCacheRecord {
  voiceId: string;
  referenceAudio: Blob;
  mimeType: string;
  updatedAt: number;
}

/**
 * RuntimeOutbox table - R3.0 通用 outbox（v16）
 * 持久化的"待发送到服务端的操作"列表，跨标签页安全。
 */
export interface RuntimeOutboxEntry {
  id: string;
  kind: 'playback' | 'quizAttempt' | 'chat';
  op: 'create_session' | 'append_record' | 'set_status';
  sessionId: string;
  recordId?: string;
  semanticKey: string;
  body: unknown;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastError?: string;
  leaseOwner?: string;
  leaseUntil?: string;
  status: 'pending' | 'sending' | 'superseded' | 'dead';
  sequence?: number;
  dependsOnEntryId?: string;
  deadReason?: string;
  deadAt?: string;
}

/**
 * SucceededEntries table - R3.0 成功凭据（v16）
 * 条目成功发送并从 outbox 删除时，在同一事务内写入此表。
 * 依赖检查时不得单凭"前置条目不在 outbox"推断成功，
 * 必须查询此表确认真实成功凭据。
 */
export interface SucceededEntry {
  entryId: string;
  deletedAt: string;
}

/**
 * RuntimeChainHeads table - R3.2 严格链尾（v17）
 * 每个 session 记录当前链尾的 outbox entry ID。
 * 与 outbox 入队在同一 rw 事务内原子更新。
 */
export interface RuntimeChainHead {
  sessionId: string;
  tailEntryId: string;
  updatedAt: string;
}

/**
 * PlaybackVisit table - R3.1a 跨 completed playback cycle（v18）
 * 每次有效的已持久化播放周期对应一行。主键 visitId 为全局唯一 32-hex ID。
 */
export interface PlaybackVisit {
  visitId: string;           // PK
  stageId: string;
  tabOwnerId: string;        // 32 hex
  sessionId: string;         // = "pb:<stageId>:<visitId>"（legacy = "pb:<stageId>"）
  status: 'active' | 'completed';
  createEntryId?: string;
  completedStatusEntryId?: string;
  createdAt: string;
  completedCredentialAt?: string;
  isLegacyAdopted?: boolean;  // v17→v18 迁移标记
}

/**
 * PlaybackVisitStates table - R3.1a visit-specific snapshot/state（v18）
 * 与 legacy playbackState 行对应，但按 visitId 隔离，消除跨标签页覆盖。
 */
export interface PlaybackVisitState {
  visitId: string;           // PK
  stageId: string;
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  updatedAt: number;
  sceneId?: string;
  capturedAt?: string;
  completed?: boolean;
  runtimeShadowEventId?: string;
  shadowPending?: { eventId: string; capturedAt: string };
}

/** Build the compound primary key for mediaFiles: `${stageId}:${elementId}` */
export function mediaFileKey(stageId: string, elementId: string): string {
  return `${stageId}:${elementId}`;
}

// ==================== Database Definition ====================

const DATABASE_NAME = 'MAIC-Database';
const _DATABASE_VERSION = 16;

/**
 * MAIC Database Instance
 */
class MAICDatabase extends Dexie {
  // Table definitions
  stages!: EntityTable<StageRecord, 'id'>;
  scenes!: EntityTable<SceneRecord, 'id'>;
  audioFiles!: EntityTable<AudioFileRecord, 'id'>;
  imageFiles!: EntityTable<ImageFileRecord, 'id'>;
  snapshots!: EntityTable<Snapshot, 'id'>; // Undo/redo snapshots (legacy)
  chatSessions!: EntityTable<ChatSessionRecord, 'id'>;
  playbackState!: EntityTable<PlaybackStateRecord, 'stageId'>;
  stageOutlines!: EntityTable<StageOutlinesRecord, 'stageId'>;
  mediaFiles!: EntityTable<MediaFileRecord, 'id'>;
  generatedAgents!: EntityTable<GeneratedAgentRecord, 'id'>;
  voiceProfiles!: EntityTable<VoiceProfileRecord, 'id'>;
  autoVoiceCache!: EntityTable<AutoVoiceCacheRecord, 'voiceId'>;
  agentEditSessions!: EntityTable<AgentEditSessionRecord, 'id'>;
  runtimeOutbox!: EntityTable<RuntimeOutboxEntry, 'id'>;
  succeededEntries!: EntityTable<SucceededEntry, 'entryId'>;
  runtimeChainHeads!: EntityTable<RuntimeChainHead, 'sessionId'>;
  playbackVisits!: EntityTable<PlaybackVisit, 'visitId'>;
  playbackVisitStates!: EntityTable<PlaybackVisitState, 'visitId'>;

  constructor() {
    super(DATABASE_NAME);

    // Version 1: Initial schema
    this.version(1).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      // Previously had: messages, participants, discussions, sceneSnapshots
    });

    // Version 2: Remove unused tables
    this.version(2).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      // Delete removed tables
      messages: null,
      participants: null,
      discussions: null,
      sceneSnapshots: null,
    });

    // Version 3: Add chatSessions and playbackState tables
    this.version(3).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
    });

    // Version 4: Add stageOutlines table for resume-on-refresh
    this.version(4).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
    });

    // Version 5: Add mediaFiles table for async media generation
    this.version(5).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
    });

    // Version 6: Fix mediaFiles primary key — use compound key stageId:elementId
    // to prevent cross-course collisions (gen_img_1 is NOT globally unique)
    this.version(6)
      .stores({
        stages: 'id, updatedAt',
        scenes: 'id, stageId, order, [stageId+order]',
        audioFiles: 'id, createdAt',
        imageFiles: 'id, createdAt',
        snapshots: '++id',
        chatSessions: 'id, stageId, [stageId+createdAt]',
        playbackState: 'stageId',
        stageOutlines: 'stageId',
        mediaFiles: 'id, stageId, [stageId+type]',
      })
      .upgrade(async (tx) => {
        const table = tx.table('mediaFiles');
        const allRecords = await table.toArray();
        for (const rec of allRecords) {
          const newKey = `${rec.stageId}:${rec.id}`;
          // Skip if already migrated (idempotent)
          if (rec.id.includes(':')) continue;
          await table.delete(rec.id);
          await table.put({ ...rec, id: newKey });
        }
      });

    // Version 7: Add ossKey fields to mediaFiles and audioFiles for OSS storage plugin
    // Non-indexed optional fields — Dexie handles these transparently.
    this.version(7).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
    });

    // Version 8: Add generatedAgents table for AI-generated agent profiles
    this.version(8).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
    });

    // Version 9: Migrate legacy `language` field to `languageDirective`
    // Old stages stored a BCP-47 locale code (e.g. "zh-CN"); new code expects a
    // natural-language directive. Convert known locales and drop the old field.
    const LOCALE_TO_DIRECTIVE: Record<string, string> = {
      'zh-CN': 'Deliver the entire course in Chinese (Simplified, zh-CN).',
      'en-US': 'Deliver the entire course in English (en-US).',
      'ja-JP': 'Deliver the entire course in Japanese (ja-JP).',
      'ru-RU': 'Deliver the entire course in Russian (ru-RU).',
    };
    this.version(9)
      .stores({
        stages: 'id, updatedAt',
        scenes: 'id, stageId, order, [stageId+order]',
        audioFiles: 'id, createdAt',
        imageFiles: 'id, createdAt',
        snapshots: '++id',
        chatSessions: 'id, stageId, [stageId+createdAt]',
        playbackState: 'stageId',
        stageOutlines: 'stageId',
        mediaFiles: 'id, stageId, [stageId+type]',
        generatedAgents: 'id, stageId',
      })
      .upgrade(async (tx) => {
        const table = tx.table('stages');
        await table.toCollection().modify((stage: Record<string, unknown>) => {
          const lang = stage.language as string | undefined;
          if (lang && !stage.languageDirective) {
            stage.languageDirective =
              LOCALE_TO_DIRECTIVE[lang] || `Deliver the entire course in ${lang}.`;
          }
          delete stage.language;
        });
      });

    // Version 10: Add browser-local voice profiles for serverless TTS voice storage.
    this.version(10).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
    });

    // Version 11: Add auto-voice reference-clip cache (provider-neutral register-by-id).
    this.version(11).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
    });

    // Version 12: Add agentEditSessions — multi-session AI-editing conversation
    // history per stage (replaces the single-thread localStorage store).
    this.version(12).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
      agentEditSessions: 'id, stageId, [stageId+updatedAt]',
    });

    // Version 13: Add scenes.seq — monotonic insertion sequence, the new
    // trusted display order. The legacy `order` field is unreliable (cloud
    // imports, pre-rebalance writes, duplicate values); `seq` is assigned at
    // save time as array index, then sorted on load to guarantee stable
    // page order even when the source data is corrupted.
    //
    // Migration strategy: for existing records, assign seq by their CURRENT
    // sortBy('order') position. This preserves whatever ordering was last
    // applied. The next save (triggered by any user edit, or by the
    // classroom page's self-heal block) re-writes seq as the new array
    // index, fully correcting the data.
    this.version(13)
      .stores({
        stages: 'id, updatedAt',
        scenes: 'id, stageId, order, seq, [stageId+order], [stageId+seq]',
        audioFiles: 'id, createdAt',
        imageFiles: 'id, createdAt',
        snapshots: '++id',
        chatSessions: 'id, stageId, [stageId+createdAt]',
        playbackState: 'stageId',
        stageOutlines: 'stageId',
        mediaFiles: 'id, stageId, [stageId+type]',
        generatedAgents: 'id, stageId',
        voiceProfiles: 'id, providerId, kind, updatedAt',
        autoVoiceCache: 'voiceId, updatedAt',
        agentEditSessions: 'id, stageId, [stageId+updatedAt]',
      })
      .upgrade(async (tx) => {
        const table = tx.table('scenes');
        // Group existing scenes by stageId, sort by current order, assign
        // seq = index. This is the best deterministic mapping we can do
        // without knowing the "true" order — it preserves the user's last
        // applied ordering.
        const all = await table.toArray();
        const byStage = new Map<string, Array<{ id: string; order: number }>>();
        for (const rec of all) {
          const sid = rec.stageId as string;
          if (!sid) continue;
          if (!byStage.has(sid)) byStage.set(sid, []);
          byStage.get(sid)!.push({ id: rec.id, order: rec.order ?? 0 });
        }
        for (const [, list] of byStage) {
          list.sort((a, b) => a.order - b.order);
        }
        for (const [, list] of byStage) {
          for (let i = 0; i < list.length; i++) {
            await table.update(list[i].id, { seq: i });
          }
        }
      });

    // Version 14: Re-recover `seq` for courses already touched by v13.
    //
    // v13 migration sorted by `order` to assign seq — but `order` has been
    // demonstrated to be untrustworthy (cloud imports, pre-rebalance writes,
    // duplicate values). v13 therefore froze whatever corruption existed at
    // upgrade time into a "valid-looking" seq=0,1,2,..., which downstream
    // code (sortBy('seq'), collectStageData) faithfully reproduces.
    //
    // v14 re-recovers seq using the trusted comparator in
    // lib/utils/scene-order.ts with `prefer: 'createdAt'` — this **explicitly
    // ignores seq** because seq itself was poisoned by v13. Sort priority:
    // createdAt → updatedAt → id. Dedups by id. Normalizes seq=order=index.
    //
    // MUST pass prefer: 'createdAt' — default 'auto' would still pick 'seq'
    // for any course where seq looks valid (which is exactly the poisoned
    // state v13 left behind).
    //
    // Every stage gets delete + bulkPut unconditionally. We can't rely on
    // "source !== 'seq'" to skip writes because the goal of v14 is precisely
    // to overwrite the poisoned seq=0,1,2... with the freshly recovered
    // ordering.
    this.version(14)
      .stores({
        stages: 'id, updatedAt',
        scenes: 'id, stageId, order, seq, [stageId+order], [stageId+seq]',
        audioFiles: 'id, createdAt',
        imageFiles: 'id, createdAt',
        snapshots: '++id',
        chatSessions: 'id, stageId, [stageId+createdAt]',
        playbackState: 'stageId',
        stageOutlines: 'stageId',
        mediaFiles: 'id, stageId, [stageId+type]',
        generatedAgents: 'id, stageId',
        voiceProfiles: 'id, providerId, kind, updatedAt',
        autoVoiceCache: 'voiceId, updatedAt',
        agentEditSessions: 'id, stageId, [stageId+updatedAt]',
      })
      .upgrade(async (tx) => {
        const { orderSceneRecordsForDisplay } = await import('./scene-order');
        const { createLogger } = await import('@/lib/logger');
        const v14Log = createLogger('DB Migration v14');
        const table = tx.table('scenes');
        const all = (await table.toArray()) as Array<{
          id: string;
          stageId: string;
          seq?: number;
          order?: number;
          createdAt?: number;
          updatedAt?: number;
          title?: string;
        }>;
        const byStage = new Map<string, typeof all>();
        for (const rec of all) {
          if (!rec.stageId) continue;
          if (!byStage.has(rec.stageId)) byStage.set(rec.stageId, []);
          byStage.get(rec.stageId)!.push(rec);
        }
        let totalReordered = 0;
        let totalDuplicatesRemoved = 0;
        for (const [stageId, list] of byStage) {
          const before = list.slice(0, 10).map((s) => ({
            id: s.id,
            title: s.title,
            order: s.order,
            seq: s.seq,
            createdAt: s.createdAt,
          }));
          const result = orderSceneRecordsForDisplay(list, {
            prefer: 'createdAt',
          });
          totalDuplicatesRemoved += result.duplicateIdsRemoved.length;
          const after = result.ordered.slice(0, 10).map((s) => ({
            id: s.id,
            title: s.title,
            order: s.order,
            seq: s.seq,
            createdAt: s.createdAt,
          }));
          v14Log.info('[v14 Migration]', {
            stageId,
            source: result.source,
            beforeCount: list.length,
            afterCount: result.ordered.length,
            first10Before: before,
            first10After: after,
          });
          // Unconditional delete + bulkPut: v14 always rewrites seq/order,
          // because the goal is to overwrite v13's poisoned seq.
          await table.where('stageId').equals(stageId).delete();
          await table.bulkPut(
            result.ordered as Array<Record<string, unknown>>,
          );
          totalReordered += list.length;
        }
        v14Log.info('[v14 Migration] Complete', {
          totalStages: byStage.size,
          totalReordered,
          totalDuplicatesRemoved,
        });
      });

    // Version 15: Stage trust flag for scene order.
    //
    // Schema doesn't change (stages/scenes stores stay identical). We only
    // add two new optional fields to stages records: `sceneOrderTrusted`
    // and `sceneOrderRepairedAt`. v14 already recovered every stage's seq
    // using prefer='createdAt', so by v15 transition the seq field IS
    // trustworthy — we can mark every stage as trusted.
    //
    // Future reads (loadStageData, getScenesByStageId, thumbnails) will
    // use prefer='auto' (trust seq) on stages with sceneOrderTrusted=true,
    // and fall back to prefer='createdAt' only when the flag is false or
    // missing. This restores normal seq-based ordering while keeping the
    // door open for one-shot recovery of legacy courses.
    //
    // Any stage created after this migration but before the first write
    // won't have the flag set — that's fine, loadStageData treats
    // undefined as untrusted and runs the recovery pass once.
    this.version(15)
      .stores({
        stages: 'id, updatedAt',
        scenes: 'id, stageId, order, seq, [stageId+order], [stageId+seq]',
        audioFiles: 'id, createdAt',
        imageFiles: 'id, createdAt',
        snapshots: '++id',
        chatSessions: 'id, stageId, [stageId+createdAt]',
        playbackState: 'stageId',
        stageOutlines: 'stageId',
        mediaFiles: 'id, stageId, [stageId+type]',
        generatedAgents: 'id, stageId',
        voiceProfiles: 'id, providerId, kind, updatedAt',
        autoVoiceCache: 'voiceId, updatedAt',
        agentEditSessions: 'id, stageId, [stageId+updatedAt]',
      })
      .upgrade(async (tx) => {
        const { createLogger } = await import('@/lib/logger');
        const v15Log = createLogger('DB Migration v15');
        const stagesTable = tx.table('stages');
        const allStages = (await stagesTable.toArray()) as Array<{
          id: string;
          sceneOrderTrusted?: boolean;
          sceneOrderRepairedAt?: number;
        }>;
        const now = Date.now();
        let updated = 0;
        for (const s of allStages) {
          // Skip stages that already have an explicit trust state.
          if (s.sceneOrderTrusted !== undefined) continue;
          await stagesTable.update(s.id, {
            sceneOrderTrusted: true,
            sceneOrderRepairedAt: now,
          });
          updated++;
        }
        v15Log.info('[v15 Migration] Marked existing stages as sceneOrderTrusted=true', {
          totalStages: allStages.length,
          updated,
          skippedAlreadySet: allStages.length - updated,
        });
      });

    // Version 16: R3.0 RuntimeStore 通用 outbox
    // 新增 runtimeOutbox 表（持久化的"待发送到服务端的操作"列表）
    // 和 succeededEntries 表（成功凭据，解决"不存在≠成功"问题）
    this.version(16).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, seq, [stageId+order], [stageId+seq]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
      agentEditSessions: 'id, stageId, [stageId+updatedAt]',
      runtimeOutbox: 'id, kind, status, createdAt, semanticKey, sessionId, sequence, dependsOnEntryId, [kind+status], [sessionId+sequence]',
      succeededEntries: 'entryId, deletedAt',
    });

    // R3.2 严格链尾表（v17）
    this.version(17).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, seq, [stageId+order], [stageId+seq]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
      agentEditSessions: 'id, stageId, [stageId+updatedAt]',
      runtimeOutbox: 'id, kind, status, createdAt, semanticKey, sessionId, sequence, dependsOnEntryId, [kind+status], [sessionId+sequence]',
      succeededEntries: 'entryId, deletedAt',
      runtimeChainHeads: 'sessionId',
    });

    // R3.1a Playback visit-session lifecycle（v18）
    this.version(18).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, seq, [stageId+order], [stageId+seq]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      playbackVisits: 'visitId, [stageId+status], [tabOwnerId+stageId], completedCredentialAt',
      playbackVisitStates: 'visitId, [stageId+visitId]',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
      agentEditSessions: 'id, stageId, [stageId+updatedAt]',
      runtimeOutbox: 'id, kind, status, createdAt, semanticKey, sessionId, sequence, dependsOnEntryId, [kind+status], [sessionId+sequence]',
      succeededEntries: 'entryId, deletedAt',
      runtimeChainHeads: 'sessionId',
    }).upgrade(async (tx) => {
      // v17→v18 migration: legacy playbackState → visits + visitStates
      const oldRows = await tx.table('playbackState').toArray();
      if (oldRows.length === 0) return;

      const legacyVisits: PlaybackVisit[] = oldRows.map((row: any) => ({
        visitId: `legacy-${row.stageId}`,
        stageId: row.stageId,
        tabOwnerId: 'legacy-unknown',
        sessionId: `pb:${row.stageId}`,  // 旧 outbox session identity 原样保留
        status: row.completed ? 'completed' : 'active',
        createdAt: new Date(row.updatedAt || Date.now()).toISOString(),
        isLegacyAdopted: true,
      }));
      await tx.table('playbackVisits').bulkAdd(legacyVisits);

      const newStates: PlaybackVisitState[] = oldRows.map((row: any) => ({
        visitId: `legacy-${row.stageId}`,
        stageId: row.stageId,
        sceneIndex: row.sceneIndex ?? 0,
        actionIndex: row.actionIndex ?? 0,
        consumedDiscussions: row.consumedDiscussions ?? [],
        sceneId: row.sceneId,
        capturedAt: row.capturedAt,
        updatedAt: row.updatedAt ?? Date.now(),
        completed: row.completed,
        runtimeShadowEventId: row.runtimeShadowEventId,
        shadowPending: row.shadowPending,
      }));
      await tx.table('playbackVisitStates').bulkAdd(newStates);

      // 旧 playbackState 行不删除（v19+ 另案）
    });
  }
}

// Create database instance
export const db = new MAICDatabase();

// ==================== Helper Functions ====================

/**
 * Initialize database
 * Call at application startup
 */
export async function initDatabase(): Promise<void> {
  try {
    await db.open();
    // Request persistent storage to prevent browser from evicting IndexedDB
    // under storage pressure (large media blobs can trigger LRU cleanup)
    void navigator.storage?.persist?.();
    log.info('Database initialized successfully');
  } catch (error) {
    log.error('Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Clear database (optional)
 * Use with caution: deletes all data
 */
export async function clearDatabase(): Promise<void> {
  await db.delete();
  log.info('Database cleared');
}

/**
 * Export database contents (for backup)
 */
export async function exportDatabase(): Promise<{
  stages: StageRecord[];
  scenes: SceneRecord[];
  chatSessions: ChatSessionRecord[];
  playbackState: PlaybackStateRecord[];
}> {
  return {
    stages: await db.stages.toArray(),
    scenes: await db.scenes.toArray(),
    chatSessions: await db.chatSessions.toArray(),
    playbackState: await db.playbackState.toArray(),
  };
}

/**
 * Import database contents (for restoring backups)
 */
export async function importDatabase(data: {
  stages?: StageRecord[];
  scenes?: SceneRecord[];
  chatSessions?: ChatSessionRecord[];
  playbackState?: PlaybackStateRecord[];
}): Promise<void> {
  await db.transaction(
    'rw',
    [db.stages, db.scenes, db.chatSessions, db.playbackState],
    async () => {
      if (data.stages) await db.stages.bulkPut(data.stages);
      if (data.scenes) await db.scenes.bulkPut(data.scenes);
      if (data.chatSessions) await db.chatSessions.bulkPut(data.chatSessions);
      if (data.playbackState) await db.playbackState.bulkPut(data.playbackState);
    },
  );
  log.info('Database imported successfully');
}

// ==================== Convenience Query Functions ====================

/**
 * Get all scenes for a course
 */
export async function getScenesByStageId(stageId: string): Promise<SceneRecord[]> {
  // Trust model (introduced v15): once a stage has sceneOrderTrusted=true
  // (set by loadStageData after the one-shot recovery, or by v15 migration
  // for legacy stages), seq is authoritative. Use prefer='auto' so we
  // surface the user's manual reorder rather than resetting to createdAt.
  // Callers that may see a brand-new stage (no flag yet) get the recovery
  // path naturally — loadStageData flips the flag on its next read.
  const { orderSceneRecordsForDisplay } = await import('./scene-order');
  const rawScenes = await db.scenes.where('stageId').equals(stageId).toArray();
  return orderSceneRecordsForDisplay(rawScenes, { prefer: 'auto' }).ordered;
}

/**
 * Delete a course and all its related data
 */
export async function deleteStageWithRelatedData(stageId: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.stages,
      db.scenes,
      db.chatSessions,
      db.playbackState,
      db.stageOutlines,
      db.mediaFiles,
      db.generatedAgents,
      db.agentEditSessions,
    ],
    async () => {
      await db.stages.delete(stageId);
      await db.scenes.where('stageId').equals(stageId).delete();
      await db.chatSessions.where('stageId').equals(stageId).delete();
      await db.playbackState.delete(stageId);
      await db.stageOutlines.delete(stageId);
      await db.mediaFiles.where('stageId').equals(stageId).delete();
      await db.generatedAgents.where('stageId').equals(stageId).delete();
      await db.agentEditSessions.where('stageId').equals(stageId).delete();
    },
  );
}

/**
 * Get all generated agents for a course
 */
export async function getGeneratedAgentsByStageId(
  stageId: string,
): Promise<GeneratedAgentRecord[]> {
  return db.generatedAgents.where('stageId').equals(stageId).toArray();
}

/**
 * Get database statistics
 */
export async function getDatabaseStats() {
  return {
    stages: await db.stages.count(),
    scenes: await db.scenes.count(),
    audioFiles: await db.audioFiles.count(),
    imageFiles: await db.imageFiles.count(),
    snapshots: await db.snapshots.count(),
    chatSessions: await db.chatSessions.count(),
    playbackState: await db.playbackState.count(),
    stageOutlines: await db.stageOutlines.count(),
    mediaFiles: await db.mediaFiles.count(),
    generatedAgents: await db.generatedAgents.count(),
  };
}
