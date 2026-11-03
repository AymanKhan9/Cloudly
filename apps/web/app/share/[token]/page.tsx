"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import type { ArtifactMeta } from "@/lib/api";
import { ArtifactBody } from "@/components/artifacts";

// A shared artifact: anyone with the link sees this one version, nothing else of
// the session. The owner turns the link off from the artifact's share button.

type Shared = Pick<ArtifactMeta, "name" | "kind" | "mime" | "size" | "version" | "createdAt">;

export default function SharedArtifactPage() {
  const { token } = useParams<{ token: string }>();
  const [a, setA] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/shared/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message ?? "This link doesn't work.");
        setA(body.artifact);
        document.title = `${body.artifact.name} · Cloudly`;
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);
  const url = `/api/shared/${encodeURIComponent(token)}/content`;
  return (
    <main className="shared-artifact">
      <header>
        <div>
          <strong className="mono">{a?.name ?? "Shared artifact"}</strong>
          {a ? <span className="dim"> · v{a.version} · made by an agent in Cloudly</span> : null}
        </div>
        {a ? (
          <a className="btn btn-secondary btn-sm" href={`${url}?download=1`}>
            <DownloadSimple size={14} /> Download
          </a>
        ) : null}
      </header>
      {error ? <p className="notice" data-tone="danger" role="alert">{error}</p> : a ? <ArtifactBody a={a} url={url} tall /> : <div className="skeleton" style={{ height: 240 }} aria-busy="true" />}
    </main>
  );
}
