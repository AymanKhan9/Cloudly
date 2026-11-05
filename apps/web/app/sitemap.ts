import type { MetadataRoute } from "next";
import { DOCS, hrefOf } from "@/lib/docs";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: "weekly", priority: 1 },
    ...DOCS.map((d) => ({ url: SITE_URL + hrefOf(d.slug), changeFrequency: "weekly" as const, priority: d.group === "Getting started" ? 0.8 : 0.6 })),
  ];
}
