import { DocArticle } from "@/components/doc-article";
import { loadDoc } from "@/lib/load-doc";

export const metadata = { title: "Introduction" };

export default function DocsHome() {
  return <DocArticle doc={loadDoc("introduction")!} />;
}
