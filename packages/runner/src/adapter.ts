import type { RunEvent } from "@repo/shared/run-event";

export interface RunAdapter{
    start(
        task:string,
        resume?:string
    ): AsyncIterable<RunEvent>

    interrupt():Promise<void>
}

