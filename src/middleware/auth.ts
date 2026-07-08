import type { NextFunction, Request, Response } from 'express';

/**
 * Auth middleware with DEPENDENCY INJECTION.
 *
 * The middleware doesn't know or care HOW a token is verified - it receives a
 * TokenVerifier function. In production that's the Firebase verifier
 * (auth/firebaseVerifier.ts). In tests it's a stub. This is why the test suite
 * runs offline with zero Firebase configuration, and it's a clean interview
 * talking point: "my routes are testable because auth is injected, not hardcoded."
 */

export interface AuthenticatedUser {
  uid: string;
  email?: string;
}

export type TokenVerifier = (token: string) => Promise<AuthenticatedUser>;

// Express's Request type, extended with the verified user.
export interface AuthedRequest extends Request {
  user?: AuthenticatedUser;
}

export function requireAuth(verify: TokenVerifier) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      // 401 = "we don't know who you are"
      return res.status(401).json({ error: 'missing bearer token' });
    }
    try {
      req.user = await verify(header.slice('Bearer '.length));
      return next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
  };
}
