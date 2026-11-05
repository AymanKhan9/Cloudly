import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { hrefOf, slugify } from "@/lib/docs";
import { loadDoc } from "@/lib/load-doc";
import { CodeBlock } from "./code-block";
import { DocToc } from "./doc-toc";
import { JsonLd } from "./json-ld";
import { SITE_URL } from "@/lib/site";

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node.props as { children?: React.ReactNode }).children);
  return "";
}

export function DocArticle({ doc }: { doc: NonNullable<ReturnType<typeof loadDoc>> }) {
  return (
    <>
      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "TechArticle",
            headline: doc.page.title,
            description: doc.description,
            url: SITE_URL + hrefOf(doc.page.slug),
            isPartOf: { "@type": "WebSite", name: "Cloudly", url: SITE_URL },
            about: { "@type": "SoftwareApplication", name: "Cloudly" },
          },
          {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Cloudly", item: SITE_URL },
              { "@type": "ListItem", position: 2, name: "Docs", item: `${SITE_URL}/docs` },
              { "@type": "ListItem", position: 3, name: doc.page.title, item: SITE_URL + hrefOf(doc.page.slug) },
            ],
          },
        ]}
      />
      <article className="prose">
        <p className="docs-crumb">{doc.page.group}</p>
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            h2: ({ children }) => (
              <h2 id={slugify(textOf(children))}>
                <a href={`#${slugify(textOf(children))}`}>{children}</a>
              </h2>
            ),
            h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
            pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
            a: ({ node: _node, href = "", ...props }) =>
              href.startsWith("http") ? <a href={href} target="_blank" rel="noreferrer" {...props} /> : <Link href={href} {...props} />,
            table: ({ node: _node, ...props }) => (
              <div className="table-wrap">
                <table {...props} />
              </div>
            ),
          }}
        >
          {doc.markdown}
        </Markdown>

        <nav className="docs-pager" aria-label="More docs">
          {doc.prev ? (
            <Link href={hrefOf(doc.prev.slug)}>
              <small>
                <ArrowLeft size={13} /> Previous
              </small>
              {doc.prev.title}
            </Link>
          ) : (
            <span />
          )}
          {doc.next ? (
            <Link href={hrefOf(doc.next.slug)} className="next">
              <small>
                Next <ArrowRight size={13} />
              </small>
              {doc.next.title}
            </Link>
          ) : null}
        </nav>
      </article>

      {doc.toc.length > 1 ? <DocToc toc={doc.toc} /> : null}
    </>
  );
}
