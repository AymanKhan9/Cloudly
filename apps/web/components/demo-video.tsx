"use client";

import { trackCustom } from "@/lib/ads-pixel";
import { JsonLd } from "./json-ld";
import { SITE_URL } from "@/lib/site";

const SRC = "/demo/cloudly-demo.mp4";
const POSTER = "/demo/poster.jpg";

/** The 90-second launch video. Click to play: it's narrated, so it never autoplays. */
export function DemoVideo() {
  return (
    <>
      <video
        className="demo-video"
        controls
        playsInline
        preload="none"
        poster={POSTER}
        width={1920}
        height={1080}
        onPlay={(e) => {
          // Once per page view.
          if (e.currentTarget.dataset.played) return;
          e.currentTarget.dataset.played = "1";
          trackCustom("demo_played");
        }}
      >
        <source src={SRC} type="video/mp4" />
      </video>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "VideoObject",
          name: "Cloudly in 90 seconds",
          description:
            "A real task run end to end: pick a repo and an agent, the agent works in a container on your server, tests run, and a pull request opens. Plus sessions that talk to each other, agent races and councils, Discord, GitHub and Sentry triggers, and spend limits.",
          thumbnailUrl: `${SITE_URL}${POSTER}`,
          contentUrl: `${SITE_URL}${SRC}`,
          uploadDate: "2026-11-06",
          duration: "PT1M29S",
        }}
      />
    </>
  );
}
