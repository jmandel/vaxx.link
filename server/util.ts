import { base64url } from './deps.ts';
const { encode } = base64url;

export function randomStringWithEntropy(entropy: number) {
  const b = new Uint8Array(entropy);
  crypto.getRandomValues(b);
  return encode(b.buffer);
}

export function decodeBase64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(base64url.decode(s))) as T;
}

export function decodeToJson<T>(s: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(s)) as T;
}
