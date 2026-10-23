import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";

// A virtual display for the run: Xvfb, a window manager when one is installed,
// and a VNC server the user watches through Cloudly's relay. Needs the
// "Desktop and browser" sandbox preset; without it the run goes on without one.

export const DISPLAY = ":99";
export const SCREEN = { width: 1280, height: 800 };
export const VNC_PORT = 5900;

const children: ChildProcess[] = [];

function start(cmd: string, args: string[]): ChildProcess {
    const child = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, DISPLAY } });
    child.on("error", () => {});
    children.push(child);
    return child;
}

export function desktopInstalled(): boolean {
    return Boolean(Bun.which("Xvfb") && Bun.which("x11vnc") && Bun.which("xdotool"));
}

/**
 * Starts the display and the VNC server, and sets DISPLAY for everything the
 * agent runs. The VNC password keeps other containers on the sandbox network
 * out. Returns false when the tools aren't installed.
 */
export async function startDesktop(password: string): Promise<boolean> {
    if (!desktopInstalled()) return false;
    const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
    // A display left over from an earlier process would make the wait below pass too early.
    await rm(socket, { force: true });
    await rm(`/tmp/.X${DISPLAY.slice(1)}-lock`, { force: true });
    start("Xvfb", [DISPLAY, "-screen", "0", `${SCREEN.width}x${SCREEN.height}x24`, "-nolisten", "tcp"]);
    for (let i = 0; i < 50 && !existsSync(socket); i++) await Bun.sleep(100);
    if (!existsSync(socket)) return false;
    process.env.DISPLAY = DISPLAY;
    if (Bun.which("fluxbox")) start("fluxbox", []);
    // "rm:" makes x11vnc delete the file once it has read the password.
    const pwFile = `/tmp/.cloudly-vnc-${process.pid}`;
    await writeFile(pwFile, `${password}\n`, { mode: 0o600 });
    start("x11vnc", ["-display", DISPLAY, "-forever", "-shared", "-rfbport", String(VNC_PORT), "-passwdfile", `rm:${pwFile}`, "-quiet", "-noxdamage"]);
    return true;
}

export function stopDesktop(): void {
    for (const child of children.splice(0)) child.kill();
}

/** Chromium flags for running inside the sandbox, behind its proxy. */
export function browserArgs(url: string): string[] {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    return [
        // The container is the sandbox: Chromium's own needs privileges it doesn't have.
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--user-data-dir=/tmp/chromium",
        `--window-size=${SCREEN.width},${SCREEN.height}`,
        "--window-position=0,0",
        ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=localhost;127.0.0.1;cloudly-egress"] : []),
        url,
    ];
}

export function openBrowser(url: string): void {
    const bin = Bun.which("chromium") ?? Bun.which("chromium-browser") ?? Bun.which("google-chrome");
    if (!bin) throw new Error("No browser is installed in the sandbox. Tick \"Desktop and browser\" under Settings > Sandbox tools.");
    const child = spawn(bin, browserArgs(url), { stdio: "ignore", detached: true, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? DISPLAY } });
    child.on("error", () => {});
    child.unref();
}
