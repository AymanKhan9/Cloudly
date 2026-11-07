import type { MetadataRoute } from "next";
import { DOCS, hrefOf } from "@/lib/docs";
import { SITE_URL } from "@/lib/site";
import { comparisons } from "@/lib/compare";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/compare`, changeFrequency: "monthly", priority: 0.7 },
    ...comparisons().map((c) => ({ url: `${SITE_URL}/compare/${c.slug}`, changeFrequency: "monthly" as const, priority: 0.7 })),
    { url: `${SITE_URL}/changelog`, changeFrequency: "weekly", priority: 0.5 },
    ...DOCS.map((d) => ({ url: SITE_URL + hrefOf(d.slug), changeFrequency: "weekly" as const, priority: d.group === "Getting started" ? 0.8 : 0.6 })),
  ];
}
