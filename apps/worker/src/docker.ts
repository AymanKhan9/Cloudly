import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir, totalmem, homedir } from "node:os";
import path from "node:path";

import { type Workspace, workspaceMounts } from "./workspace";
import { type RunEvent } from "@repo/shared/run-event";
import { isProviderHarness, launcherPath, agentFeatures } from "@repo/shared/providers";
import { config, enabledProvider, providerRunCredentials, providerEnvProblem } from "@repo/db";
import { ensureEgress, EGRESS_FLAGS, GATEWAY_URL, GATEWAY_TLS_URL, CA_BUNDLE_DIR, sandboxTrustFlags } from "./egress";
import { placeholderCodexAuth } from "./egress-proxy";

// What a run container gets instead of a real credential. Shaped like the real
// thing in case a CLI checks the prefix; the gateway replaces it on the way out.
const PLACEHOLDERS: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-ant-api03-cloudly-placeholder",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-cloudly-placeholder",
    OPENAI_API_KEY: "sk-cloudly-placeholder",
    GEMINI_API_KEY: "cloudly-placeholder",
};

// Each agent's own setting for where its model API lives.
const GATEWAY_ENV: Record<string, string[]> = {
    "native-claude": ["-e", `ANTHROPIC_BASE_URL=${GATEWAY_URL}/anthropic`],
    "native-codex": ["-e", `OPENAI_BASE_URL=${GATEWAY_URL}/openai/v1`],
    "gemini-acp": ["-e", `GOOGLE_GEMINI_BASE_URL=${GATEWAY_URL}/gemini`],
};

interface ControlConfig{
    task:string,
    harness:string,
    resume?:string,
    fallbackTask?:string,
    maxBudgetUsd?:number,
    systemAppend?:string,
    model?:string,
    effort?:string,
    mcpServers?:{ name: string; url: string }[],
    desktop?:{ password: string },
    context?:boolean,
    research?:boolean,
    acp?:AcpLaunchConfig,
    sessions?:boolean,
    ask?:boolean
}

/** How the runner starts an added agent (see @repo/shared/providers). */
export interface AcpLaunchConfig {
    name: string;
    command: string;
    authMethodId?: string;
    /** Written under HOME before it starts. */
    homeFiles?: Record<string, string>;
    /** Started behind ordinary pipes. */
    pipes?: boolean;
    /** Resumes its own session across turns. */
    resume?: boolean;
    /** Where the runner reads its turn's cost, beyond ACP usage updates. */
    cost?: "pi-session";
    /** A trial: shell lines that install the new version under /tmp first. */
    preinstall?: string;
}

/** An added agent's launch, from Settings > Agents. */
export async function acpLaunch(harness: string): Promise<AcpLaunchConfig | undefined> {
    if (!isProviderHarness(harness)) return undefined;
    const provider = await enabledProvider(harness);
    if (!provider) throw new Error(`The agent "${harness}" isn't added in Cloudly, or is turned off. See Settings > Agents.`);
    const { launch } = provider.spec;
    // From the catalog at run time, so agents added before these existed get them too.
    const features = agentFeatures(harness);
    return {
        name: provider.name, command: launcherPath(provider.id), authMethodId: launch.authMethodId, homeFiles: launch.homeFiles, pipes: launch.pipes,
        resume: features.resume, cost: features.cost === "pi-session" ? "pi-session" : undefined,
    };
}

export interface ContainerOptions {
    /** The agent's own session id from an earlier turn. */
    resume?: string;
    /** With resume: the task with the earlier conversation in it, if the session can't be loaded after all. */
    fallbackTask?: string;
    /** Host dir mounted as the sandbox HOME so ~/.claude, ~/.codex and ~/.gemini persist. */
    homeDir?: string;
    /** Remaining monthly budget; Claude stops itself there. */
    maxBudgetUsd?: number;
    /** Added to the agent's own system prompt (Claude); other agents get it in the task. */
    systemAppend?: string;
    /** The session's "/model" choice; beats a model pinned in the repo's settings. */
    model?: string;
    /** How hard the agent thinks, from the chat box (see @repo/shared/effort). */
    effort?: string;
    /** Built from the setup script in Settings; the base image when there is none. */
    image?: string;
    /** Connected MCP servers, by name; the sandbox reaches them through the gateway. */
    mcpServers?: string[];
    /** Starts a virtual display with this VNC password. */
    desktopPassword?: string;
    /** Host dir mounted at /files: the repo's kept files. */
    filesDir?: string;
    /** Host dir mounted at /artifacts: what the agent makes for the user to look at. */
    artifactsDir?: string;
    /** A trial of an added agent's new version: installed in the sandbox first, then run from there. */
    trialLaunch?: { block: string; run: string };
    /** Messages the user sent while the turn runs, not yet handed to the runner; each is written once. */
    steers?: () => Promise<{ id: string; text: string }[]>;
    /** Environment for the agent: secret placeholders, and exposed secrets' real values. */
    env?: Record<string, string>;
    /** Host dir mounted at /context: the repo's shared context, when it's on. */
    contextDir?: string;
    /** Extra host dirs to mount: [host path, container path]. */
    mounts?: [string, string][];
    /** A research turn: the agent's own web search on. */
    research?: boolean;
    /** Host dir mounted at /sessions: the user's other sessions this one may see. */
    sessionsDir?: string;
    /** Host dir mounted at /ask, where ask_user leaves the agent's question. */
    askDir?: string;
}

