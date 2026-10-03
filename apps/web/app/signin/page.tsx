import Link from "next/link";
import { CloudPlate } from "@/components/cloud-plate";
import { GitHubIcon, Mark } from "@/components/icons";
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
    <main className="signin">
      <figure className="signin-sky mount">
        <div className="mount-head">
          <span className="caps">Plate I</span>
          <span className="caps" style={{ color: "var(--slate)" }}>
            Fair weather
          </span>
        </div>
        <div className="mount-window">
          <CloudPlate growth={0.55} genus={0} label="Cumulus cloud over the station" />
        </div>
        <figcaption className="mount-caption">
          <span>
            <span className="latin">Cumulus mediocris</span>, fair weather over the station.
          </span>
        </figcaption>
      </figure>

      <div className="signin-panel">
        <Link href="/" className="wordmark" aria-label="Cloudly home">
          <Mark />
          Cloudly
        </Link>

        <div className="signin-card">
          <h1 className="display">Sign in to your station.</h1>
          <p>Use the GitHub account you listed when you set up this instance.</p>
          <SetupNotice />
          {message ? (
            <div className="alert" role="alert">
              {message}
            </div>
          ) : null}
          <a className="btn btn-signal" href="/api/auth/github/login">
            <GitHubIcon />
            Continue with GitHub
          </a>
          <p className="signin-fine">
            Only the GitHub accounts listed during setup can sign in. Cloudly asks GitHub for your
            public profile only; repository access comes from the GitHub App you installed.
          </p>
        </div>

        <span className="signin-fine" style={{ margin: 0 }}>
          Self-hosted · MIT
        </span>
      </div>
    </main>
  );
}
