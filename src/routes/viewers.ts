import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import type { AuthedRequest } from '../middleware/auth';
import { inviteViewerSchema, viewerIdParamSchema } from '../schemas/viewer';
import type { ViewersRepo } from '../repos/viewersRepo';

/**
 * Trusted-viewer management: invite / accept / revoke / list.
 * All owner-side mutations are uid-scoped; accept additionally requires the
 * caller's verified token email to match the invited email - possession of
 * an invite id alone is not enough to claim it.
 */

export function viewersRouter(repo: ViewersRepo): Router {
  const router = Router();

  // POST /api/v1/viewers/invite
  router.post('/invite', async (req: AuthedRequest, res: Response) => {
    try {
      const { email } = inviteViewerSchema.parse(req.body);
      // Sharing with yourself is meaningless - you already have full access.
      if (req.user!.email && req.user!.email.toLowerCase() === email.toLowerCase()) {
        return res.status(422).json({ error: 'cannot invite yourself' });
      }
      const invite = await repo.invite(req.user!.uid, email);
      return res.status(201).json(invite);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // POST /api/v1/viewers/accept/:inviteId
  router.post('/accept/:inviteId', async (req: AuthedRequest, res: Response) => {
    try {
      const inviteId = viewerIdParamSchema.parse(req.params.inviteId);
      if (!req.user!.email) {
        // Can't match an email-addressed invite without a verified email.
        return res.status(403).json({ error: 'token has no verified email' });
      }
      const accepted = await repo.accept(inviteId, req.user!.uid, req.user!.email);
      // Missing, already handled, or addressed to a different email:
      // one undifferentiated 404 - don't tell a stranger which it was.
      if (!accepted) return res.status(404).json({ error: 'invite not found' });
      return res.status(200).json(accepted);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // DELETE /api/v1/viewers/:id  (owner revokes)
  router.delete('/:id', async (req: AuthedRequest, res: Response) => {
    try {
      const id = viewerIdParamSchema.parse(req.params.id);
      const revoked = await repo.revoke(req.user!.uid, id);
      if (!revoked) return res.status(404).json({ error: 'viewer not found' });
      return res.status(204).send();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(422).json({ error: 'validation failed', issues: err.issues });
      }
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // GET /api/v1/viewers  (owner lists everyone they've invited)
  router.get('/', async (req: AuthedRequest, res: Response) => {
    const items = await repo.listForOwner(req.user!.uid);
    return res.status(200).json({ items });
  });

  // GET /api/v1/viewers/shared-with-me  (viewer lists owners who shared)
  router.get('/shared-with-me', async (req: AuthedRequest, res: Response) => {
    const items = await repo.sharedWithMe(req.user!.uid);
    return res.status(200).json({ items });
  });

  return router;
}
