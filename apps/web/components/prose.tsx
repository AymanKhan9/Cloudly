import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown in the docs' typography, for the compare and changelog pages. */
export function Prose({ markdown }: { markdown: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, href = "", ...props }) =>
          href.startsWith("http") ? <a href={href} target="_blank" rel="noreferrer" {...props} /> : <Link href={href} {...props} />,
        table: ({ node: _node, ...props }) => (
          <div className="table-wrap">
            <table {...props} />
          </div>
        ),
      }}
    >
      {markdown}
    </Markdown>
  );
}
