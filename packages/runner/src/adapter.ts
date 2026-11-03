import type { RunEvent } from "@repo/shared/run-event";

export interface RunAdapter{
    start(
        task:string,
        resume?:string,
        /** The task with the earlier conversation in it, if the agent's own session can't be resumed. */
        fallbackTask?:string,
    ): AsyncIterable<RunEvent>

    interrupt():Promise<void>

    /**
     * A message from the user while the turn runs. Returns whether the agent will
     * get it in this turn; false once the turn is ending (it becomes the next turn).
     */
    steer?(text: string): boolean
}

/** How a message mid-turn reads to an agent that had to be interrupted for it. */
export function steerPrompt(texts: string[]): string {
    const body = texts.join("\n\n");
    return `The user sent this while you were working, so you were stopped for it. Take it into account and carry on with the task:\n\n${body}`;
}

