import { test, expect } from "bun:test";
import { prisma, deleteSetting } from "@repo/db";
import { syncSandboxImage, sandboxImage, BASE_IMAGE } from "../src/sandbox-image";

const run = async (args: string[]) => {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { out: (await new Response(p.stdout).text()).trim(), code: await p.exited };
};

test("the setup script builds the image runs use; a broken script fails once and keeps the last good image", async () => {
  // A script saved in Settings wins over the env var this test sets.
  await deleteSetting("SANDBOX_SETUP_SCRIPT");
  await prisma.sandboxImage.deleteMany();
  try {
    process.env.SANDBOX_SETUP_SCRIPT = "echo built > /etc/cloudly-test-marker";
    await syncSandboxImage();
    const good = await prisma.sandboxImage.findUniqueOrThrow({ where: { id: 1 } });
    expect(good.status).toBe("ready");
    expect(good.image.startsWith("cloudly-sandbox:")).toBe(true);
    expect(await sandboxImage()).toBe(good.image);
    const marker = await run(["run", "--rm", good.image, "cat", "/etc/cloudly-test-marker"]);
    expect(marker.out).toBe("built");
    expect((await run(["run", "--rm", good.image, "id", "-u"])).out).toBe("1000");

    process.env.SANDBOX_SETUP_SCRIPT = "echo about to fail; exit 3";
    await syncSandboxImage();
    const bad = await prisma.sandboxImage.findUniqueOrThrow({ where: { id: 1 } });
    expect(bad.status).toBe("failed");
    expect(bad.log).toContain("about to fail");
    expect(await sandboxImage()).toBe(good.image);

    // Not retried on its own.
    const before = bad.updatedAt.getTime();
    await syncSandboxImage();
    expect((await prisma.sandboxImage.findUniqueOrThrow({ where: { id: 1 } })).updatedAt.getTime()).toBe(before);

    delete process.env.SANDBOX_SETUP_SCRIPT;
    await syncSandboxImage();
    expect(await sandboxImage()).toBe(BASE_IMAGE);
    await run(["rmi", good.image]);
  } finally {
    delete process.env.SANDBOX_SETUP_SCRIPT;
    await prisma.sandboxImage.deleteMany();
  }
}, 180000);
