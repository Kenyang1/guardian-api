import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { Viewer } from '../schemas/viewer';

/**
 * Trusted-viewers repository. Same seam as the other repos.
 *
 * The invite lifecycle lives in the status column:
 *   invite  -> row exists, viewer_uid NULL, status 'pending'
 *   accept  -> viewer_uid filled (identity bound), status 'accepted'
 *   revoke  -> same row kept, status 'revoked' (audit trail + dead invite ids)
 *
 * hasAcceptedAccess() is the security kernel of the milestone: exactly one of
 * the three states grants read access, and the check is a single indexed
 * lookup the middleware runs per request.
 */

export interface ViewersRepo {
  // Upsert-ish: re-inviting a revoked email re-opens it as pending; an
  // existing pending/accepted invite is returned unchanged (idempotent).
  invite(ownerUid: string, viewerEmail: string): Promise<Viewer>;
  // Binds the caller's uid to a pending invite - but only if the caller's
  // verified token email matches the invited email. Null = no such invite
  // for you (missing id, wrong email, or not pending) -> route sends 404.
  accept(inviteId: string, viewerUid: string, viewerEmail: string): Promise<Viewer | null>;
  // Owner-scoped, like every mutation in this API. False -> 404.
  revoke(ownerUid: string, id: string): Promise<boolean>;
  listForOwner(ownerUid: string): Promise<Viewer[]>;
  // Owners who shared with this viewer (accepted only).
  sharedWithMe(viewerUid: string): Promise<Viewer[]>;
  hasAcceptedAccess(ownerUid: string, viewerUid: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests / local hacking)
// ---------------------------------------------------------------------------

export class InMemoryViewersRepo implements ViewersRepo {
  private rows: Viewer[] = [];

  async invite(ownerUid: string, viewerEmail: string): Promise<Viewer> {
    const email = viewerEmail.toLowerCase();
    const existing = this.rows.find((r) => r.ownerUid === ownerUid && r.viewerEmail === email);
    if (existing) {
      if (existing.status === 'revoked') {
        existing.status = 'pending';
        existing.viewerUid = null;
      }
      return existing;
    }
    const row: Viewer = {
      id: randomUUID(),
      ownerUid,
      viewerEmail: email,
      viewerUid: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async accept(inviteId: string, viewerUid: string, viewerEmail: string): Promise<Viewer | null> {
    const row = this.rows.find(
      (r) =>
        r.id === inviteId &&
        r.status === 'pending' &&
        r.viewerEmail === viewerEmail.toLowerCase(),
    );
    if (!row) return null;
    row.viewerUid = viewerUid;
    row.status = 'accepted';
    return row;
  }

  async revoke(ownerUid: string, id: string): Promise<boolean> {
    const row = this.rows.find(
      (r) => r.id === id && r.ownerUid === ownerUid && r.status !== 'revoked',
    );
    if (!row) return false;
    row.status = 'revoked';
    return true;
  }

  async listForOwner(ownerUid: string): Promise<Viewer[]> {
    return this.rows.filter((r) => r.ownerUid === ownerUid);
  }

  async sharedWithMe(viewerUid: string): Promise<Viewer[]> {
    return this.rows.filter((r) => r.viewerUid === viewerUid && r.status === 'accepted');
  }

  async hasAcceptedAccess(ownerUid: string, viewerUid: string): Promise<boolean> {
    return this.rows.some(
      (r) => r.ownerUid === ownerUid && r.viewerUid === viewerUid && r.status === 'accepted',
    );
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation (production)
// ---------------------------------------------------------------------------

const RETURNING = 'id, owner_uid, viewer_email, viewer_uid, status, created_at';

export class PostgresViewersRepo implements ViewersRepo {
  constructor(private pool: Pool) {}

  async invite(ownerUid: string, viewerEmail: string): Promise<Viewer> {
    // ON CONFLICT on unique (owner_uid, viewer_email). The WHERE on the
    // update arm means only revoked rows get re-opened; pending/accepted
    // conflicts update nothing and return no row, so we fall back to a select.
    const email = viewerEmail.toLowerCase();
    const { rows } = await this.pool.query(
      `insert into trusted_viewers (owner_uid, viewer_email)
       values ($1, $2)
       on conflict (owner_uid, viewer_email)
       do update set status = 'pending', viewer_uid = null
        where trusted_viewers.status = 'revoked'
       returning ${RETURNING}`,
      [ownerUid, email],
    );
    if (rows[0]) return mapViewerRow(rows[0]);
    const existing = await this.pool.query(
      `select ${RETURNING} from trusted_viewers where owner_uid = $1 and viewer_email = $2`,
      [ownerUid, email],
    );
    return mapViewerRow(existing.rows[0]);
  }

  async accept(inviteId: string, viewerUid: string, viewerEmail: string): Promise<Viewer | null> {
    // Three conditions in one atomic update: right invite, still pending,
    // and the accepting user's verified email is the invited email.
    const { rows } = await this.pool.query(
      `update trusted_viewers
          set viewer_uid = $1, status = 'accepted'
        where id = $2 and status = 'pending' and viewer_email = $3
       returning ${RETURNING}`,
      [viewerUid, inviteId, viewerEmail.toLowerCase()],
    );
    return rows[0] ? mapViewerRow(rows[0]) : null;
  }

  async revoke(ownerUid: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update trusted_viewers
          set status = 'revoked'
        where id = $1 and owner_uid = $2 and status <> 'revoked'`,
      [id, ownerUid],
    );
    return (rowCount ?? 0) > 0;
  }

  async listForOwner(ownerUid: string): Promise<Viewer[]> {
    const { rows } = await this.pool.query(
      `select ${RETURNING} from trusted_viewers where owner_uid = $1 order by created_at desc`,
      [ownerUid],
    );
    return rows.map(mapViewerRow);
  }

  async sharedWithMe(viewerUid: string): Promise<Viewer[]> {
    const { rows } = await this.pool.query(
      `select ${RETURNING} from trusted_viewers
        where viewer_uid = $1 and status = 'accepted'
        order by created_at desc`,
      [viewerUid],
    );
    return rows.map(mapViewerRow);
  }

  async hasAcceptedAccess(ownerUid: string, viewerUid: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `select 1 from trusted_viewers
        where owner_uid = $1 and viewer_uid = $2 and status = 'accepted'`,
      [ownerUid, viewerUid],
    );
    return (rowCount ?? 0) > 0;
  }
}

function mapViewerRow(r: Record<string, unknown>): Viewer {
  return {
    id: r.id as string,
    ownerUid: r.owner_uid as string,
    viewerEmail: r.viewer_email as string,
    viewerUid: (r.viewer_uid as string | null) ?? null,
    status: r.status as Viewer['status'],
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}
