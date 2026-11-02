"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCircleUp, ArrowSquareOut, ArrowsClockwise, CheckCircle, Circle, Info, MagnifyingGlass, Plus, Terminal, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { api, ApiError, type AgentRow, type AgentsSettings, type CatalogItem, type RegistryItem } from "@/lib/api";
import { AgentLogo, MaskIcon } from "@/components/agent-logo";
import { useApp } from "@/components/app-context";
import { HARNESSES, costLabel } from "@/lib/harness";

// Settings > Agents. The three built-in agents, plus any added the way T3 Code
// adds providers: from Cloudly's list, the ACP registry, or a command you enter.

const SOURCE: Record<AgentRow["source"], string> = { catalog: "Cloudly's list", registry: "ACP registry", custom: "Your command" };

const hostsText = (hosts: string[]) => hosts.join(", ");
const parseHosts = (text: string) => text.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);

/** One key's row: where it goes, whether it's set, and a write-only field. */
function KeyField({ agent, k, onSaved }: { agent: AgentRow; k: AgentRow["credentials"][number]; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userDefined = agent.source !== "catalog";

  async function save(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      await api(`/settings/agents/${agent.id}/keys`, { method: "PUT", body: JSON.stringify({ values: { [k.env]: next } }) });
      setValue("");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await api(`/settings/agents/${agent.id}/keys/${k.env}`, { method: "DELETE" }).catch(() => {});
    setBusy(false);
    onSaved();
  }

  const Icon = k.set || k.reused ? CheckCircle : k.optional ? Circle : WarningCircle;
  return (
    <div className="agent-key">
      <div>
        <div className="name">
          {k.label} <span className="mono dim">{k.env}</span>
        </div>
        <div className="state" data-set={k.set || k.reused || undefined} data-locked={!k.set && !k.reused && !k.optional ? true : undefined}>
          <Icon size={13} weight="bold" />
          {k.set ? `Set, ending ${k.preview?.replace("…", "")}` : k.reused ? `Using ${k.reuse} from your keys` : k.optional ? "Optional, not set" : "Needed, not set"}
        </div>
        <div className="hint">Sent only to {hostsText(k.hosts)}</div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) save(value);
        }}
      >
        <input className="input mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={k.set ? "Replace" : "Paste key"} aria-label={`${k.label} for ${agent.name}`} autoComplete="off" />
        <button type="submit" className="btn btn-secondary" disabled={busy || !value.trim()}>
          Save
        </button>
        {k.set ? (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => save(null)}>
            Clear
          </button>
        ) : null}
        {userDefined ? (
          <button type="button" className="icon-btn" disabled={busy} onClick={remove} aria-label={`Remove ${k.env}`} title="Remove this key">
            <Trash size={15} />
          </button>
        ) : null}
      </form>
      {error ? <p className="hint err" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </div>
  );
}

