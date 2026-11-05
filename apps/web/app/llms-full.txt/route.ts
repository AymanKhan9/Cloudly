import { DOCS, hrefOf } from "@/lib/docs";
import { loadDoc } from "@/lib/load-doc";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

// Every docs page in one file, for AI assistants that read whole docs at once.
export function GET() {
  const body = DOCS.map((d) => `<!-- ${SITE_URL}${hrefOf(d.slug)} -->\n${loadDoc(d.slug)!.markdown.trim()}\n`).join("\n---\n\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
