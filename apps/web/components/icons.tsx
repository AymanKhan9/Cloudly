import type { SVGProps } from "react";

/** The Cloudly mark: a cloud with a check in it (work that was checked before it came back). */
export function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 -1 24 24" aria-hidden="true" {...props}>
      <path fill="currentColor" fillRule="evenodd" d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z M7.14 13.31 10.55 16.71 16.66 10.61 15.24 9.19 10.55 13.89 8.56 11.89Z" />
    </svg>
  );
}
