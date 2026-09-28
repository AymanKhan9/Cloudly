import type { RunAdapter } from "./adapter";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";

const CONFIG_PATH = process.env.CONTROL_CONFIG_PATH ?? "/control/config.json";

type RunConfig = {
    task: string;
    resume?: string;
    harness:string;
};

const adapters: Record<string,()=>RunAdapter> = {
    "native-claude" : ()=> new ClaudeAdapter(),
    "native-codex": ()=> new CodexAdapter(),
};

async function loadConfig(): Promise<RunConfig> {
    const raw = await Bun.file(CONFIG_PATH).json();
    if (typeof raw.task !== "string") {
        throw new Error(`invalid config at ${CONFIG_PATH}: missing "task"`);
    }
    return { task: raw.task, resume: raw.resume, harness:raw.harness };
}

let lastSeq = -1;

async function main() {
    const config = await loadConfig();
    const makeAdapter = adapters[config.harness];
    if(!makeAdapter){
        throw new Error(`unknown harness: ${config.harness}`);
    }
    const adapter : RunAdapter = makeAdapter();

    process.on("SIGINT", () => {
        adapter.interrupt();
    });

    for await (const event of adapter.start(config.task, config.resume)) {
        lastSeq = event.seq;
        console.log(JSON.stringify(event));
    }
}

main().catch((err) => {
    console.log(JSON.stringify({
        seq: lastSeq + 1,
        ts: Date.now(),
        kind: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
    }));
    process.exit(1);
});
