import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM encryption for access tokens at rest.
 * Format: base64(iv) . base64(authTag) . base64(ciphertext)
 */

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, ciphertext].map((b) => b.toString('base64')).join('.')
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [ivB64, tagB64, dataB64] = encoded.split('.')
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
