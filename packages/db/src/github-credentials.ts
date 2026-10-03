import { config } from "./secrets";

export interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

/**
 * The GitHub App this instance acts as. The private key comes from the
 * browser-entered setting, else from the PEM file GITHUB_APP_PRIVATE_KEY_PATH
 * points at (the original .env setup). Null until all three exist.
 */
export async function githubAppCredentials(): Promise<GitHubAppCredentials | null> {
  const appId = await config("GITHUB_APP_ID");
  const installationId = await config("GITHUB_APP_INSTALLATION_ID");
  let privateKey = await config("GITHUB_APP_PRIVATE_KEY");

  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!privateKey && keyPath && (await Bun.file(keyPath).exists())) {
    privateKey = await Bun.file(keyPath).text();
  }

  if (!appId || !installationId || !privateKey) return null;
  return { appId, installationId, privateKey };
}

/** Changes whenever the credentials do, so cached clients know to rebuild. */
export function credentialsFingerprint(c: GitHubAppCredentials): string {
  return `${c.appId}:${c.installationId}:${new Bun.CryptoHasher("sha256").update(c.privateKey).digest("hex").slice(0, 16)}`;
}
