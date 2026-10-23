// The stdio side of a small MCP server: one JSON-RPC message per line in, one
// answer per line out. Calls run concurrently; each answer is written whole.

type Json = Record<string, any>;

export async function serveStdio(handle: (message: Json) => Promise<Json | null>): Promise<void> {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of Bun.stdin.stream()) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let message: Json;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            handle(message).then((out) => out && process.stdout.write(JSON.stringify(out) + "\n"));
        }
    }
}