/** A key of the agent's own choosing (registry and custom agents): its variable, hosts and value. */
function DefineKey({ agent, onSaved }: { agent: AgentRow; onSaved: () => void }) {
  const [env, setEnv] = useState("");
  const [hosts, setHosts] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/settings/agents/${agent.id}/keys`, {
        method: "PUT",
        body: JSON.stringify({ define: [{ env, hosts: parseHosts(hosts) }], values: value ? { [env]: value } : {} }),
      });
      setEnv("");
      setHosts("");
      setValue("");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="agent-define" onSubmit={add}>
      <input className="input mono" value={env} onChange={(e) => setEnv(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} placeholder="AGENT_API_KEY" aria-label="Variable name" required />
      <input className="input mono" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="api.example.com" aria-label="Hosts it's sent to" required />
      <input className="input mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" aria-label="Value" autoComplete="off" />
      <button type="submit" className="btn btn-secondary" disabled={busy || !env || !hosts}>
        <Plus size={14} />
        Add key
      </button>
      {error ? <p className="hint" style={{ color: "var(--danger)", gridColumn: "1 / -1" }}>{error}</p> : null}
    </form>
  );
}

type ImageStatus = NonNullable<AgentsSettings["image"]>["status"] | undefined;

/** Where an agent is with its updates: installing one, one waiting, or what the last one did. */
function UpdateLine({ agent, busy, onUpdate }: { agent: AgentRow; busy: boolean; onUpdate: () => void }) {
  if (agent.source === "custom") return null;
  if (agent.updateState === "updating") {
    return (
      <div className="state update-line">
        <ArrowsClockwise size={13} weight="bold" />
        <span>
          Updating to <span className="mono">{agent.version}</span>. New turns use it once the sandbox image is rebuilt.
        </span>
      </div>
    );
  }
  if (agent.availableVersion) {
    return (
      <div className="state update-line" data-available>
        <ArrowCircleUp size={13} weight="bold" />
        <span>
          <span className="mono">{agent.availableVersion}</span> is available.
        </span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onUpdate}>
          Update
        </button>
      </div>
    );
  }
  if (agent.updateState === "failed" && agent.updateNote) {
    return (
      <div className="state update-line" data-locked>
        <WarningCircle size={13} weight="bold" />
        <span>{agent.updateNote}</span>
      </div>
    );
  }
  // A recent update, shown for a week.
  if (agent.updateState === "updated" && agent.updateNote && agent.updatedVersionAt && Date.now() - new Date(agent.updatedVersionAt).getTime() < 7 * 86_400_000) {
    return (
      <div className="state update-line" data-set>
        <ArrowCircleUp size={13} weight="bold" />
        <span>{agent.updateNote}</span>
      </div>
    );
  }
  return null;
}

/** Where an agent is on its way to its first turn. */
function installState(agent: AgentRow, image: ImageStatus): { ok: boolean; text: string } {
  if (agent.missing.length) return { ok: false, text: `Needs ${agent.missing.join(" and ")}` };
  if (agent.installed) return { ok: true, text: "Ready" };
  if (image === "building" || image === "pending") return { ok: false, text: "Installing into the sandbox image" };
  if (image === "failed") return { ok: false, text: "Not installed: the sandbox image didn't build" };
  return { ok: false, text: "Waiting for the worker to install it" };
}

function AgentItem({ agent, image, onChange }: { agent: AgentRow; image: ImageStatus; onChange: () => void }) {
  const [open, setOpen] = useState(agent.missing.length > 0);
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState(hostsText(agent.spec.hosts));
  const [hostsMsg, setHostsMsg] = useState<string | null>(null);

  async function act(init: RequestInit, path = "") {
    setBusy(true);
    await api(`/settings/agents/${agent.id}${path}`, init).catch(() => {});
    setBusy(false);
    onChange();
  }

  async function saveHosts(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/settings/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ hosts: parseHosts(hosts) }) });
      setHostsMsg("Saved.");
      onChange();
    } catch (err) {
      setHostsMsg(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  }

  const state = installState(agent, image);
  return (
    <div className="agent-item">
      <div className="agent-head">
        <span className="agent-mark">
          <AgentLogo harness={agent.id} icon={agent.icon} size={18} />
        </span>
        <div className="agent-meta">
          <div className="name">
            {agent.name}
            {!agent.enabled ? <span className="dim"> (off)</span> : null}
          </div>
          <div className="hint">
            {SOURCE[agent.source]}
            {agent.version ? <> · <span className="mono">{agent.version}</span></> : null} · <span className="mono">{agent.id}</span>
          </div>
          <div className="state" data-set={state.ok || undefined} data-locked={agent.missing.length > 0 || image === "failed" || undefined}>
            {state.ok ? <CheckCircle size={13} weight="bold" /> : agent.missing.length ? <WarningCircle size={13} weight="bold" /> : <Circle size={13} weight="bold" />}
            {state.text}
          </div>
          <UpdateLine agent={agent} busy={busy} onUpdate={() => act({ method: "POST" }, "/update")} />
        </div>
        <div className="mcp-actions">
          {agent.source !== "custom" ? (
            <button
              type="button"
              className="pill"
              aria-pressed={agent.autoUpdate}
              disabled={busy}
              onClick={() => act({ method: "PATCH", body: JSON.stringify({ autoUpdate: !agent.autoUpdate }) })}
              title={agent.autoUpdate ? "Newer versions install on their own. Click to update by hand instead." : "Install newer versions on their own"}
            >
              <ArrowsClockwise size={13} />
              <span className="pill-text">{agent.autoUpdate ? "Auto-update on" : "Auto-update off"}</span>
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            Keys
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ method: "PATCH", body: JSON.stringify({ enabled: !agent.enabled }) })}>
            {agent.enabled ? "Turn off" : "Turn on"}
          </button>
          <button type="button" className="icon-btn" disabled={busy} onClick={() => act({ method: "DELETE" })} aria-label={`Remove ${agent.name}`} title="Remove">
            <Trash size={16} />
          </button>
        </div>
      </div>
      {open ? (
        <div className="agent-body">
          {agent.credentials.length ? (
            agent.credentials.map((k) => <KeyField key={k.env} agent={agent} k={k} onSaved={onChange} />)
          ) : (
            <p className="hint">No keys yet. If it signs in with an API key from its environment, add that key and the hosts it&apos;s sent to.</p>
          )}
          {agent.source !== "catalog" ? <DefineKey agent={agent} onSaved={onChange} /> : null}
          <form className="agent-hosts" onSubmit={saveHosts}>
            <label className="label" htmlFor={`hosts-${agent.id}`}>
              Other hosts it needs
            </label>
            <div className="agent-hosts-row">
              <input id={`hosts-${agent.id}`} className="input mono" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="None" />
              <button type="submit" className="btn btn-secondary">
                Save
              </button>
            </div>
            <p className="hint">{hostsMsg ?? "Sign-in, model lists or update checks. Its keys' hosts are allowed already."}</p>
          </form>
        </div>
      ) : null}
    </div>
  );
}

type Pick =
  | { kind: "catalog"; item: CatalogItem }
  | { kind: "registry"; item: RegistryItem }
  | { kind: "custom" };

const STEPS = ["Agent", "Name", "Keys"] as const;

/** The add-agent dialog: pick an agent, name it, give it its keys. */
function AddAgentDialog({ settings, onClose, onAdded }: { settings: AgentsSettings; onClose: () => void; onAdded: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [pick, setPick] = useState<Pick | null>(null);
  const [registry, setRegistry] = useState<RegistryItem[] | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [installScript, setInstallScript] = useState("");
  const [hosts, setHosts] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [own, setOwn] = useState<{ env: string; hosts: string; value: string }[]>([{ env: "", hosts: "", value: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    api<{ agents: RegistryItem[] }>("/settings/agents/registry")
      .then((r) => setRegistry(r.agents))
      .catch((err) => setRegistryError(err instanceof ApiError ? err.message : "Couldn't load the ACP registry."));
  }, []);

  const added = useMemo(() => new Set(settings.agents.map((a) => a.sourceId)), [settings.agents]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (registry ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.id.includes(q));
  }, [registry, query]);

  function choose(p: Pick) {
    setPick(p);
    setError(null);
    setName(p.kind === "custom" ? "" : p.item.name);
    if (!(p.kind === "catalog" && p.item.unavailable)) setStep(1);
  }

  const catalogKeys = pick?.kind === "catalog" ? pick.item.credentials : pick?.kind === "registry" && pick.item.catalogId ? settings.catalog.find((c) => c.id === pick.item.catalogId)?.credentials ?? [] : [];
  const definesOwn = pick?.kind === "custom" || (pick?.kind === "registry" && !pick.item.catalogId);
  const canNext = step === 0 ? Boolean(pick) && !(pick?.kind === "catalog" && pick.item.unavailable) : step === 1 ? Boolean(name.trim()) && (pick?.kind !== "custom" || Boolean(command.trim())) : true;

  async function submit() {
    if (!pick) return;
    setBusy(true);
    setError(null);
    const keys = {
      values: {
        ...Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())),
        ...Object.fromEntries(own.filter((o) => o.env && o.value).map((o) => [o.env, o.value])),
      },
      define: definesOwn ? own.filter((o) => o.env && o.hosts).map((o) => ({ env: o.env, hosts: parseHosts(o.hosts) })) : [],
    };
    const body =
      pick.kind === "custom"
        ? { kind: "custom", name, command, args: args.split("\n").map((a) => a.trim()).filter(Boolean), installScript }
        : { kind: pick.kind, id: pick.item.id, name };
    try {
      const res = await api<{ message?: string }>("/settings/agents", { method: "POST", body: JSON.stringify({ ...body, hosts: parseHosts(hosts), keys }) });
      onAdded();
      if (res.message) {
        setError(`Added, but its keys weren't saved: ${res.message}`);
        return;
      }
      ref.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the agent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="agent-dialog" onClose={onClose} aria-labelledby="add-agent-h">
      <header className="agent-dialog-head">
        <div>
          <h2 id="add-agent-h">Add agent</h2>
          <p className="hint">Installed into the sandbox image; its keys reach the sandbox only as placeholders.</p>
        </div>
        <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      <ol className="stepper" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} data-done={i < step || undefined}>
            <span className="num">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      <div className="agent-dialog-body">
        {step === 0 ? (
          <>
            <span className="label">Agent</span>
            <div className="agent-tiles" role="list">
              {settings.builtin.map((b) => (
                <div key={b.id} role="listitem" className="agent-tile" data-builtin>
                  <AgentLogo harness={b.id} size={18} />
                  <span className="tile-name">{b.name}</span>
                  <span className="tile-badge">Built in</span>
                </div>
              ))}
              {settings.catalog.map((c) => {
                const on = pick?.kind === "catalog" && pick.item.id === c.id;
                const isAdded = added.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="listitem"
                    className="agent-tile"
                    aria-pressed={on}
                    disabled={isAdded}
                    data-unavailable={c.unavailable ? true : undefined}
                    onClick={() => choose({ kind: "catalog", item: c })}
                    title={c.blurb}
                  >
                    {c.icon ? <MaskIcon src={c.icon} size={18} /> : <Circle size={18} />}
                    <span className="tile-name">{c.name}</span>
                    {isAdded ? <span className="tile-badge">Added</span> : c.unavailable ? <span className="tile-badge">Unavailable</span> : null}
                  </button>
                );
              })}
            </div>
            {pick?.kind === "catalog" && pick.item.unavailable ? (
              <div className="notice" data-tone="warn" role="status">
                <Info size={16} weight="bold" />
                {pick.item.unavailable}
              </div>
            ) : null}

            <div className="agent-or">Or choose from the ACP registry</div>
            <div className="agent-search">
              <label className="input-icon">
                <MagnifyingGlass size={15} />
                <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents" aria-label="Search the ACP registry" />
              </label>
              <button type="button" className="btn btn-secondary" onClick={() => choose({ kind: "custom" })}>
                <Terminal size={15} />
                Enter a command
              </button>
            </div>
            <div className="registry-list" aria-busy={registry === null && !registryError}>
              {registryError ? <p className="hint" style={{ color: "var(--danger)" }}>{registryError}</p> : null}
              {registry === null && !registryError ? <div className="skeleton" style={{ width: "60%" }} /> : null}
              {shown.map((r) => {
                const isAdded = r.added;
                return (
                  <div key={r.id} className="registry-row">
                    {r.icon ? <MaskIcon src={r.icon} size={20} /> : <Circle size={20} />}
                    <div className="registry-meta">
                      <div className="name">
                        {r.name} <span className="mono dim">{r.version}</span>
                      </div>
                      <div className="hint registry-desc">{r.description}</div>
                    </div>
                    {r.website ? (
                      <a className="icon-btn" href={r.website} target="_blank" rel="noreferrer" aria-label={`${r.name} website`} title="Website">
                        <ArrowSquareOut size={15} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={isAdded || !r.installable}
                      title={!r.installable ? "No build for a Linux sandbox" : undefined}
                      onClick={() => choose({ kind: "registry", item: r })}
                    >
                      {isAdded ? "Added" : r.installable ? "Add" : "No Linux build"}
                    </button>
                  </div>
                );
              })}
              {registry && !shown.length ? <p className="hint">No agents match.</p> : null}
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <div className="agent-form">
            <div className="field">
              <label className="label" htmlFor="agent-name">
                Name
              </label>
              <input id="agent-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="My agent" required />
              <p className="hint">What sessions and the agent picker call it.</p>
            </div>
            {pick?.kind === "custom" ? (
              <>
                <div className="field">
                  <label className="label" htmlFor="agent-cmd">
                    ACP command
                  </label>
                  <input id="agent-cmd" className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="my-agent" required />
                  <p className="hint">Runs inside the sandbox and speaks the Agent Client Protocol on stdin and stdout.</p>
                </div>
                <div className="field">
                  <label className="label" htmlFor="agent-args">
                    Arguments, one per line
                  </label>
                  <textarea id="agent-args" className="textarea mono" rows={2} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="acp" />
                </div>
                <div className="field">
                  <label className="label" htmlFor="agent-install">
                    Install script
                  </label>
                  <textarea id="agent-install" className="textarea mono" rows={4} value={installScript} onChange={(e) => setInstallScript(e.target.value)} placeholder="npm install -g my-agent" />
                  <p className="hint">Runs as root while the sandbox image builds, like the setup script. Leave it empty if the command is installed already.</p>
                </div>
              </>
            ) : pick?.kind === "registry" ? (
              <p className="hint">
                {pick.item.name} {pick.item.version} from the ACP registry. {pick.item.description}
              </p>
            ) : pick?.kind === "catalog" ? (
              <>
                <p className="hint">{pick.item.blurb}</p>
                {pick.item.note ? (
                  <div className="notice" role="note">
                    <Info size={16} weight="bold" />
                    {pick.item.note}
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="field">
              <label className="label" htmlFor="agent-hosts">
                Other hosts it needs
              </label>
              <input id="agent-hosts" className="input mono" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="Optional, e.g. api.example.com" />
              <p className="hint">The sandbox reaches only allowed hosts. Its keys&apos; hosts are allowed already.</p>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="agent-form">
            {catalogKeys.map((k) => (
              <div className="field" key={k.env}>
                <label className="label" htmlFor={`key-${k.env}`}>
                  {k.label} <span className="mono dim">{k.env}</span>
                </label>
                <input
                  id={`key-${k.env}`}
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  value={values[k.env] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [k.env]: e.target.value }))}
                  placeholder={k.reuse ? `Leave empty to use ${k.reuse} from your keys` : k.optional ? "Optional" : "Paste key"}
                />
                <p className="hint">Sent only to {hostsText(k.hosts)}.</p>
              </div>
            ))}
            {definesOwn ? (
              <>
                <p className="hint">
                  If it signs in with an API key from its environment, name the variable and the hosts it&apos;s sent to. The sandbox gets a placeholder; the proxy fills in the real key only on requests to those hosts.
                </p>
                {own.map((o, i) => (
                  <div className="agent-define" key={i}>
                    <input
                      className="input mono"
                      value={o.env}
                      onChange={(e) => setOwn((list) => list.map((x, j) => (j === i ? { ...x, env: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") } : x)))}
                      placeholder="AGENT_API_KEY"
                      aria-label="Variable name"
                    />
                    <input className="input mono" value={o.hosts} onChange={(e) => setOwn((list) => list.map((x, j) => (j === i ? { ...x, hosts: e.target.value } : x)))} placeholder="api.example.com" aria-label="Hosts it's sent to" />
                    <input className="input mono" type="password" value={o.value} onChange={(e) => setOwn((list) => list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="Value" aria-label="Value" autoComplete="off" />
                    <button type="button" className="icon-btn" onClick={() => setOwn((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : [{ env: "", hosts: "", value: "" }]))} aria-label="Remove this key">
                      <Trash size={15} />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={() => setOwn((list) => [...list, { env: "", hosts: "", value: "" }])}>
                  <Plus size={14} />
                  Another key
                </button>
              </>
            ) : null}
            {!catalogKeys.length && !definesOwn ? <p className="hint">No keys needed.</p> : null}
          </div>
        ) : null}
      </div>

      <footer className="form-foot agent-dialog-foot">
        <span className="msg" role="status" data-tone={error ? "danger" : undefined}>
          {error ?? ""}
        </span>
        <button type="button" className="btn btn-ghost" onClick={() => (step === 0 ? ref.current?.close() : setStep(step - 1))}>
          {step === 0 ? "Cancel" : "Back"}
        </button>
        {step < 2 ? (
          <button type="button" className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "Adding" : "Add agent"}
          </button>
        )}
      </footer>
    </dialog>
  );
}

export function AgentsPanel() {
  const { refreshHarnesses } = useApp();
  const [settings, setSettings] = useState<AgentsSettings | null>(null);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const s = await api<AgentsSettings>("/settings/agents").catch(() => null);
    setSettings(s);
    refreshHarnesses().catch(() => {});
  }, [refreshHarnesses]);
  useEffect(() => {
    load();
  }, [load]);

  async function checkUpdates() {
    setChecking(true);
    setCheckMsg(null);
    try {
      const { results } = await api<{ results: { id: string; to: string; outcome: "installing" | "available" | "skipped" }[] }>("/settings/agents/updates/check", { method: "POST" });
      const name = (id: string) => settings?.agents.find((a) => a.id === id)?.name ?? id;
      const fresh = results.filter((r) => r.outcome !== "skipped");
      setCheckMsg(
        fresh.length === 0
          ? "Every agent is up to date."
          : fresh.map((r) => `${name(r.id)} ${r.to}${r.outcome === "installing" ? " is installing" : " is available"}`).join(". ") + ".",
      );
      await load();
    } catch (err) {
      setCheckMsg(err instanceof ApiError ? err.message : "Couldn't check for updates.");
    } finally {
      setChecking(false);
    }
  }

  // The image builds in the background after an agent is added; check back until it's done.
  const waiting = Boolean(settings?.agents.some((a) => !a.installed || a.updateState === "updating") && settings?.image?.status !== "failed");
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  return (
    <section className="set-sec" aria-labelledby="agents-h" id="agents">
      <header>
        <h2 id="agents-h">Agents</h2>
        <p>
          Claude Agent, Codex and Gemini CLI are built in. Add Cursor, Grok, OpenCode and more, from the ACP registry or a command of your own. Each is installed into the sandbox image, and its keys reach the sandbox only as placeholders.
        </p>
      </header>
      <div className="set-body">
        {settings?.image?.status === "failed" ? (
          <div className="notice" data-tone="danger" role="alert">
            <WarningCircle size={16} weight="bold" />
            The sandbox image didn&apos;t build. Its log is under Sandbox tools.
          </div>
        ) : null}
        <div className="panel">
          {HARNESSES.map((h) => (
            <div className="agent-item" key={h.id}>
              <div className="agent-head">
                <span className="agent-mark">
                  <AgentLogo harness={h.id} size={18} />
                </span>
                <div className="agent-meta">
                  <div className="name">{h.name}</div>
                  <div className="hint">Built in · {costLabel(h.cost)} · its key or plan sign-in is under Keys and connections</div>
                </div>
              </div>
            </div>
          ))}
          {settings === null ? (
            <div className="panel-row" aria-busy="true">
              <div className="skeleton" style={{ width: "50%" }} />
            </div>
          ) : (
            settings.agents.map((a) => <AgentItem key={a.id} agent={a} image={settings.image?.status} onChange={load} />)
          )}
          <div className="panel-row form-foot">
            <span className="msg" role="status">
              {checkMsg ?? "Pi and OpenCode report what their turns cost. Other added agents record no cost unless you set prices for them (see Configuration in the docs)."}
            </span>
            <button type="button" className="btn btn-secondary" disabled={!settings?.agents.some((a) => a.source !== "custom") || checking} onClick={checkUpdates} title="Agents also check for updates every six hours">
              <ArrowsClockwise size={15} />
              {checking ? "Checking" : "Check for updates"}
            </button>
            <button type="button" className="btn btn-primary" disabled={!settings} onClick={() => setAdding(true)}>
              <Plus size={15} />
              Add agent
            </button>
          </div>
        </div>
      </div>
      {adding && settings ? <AddAgentDialog settings={settings} onClose={() => setAdding(false)} onAdded={load} /> : null}
    </section>
  );
}
