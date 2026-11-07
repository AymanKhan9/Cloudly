import type { Metadata } from "next";
import { Prose } from "@/components/prose";
import { REPO } from "@/lib/site";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every Cloudly release, with its date and what changed.",
  alternates: { canonical: "/changelog" },
};

// The GitHub releases, refreshed daily. The release workflow writes each one's notes from its commits.
export const revalidate = 86400;

type Release = { tag_name: string; published_at: string; body: string | null; html_url: string };

export default async function Changelog() {
  const res = await fetch(`https://api.github.com/repos/${REPO.replace("https://github.com/", "")}/releases?per_page=100`, {
    headers: { Accept: "application/vnd.github+json" },
    next: { revalidate },
  });
  const releases: Release[] = res.ok ? await res.json() : [];
  const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <article className="prose">
      <h1>Changelog</h1>
      <p>
        Every Cloudly release, newest first. To update a server, re-run the install command (see{" "}
        <a href="/docs/upgrading">Upgrades</a>). The same notes are on <a href={`${REPO}/releases`}>GitHub</a>.
      </p>
      {releases.length === 0 ? <p>The release list couldn&apos;t be loaded just now; it&apos;s on GitHub in the meantime.</p> : null}
      {releases.map((r) => (
        <section key={r.tag_name}>
          <h2 id={r.tag_name}>
            {r.tag_name} <small style={{ fontWeight: 400, color: "var(--text-3)" }}>· {date(r.published_at)}</small>
          </h2>
          <Prose markdown={r.body || "Maintenance release."} />
        </section>
      ))}
    </article>
  );
}