/** The gateway URL agents use for a connected MCP server. */
export function mcpGatewayUrl(name: string): string {
    return `${GATEWAY_URL}/mcp/${name}`;
}

/**
 * `-e NAME` flags plus the values for the docker client's own environment, so
 * values stay off the command line (see credentialFlags).
 */
export function envFlags(env: Record<string, string> = {}): { flags: string[]; env: Record<string, string> } {
    return { flags: Object.keys(env).flatMap((name) => ["-e", name]), env };
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
 * so they never appear on a command line (world-readable in /proc). A plan
 * sign-in (Claude token, ChatGPT auth.json) is used instead of the API key when
 * one is saved.
 */
export async function credentialFlags(harness: string): Promise<{
    flags: string[];
    env: Record<string, string>;
    /** Host dir holding Codex's auth.json; saved back after the run. */
    codexHome?: string;
}> {
    if (isProviderHarness(harness)) return providerCredentialFlags(harness);
    const required = HARNESS_CREDENTIALS[harness];
    if (!required) {
        throw new Error(`unsupported harness: ${harness}`);
    }

    const flags: string[] = [];
    const env: Record<string, string> = {};
    let codexHome: string | undefined;

    const claudeToken = harness === "native-claude" ? await config("CLAUDE_CODE_OAUTH_TOKEN") : undefined;
    const codexAuth = harness === "native-codex" ? await config("CODEX_AUTH_JSON") : undefined;
    // Real credentials never enter the container: it gets a placeholder and the
    // gateway's address, and the gateway adds the real value (egress-proxy.ts).
    // A ChatGPT sign-in is the exception: Codex refreshes it itself.
    if (claudeToken) {
        flags.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN}`, ...GATEWAY_ENV[harness]!);
    } else if (codexAuth) {
        codexHome = await writeCodexHome(codexAuth);
        flags.push(
            "-v", `${codexHome}:/codex-home`, "-e", "CODEX_HOME=/codex-home",
            "-e", `CODEX_REFRESH_TOKEN_URL_OVERRIDE=${GATEWAY_TLS_URL}/codex-refresh`,
            "-v", `${CA_BUNDLE_DIR}:/cloudly-ca:ro`, "-e", "CODEX_CA_CERTIFICATE=/cloudly-ca/bundle.pem",
        );
    } else {
        for (const name of required) {
            if (!(await config(name))) {
                throw new Error(`harness "${harness}" needs ${name}. Add it under Settings, or in the server's .env.`);
            }
            flags.push("-e", `${name}=${PLACEHOLDERS[name]}`);
        }
        flags.push(...GATEWAY_ENV[harness]!);
    }
    for (const name of OPTIONAL_ENV[harness] ?? []) {
        const value = process.env[name];
        if (value) {
            flags.push("-e", name);
            env[name] = value;
        }
    }
    return { flags, env, codexHome };
}

/**
 * An added agent's keys, as placeholders the egress proxy swaps for the real
 * values on requests to each key's hosts, plus its plain settings.
 */
async function providerCredentialFlags(harness: string): Promise<{ flags: string[]; env: Record<string, string> }> {
    const provider = await enabledProvider(harness);
    if (!provider) throw new Error(`The agent "${harness}" isn't added in Cloudly, or is turned off. See Settings > Agents.`);
    const { resolved, missing } = await providerRunCredentials(harness);
    if (missing.length) {
        throw new Error(`${provider.name} needs ${missing.map((c) => `a ${c.label}`).join(" and ")}. Add it under Settings > Agents.`);
    }
    // Settings from the registry can't take over the proxy, CA or PATH variables Cloudly sets.
    const env: Record<string, string> = Object.fromEntries(
        Object.entries(provider.spec.launch.env ?? {}).filter(([name]) => !providerEnvProblem(name)),
    );
    for (const c of resolved) env[c.env] = c.placeholder;
    return envFlags(env);
}

