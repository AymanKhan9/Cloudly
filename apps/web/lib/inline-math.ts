/**
 * Single dollars aren't math in chat replies, so "$5 and $10" stay prices. Agents
 * still write inline TeX that way ("$O(n \log n)$"), so a $…$ span is made math
 * when it reads as TeX: no space just inside either dollar, not followed by a
 * digit, and a backslash, ^, _ or brace in it. Code is left alone.
 */
export function inlineMath(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/(^|[^\\$\w])\$(?=[^\s$])([^$\n]*?[^\s\\$])\$(?![\d$\w])/g, (m, before: string, tex: string) =>
            /[\\^_{}]/.test(tex) ? `${before}$$${tex}$$` : m,
          ),
    )
    .join("");
}
