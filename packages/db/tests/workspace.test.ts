import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  prisma, envNameProblem, saveEnvSecret, secretsForRepo, proxySecrets, listEnvSecrets, secretPlaceholder,
  cleanFilePath, repoFileProblem, putRepoFile, REPO_FILE_MAX_BYTES, signRelayToken, relayKey,
} from "../src";

test("secret names: plain env names only, and never ones that steer the sandbox", () => {
  expect(envNameProblem("STRIPE_API_KEY")).toBeNull();
  expect(envNameProblem("stripe")).not.toBeNull();
  for (const name of ["HTTPS_PROXY", "NO_PROXY", "ANTHROPIC_BASE_URL", "NODE_OPTIONS", "PATH", "SSL_CERT_FILE", "GIT_SSH_COMMAND"]) {
    expect(envNameProblem(name)).toContain("can't be overridden");
  }
});

test("a repo's secret wins over the instance-wide one; only hidden secrets with hosts reach the proxy", async () => {
  const repo = "acme/widgets";
  await prisma.envSecret.deleteMany({ where: { name: { startsWith: "T_" } } });
  try {
    await saveEnvSecret({ name: "T_TOKEN", repo: "*", value: "global-value", hosts: "api.example.com", exposed: false });
    await saveEnvSecret({ name: "T_TOKEN", repo, value: "repo-value", hosts: "https://api.example.com/v1\nfiles.example.com", exposed: false });
    await saveEnvSecret({ name: "T_PLAIN", repo, value: "not-secret", hosts: "", exposed: true });

    const forRepo = await secretsForRepo(repo);
    const token = forRepo.find((s) => s.name === "T_TOKEN")!;
    expect(token.value).toBe("repo-value");
    expect(token.hosts).toEqual(["api.example.com", "files.example.com"]);
    expect(token.placeholder).toMatch(/^cloudly-secret-[0-9a-f]{24}$/);
    expect(token.placeholder).not.toContain("repo-value");
    expect(forRepo.find((s) => s.name === "T_PLAIN")?.exposed).toBe(true);
    expect((await secretsForRepo("other/repo")).find((s) => s.name === "T_TOKEN")?.value).toBe("global-value");

    const proxy = await proxySecrets();
    expect(proxy.some((s) => s.value === "not-secret")).toBe(false);
    expect(proxy.filter((s) => s.value === "repo-value" || s.value === "global-value")).toHaveLength(2);

    // Listings show a masked preview, never the value.
    const listed = await listEnvSecrets();
    expect(JSON.stringify(listed)).not.toContain("repo-value");

    // Updating without a value keeps the old one.
    await saveEnvSecret({ name: "T_TOKEN", repo, hosts: "api.example.com", exposed: false });
    expect((await secretsForRepo(repo)).find((s) => s.name === "T_TOKEN")?.value).toBe("repo-value");
    // The same secret gets the same placeholder every run.
    const row = await prisma.envSecret.findFirstOrThrow({ where: { name: "T_TOKEN", repo } });
    expect(await secretPlaceholder(row.id)).toBe(token.placeholder);
  } finally {
    await prisma.envSecret.deleteMany({ where: { name: { startsWith: "T_" } } });
  }
});

test("kept file paths are plain relative paths", () => {
  expect(cleanFilePath("data/sample.csv")).toBe("data/sample.csv");
  expect(cleanFilePath("/data//sample.csv")).toBe("data/sample.csv");
  expect(cleanFilePath("a\\b.txt")).toBe("a/b.txt");
  for (const bad of ["", "..", "../etc/passwd", "a/../../b", "./x", "a\x00b", "a\nb"]) expect(cleanFilePath(bad)).toBeNull();
});

test("file limits count what's already kept, but not the file being replaced", async () => {
  const repo = "acme/limits";
  await prisma.repoFile.deleteMany({ where: { repo } });
  try {
    expect(await repoFileProblem(repo, "big.bin", REPO_FILE_MAX_BYTES + 1)).toContain("25 MB");
    await putRepoFile(repo, "a.txt", new TextEncoder().encode("hello"));
    expect(await repoFileProblem(repo, "a.txt", 10)).toBeNull();
    const row = await prisma.repoFile.findUniqueOrThrow({ where: { repo_path: { repo, path: "a.txt" } } });
    expect(row.size).toBe(5);
    expect(Buffer.from(row.content).toString()).toBe("hello");
  } finally {
    await prisma.repoFile.deleteMany({ where: { repo } });
  }
});

test("relay tokens are signed with a key derived from the master key", async () => {
  const { token, exp } = await signRelayToken("desktop", "run-00000000-0000-0000-0000-000000000000", 60);
  const [body, sig] = token.split(".");
  expect(createHmac("sha256", await relayKey()).update(body!).digest("base64url")).toBe(sig!);
  expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ k: "desktop", c: "run-00000000-0000-0000-0000-000000000000", exp });
});