/** Codex's home for ChatGPT sign-ins: its sessions, a placeholder auth.json, and its config. */
export const CODEX_HOME = path.join(process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly"), "codex-home");

/**
 * The sandbox's Codex home: a look-alike auth.json (no working token) and a
 * config that sends Codex's ChatGPT calls to the gateway, which adds the real
 * token. Codex's own refreshes go to the gateway too (egress-proxy.ts).
 */
async function writeCodexHome(authJson: string): Promise<string> {
    await mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });
    const placeholder = placeholderCodexAuth(JSON.parse(authJson));
    await writeFile(path.join(CODEX_HOME, "auth.json"), JSON.stringify(placeholder), { mode: 0o600 });
    // No config needed: its chatgpt.com calls reach the gateway through the proxy.
    await rm(path.join(CODEX_HOME, "config.toml"), { force: true });
    return CODEX_HOME;
}

export async function* createRunContainer(workspace: Workspace, task:string,harness:string,runId:string, options: ContainerOptions = {}): AsyncIterable<RunEvent>{
    const controlDir = await mkdtemp(
        path.join(tmpdir(),"run-control-"),
    );

    let credentials: Awaited<ReturnType<typeof credentialFlags>> | undefined;
    let steerTimer: ReturnType<typeof setInterval> | undefined;
    try{
        const config:ControlConfig = {
            task,
            harness,
            resume: options.resume,
            fallbackTask: options.fallbackTask,
            maxBudgetUsd: options.maxBudgetUsd,
            systemAppend: options.systemAppend,
            model: options.model,
            effort: options.effort,
            mcpServers: options.mcpServers?.map((name) => ({ name, url: mcpGatewayUrl(name) })),
            desktop: options.desktopPassword ? { password: options.desktopPassword } : undefined,
            context: Boolean(options.contextDir),
            research: options.research,
            acp: options.trialLaunch
                ? { ...(await acpLaunch(harness))!, command: options.trialLaunch.run, preinstall: options.trialLaunch.block }
                : await acpLaunch(harness),
            sessions: Boolean(options.sessionsDir),
            ask: Boolean(options.askDir),
        };

        await writeFile(
            path.join(controlDir,"config.json"),
            JSON.stringify(config),
            "utf-8",
        );
        // Messages mid-turn go here; the runner reads each new file (it can't write to /control).
        if (options.steers) {
            const steerDir = path.join(controlDir, "steer");
            await mkdir(steerDir, { recursive: true });
            let writing = false;
            steerTimer = setInterval(async () => {
                if (writing) return;
                writing = true;
                try {
                    for (const m of await options.steers!()) {
                        await writeFile(path.join(steerDir, `${Date.now()}-${m.id}.json`), JSON.stringify(m), "utf-8");
                    }
                } catch (err) {
                    console.error(`run ${runId}: couldn't pass on a message:`, err);
                } finally {
                    writing = false;
                }
            }, 1000);
        }

        credentials = await credentialFlags(harness);
        const runEnv = envFlags(options.env);
        await ensureEgress();
        const trust = await sandboxTrustFlags();
        const proc = Bun.spawn([
            "docker",
            "run",
            "--rm",

            ...SANDBOX_LIMITS,
            ...EGRESS_FLAGS,
            ...trust,
            // A desktop starts many processes; tini reaps them and passes SIGINT on.
            ...(options.desktopPassword ? ["--init", "--shm-size", "256m"] : []),

            "--name",
            `run-${runId}`,

            "--label",
            `run_id=${runId}`,

            ...workspaceMounts(workspace),

            ...runnerMountFlags(process.cwd()),

            "-w",
            "/repo/packages/runner",

            "-v",
            `${controlDir}:/control:ro`,

            "-e",
            "CONTROL_CONFIG_PATH=/control/config.json",

            ...(options.homeDir ? ["-v", `${options.homeDir}:/home/node`, "-e", "HOME=/home/node"] : []),

            ...(options.filesDir ? ["-v", `${options.filesDir}:/files`] : []),
            ...(options.artifactsDir ? ["-v", `${options.artifactsDir}:/artifacts`] : []),
            ...(options.contextDir ? ["-v", `${options.contextDir}:/context`] : []),
            ...(options.sessionsDir ? ["-v", `${options.sessionsDir}:/sessions`] : []),
            ...(options.askDir ? ["-v", `${options.askDir}:/ask`] : []),
            ...(options.mounts ?? []).flatMap(([host, inside]) => ["-v", `${host}:${inside}`]),

            ...runEnv.flags,
            ...credentials.flags,

            "--user",
            sandboxUser(),

            options.image ?? "cloud-agents-base",

            "bun",
            "src/index.ts"

        ],{
            stdout:"pipe",
            stderr:"pipe",
            env: { ...process.env, ...runEnv.env, ...credentials.env },
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
        if (steerTimer) clearInterval(steerTimer);
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