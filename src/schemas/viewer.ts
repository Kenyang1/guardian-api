import { z } from 'zod';

/**
 * Trusted-viewer module schemas. Same three-job pattern as transaction.ts and
 * budget.ts: runtime validation, inferred TS types, a shape the app can share.
 *
 * Note there is no password anywhere: authentication is delegated to Firebase,
 * so this API is credential-free by design. An invite is just an email.
 */

export const inviteViewerSchema = z.object({
  email: z.string().email(),
});

// Route params (same pattern as transactionIdParamSchema).
export const viewerIdParamSchema = z.string().uuid('id must be a UUID');

// Mirrors the trusted_viewers table column-for-column.
export const viewerResponseSchema = z.object({
  id: z.string().uuid(),
  ownerUid: z.string(),
  viewerEmail: z.string(),
  // Null until the invite is accepted: the row exists before the viewer's
  // identity does, so the uid is nullable until acceptance binds them.
  viewerUid: z.string().nullable(),
  status: z.enum(['pending', 'accepted', 'revoked']),
  createdAt: z.string(),
});

export type InviteViewerInput = z.infer<typeof inviteViewerSchema>;
export type Viewer = z.infer<typeof viewerResponseSchema>;
