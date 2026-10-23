export interface DocPage {
  slug: string;
  title: string;
  group: string;
}

/** Sidebar order. Each page is content/docs/<slug>.md; "introduction" is /docs. */
export const DOCS: DocPage[] = [
  { slug: "introduction", title: "Introduction", group: "Getting started" },
  { slug: "installation", title: "Installation", group: "Getting started" },
  { slug: "setup", title: "First-run setup", group: "Getting started" },
  { slug: "sessions", title: "Sessions and chat", group: "Using Cloudly" },
  { slug: "agents", title: "Agents and models", group: "Using Cloudly" },
  { slug: "spend-limit", title: "Spend limit", group: "Using Cloudly" },
  { slug: "arena", title: "Comparing agents", group: "Using Cloudly" },
  { slug: "mcp", title: "MCP servers", group: "Using Cloudly" },
  { slug: "shared-context", title: "Shared context", group: "Using Cloudly" },
  { slug: "secrets-and-files", title: "Secrets and files", group: "Using Cloudly" },
  { slug: "desktop-and-previews", title: "Desktop and previews", group: "Using Cloudly" },
  { slug: "sandbox", title: "Sandbox and network", group: "Using Cloudly" },
  { slug: "configuration", title: "Configuration", group: "Running it" },
  { slug: "upgrading", title: "Upgrades and troubleshooting", group: "Running it" },
  { slug: "architecture", title: "Architecture", group: "Under the hood" },
  { slug: "security", title: "Security model", group: "Under the hood" },
];

export const hrefOf = (slug: string) => (slug === "introduction" ? "/docs" : `/docs/${slug}`);

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
