import type { RunAdapter } from "./adapter";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { AcpAdapter } from "./adapters/acp";

const CONFIG_PATH = process.env.CONTROL_CONFIG_PATH ?? "/control/config.json";

type RunConfig = {
    task: string;
    resume?: string;
    harness:string;
    /** What's left of the monthly limit; only Claude can enforce it mid-run. */
    maxBudgetUsd?: number;
};

const adapters: Record<string,(config: RunConfig)=>RunAdapter> = {
    "native-claude" : (config)=> new ClaudeAdapter(config.maxBudgetUsd),
    "native-codex": ()=> new CodexAdapter(),
    "gemini-acp": ()=> new AcpAdapter(),
};

async function loadConfig(): Promise<RunConfig> {
    const raw = await Bun.file(CONFIG_PATH).json();
    if (typeof raw.task !== "string") {
        throw new Error(`invalid config at ${CONFIG_PATH}: missing "task"`);
    }
    return { task: raw.task, resume: raw.resume, harness:raw.harness, maxBudgetUsd: raw.maxBudgetUsd };
}

let lastSeq = -1;

async function main() {
    const config = await loadConfig();
    const makeAdapter = adapters[config.harness];
    if(!makeAdapter){
        throw new Error(`unknown harness: ${config.harness}`);
    }
    const adapter : RunAdapter = makeAdapter(config);

    process.on("SIGINT", () => {
        adapter.interrupt();
    });

    for await (const event of adapter.start(config.task, config.resume)) {
        lastSeq = event.seq;
        console.log(JSON.stringify(event));
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.log(JSON.stringify({
            seq: lastSeq + 1,
            ts: Date.now(),
            kind: "error",
            data: { message: err instanceof Error ? err.message : String(err) },
        }));
        process.exit(1);
    });
