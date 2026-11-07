import { DOCS, hrefOf } from "@/lib/docs";
import { loadDoc } from "@/lib/load-doc";
import { REPO, SITE_DESCRIPTION, SITE_URL } from "@/lib/site";
import { comparisons } from "@/lib/compare";

export const dynamic = "force-static";

// llms.txt (llmstxt.org): a map of the docs for AI assistants and answer engines.
export function GET() {
  const groups = [...new Set(DOCS.map((d) => d.group))];
  const body = [
    "# Cloudly",
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `Website: ${SITE_URL}. Source: ${REPO}. Install on a fresh Ubuntu or Debian VM with \`curl -fsSL ${SITE_URL}/install.sh | sh\`.`,
    `The full text of every docs page is at ${SITE_URL}/llms-full.txt.`,
    ...groups.flatMap((g) => [
      "",
      `## ${g}`,
      "",
      ...DOCS.filter((d) => d.group === g).map((d) => `- [${d.title}](${SITE_URL}${hrefOf(d.slug)}): ${loadDoc(d.slug)!.description}`),
    ]),
    "",
    "## Comparisons",
    "",
    ...comparisons().map((c) => `- [${c.title}](${SITE_URL}/compare/${c.slug}): ${c.description}`),
    "",
    "## Releases",
    "",
    `- [Changelog](${SITE_URL}/changelog): every release with its date and changes`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
