import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { TokenVerifier } from '../middleware/auth';

/**
 * Production TokenVerifier for Firebase Auth ID tokens.
 *
 * Firebase ID tokens are standard JWTs signed by Google. Rather than pulling in
 * the full firebase-admin SDK, we verify them directly against Google's public
 * JWKS - lighter dependency, same security guarantees. The three checks below
 * (signature, issuer, audience) are exactly what firebase-admin does internally.
 *
 * Swap-in alternative: if you later need more Firebase features server-side
 * (custom claims, user management), replace this with firebase-admin's
 * auth().verifyIdToken() - the TokenVerifier interface stays identical.
 */

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
);

export function firebaseTokenVerifier(projectId: string): TokenVerifier {
  return async (token: string) => {
    const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    if (!payload.sub) throw new Error('token missing subject');
    return { uid: payload.sub, email: payload.email as string | undefined };
  };
}
