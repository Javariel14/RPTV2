import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { identityClaims, FoundationError, type Identity } from '@rpt/contracts';
export interface IdentityVerifier {
  verify(token: string): Promise<Identity>;
}
export class JwtIdentityVerifier implements IdentityVerifier {
  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    private readonly keys: JWTVerifyGetKey,
  ) {}
  async verify(token: string): Promise<Identity> {
    try {
      const result = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'session_id', 'aal'],
        clockTolerance: 5,
        maxTokenAge: '1h',
      });
      return identityClaims.parse(result.payload);
    } catch {
      throw new FoundationError('UNAUTHENTICATED');
    }
  }
}
/** Issuer is operator configuration, never a URL from an unverified token. */
export function supabaseVerifier(issuer: string): IdentityVerifier {
  const url = new URL(issuer);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/auth/v1')
  )
    throw new FoundationError('UNAVAILABLE');
  return new JwtIdentityVerifier(
    issuer,
    'authenticated',
    createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 60_000,
    }),
  );
}
