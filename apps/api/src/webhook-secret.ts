import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env.ts';
import { httpError } from './tenant.ts';

/**
 * Webhook signing secrets at rest: AES-256-GCM under the first WEBHOOK_ENCRYPTION_KEYS entry,
 * bound to the endpoint id (additional data), stored as `v1:<key id>:<iv>:<ciphertext+tag>`
 * (base64). The API only encrypts: it shows a secret once, on create or rotate. Decryption lives
 * in the worker's signing path (services/worker-py/worker/webhooks.py), the format's twin, and in
 * `openSecret` for the SSH-only stack-plan.ts (never an HTTP route).
 */
const [activeId = '', activeSecret = ''] = (env.WEBHOOK_ENCRYPTION_KEYS[0] ?? '').split(/:(.*)/s);
// The configured secret is already high-entropy; SHA-256 just fixes its length at 32 bytes.
const activeKey = createHash('sha256').update(activeSecret).digest();

export function encryptSecret(secret: string, endpointId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', activeKey, iv).setAAD(Buffer.from(endpointId));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1:${activeId}:${iv.toString('base64')}:${data.toString('base64')}`;
}

/** The reverse of encryptSecret under any WEBHOOK_ENCRYPTION_KEYS entry; throws on a wrong key or row. */
export function openSecret(stored: string, endpointId: string) {
  const [version, keyId, iv, data] = stored.split(':');
  const secret = env.WEBHOOK_ENCRYPTION_KEYS.map((k) => k.split(/:(.*)/s)).find(
    ([id]) => id === keyId,
  )?.[1];
  if (version !== 'v1' || secret === undefined || !iv || !data)
    throw new Error('unreadable secret');
  const key = createHash('sha256').update(secret).digest();
  const raw = Buffer.from(data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    .setAAD(Buffer.from(endpointId))
    .setAuthTag(raw.subarray(-16));
  return Buffer.concat([decipher.update(raw.subarray(0, -16)), decipher.final()]).toString('utf8');
}

/** An org-owned row's secret at rest (BYO keys, MCP auth headers): bound to org and row id, plus
 * its last 4 characters to recognise it in settings. The worker decrypts it with the same AAD. */
export const sealSecret = (secret: string, orgId: string, id: string) => ({
  cipher: encryptSecret(secret, `${orgId}/${id}`),
  hint: secret.slice(-4),
});

/** A stored secret only goes where it was entered for: moving it (new URL or header) needs it
 * again, so nobody can redirect it to a host they control. */
export function requireSecretAgain(moved: boolean, stored: boolean, entered: boolean) {
  if (moved && stored && !entered) {
    throw httpError(400, 'enter the secret again when changing where it is sent');
  }
}

/** Standard Webhooks secret: `whsec_` + base64 of 24 random bytes. */
export const newSecret = () => `whsec_${randomBytes(24).toString('base64')}`;
