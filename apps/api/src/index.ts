import { Hono } from 'hono'
import { prisma } from "@repo/db";
import { zValidator } from '@hono/zod-validator'
import { RunSchema } from '@repo/shared/run';
import { stream, streamSSE } from 'hono/streaming';
import { authMiddleware } from './middleware/auth_middleware';

const app = new Hono()

app.use(authMiddleware);

const CreateRunSchema = RunSchema.pick({
  repo: true,
  baseBranch: true,
  prompt: true,
  harness: true,
});




app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.post('/runs',zValidator("json",CreateRunSchema),async (c)=>{

  const {repo,baseBranch,prompt,harness} = c.req.valid("json");

  try{
    const run = await prisma.run.create({
      data: {
        repo,
        baseBranch,
        prompt,
        harness,
        status:"queued",
      },
    })
    return c.json({message:"Run created",id:run.id},201);
  }catch(e){
    console.error(e);
    return c.json({message:'Failed to create run'},500);
  }
})

app.get('/runs/:id', async (c)=>{
  const id = c.req.param('id');

  try{
    const run = await prisma.run.findUnique({
      where:{
        id,
      },
    })

    if(!run){
      return c.json({error:"Run not found"},404);
    }

    return c.json({message:'Found the run',run})
  }catch(e){
    return c.json({error:"Failed to fetch run"},500);
  }

})

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"];

app.post('/runs/:id/cancel', async (c) => {
  const id = c.req.param('id');

  try {
    const run = await prisma.run.findUnique({ where: { id } });

    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }

    if (TERMINAL_STATUSES.includes(run.status)) {
      return c.json({ message: `Run already ${run.status}, cannot cancel` }, 409);
    }

    await prisma.run.update({
      where: { id },
      data: { cancelRequested: true },
    });

    return c.json({ message: "Cancel requested" });
  } catch (e) {
    console.error(e);
    return c.json({ error: "Failed to cancel run" }, 500);
  }
})


app.get('/runs/:id/events',async (c)=>{
    const id = c.req.param('id');
    const run = await prisma.run.findUnique({where:{id}})

    if(!run){
      return c.json({error:"Run not found"},404);
    }

    const lastEventIdHeader = c.req.header('Last-Event-ID');
    let lastSeq = lastEventIdHeader !== undefined ? parseInt(lastEventIdHeader, 10) : -1;

    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        const events = await prisma.runEvent.findMany({
          where: { runId: id, seq: { gt: lastSeq } },
          orderBy: { seq: 'asc' },
        });

        let sawDone = false;

        for (const event of events) {
          await stream.writeSSE({
            id: String(event.seq),
            data: JSON.stringify({ kind: event.kind, data: event.data, ts: event.ts }),
          });
          lastSeq = event.seq;
          if (event.kind === 'done') sawDone = true;
        }

        if (sawDone) break;

        const current = await prisma.run.findUnique({ where: { id }, select: { status: true } });
        if (current && TERMINAL_STATUSES.includes(current.status)) break;

        if (events.length === 0) {
          // Keep the connection alive: a comment line (per the SSE spec, any
          // line starting with ":") is ignored by EventSource but keeps
          // bytes flowing, so Bun's idle-connection timeout doesn't tear
          // down the stream during a quiet stretch with no new events.
          await stream.write(': ping\n\n');
        }

        await stream.sleep(500);
      }

      await stream.close();
    })




})






export default app
