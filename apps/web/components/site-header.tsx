import Link from "next/link";
import { GithubLogo } from "@phosphor-icons/react/dist/ssr";
import { Mark } from "./icons";
import { ThemeToggle } from "./theme-toggle";

export const REPO_URL = "https://github.com/AymanKhan9/Cloudly";
export const MARKETING = process.env.NEXT_PUBLIC_SITE_MODE === "marketing";

/** The top bar shared by the landing page and the docs. */
export function SiteHeader({ current }: { current?: "docs" }) {
  return (
    <header className="topbar">
      <div className="wrap">
        <Link href="/" className="wordmark" aria-label="Cloudly home">
          <Mark />
          Cloudly
        </Link>
        <nav aria-label="Main">
          <Link href="/#how" className="hide-sm">
            How it works
          </Link>
          <Link href="/#spend" className="hide-sm">
            Spend limit
          </Link>
          <Link href="/docs" aria-current={current === "docs" ? "page" : undefined}>
            Docs
          </Link>
          <a href={REPO_URL} aria-label="Cloudly on GitHub">
            <GithubLogo size={18} />
          </a>
          <ThemeToggle />
          {MARKETING ? null : (
            <Link href="/signin" className="btn btn-secondary btn-sm">
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
