import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// The public website is indexed, AI crawlers included. A self-hosted instance is
// someone's private server, so it asks not to be.
export default function robots(): MetadataRoute.Robots {
  if (process.env.NEXT_PUBLIC_SITE_MODE !== "marketing") return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/app", "/signin", "/setup", "/share"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
