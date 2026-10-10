// The only way out of a run container. Runs in its own container on both the
// sandbox's internal network (no route out, no outside DNS) and the normal one.
// HTTPS only: clients send CONNECT host:443 and this pipes the encrypted stream
// through when the host is allowed. It never sees request contents.
import net from "node:net";
import { readFileSync } from "node:fs";

const ALLOW_FILE = process.env.ALLOW_FILE ?? "/allow/hosts";
const PORT = Number(process.env.PORT ?? 3128);

// Re-read on every connection so Settings changes apply without a restart.
function allowed(host: string): boolean {
  let rules: string[] = [];
  try {
    rules = readFileSync(ALLOW_FILE, "utf8").split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"));
  } catch {}
  const h = host.toLowerCase();
  // "example.com" allows it and its subdomains; "*" allows everything.
  return rules.some((r) => r === "*" || h === r || h.endsWith(`.${r}`));
}

export function parseConnect(head: string): { host: string; port: number } | null {
  const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]\r\n/i.exec(head);
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

export function startProxy(port = PORT, isAllowed = allowed): net.Server {
  const server = net.createServer((client) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off("data", onData);
      const target = parseConnect(head);
      if (!target) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Type: text/plain\r\n\r\nOnly HTTPS (CONNECT) goes through Cloudly's egress proxy.\n");
        return;
      }
      if (target.port !== 443 || !isAllowed(target.host)) {
        console.log(`deny  ${target.host}:${target.port}`);
        client.end(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${target.host} isn't on this Cloudly instance's allowed list. Add it under Settings > Sandbox tools > Network.\n`,
        );
        return;
      }
      console.log(`allow ${target.host}`);
      const upstream = net.connect(target.port, target.host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.slice(end + 4);
        if (rest) upstream.write(Buffer.from(rest, "latin1"));
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  server.listen(port);
  return server;
}

if (import.meta.main) {
  startProxy();
  console.log(`egress proxy on :${PORT}, rules from ${ALLOW_FILE}`);
}
