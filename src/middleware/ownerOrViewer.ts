import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from './auth';
import type { ViewersRepo } from '../repos/viewersRepo';

/**
 * Authorization middleware for shared (read-only) routes.
 *
 * Runs AFTER requireAuth, so req.user is a verified identity. The question
 * here is no longer "who are you?" (authentication) but "are you allowed to
 * see THIS owner's data?" (authorization). Allowed when either:
 *   - the caller IS the owner (owners can use their own shared URLs), or
 *   - an accepted trusted_viewers row links owner -> caller.
 *
 * Denial is 403, not 404: an ownerUid is a capability handed to the viewer
 * through the invite they accepted - it is not a secret to be hidden the way
 * another user's transaction id is (M2's 404 rule). And not 401: the token
 * was valid; identity is known; permission is what's missing.
 */

export function requireOwnerOrAcceptedViewer(viewers: ViewersRepo) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const ownerUid = req.params.ownerUid;
    const caller = req.user!.uid; // requireAuth ran first

    if (caller === ownerUid) return next();
    if (await viewers.hasAcceptedAccess(ownerUid, caller)) return next();

    return res.status(403).json({ error: 'forbidden' });
  };
}
