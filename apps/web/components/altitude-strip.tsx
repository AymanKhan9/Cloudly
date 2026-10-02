"use client";

import { useEffect, useRef, useState } from "react";
import { CloudPlate } from "./cloud-plate";

/**
 * One altitude tier of the page's descent, drawn as a numbered plate strip:
 * cirrus high, altocumulus in the middle, stratocumulus low. The layer
 * thickens as it scrolls through the viewport.
 */
export function AltitudeStrip({
  plate,
  genus,
  name,
  altitude,
}: {
  plate: string;
  genus: number;
  name: string;
  altitude: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [growth, setGrowth] = useState(0.45);
  const [stretch, setStretch] = useState(3);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setStretch(Math.max(1.4, el.clientWidth / el.clientHeight / 1.6));
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const t = 1 - Math.min(1, Math.max(0, r.top / window.innerHeight));
      setGrowth(0.3 + t * 0.6);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <figure className="strip mount" ref={ref}>
      <div className="strip-sky mount-window">
        <CloudPlate growth={growth} genus={genus} stretch={stretch} camY={0.38} zenith={genus !== 0} label={`${name} layer`} />
      </div>
      <figcaption className="mount-caption strip-legend">
        <span className="caps">Plate {plate}</span>
        <span className="latin">{name}</span>
        <span className="num">{altitude}</span>
      </figcaption>
    </figure>
  );
}
