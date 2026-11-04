/**
 * Sets a local Cloudly up for end-to-end testing against the stand-in GitHub
 * (github.ts): a GitHub App to match it, a signed-in user, a test repository,
 * and the scripted agent (scripted-agent.js) added by command.
 *
 *   bun scripts/local-test/setup.ts <github url> <api url> <out.json>
 *
 * Writes { cookie, webhookSecret, agent } to out.json for test scripts.
 */
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { prisma, setSetting, config } from "../../packages/db/src/index";
import { hashToken } from "../../apps/api/src/session";

const [githubUrl = "http://127.0.0.1:9797", apiUrl = "http://127.0.0.1:8787", out = "local-test.json"] = process.argv.slice(2);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
if (!(await config("GITHUB_APP_PRIVATE_KEY"))) await setSetting("GITHUB_APP_PRIVATE_KEY", privateKey);
await setSetting("GITHUB_APP_ID", "1");
await setSetting("GITHUB_APP_INSTALLATION_ID", "1");
await setSetting("GITHUB_APP_SLUG", "cloudly-local");
await setSetting("GITHUB_CLIENT_ID", "Iv1.local");
const webhookSecret = (await config("GITHUB_WEBHOOK_SECRET")) ?? crypto.randomUUID();
await setSetting("GITHUB_WEBHOOK_SECRET", webhookSecret);
await setSetting("ALLOWED_GITHUB_LOGINS", "tester");

const user = await prisma.user.upsert({ where: { githubId: 777_000_1 }, update: {}, create: { githubId: 777_000_1, login: "tester" } });
const token = crypto.randomUUID();
await prisma.session.create({ data: { id: await hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });

// A small Node project: tests to pass or fail, and a page for screenshots and previews.
const files = {
  "README.md": "# shop\n\nA test repository for Cloudly.\n",
  "package.json": JSON.stringify({ name: "shop", version: "1.0.0", scripts: { test: "node test.js", start: "node server.js" } }, null, 2) + "\n",
  "src/app.js": "export function average(xs) {\n  let total = 0;\n  return xs.reduce((a, b) => a + b, total) / xs.length;\n}\n",
  "test.js": "const fs = require('node:fs');\nif (fs.existsSync('BROKEN')) { console.error('Error: expected 2, got 3'); process.exit(1); }\nconsole.log('1 test passed');\n",
  "server.js": "const http = require('node:http');\nconst fs = require('node:fs');\nhttp.createServer((req, res) => {\n  const file = 'public' + (req.url === '/' ? '/index.html' : req.url);\n  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }\n  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' });\n  res.end(fs.readFileSync(file));\n}).listen(process.env.PORT || 3000);\n",
  "public/index.html": "<!doctype html><title>Shop</title><body style=\"font:18px system-ui;padding:40px;background:#fff\"><h1 id=title>Shop</h1><p>Welcome.</p></body>\n",
};
// Made once: setting up again keeps its branches.
const have = (await (await fetch(`${githubUrl}/installation/repositories`)).json()).repositories as { full_name: string }[];
if (!have.some((r) => r.full_name === "acme/shop")) {
  const made = await fetch(`${githubUrl}/_repo`, { method: "POST", body: JSON.stringify({ owner: "acme", repo: "shop", files }) });
  if (!made.ok) throw new Error(`Couldn't make the test repo: ${await made.text()}`);
}

// The scripted agent, added the way a user adds one by command.
const agentSource = await Bun.file(path.join(import.meta.dir, "scripted-agent.js")).text();
const installScript = `mkdir -p /opt/scripted\ncat > /opt/scripted/agent.js <<'SCRIPTED_AGENT_EOF'\n${agentSource}\nSCRIPTED_AGENT_EOF\nchmod 755 /opt/scripted/agent.js`;
const cookie = `session=${token}`;
const headers = { cookie, "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" };
/** Adds the agent by command, or again when its script changed (an added agent's command can't be edited). */
async function addAgent(name: string, script: string): Promise<string> {
  const existing = await prisma.provider.findFirst({ where: { name, source: "custom" } });
  if (existing && (existing.spec as { launch?: { install?: { script?: string } } }).launch?.install?.script === script.trim()) return existing.id;
  if (existing) await fetch(`${apiUrl}/settings/agents/${existing.id}`, { method: "DELETE", headers });
  const res = await fetch(`${apiUrl}/settings/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "custom", name, command: "node", args: ["/opt/scripted/agent.js"], installScript: script }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Couldn't add ${name}: ${JSON.stringify(body)}`);
  return body.agent.id;
}
// Two, for comparing and councils. The second only runs the script the first installs.
const agent = await addAgent("Scripted", installScript);
const second = await addAgent("Scripted Two", "true");
await Bun.write(out, JSON.stringify({ cookie, token, webhookSecret, agent, second, userId: user.id }, null, 2));
console.log(`Ready. Agents ${agent} and ${second}; cookie in ${out}.`);
process.exit(0);
