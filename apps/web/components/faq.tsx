import { JsonLd } from "./json-ld";
import { REPO, SITE_URL } from "@/lib/site";

// Shown on the landing page and given to search engines as FAQPage data, from one list
// so the two never drift apart.
const FAQ = [
  {
    q: "What is Cloudly?",
    a: "Cloudly is a free, open-source server that runs coding agents such as Claude Code, Codex and Gemini CLI against your GitHub repositories. You give it a task from the browser, Discord, Slack, a GitHub issue or a Sentry error, and it comes back with a branch and a pull request whose tests have been run.",
  },
  {
    q: "Is Cloudly free?",
    a: "Yes. Cloudly is MIT-licensed and there is no Cloudly account or hosted service. You pay your cloud provider for the VM (or use a free tier such as Oracle Cloud's Always Free Arm machine) and pay for model usage through your own API keys, or use the Claude or ChatGPT plan you already have.",
  },
  {
    q: "Can I use my Claude or ChatGPT subscription instead of API keys?",
    a: "Yes. Claude Code can run on a Claude plan sign-in and Codex on a ChatGPT sign-in, added under Settings. Runs on a plan don't count toward Cloudly's spend limit.",
  },
  {
    q: "Which coding agents does Cloudly support?",
    a: "Claude Code, Codex and Gemini CLI are built in. Cursor, Grok, OpenCode, Antigravity, Pi and any other agent in the Agent Client Protocol (ACP) registry can be added from Settings. You pick one per session, or give the same task to several and keep the best result.",
  },
  {
    q: "Where does my code run, and are my API keys safe?",
    a: "On a VM in your own cloud account. Each turn runs in a throwaway, non-root Docker container. Agents only ever see placeholders for your keys: an egress proxy fills in the real key on the way to the hosts you allow. GitHub credentials stay outside the sandbox too; Cloudly commits and opens the pull request itself.",
  },
  {
    q: "How is Cloudly different from hosted agents or desktop agent apps?",
    a: "Hosted cloud agents run your code on someone else's servers. Desktop agent apps run agents on the computer in front of you, so the work pauses when it sleeps. Cloudly is a self-hosted server: agents keep working with your laptop closed, on infrastructure and keys you control, and every change is checked by your tests and optionally a reviewer agent before it becomes a pull request.",
  },
  {
    q: "What do I need to install it?",
    a: `A fresh Ubuntu 22.04+ or Debian 12+ VM with 1 GB of RAM or more, and a GitHub account. Run curl -fsSL ${SITE_URL}/install.sh | sh on the VM; it sets up Docker, Postgres and HTTPS, then finishes in the browser in about fifteen minutes.`,
  },
];

export function Faq() {
  return (
    <section id="faq" className="section">
      <div className="wrap faq">
        <h2>Questions</h2>
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
          },
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Cloudly",
            url: SITE_URL,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Linux (Ubuntu, Debian)",
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
            license: "https://opensource.org/licenses/MIT",
            downloadUrl: `${SITE_URL}/install.sh`,
            sameAs: [REPO],
          },
          { "@context": "https://schema.org", "@type": "WebSite", name: "Cloudly", alternateName: "usecloudly", url: SITE_URL },
        ]}
      />
    </section>
  );
}
