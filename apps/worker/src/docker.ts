import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import path from "node:path";

import { type Workspace } from "./workspace";
import { type RunEvent } from "@repo/shared/run-event";
import { config } from "@repo/db";
import { ensureEgress, EGRESS_FLAGS } from "./egress";

interface ControlConfig{
    task:string,
    harness:string,
    resume?:string,
    maxBudgetUsd?:number
}

export interface ContainerOptions {
    /** The agent's own session id from an earlier turn. */
    resume?: string;
    /** Host dir mounted as the sandbox HOME so ~/.claude, ~/.codex and ~/.gemini persist. */
    homeDir?: string;
    /** Remaining monthly budget; Claude stops itself there. */
    maxBudgetUsd?: number;
    /** Built from the setup script in Settings; the base image when there is none. */
    image?: string;
}

// Codex takes an API key through the SDK's `apiKey` option (it becomes
// CODEX_API_KEY for the CLI), so no mounted ~/.codex/auth.json is needed.
const HARNESS_CREDENTIALS: Record<string, string[]> = {
    "native-claude": ["ANTHROPIC_API_KEY"],
    "native-codex": ["OPENAI_API_KEY"],
    "gemini-acp": ["GEMINI_API_KEY"],
};

// Not credentials: passed through only when set, never required.
const OPTIONAL_ENV: Record<string, string[]> = {
    "gemini-acp": ["GEMINI_MODEL"],
};

// The worker runs from the install dir, whose .env holds the master key and the
// database URL. The sandbox gets only what the runner needs, never that dir.
const RUNNER_MOUNTS = [
    "package.json",
    "node_modules",
    "packages/shared",
    "packages/runner/package.json",
    "packages/runner/tsconfig.json",
    "packages/runner/node_modules",
    "packages/runner/src",
];

export function runnerMountFlags(root: string): string[] {
    return RUNNER_MOUNTS.flatMap((p) => ["-v", `${path.join(root, p)}:/repo/${p}:ro`]);
}

// Leave room for Postgres, the API, the worker and the web app.
// ponytail: one cap per container; with WORKER_CONCURRENCY > 1 the runs can still
// oversubscribe RAM together. Set SANDBOX_MEMORY explicitly on shared hosts.
const SANDBOX_MEMORY = process.env.SANDBOX_MEMORY
    ?? `${Math.max(512, Math.floor(totalmem() / 1048576) - 768)}m`;

export const SANDBOX_LIMITS = [
    "--memory", SANDBOX_MEMORY,
    "--pids-limit", process.env.SANDBOX_PIDS ?? "2048",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
];

/**
 * The sandbox runs as the worker's own uid, which owns the workspace it writes
 * (1000 on installs). Never root: that uid is also the container's.
 */
export function sandboxUser(): string {
    const uid = process.getuid!();
    if (uid === 0) throw new Error("Run the worker as a non-root user; the sandbox runs as the same uid.");
    return `${uid}:${process.getgid!()}`;
}

/**
 * Keys go in as `-e NAME` with the value in the docker client's environment,
 * so they never appear on a command line (world-readable in /proc).
 */
export async function credentialFlags(harness: string): Promise<{ flags: string[]; env: Record<string, string> }> {
    const required = HARNESS_CREDENTIALS[harness];
    if (!required) {
        throw new Error(`unsupported harness: ${harness}`);
    }

    const flags: string[] = [];
    const env: Record<string, string> = {};
    for (const name of required) {
        const value = await config(name);
        if (!value) {
            throw new Error(`harness "${harness}" needs ${name}. Add it under Settings, or in the server's .env.`);
        }
        flags.push("-e", name);
        env[name] = value;
    }
    for (const name of OPTIONAL_ENV[harness] ?? []) {
        const value = process.env[name];
        if (value) {
            flags.push("-e", name);
            env[name] = value;
        }
    }
    return { flags, env };
}

export async function* createRunContainer(workspace: Workspace, task:string,harness:string,runId:string, options: ContainerOptions = {}): AsyncIterable<RunEvent>{
    const controlDir = await mkdtemp(
        path.join(tmpdir(),"run-control-"),
    );

    try{
        const config:ControlConfig = {
            task,
            harness,
            resume: options.resume,
            maxBudgetUsd: options.maxBudgetUsd,
        };

        await writeFile(
            path.join(controlDir,"config.json"),
            JSON.stringify(config),
            "utf-8",
        );

        const credentials = await credentialFlags(harness);
        await ensureEgress();
        const proc = Bun.spawn([
            "docker",
            "run",
            "--rm",

            ...SANDBOX_LIMITS,
            ...EGRESS_FLAGS,

            "--name",
            `run-${runId}`,

            "--label",
            `run_id=${runId}`,

            "-v",
            `${workspace.runDir}:/workspace`,

            ...runnerMountFlags(process.cwd()),

            "-w",
            "/repo/packages/runner",

            "-v",
            `${controlDir}:/control:ro`,

            "-e",
            "CONTROL_CONFIG_PATH=/control/config.json",

            ...(options.homeDir ? ["-v", `${options.homeDir}:/home/node`, "-e", "HOME=/home/node"] : []),

            ...credentials.flags,

            "--user",
            sandboxUser(),

            options.image ?? "cloud-agents-base",

            "bun",
            "src/index.ts"

        ],{
            stdout:"pipe",
            stderr:"pipe",
            env: { ...process.env, ...credentials.env },
        });

        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();

        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, {
                stream: true,
            });

            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);

                if (!line) {
                    continue;
                }

                const event = JSON.parse(line) as RunEvent;

                console.log(event);

                yield event;
            }
        }

        const finalText = buffer.trim();

        if (finalText) {
            const event = JSON.parse(finalText) as RunEvent;

            console.log(event);

            yield event;
        }

        // 4. Wait for process completion
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
        const stderr = await new Response(
            proc.stderr,
        ).text();

        throw new Error(
            `Run container exited with code ${exitCode}: ${stderr}`,
        );
        }
    }finally{
        await rm(controlDir,{
            recursive:true,
            force:true
        })
    }
}


/**
 * Sends SIGINT (never SIGTERM — SIGTERM leaves the agent's turn unfinished)
 * to a run container by its stable name. A container that's already exited
 * (the run finished right as cancel was requested) is not an error — this
 * is an expected, benign race.
 */
export async function cancelRun(runId: string): Promise<void> {
    const proc = Bun.spawn(["docker", "kill", "-s", "SIGINT", `run-${runId}`], {
        stdout: "pipe",
        stderr: "pipe",
    });

    const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0 && !stderr.includes("No such container")) {
        throw new Error(`docker kill failed for run-${runId}: ${stderr}`);
    }
}

/**
 * Force-removes a run's container whether it's running or already exited —
 * used by the recovery sweep to clean up before redoing a run from scratch.
 * A container that no longer exists is not an error.
 */
export async function removeContainer(runId: string): Promise<void> {
    const proc = Bun.spawn(["docker", "rm", "-f", `run-${runId}`], {
        stdout: "pipe",
        stderr: "pipe",
    });

    const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0 && !stderr.includes("No such container")) {
        throw new Error(`docker rm failed for run-${runId}: ${stderr}`);
    }
}

export async function runContainerCommand(
    args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["docker", "run", "--rm", ...SANDBOX_LIMITS, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { stdout, stderr, exitCode };
}