import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Workspace } from "./workspace";
import { type RunEvent } from "@repo/shared/run-event";

interface ControlConfig{
    task:string,
    harness:string
}

// native-codex isn't supported yet: its real credential is a mounted OAuth
// session file (~/.codex/auth.json), not an env var, which needs its own
// design pass rather than being bolted onto the env-var-only model below.
const HARNESS_CREDENTIALS: Record<string, string[]> = {
    "native-claude": ["ANTHROPIC_API_KEY"],
};

function credentialFlags(harness: string): string[] {
    const required = HARNESS_CREDENTIALS[harness];
    if (!required) {
        throw new Error(`unsupported harness: ${harness}`);
    }

    const flags: string[] = [];
    for (const name of required) {
        const value = process.env[name];
        if (!value) {
            throw new Error(`harness "${harness}" requires ${name} to be set`);
        }
        flags.push("-e", `${name}=${value}`);
    }
    return flags;
}

export async function* createRunContainer(workspace: Workspace, task:string,harness:string,runId:string): AsyncIterable<RunEvent>{
    const controlDir = await mkdtemp(
        path.join(tmpdir(),"run-control-"),
    );

    try{
        const config:ControlConfig = {
            task,
            harness,
        };

        await writeFile(
            path.join(controlDir,"config.json"),
            JSON.stringify(config),
            "utf-8",
        );

        const proc = Bun.spawn([
            "docker",
            "run",
            "--rm",

            "--name",
            `run-${runId}`,

            "--label",
            `run_id=${runId}`,

            "-v",
            `${workspace.runDir}:/workspace`,

            "-v",
            `${process.cwd()}:/repo:ro`,

            "-w",
            "/repo/packages/runner",

            "-v",
            `${controlDir}:/control:ro`,

            "-e",
            "CONTROL_CONFIG_PATH=/control/config.json",

            ...credentialFlags(harness),

            "--user",
            "1000:1000",

            "cloud-agents-base",

            "bun",
            "src/index.ts"

        ],{
            stdout:"pipe",
            stderr:"pipe"
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
    const proc = Bun.spawn(["docker", "run", "--rm", ...args], {
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