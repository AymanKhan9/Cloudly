import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { createRunContainer, runContainerCommand } from "./docker";
import { exportPatch, type CommitInfo, publishCommit, type PublishResult, destroyPublish } from "./finalize";

export async function v0(
    repoPath: string,
    task: string,
    checkCommand?: string,
): Promise<PublishResult> {
    const commitInfo: CommitInfo = {
        runId: crypto.randomUUID(),
        task,
        createdAt: new Date(),
    };

    let ws: Workspace | undefined;
    let result: PublishResult | undefined;

    try {
        ws = await createWorkspace(repoPath);

        for await (const _event of createRunContainer(ws, task, "native-claude", commitInfo.runId)) {
            // createRunContainer already prints each event as it arrives.
        }

        const patch = await exportPatch(ws);

        if (checkCommand) {
            const { exitCode, stdout, stderr } = await runContainerCommand([
                "-v", `${ws.runDir}:/workspace`,
                "--network", "none",
                "--user", "1000:1000",
                "cloud-agents-base",
                "sh", "-c",
                `cd /workspace && ${checkCommand}`,
            ]);

            console.log(`--- check (exit ${exitCode}) ---`);
            console.log(stdout);
            if (stderr) console.log(stderr);
        }

        result = await publishCommit(ws, patch, commitInfo);

        const diff = await Bun.$`git -C ${result.publishDir} show ${result.commitSha}`.text();
        console.log("--- diff ---");
        console.log(diff);

        return result;
    } finally {
        if (ws) await destroyWorkspace(ws);
        if (result) await destroyPublish(result);
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const repoPath = args[0];
    const task = args[1];

    const checkIndex = args.indexOf("--check");
    const checkCommand = checkIndex !== -1 ? args[checkIndex + 1] : undefined;

    if (!repoPath || !task) {
        console.error('usage: bun run v0 <local-repo> "<task>" [--check "<command>"]');
        process.exit(1);
    }

    v0(repoPath, task, checkCommand)
        .then((result) => {
            console.log("done:", result.commitSha);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
