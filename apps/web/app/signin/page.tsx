import Link from "next/link";
import { GithubLogo, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { Mark } from "@/components/icons";
import { SetupNotice } from "@/components/setup-notice";

const ERRORS: Record<string, string> = {
  "not-allowed": "That GitHub account isn't allowed on this instance. Ask the owner to add it under Settings.",
  expired: "The sign-in attempt expired before it finished. Try again.",
  github: "GitHub didn't complete the sign-in. Try again, and check the GitHub App's client ID and secret if it keeps failing.",
  server: "Something went wrong on this instance. The API logs have the details.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? ERRORS.server) : null;

  return (
    <main className="auth">
      <div className="auth-card">
        <Link href="/" className="wordmark" aria-label="Cloudly home">
          <Mark />
          Cloudly
        </Link>
        <h1>Sign in to your instance</h1>
        <p className="lede">Use the GitHub account you listed when you set it up.</p>
        <SetupNotice />
        {message ? (
          <div className="notice" data-tone="danger" role="alert">
            <WarningCircle size={16} weight="bold" />
            {message}
          </div>
        ) : null}
        <a className="btn btn-primary btn-lg" href="/api/auth/github/login">
          <GithubLogo size={18} weight="fill" />
          Continue with GitHub
        </a>
        <p className="fine">
          Cloudly asks GitHub for your public profile only. Repository access comes from the GitHub App you installed,
          and only the accounts listed during setup can sign in.
        </p>
        <div className="auth-foot">
          <span>Self-hosted, MIT licensed</span>
          <Link href="/">About Cloudly</Link>
        </div>
      </div>
    </main>
  );
}
