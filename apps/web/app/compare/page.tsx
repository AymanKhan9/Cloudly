import type { Metadata } from "next";
import Link from "next/link";
import { comparisons } from "@/lib/compare";

export const metadata: Metadata = {
  title: "Self-hosted alternatives to Claude Code on the web, Codex cloud and desktop agent apps",
  description:
    "How Cloudly compares with Claude Code on the web, OpenAI Codex cloud, OpenHands, Conductor, T3 Code and Orca: where agents run, which agents you can use, and what keeps working with your laptop closed.",
  alternates: { canonical: "/compare" },
};

export default function CompareHub() {
  return (
    <article className="prose">
      <h1>Cloudly compared</h1>
      <p>
        Cloudly is a free, open-source server that runs coding agents such as Claude Code, Codex and Gemini CLI on your
        GitHub repos, from a VM you own. Hosted agents run on a vendor&apos;s servers and use only that vendor&apos;s
        agent. Desktop apps run agents on your own computer, so the work stops when it sleeps. Here&apos;s how it lines up,
        with an honest note on when to pick the other one.
      </p>
      <ul>
        {comparisons().map((c) => (
          <li key={c.slug}>
            <Link href={`/compare/${c.slug}`}>{c.title}</Link>: {c.description}
          </li>
        ))}
      </ul>
    </article>
  );
}
