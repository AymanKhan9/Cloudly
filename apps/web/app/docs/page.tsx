import { DocArticle } from "@/components/doc-article";
import { loadDoc } from "@/lib/load-doc";

export const metadata = {
  title: "Introduction",
  description: loadDoc("introduction")!.description,
  alternates: { canonical: "/docs" },
};

export default function DocsHome() {
  return <DocArticle doc={loadDoc("introduction")!} />;
}
