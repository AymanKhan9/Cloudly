"use client";

import { useEffect, useRef, useState } from "react";
import { CloudScene, type SceneState } from "./cloud-scene";

const STEPS: { title: string; body: string; state: SceneState }[] = [
  {
    title: "Hand off a task from the browser.",
    body: "Pick a repo and an agent, describe the change, close the laptop. The worker on your VM picks it up and starts a fresh container for this run alone.",
    state: { sandbox: true, flows: ["task", "dispatch"], lit: ["web", "worker", "sandbox"] },
  },
  {
    title: "Your keys never enter the sandbox.",
    body: "The agent only holds a placeholder. A gateway outside the container swaps in your API key or Claude or ChatGPT plan token on the way to the vendor, so a malicious repo has nothing to steal.",
    state: { sandbox: true, flows: ["placeholder", "key"], lit: ["sandbox", "gateway", "model"] },
  },
  {
    title: "The sandbox can't phone home.",
    body: "Run containers reach only the model APIs, the main package registries and GitHub, plus any hosts you add. Everything else, DNS included, is blocked.",
    state: { sandbox: true, flows: ["blocked"], lit: ["sandbox"] },
  },
  {
    title: "Untrusted output is checked outside.",
    body: "The patch is exported in a network-less container, validated, then committed deterministically in a clone the agent never touched. The sandbox is removed.",
    state: { sandbox: false, flows: ["patch"], lit: ["worker"] },
  },
  {
    title: "A pull request lands on your repo.",
    body: "The worker pushes the branch and opens the pull request with a short-lived GitHub App token. GitHub credentials never enter the sandbox.",
    state: { sandbox: false, flows: ["pr"], lit: ["worker", "github"], badge: "Pull request opened" },
  },
];

const AUTOPLAY_MS = 3200;

export function RunStory({ hero }: { hero: React.ReactNode }) {
  const [inStep, setInStep] = useState<number | null>(null);
  const [auto, setAuto] = useState(0);
  const [paused, setPaused] = useState(false);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Which step sits in the middle band of the viewport drives the scene.
  useEffect(() => {
    const seen = new Map<Element, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target, e.isIntersecting);
        const i = stepRefs.current.findIndex((el) => el && seen.get(el));
        setInStep(i === -1 ? null : i);
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    stepRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  // In the hero, the model plays the run on a loop until someone takes over.
  useEffect(() => {
    if (inStep !== null || paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setAuto((i) => (i + 1) % STEPS.length), AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [inStep, paused]);

  const stage = inStep ?? auto;
  const step = STEPS[stage]!;

  return (
    <div className="wrap story">
      <div className="story-copy">
        {hero}
        <div className="story-steps" id="how">
          <h2>How a run works on your own cloud.</h2>
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              ref={(el) => {
                stepRefs.current[i] = el;
              }}
              className="step"
              data-active={inStep === i || undefined}
            >
              <span className="step-n num">{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="story-stage">
        <CloudScene state={step.state} label={`Model of your cloud account. Step ${stage + 1} of ${STEPS.length}: ${step.title}`} />
        <div className="scene-caption">
          <p aria-live="polite">
            <strong>{step.title}</strong>
          </p>
          <div className="scene-dots" role="group" aria-label="Run steps">
            {STEPS.map((s, i) => (
              <button
                key={s.title}
                type="button"
                aria-label={`Step ${i + 1}: ${s.title}`}
                aria-current={stage === i ? "step" : undefined}
                onClick={() => {
                  if (inStep !== null) stepRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
                  else {
                    setAuto(i);
                    setPaused(true);
                  }
                }}
              />
            ))}
          </div>
        </div>
        <p className="scene-hint">Drag or use the arrow keys to turn the model.</p>
      </div>
    </div>
  );
}
