/** The deployment drawn as an atlas plate: one VM in the user's account. */
export function StationFigure() {
  const chalk = "#eef2f7";
  const dim = "rgba(238,242,247,0.55)";
  const hair = "rgba(238,242,247,0.35)";
  const rose = "#e8b9a6";

  const box = (x: number, y: number, w: number, h: number, title: string, sub?: string, strong = false) => (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="3" fill={strong ? "rgba(238,242,247,0.08)" : "none"} stroke={chalk} strokeWidth="1.25" />
      <text x={x + 14} y={y + 24} fill={chalk} style={{ fontSize: 14, fontWeight: 600 }}>
        {title}
      </text>
      {sub ? (
        <text x={x + 14} y={y + 43} fill={dim} style={{ fontSize: 12 }}>
          {sub}
        </text>
      ) : null}
    </g>
  );

  const arrow = (d: string, label: string, lx: number, ly: number, color = chalk) => (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth="1.25" markerEnd="url(#arrowhead)" />
      <text x={lx} y={ly} fill={color} style={{ fontSize: 12 }}>
        {label}
      </text>
    </g>
  );

  const tall = (
    <svg className="station-tall" viewBox="0 0 360 700" role="img" aria-label="Where Cloudly runs: one VM in your account, a sandbox per run, GitHub and the model API outside.">
      <defs>
        <marker id="arrowhead-tall" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" fill={chalk} />
        </marker>
      </defs>
      {box(100, 6, 160, 44, "Your browser")}
      <path d="M180 50 L180 86" stroke={chalk} strokeWidth="1.25" markerEnd="url(#arrowhead-tall)" />
      <rect x="6" y="92" width="348" height="440" rx="4" fill="none" stroke={hair} strokeDasharray="5 6" />
      <text x="20" y="114" fill={dim} className="caps" style={{ fontSize: 11 }}>
        Your cloud account
      </text>
      <rect x="20" y="126" width="320" height="392" rx="3" fill="none" stroke={chalk} strokeWidth="1.6" />
      <text x="34" y="150" fill={chalk} style={{ fontSize: 15, fontWeight: 700 }}>
        One VM
      </text>
      <text x="96" y="150" fill={dim} style={{ fontSize: 12 }}>
        Linux · Docker
      </text>
      {box(34, 166, 140, 58, "Web + API", "sign-in, live stream")}
      {box(186, 166, 140, 58, "Postgres", "runs, budget")}
      {box(34, 238, 292, 58, "Worker", "claims runs, enforces limit", true)}
      <path d="M180 296 L180 324" stroke={chalk} strokeWidth="1.25" markerEnd="url(#arrowhead-tall)" />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={34 + i * 99} y="330" width="90" height="92" rx="3" fill="none" stroke={rose} strokeWidth="1.25" />
          <text x={44 + i * 99} y="352" fill={rose} style={{ fontSize: 13, fontWeight: 600 }}>
            Sandbox
          </text>
          <text x={44 + i * 99} y="370" fill={dim} style={{ fontSize: 11 }}>
            non-root
          </text>
          <text x={44 + i * 99} y="386" fill={dim} style={{ fontSize: 11 }}>
            no GitHub
          </text>
          <text x={44 + i * 99} y="401" fill={dim} style={{ fontSize: 11 }}>
            creds
          </text>
        </g>
      ))}
      <text x="34" y="446" fill={dim} style={{ fontSize: 12 }}>
        one container per run, removed when it ends
      </text>
      <path d="M100 518 L100 560" stroke={chalk} strokeWidth="1.25" markerEnd="url(#arrowhead-tall)" />
      <path d="M262 518 L262 560" stroke={rose} strokeWidth="1.25" markerEnd="url(#arrowhead-tall)" />
      {box(20, 566, 158, 62, "GitHub", "push + PR, App token")}
      {box(186, 566, 154, 62, "Model API", "called with your key")}
    </svg>
  );

  return (
    <figure className="station-figure" style={{ margin: 0 }}>
      {tall}
      <svg className="station-wide" viewBox="0 0 760 500" role="img" aria-labelledby="station-title station-desc">
        <title id="station-title">Where Cloudly runs</title>
        <desc id="station-desc">
          One VM in your cloud account runs the Cloudly web app, API, worker and Postgres. Each run gets its own sandbox
          container that calls the model API with your key. The worker, outside the sandbox, pushes the branch and opens
          the pull request on GitHub.
        </desc>
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 10 5 0 10z" fill="currentColor" style={{ color: chalk }} />
          </marker>
        </defs>

        <rect x="150" y="20" width="420" height="460" rx="4" fill="none" stroke={hair} strokeDasharray="5 6" />
        <text x="166" y="44" fill={dim} className="caps" style={{ fontSize: 11 }}>
          Your cloud account
        </text>

        <rect x="172" y="60" width="376" height="400" rx="3" fill="none" stroke={chalk} strokeWidth="1.6" />
        <text x="188" y="86" fill={chalk} style={{ fontSize: 15, fontWeight: 700 }}>
          One VM
        </text>
        <text x="250" y="86" fill={dim} style={{ fontSize: 12 }}>
          Linux · Docker
        </text>

        {box(190, 104, 162, 62, "Web + API", "sign-in, live stream")}
        {box(368, 104, 162, 62, "Postgres", "runs, events, budget")}
        {box(190, 184, 340, 62, "Worker", "claims runs, enforces your limit", true)}

        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect x={190 + i * 116} y="282" width="104" height="96" rx="3" fill="none" stroke={rose} strokeWidth="1.25" />
            <text x={202 + i * 116} y="304" fill={rose} style={{ fontSize: 13, fontWeight: 600 }}>
              Sandbox
            </text>
            <text x={202 + i * 116} y="322" fill={dim} style={{ fontSize: 11.5 }}>
              non-root
            </text>
            <text x={202 + i * 116} y="338" fill={dim} style={{ fontSize: 11.5 }}>
              no GitHub creds
            </text>
          </g>
        ))}
        <text x="190" y="410" fill={dim} style={{ fontSize: 12 }}>
          one container per run, removed when it ends
        </text>

        {arrow("M360 246 L360 278", "", 0, 0)}

        {box(10, 112, 118, 50, "Your browser")}
        {arrow("M128 137 L186 137", "", 0, 0)}

        {box(600, 290, 150, 62, "Model API", "called with your key")}
        {arrow("M538 330 L594 322", "", 0, 0, rose)}

        {box(600, 178, 150, 62, "GitHub", "push + PR, App token")}
        {arrow("M530 214 L594 210", "", 0, 0)}
      </svg>
    </figure>
  );
}
