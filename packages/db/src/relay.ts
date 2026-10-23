import { createHmac } from "node:crypto";
import { masterKey } from "./secrets";

// Tokens for Cloudly's relay (apps/worker/src/relay.ts), the narrow way in to a
// sandbox's desktop or preview. The API signs one per viewer and purpose; the
// relay checks it with the same key, which the worker derives from the master
// key and hands to the relay container, so the API and worker never talk.

export async function relayKey(): Promise<string> {
  return createHmac("sha256", await masterKey()).update("cloudly-relay-v1").digest("hex");
}

export async function signRelayToken(kind: "desktop" | "preview", container: string, ttlSeconds: number): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ k: kind, c: container, exp })).toString("base64url");
  const sig = createHmac("sha256", await relayKey()).update(body).digest("base64url");
  return { token: `${body}.${sig}`, exp };
}
