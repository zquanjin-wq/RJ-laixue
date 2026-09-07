import type { Pool } from 'pg';

export interface PptxSourceRecord {
  id: string;
  ownerUserId: string;
  assetId: string;
  originalFilename: string;
  status: 'uploaded' | 'parsed' | 'failed';
  contentHash: string | null;
  parserVersion: string | null;
  importResult: unknown;
  warnings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const columns = `id,owner_user_id AS "ownerUserId",asset_id AS "assetId",
  original_filename AS "originalFilename",status,content_hash AS "contentHash",
  parser_version AS "parserVersion",import_result AS "importResult",warnings,
  created_at AS "createdAt",updated_at AS "updatedAt"`;

export class PptxSourceRepository {
  constructor(private readonly pool: Pool) {}

  async register(input: {
    ownerUserId: string;
    assetId: string;
    originalFilename: string;
  }): Promise<PptxSourceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const asset = await client.query<{
        ownerUserId: string;
        state: string;
        kind: string;
        contentType: string;
      }>(
        `SELECT owner_user_id AS "ownerUserId",state,kind,content_type AS "contentType"
         FROM app.course_assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [input.assetId],
      );
      const row = asset.rows[0];
      if (!row || row.ownerUserId !== input.ownerUserId)
        throw new Error('PPTX source asset is not owned by this user');
      if (
        row.state !== 'ready' ||
        row.kind !== 'material' ||
        row.contentType !==
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ) {
        throw new Error('PPTX source asset is not confirmed');
      }
      const inserted = await client.query<PptxSourceRecord>(
        `INSERT INTO app.classroom_generation_sources (owner_user_id,asset_id,source_kind,original_filename)
         VALUES ($1,$2,'pptx',$3)
         ON CONFLICT (asset_id) DO NOTHING RETURNING ${columns}`,
        [input.ownerUserId, input.assetId, input.originalFilename],
      );
      if (inserted.rows[0]) {
        await client.query('COMMIT');
        return inserted.rows[0];
      }
      const existing = await client.query<PptxSourceRecord>(
        `SELECT ${columns} FROM app.classroom_generation_sources WHERE asset_id=$1 AND owner_user_id=$2`,
        [input.assetId, input.ownerUserId],
      );
      if (!existing.rows[0]) throw new Error('PPTX source asset belongs to another user');
      await client.query('COMMIT');
      return existing.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getOwned(id: string, ownerUserId: string): Promise<PptxSourceRecord | null> {
    const result = await this.pool.query<PptxSourceRecord>(
      `SELECT ${columns} FROM app.classroom_generation_sources WHERE id=$1 AND owner_user_id=$2`,
      [id, ownerUserId],
    );
    return result.rows[0] ?? null;
  }
}
