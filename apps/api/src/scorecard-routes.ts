import { Hono } from "hono";
import { agentScorecard, pickAgent } from "@repo/db";
import type { AuthEnv } from "./middleware/auth_middleware";
import { listHarnesses } from "./harnesses";

// The agent scorecard (see @repo/db scorecard): how each agent has done on a
// repo, and which one "Auto" would pick for a new session there.

export const scorecard = new Hono<AuthEnv>();
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

scorecard.get("/", async (c) => {
  const repo = c.req.query("repo") || null;
  if (repo && !SLUG.test(repo)) return c.json({ message: "Expected owner/repo" }, 400);
  const days = Math.min(365, Math.max(7, Number(c.req.query("days")) || 90));
  const agents = await agentScorecard({ repo, days });
  const ready = (await listHarnesses()).filter((h) => h.ready).map((h) => h.id);
  // The best record whether or not that agent can run now, to say why Auto didn't pick it.
  const best = repo ? pickAgent(agents, agents.map((a) => a.harness)) : null;
  return c.json({ repo, days, agents, pick: repo ? pickAgent(agents, ready) : null, best });
});
