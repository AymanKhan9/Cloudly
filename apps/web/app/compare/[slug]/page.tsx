import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { comparisons } from "@/lib/compare";
import { Prose } from "@/components/prose";

export const dynamicParams = false;

export function generateStaticParams() {
  return comparisons().map((c) => ({ slug: c.slug }));
}

const find = (slug: string) => comparisons().find((c) => c.slug === slug);

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const c = find((await params).slug);
  if (!c) return {};
  const url = `/compare/${c.slug}`;
  return { title: c.title, description: c.description, alternates: { canonical: url }, openGraph: { type: "article", url, title: c.title, description: c.description } };
}

export default async function ComparePage({ params }: { params: Promise<{ slug: string }> }) {
  const c = find((await params).slug);
  if (!c) notFound();
  return (
    <article className="prose">
      <Prose markdown={c.markdown} />
    </article>
  );
}
