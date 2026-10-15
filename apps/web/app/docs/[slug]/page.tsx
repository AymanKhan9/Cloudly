import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "@/components/doc-article";
import { DOCS } from "@/lib/docs";
import { loadDoc } from "@/lib/load-doc";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.filter((d) => d.slug !== "introduction").map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: DOCS.find((d) => d.slug === slug)?.title };
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const doc = loadDoc((await params).slug);
  if (!doc) notFound();
  return <DocArticle doc={doc} />;
}
