/**
 * Access-token issuance/verification — EdDSA (Ed25519) via jose.
 *
 * The keypair is generated once (scripts/generate-jwt-keys.mjs) and stored as
 * the JWT_PRIVATE_KEY / JWT_PUBLIC_KEY Vercel env vars (PEM, PKCS8 / SPKI).
 * Only identity-svc ever touches the private key; every other service only
 * needs the public key to verify.
 */
import * as jose from 'jose';

const ALG = 'EdDSA';
const ISSUER = 'shikhon-lms';

export interface AccessTokenClaims {
  sub: string; // user id
  tid: string; // tenant id
  role: string; // primary role code
  roles: string[]; // all role codes held
}

function pem(envVar: string): string {
  const v = process.env[envVar];
  if (!v) throw new Error(`${envVar} env var is not set`);
  // Vercel env values keep literal \n; PEM parsing needs real newlines.
  return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
}

let _privateKey: ReturnType<typeof jose.importPKCS8> | null = null;
let _publicKey: ReturnType<typeof jose.importSPKI> | null = null;

function privateKey(): ReturnType<typeof jose.importPKCS8> {
  if (!_privateKey) _privateKey = jose.importPKCS8(pem('JWT_PRIVATE_KEY'), ALG);
  return _privateKey;
}

function publicKey(): ReturnType<typeof jose.importSPKI> {
  if (!_publicKey) _publicKey = jose.importSPKI(pem('JWT_PUBLIC_KEY'), ALG);
  return _publicKey;
}

export async function signAccessToken(claims: AccessTokenClaims, expiresIn = '15m'): Promise<string> {
  const key = await privateKey();
  return new jose.SignJWT({ tid: claims.tid, role: claims.role, roles: claims.roles })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(expiresIn)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const key = await publicKey();
  const { payload } = await jose.jwtVerify(token, key, { issuer: ISSUER });
  if (!payload.sub || !payload.tid || !payload.role) {
    throw new Error('access token missing required claims');
  }
  return {
    sub: payload.sub,
    tid: payload.tid as string,
    role: payload.role as string,
    roles: (payload.roles as string[] | undefined) ?? [payload.role as string],
  };
}
