import { JsonLd } from "./json-ld";
import { REPO, SITE_DESCRIPTION, SITE_URL } from "@/lib/site";

// Shown on the landing page and given to search engines as FAQPage data, from one list
// so the two never drift apart.
const FAQ = [
  {
    q: "What is Cloudly?",
    a: "Cloudly (usecloudly.dev) is a free, open-source server that runs coding agents such as Claude Code, Codex and Gemini CLI against your GitHub repositories, on a VM you own. You give it a task from the browser, Discord, Slack, a GitHub issue or a Sentry error, and it comes back with a branch and a pull request whose tests have been run.",
  },
  {
    q: "Is Cloudly free?",
    a: "Yes. Cloudly is MIT-licensed and there is no Cloudly account or hosted service. You pay your cloud provider for the VM (or use a free tier such as Oracle Cloud's Always Free Arm machine) and pay for model usage through your own API keys, or use the Claude or ChatGPT plan you already have.",
  },
  {
    q: "Is Cloudly a hosted service?",
    a: "No. Cloudly is software you install on your own Linux VM. There is no Cloudly account and no hosted control plane: the web app, API, worker and Postgres all run on your machine.",
  },
  {
    q: "Can Claude Code be self-hosted?",
    a: "Yes. Cloudly runs Claude Code on a VM in your own cloud account, so the agent keeps working after you close your laptop and your code stays on infrastructure you control. Each turn runs in a fresh container on that VM and ends with a pull request. It can use an Anthropic API key or your own Claude plan.",
  },
  {
    q: "Can I use my Claude or ChatGPT subscription instead of API keys?",
    a: "Yes, for your own use. Claude Code can run on a Claude plan token you create with Anthropic's own claude setup-token command, and Codex on a ChatGPT sign-in. Plans are meant for one person's ordinary use, so if other people use your Cloudly, give it API keys rather than your plan. Runs on a plan don't count toward Cloudly's spend limit.",
  },
  {
    q: "Which coding agents does Cloudly support?",
    a: "Claude Code, Codex and Gemini CLI are built in. Cursor, Grok, OpenCode, Antigravity, Pi and any other agent in the Agent Client Protocol (ACP) registry can be added from Settings. You pick one per session, or give the same task to several and keep the best result.",
  },
  {
    q: "Is there an open-source alternative to Codex cloud or Devin?",
    a: "Cloudly is one. It's MIT-licensed, runs on your own VM, and works with Codex, Claude Code, Gemini CLI and other agents instead of a single vendor's. Like hosted agents, it takes a task, works with your laptop closed and opens a pull request; unlike them, the environment and the keys stay yours.",
  },
  {
    q: "Where does my code run, and are my API keys safe?",
    a: "On a VM in your own cloud account. Each turn runs in a throwaway, non-root Docker container. Agents only ever see placeholders for your keys: an egress proxy fills in the real key on the way to the hosts you allow. GitHub credentials stay outside the sandbox too; Cloudly commits and opens the pull request itself.",
  },
  {
    q: "Does Cloudly use containers or microVMs?",
    a: "Containers. Each turn runs in a fresh, non-root Docker container that is deleted afterwards, with network access limited to an allowlist. Keys and GitHub credentials stay outside the container, so there is nothing to steal inside it.",
  },
  {
    q: "How does Cloudly stop a malicious repository from stealing my keys?",
    a: "The agent only ever holds placeholders. A proxy outside the sandbox swaps in the real key on requests to approved hosts, and other network traffic, DNS included, is blocked. The finished change is exported and validated in a container with no network, then committed in a clean clone the agent never touched.",
  },
  {
    q: "How does the spend limit work?",
    a: "You set a monthly limit. At 80% you get a banner and an email; at 100% new runs are refused. Claude Code reports exact cost, while Codex and Gemini token usage is priced from a table you control and marked as an estimate. Runs on a Claude or ChatGPT plan don't count.",
  },
  {
    q: "Can I give the same task to several agents?",
    a: "Yes. Give one task to two or three agents, compare their cost, time, diff size and summaries side by side, and open the best result as the pull request. For questions rather than code, a council of agents researches, cross-examines and writes one report.",
  },
  {
    q: "Does Cloudly support MCP servers?",
    a: "Yes. Connect Linear, Notion, Sentry or your own MCP server once in Settings. Cloudly handles the OAuth sign-in and keeps the tokens, and every agent gets the tools without ever holding a token.",
  },
  {
    q: "How is Cloudly different from hosted agents or desktop agent apps?",
    a: "Hosted cloud agents run your code on someone else's servers. Desktop agent apps run agents on the computer in front of you, so the work pauses when it sleeps. Cloudly is a self-hosted server: agents keep working with your laptop closed, on infrastructure and keys you control, and every change is checked by your tests and optionally a reviewer agent before it becomes a pull request.",
  },
  {
    q: "What do I need to install it?",
    a: `A fresh Ubuntu 22.04+ or Debian 12+ VM with 1 GB of RAM or more, and a GitHub account. Run curl -fsSL ${SITE_URL}/install.sh | sh on the VM; it sets up Docker, Postgres and HTTPS, then finishes in the browser in about fifteen minutes. You can also run it on your own computer to try it.`,
  },
];

export function Faq() {
  return (
    <section id="faq" className="section">
      <div className="wrap faq">
        <h2>Questions</h2>
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>
              <h3>{f.q}</h3>
            </summary>
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
            "@type": "Organization",
            "@id": `${SITE_URL}/#org`,
            name: "Cloudly",
            alternateName: "usecloudly",
            url: SITE_URL,
            logo: `${SITE_URL}/icon.png`,
            sameAs: [REPO],
            founder: { "@type": "Person", name: "Ayman Khan", url: "https://github.com/AymanKhan9" },
          },
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Cloudly",
            alternateName: "usecloudly",
            description: SITE_DESCRIPTION,
            url: SITE_URL,
            applicationCategory: "DeveloperApplication",
            applicationSubCategory: "Self-hosted cloud coding agents",
            operatingSystem: "Linux (Ubuntu 22.04+, Debian 12+)",
            memoryRequirements: "1 GB RAM",
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
            isAccessibleForFree: true,
            license: "https://opensource.org/licenses/MIT",
            downloadUrl: `${SITE_URL}/install.sh`,
            installUrl: `${SITE_URL}/docs/installation`,
            softwareHelp: `${SITE_URL}/docs`,
            featureList: [
              "Runs Claude Code, Codex and Gemini CLI, plus any Agent Client Protocol agent",
              "API keys and GitHub credentials never enter the sandbox",
              "Tests run on every change before the pull request",
              "Monthly spend limit that refuses new runs at 100%",
              "Give one task to several agents and keep the best pull request",
              "Start tasks from the browser, Discord, Slack, GitHub issues or Sentry",
            ],
            author: { "@id": `${SITE_URL}/#org` },
            sameAs: [REPO],
          },
          { "@context": "https://schema.org", "@type": "WebSite", name: "Cloudly", alternateName: "usecloudly", url: SITE_URL, publisher: { "@id": `${SITE_URL}/#org` } },
        ]}
      />
    </section>
  );
}
