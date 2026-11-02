import type { RunEvent } from "@repo/shared/run-event";

export interface RunAdapter{
    start(
        task:string,
        resume?:string,
        /** The task with the earlier conversation in it, if the agent's own session can't be resumed. */
        fallbackTask?:string,
    ): AsyncIterable<RunEvent>

    interrupt():Promise<void>
}

