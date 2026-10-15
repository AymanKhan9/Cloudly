import type { SVGProps } from "react";

/** Cloudly mark: a circle half filled, one run in flight. */
export function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...props}>
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M16 4a12 12 0 0 1 0 24Z" fill="currentColor" />
    </svg>
  );
}
