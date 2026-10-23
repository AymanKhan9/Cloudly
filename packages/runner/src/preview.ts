// A session's app, kept running so the user can open it. Runs the user's
// command, and forwards FORWARD_PORT on every interface to the app's port on
// localhost, since most dev servers only listen on localhost and Cloudly's relay
// reaches the container from outside it. With a desktop, the app also opens in
// the sandbox's browser, for viewing it without running its code in your own.
import net from "node:net";
import { spawn } from "node:child_process";
import { openBrowser, startDesktop } from "./desktop";

export const FORWARD_PORT = 39000;

interface PreviewConfig {
    command: string;
    port: number;
    desktop?: { password: string };
}

export function forward(listenPort: number, targetPort: number): net.Server {
    const server = net.createServer((client) => {
        const upstream = net.connect(targetPort, "127.0.0.1");
        client.pipe(upstream).pipe(client);
        const close = () => {
            client.destroy();
            upstream.destroy();
        };
        client.on("error", close);
        upstream.on("error", close);
    });
    server.listen(listenPort, "0.0.0.0");
    return server;
}

async function listening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => {
            s.destroy();
            resolve(true);
        });
        s.on("error", () => resolve(false));
    });
}

if (import.meta.main) {
    const config = (await Bun.file(process.env.CONTROL_CONFIG_PATH ?? "/control/config.json").json()) as PreviewConfig;
    const desktop = config.desktop ? await startDesktop(config.desktop.password) : false;
    forward(FORWARD_PORT, config.port);
    console.log(`[cloudly] running: ${config.command}`);
    const app = spawn("bash", ["-lc", config.command], { cwd: "/workspace", stdio: "inherit", env: { ...process.env, PORT: String(config.port) } });
    app.on("exit", (code) => {
        console.log(`[cloudly] the command exited with code ${code}`);
        process.exit(code ?? 1);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.kill(signal));

    // Say when the app is up, and open it on the desktop.
    for (let i = 0; i < 600; i++) {
        if (await listening(config.port)) {
            console.log(`[cloudly] the app is listening on port ${config.port}`);
            if (desktop) {
                try {
                    openBrowser(`http://localhost:${config.port}`);
                } catch (err) {
                    console.log(`[cloudly] ${err instanceof Error ? err.message : err}`);
                }
            }
            break;
        }
        await Bun.sleep(1000);
    }
}
