/**
 * One-off: generates the Ed25519 keypair for access-token signing (see
 * packages/server-core/src/jwt.ts). Run once, then paste the two PEM blocks
 * into the JWT_PRIVATE_KEY / JWT_PUBLIC_KEY Vercel env vars (Production only
 * — identity-svc is the only service that ever touches the private key).
 * Re-running this rotates the keypair, which invalidates every access token
 * already issued.
 */
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });

console.log('JWT_PRIVATE_KEY:\n');
console.log(await exportPKCS8(privateKey));
console.log('JWT_PUBLIC_KEY:\n');
console.log(await exportSPKI(publicKey));
