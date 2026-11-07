import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// The public website is indexed, AI crawlers included. A self-hosted instance is
// someone's private server, so it asks not to be.
const PRIVATE = ["/app", "/signin", "/setup", "/share"];

export default function robots(): MetadataRoute.Robots {
  if (process.env.NEXT_PUBLIC_SITE_MODE !== "marketing") return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: [
      // Named so the policy is explicit: search, answer and training crawlers are all welcome.
      {
        userAgent: ["OAI-SearchBot", "ChatGPT-User", "GPTBot", "Claude-SearchBot", "Claude-User", "ClaudeBot", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot"],
        allow: "/",
        disallow: PRIVATE,
      },
      { userAgent: "*", allow: "/", disallow: PRIVATE },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
