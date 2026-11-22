"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { YardIcon } from "@/shared/components/TokYard";

const number = n => new Intl.NumberFormat("en-US").format(n || 0);
const compact = n => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
const date = value => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
async function api(url, method = "GET", body) {
  const response = await fetch(url, { method, cache: "no-store", headers: body ? { "Content-Type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function Field({ label, hint, children }) { return <label className="yard-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Budget({ budget, label = "Monthly", source }) {
  const used = Math.min(100, budget.limit ? budget.consumed / budget.limit * 100 : 0);
  const held = Math.min(100 - used, budget.limit ? budget.reserved / budget.limit * 100 : 0);
  return <div className="yard-budget"><div className="yard-budget-label"><strong><small>{label} · </small>{number(budget.consumed)} <small>used</small></strong><span>{budget.limit === null ? "No cap" : `${number(budget.limit)} tokens`}</span></div>{budget.limit !== null && <div className="yard-meter" role="meter" aria-label={`${label} tokens used and held`} aria-valuemin={0} aria-valuemax={budget.limit || 1} aria-valuenow={Math.min(budget.limit, budget.consumed + budget.reserved)} aria-valuetext={`${number(budget.consumed)} used, ${number(budget.reserved)} held, ${number(budget.remaining)} remaining`}><i style={{ width: `${used}%` }}/><i className="held" style={{ width: `${held}%` }}/></div>}<div className="yard-budget-footer"><span>{budget.limit === null ? "Usage tracked without a cap" : `${number(budget.remaining)} available`}</span>{budget.reserved > 0 && <span className="yard-held-text">{number(budget.reserved)} held</span>}</div><dl className="yard-token-breakdown" aria-label={`${label} token usage`}><div><dt>Input tokens</dt><dd>{number(budget.inputTokens)}</dd></div><div><dt>Output tokens</dt><dd>{number(budget.outputTokens)}</dd></div><div><dt>Total tokens</dt><dd>{number(budget.consumed)}</dd></div>{budget.unclassifiedTokens > 0 && <div className="unclassified"><dt>Unclassified tokens</dt><dd>{number(budget.unclassifiedTokens)}</dd></div>}</dl>{budget.unclassifiedTokens > 0 && <p className="yard-help">Unclassified tokens have a verified total but no recorded input/output split.</p>}<p className="yard-help">{source}</p></div>;
}
function SharedBudget({ budget, profileName, personalAvailable }) {
  if (!budget) return null;
  return <section className="yard-shared-budget" aria-label={`${profileName} shared budget`}><h3>Shared with {profileName}</h3><p className="yard-help">Everyone on this profile uses the same pool, within their personal limits. No unused share is reserved for a member.</p>{personalAvailable !== undefined && <p className="yard-help"><strong>{number(personalAvailable)} tokens available to you now.</strong> Every request must fit your personal limits and the pool.</p>}<Budget budget={budget} label="Shared monthly"/><Budget budget={budget.daily} label="Shared daily"/></section>;
}
function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog className="yard-dialog" ref={ref} aria-labelledby="yard-dialog-title" onCancel={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}><div className="yard-dialog-head"><h2 id="yard-dialog-title">{title}</h2><button aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</dialog>;
}
function QuotaMode({ profile }) {
  const [mode, setMode] = useState(profile?.usageOnly ? "usage" : profile?.quotaMode || "fixed");
  return <fieldset className="yard-quota-policy"><legend>Usage policy</legend><Field label="Quota mode"><select name="quotaMode" value={mode} onChange={e => setMode(e.target.value)}><option value="fixed">Fixed · separate allowance per person</option><option value="shared">Shared · one pool for this profile</option><option value="usage">Usage only · track without token budgets</option></select></Field>
    {mode === "usage" ? <p>Track each person’s daily and monthly usage without personal or shared token budgets. Existing usage and saved limits are preserved. No TokYard output cap is applied. Client settings and model/provider limits still apply. Model access and concurrent requests remain controlled below.</p> : <>
      {mode === "shared" ? <><p>Unused pool tokens are available to any member, up to their personal limit. Access is first come, first served; individual shares are not guaranteed.</p><Field label="Shared monthly token allowance" hint="Total for everyone on this profile. Empty means no shared monthly cap."><input name="sharedTokenLimit" type="number" min="0" max="1000000000000" step="1" defaultValue={profile?.sharedTokenLimit ?? ""}/></Field><Field label="Shared daily token allowance" hint="Total for everyone on this profile. Empty means no shared daily cap. Resets at 00:00 UTC."><input name="sharedDailyTokenLimit" type="number" min="0" max="1000000000000" step="1" defaultValue={profile?.sharedDailyTokenLimit ?? ""}/></Field><p>Set at least one shared limit. Set 0 to stop pool requests. Earlier usage and held tokens still count.</p></> : <p>Each person keeps a separate allowance. Unused tokens are not shared.</p>}
      <Field label="Monthly token allowance" hint="Maximum per person this month, including pool use. Used and held tokens remain. Personal overrides take priority."><input name="tokenLimit" type="number" required min="0" max="1000000000000" step="1" defaultValue={profile?.tokenLimit ?? 1000000}/></Field>
      <Field label="Daily token allowance" hint="Maximum per person today, including pool use. Leave empty for no personal daily cap. Resets at 00:00 UTC."><input name="dailyTokenLimit" type="number" min="0" max="1000000000000" step="1" defaultValue={profile?.dailyTokenLimit ?? ""}/></Field>
      <Field label="Output tokens / request" hint="TokYard cap; the model/provider may support less."><input name="maxOutputTokens" type="number" required min="1" max="1000000000000" step="1" defaultValue={profile?.maxOutputTokens ?? 4096}/></Field>
    </>}
  </fieldset>;
}
function AllowedModels({ initialModels = [] }) {
  const [selected, setSelected] = useState(initialModels), [all, setAll] = useState(!initialModels.length);
  const [groups, setGroups] = useState(null), [error, setError] = useState(""), [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const mode = useRef(null);
  useEffect(() => {
    let cancelled = false;
    setGroups(null); setError("");
    api("/api/workspace/models").then(data => { if (!cancelled) setGroups(data.groups); }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [retry]);
  useEffect(() => { mode.current.setCustomValidity(!all && !selected.length ? "Select at least one model or allow all direct text models." : ""); }, [all, selected]);
  const known = new Set((groups || []).flatMap(g => g.models));
  const saved = selected.filter(id => !known.has(id));
  const choices = [...(saved.length ? [{ name: groups ? "Previously selected · unavailable on active connections" : "Saved selections", alias: "saved", models: saved }] : []), ...(groups || [])];
  const search = query.trim().toLowerCase();
  const visible = choices.map(g => ({ ...g, models: g.models.filter(id => `${g.name} ${id}`.toLowerCase().includes(search)) })).filter(g => g.models.length);
  return <fieldset className="yard-model-picker">
    <legend>Allowed models</legend>
    <label className="yard-model-option"><input ref={mode} type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}/><span>Allow all direct text models</span></label>
    <small>Uncheck to choose models from your active connections.</small>
    {!all && <>
      <div className="yard-model-toolbar"><label className="yard-field"><span className="sr-only">Search available models</span><input type="search" placeholder="Search model or provider…" value={query} onChange={e => setQuery(e.target.value)}/></label><small role="status">{selected.length} / 200 selected</small></div>
      {error ? <div role="alert"><p>Could not load available models. Saved selections are preserved.</p><button type="button" className="yard-text-button" onClick={() => setRetry(n => n + 1)}>Retry loading models</button></div> : groups === null && <p role="status">Loading available models…</p>}
      <div className="yard-model-list" role="group" aria-label="Available models">
        {visible.map(group => <div className="yard-model-group" key={group.alias}><h3>{group.name}</h3>{group.models.map(id => <label className="yard-model-option" key={id}><input type="checkbox" checked={selected.includes(id)} disabled={!selected.includes(id) && selected.length >= 200} onChange={e => setSelected(ids => e.target.checked ? [...ids, id] : ids.filter(value => value !== id))}/><span><strong>{id.slice(id.indexOf("/") + 1)}</strong><code>{id}</code></span></label>)}</div>)}
        {groups !== null && !visible.length && <p>{search ? "No models match your search." : "No models available. Add or enable connections and configure their models in Connections."}</p>}
      </div>
      <small>Saved models stay selected if their connection becomes unavailable.</small>
    </>}
    {(all ? [] : selected).map(id => <input key={id} type="hidden" name="allowedModels" value={id}/>)}
  </fieldset>;
}
export default function Workspace() {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [selected, setSelected] = useState(null), [keys, setKeys] = useState([]);
  const [view, setView] = useState("people"), [query, setQuery] = useState("");
  const [modal, setModal] = useState(null), [busy, setBusy] = useState(false), [secret, setSecret] = useState(null);
  const [copied, setCopied] = useState(false), [origin, setOrigin] = useState("");
  const reload = useCallback(async () => {
    try { const next = await api("/api/workspace"); setData(next); setSelected(id => id || next.users?.[0]?.id || next.user?.id); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { reload(); const timer = setInterval(reload, 15000); return () => clearInterval(timer); }, [reload]);
  useEffect(() => { const update = () => setView(["profiles", "activity"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "people"); update(); setOrigin(location.origin); window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setKeys([]);
    api(`/api/workspace/keys?userId=${encodeURIComponent(selected)}`).then(d => { if (!cancelled) setKeys(d.keys); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selected]);
  const admin = data?.role === "admin";
  const user = admin ? data.users.find(u => u.id === selected) : data?.user;
  const budget = admin ? user?.budget : data?.budget;
  const mutate = async (url, method, body) => {
    setBusy(true); setError("");
    try {
      const result = await api(url, method, body);
      await reload();
      if (selected) setKeys((await api(`/api/workspace/keys?userId=${encodeURIComponent(selected)}`)).keys);
      setModal(null);
      return result;
    } catch (err) { setError(err.message); throw err; }
    finally { setBusy(false); }
  };
  const submit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(form);
    try {
      if (modal.type === "user") {
        const result = await mutate("/api/workspace/users", "POST", values); setSelected(result.user.id);
      } else if (modal.type === "edit") {
        const patch = { name: values.name, profileId: values.profileId, ...(values.tokenLimit !== undefined ? { tokenLimit: values.tokenLimit === "" ? null : Number(values.tokenLimit) } : {}), ...(values.dailyTokenLimit !== undefined ? { dailyTokenLimit: values.dailyTokenLimit === "" ? null : Number(values.dailyTokenLimit) } : {}) };
        if (values.password) patch.password = values.password;
        await mutate(`/api/workspace/users/${user.id}`, "PATCH", patch);
      } else if (modal.type === "profile") {
        const usageOnly = values.quotaMode === "usage";
        await mutate(`/api/workspace/profiles${modal.profile ? `/${modal.profile.id}` : ""}`, modal.profile ? "PATCH" : "POST", { ...values, usageOnly, ...(usageOnly ? { quotaMode: modal.profile?.quotaMode || "fixed" } : { tokenLimit: Number(values.tokenLimit), dailyTokenLimit: values.dailyTokenLimit === "" ? null : Number(values.dailyTokenLimit), sharedTokenLimit: values.sharedTokenLimit ? Number(values.sharedTokenLimit) : null, sharedDailyTokenLimit: values.sharedDailyTokenLimit ? Number(values.sharedDailyTokenLimit) : null }), maxConcurrent: Number(values.maxConcurrent), ...(usageOnly ? {} : { maxOutputTokens: Number(values.maxOutputTokens) }), allowedModels: form.getAll("allowedModels") });
      } else if (modal.type === "key") {
        const result = await mutate("/api/workspace/keys", "POST", { name: values.name, userId: user.id }); setSecret(result); setCopied(false);
      } else if (modal.type === "reconcile") {
        await mutate(`/api/workspace/requests/${modal.request.id}/reconcile`, "POST", { actualTokens: Number(values.actualTokens), reason: values.reason });
      } else if (modal.type === "password") {
        setBusy(true); setError("");
        if (values.newPassword !== values.confirmPassword) throw new Error("New passwords do not match");
        await api("/api/workspace/password", "POST", values);
        // Reload the document to discard cached member session state.
        location.assign(new URL("/login?passwordChanged=1", location.origin));
      }
    } catch (err) { if (modal.type === "password") setError(err.message); }
    finally { if (modal.type === "password") setBusy(false); }
  };
  if (!data) return <div className="yard-loading" role="status">{error || "Opening your workspace…"}{error && <button className="yard-button" onClick={reload}>Try again</button>}</div>;
  const total = admin ? data.users.reduce((s, u) => s + u.budget.consumed, 0) : budget.consumed;
  const held = admin ? data.users.reduce((s, u) => s + u.budget.reserved, 0) : budget.reserved;
  const filtered = admin ? data.users.filter(u => `${u.name} ${u.email} ${u.profileName}`.toLowerCase().includes(query.toLowerCase())) : [];
  const requests = data.requests.filter(r => view === "activity" || !admin || r.userId === selected);
  const profile = modal?.profile;
  return <div className="yard-workspace">
    <div className="yard-page-heading"><div><div className="yard-eyebrow">{admin ? "YOUR AI WORKSPACE" : "YOUR PERSONAL ACCESS"}</div><h1>{admin ? view === "profiles" ? "A policy for every team." : view === "activity" ? "Every token, accounted for." : "Shared access. Clear limits." : `Welcome, ${user.name.split(" ")[0]}.`}</h1><p>{admin ? "Connect your AI accounts. Give everyone room to work." : "Your token allowance and API keys, together in one place."}</p></div>{admin && <button className="yard-button primary" onClick={() => setModal({ type: view === "profiles" ? "profile" : "user" })}><YardIcon name="plus"/>{view === "profiles" ? "New profile" : "Add person"}</button>}</div>
    {error && <div className="yard-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    <div className="yard-stat-grid"><div><span>{admin ? "People in workspace" : "Monthly allowance"}</span><strong>{admin ? number(data.users.length) : budget.limit === null ? "No cap" : compact(budget.limit)}</strong><small>{admin ? `${data.users.filter(u => u.isActive).length} active members` : "Input + output tokens"}</small></div><div><span>Tokens used this month</span><strong>{compact(total)}</strong><small>Calendar month · UTC</small></div><div><span>Tokens held</span><strong>{compact(held)}</strong><small>{held ? "In flight or awaiting review" : "No outstanding reservations"}</small></div><div><span>{admin ? "Provider connections" : "Active API keys"}</span><strong>{admin ? number(data.connections.filter(c => c.isActive).length) : number(keys.filter(k => k.isActive).length)}</strong><small>{admin ? "Shared across your people" : user?.usageOnly ? "Usage tracked across all keys" : "One shared allowance"}</small></div></div>
    {admin && <div className="yard-tabs" role="navigation" aria-label="Workspace views">{[["people", "People & quotas"], ["profiles", "Profiles"], ["activity", "Activity"]].map(([id, label]) => <a key={id} className={view === id ? "active" : ""} href={id === "people" ? "#" : `#${id}`} aria-current={view === id ? "page" : undefined}>{label}{id === "people" && <span>{data.users.length}</span>}</a>)}<button className="yard-refresh" aria-label="Refresh workspace" onClick={reload}><YardIcon name="refresh"/></button></div>}
    {view === "profiles" && admin ? <div className="yard-profile-grid">{data.profiles.map(p => <article className="yard-panel yard-profile" key={p.id}><div className="yard-profile-symbol"><YardIcon name="profiles" size={24}/></div><h2>{p.name}</h2><p>{data.users.filter(u => u.profileId === p.id).length} people on this profile</p><strong>{p.usageOnly ? "Usage only" : <>{number(p.tokenLimit)} <small>tokens / person / month</small></>}</strong><dl><div><dt>Quota mode</dt><dd>{p.usageOnly ? "Usage only · no token budget" : p.quotaMode === "shared" ? "Shared profile pool" : "Fixed per person"}</dd></div><div><dt>Daily allowance / person</dt><dd>{p.usageOnly || p.dailyTokenLimit === null ? "No daily cap" : number(p.dailyTokenLimit)}</dd></div><div><dt>Concurrent requests</dt><dd>{p.maxConcurrent}</dd></div><div><dt>Output limit</dt><dd>{p.usageOnly ? "Model / client limit" : number(p.maxOutputTokens)}</dd></div><div><dt>Model access</dt><dd>{p.allowedModels.length ? `${p.allowedModels.length} allowed models` : "All direct text models"}</dd></div></dl><SharedBudget budget={p.budget} profileName={p.name}/><button className="yard-button" onClick={() => setModal({ type: "profile", profile: p })}>Edit profile<YardIcon name="arrow"/></button></article>)}</div> : view === "activity" && admin ? <section className="yard-panel"><div className="yard-panel-heading"><div><h2>Request ledger</h2><p>Latest 100 requests. Held tokens need reliable usage or owner reconciliation.</p></div></div><RequestList requests={requests} reconcile={r => setModal({ type: "reconcile", request: r })}/></section> : <div className={`yard-people-grid ${admin ? "" : "member"}`}>
      {admin && <section className="yard-panel yard-people"><div className="yard-panel-heading"><h2>People & quotas</h2><span className="yard-tag">{data.users.length} people</span></div><div className="yard-search"><YardIcon name="people"/><input aria-label="Search people" placeholder="Search name, email or profile…" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="yard-people-label"><span>PERSON</span><span>MONTHLY USAGE</span></div>{filtered.length ? filtered.map(u => <button key={u.id} className={`yard-person ${u.id === selected ? "selected" : ""}`} onClick={() => setSelected(u.id)} aria-pressed={u.id === selected}><span className="yard-person-identity"><span className="yard-avatar">{u.name.slice(0, 1).toUpperCase()}</span><span><strong>{u.name}<i className={`yard-status-dot ${u.isActive ? "" : "paused"}`}/></strong><small>{u.email}</small><span className="yard-profile-pill">{u.profileName}{!u.isActive && " · Paused"}</span></span></span><span className="yard-person-usage"><strong>{compact(u.budget.consumed)} <small>/ {u.budget.limit === null ? "No cap" : compact(u.budget.limit)}</small></strong>{u.budget.limit !== null && <span className="yard-meter"><i style={{ width: `${Math.min(100, u.budget.limit ? (u.budget.consumed + u.budget.reserved) / u.budget.limit * 100 : 0)}%` }}/></span>}<small>In {compact(u.budget.inputTokens)} · Out {compact(u.budget.outputTokens)}</small>{(u.usageOnly || u.budget.daily.limit !== null) && <small>{compact(u.budget.daily.consumed)}{u.budget.daily.limit !== null && ` / ${compact(u.budget.daily.limit)}`} today</small>}</span><YardIcon name="chevron" size={15}/></button>) : <div className="yard-empty"><YardIcon name="people" size={32}/><h3>{query ? "No matching people" : "Make room for your people."}</h3><p>{query ? "Try another name or email." : "Add a person, assign a profile, and share your AI connections."}</p>{!query && <button className="yard-button primary" onClick={() => setModal({ type: "user" })}>Add first person</button>}</div>}<div className="yard-panel-foot"><span className="yard-dot"/>Daily and monthly limits reset at 00:00 UTC.</div></section>}
      <div className="yard-inspector">{user ? <><section className="yard-panel yard-inspector-top"><div className="yard-panel-heading"><h2>{admin ? "Access overview" : user.usageOnly ? "Your usage" : "Your allowance"}</h2><span className={`yard-badge ${user.isActive ? "" : "warning"}`}>{user.isActive ? "Active" : "Paused"}</span></div><div className="yard-inspector-person"><span className="yard-avatar large">{user.name.slice(0, 1).toUpperCase()}</span><h2>{user.name}</h2><p>{user.email}</p><span className="yard-profile-pill">{user.profileName}</span></div><Budget budget={budget} source={user.usageOnly ? "Usage only · no monthly token cap" : user.tokenLimitOverride === null ? "Monthly limit inherited from profile" : "Monthly personal override; profile changes do not apply"}/><Budget budget={budget.daily} label="Daily" source={user.usageOnly ? "Usage only · no daily token cap" : user.dailyTokenLimitOverride === null ? "Daily limit inherited from profile" : "Daily personal override; profile changes do not apply"}/><SharedBudget budget={budget.shared} profileName={user.profileName} personalAvailable={budget.available}/><dl className="yard-access-details"><div><dt>Monthly resets</dt><dd>{new Date(budget.resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · UTC</dd></div><div><dt>Daily resets</dt><dd>00:00 UTC</dd></div><div><dt>Output per request</dt><dd>{user.maxOutputTokens === null ? "Model / client limit" : number(user.maxOutputTokens)}</dd></div><div><dt>Concurrent requests</dt><dd>{user.maxConcurrent}</dd></div></dl>{!admin && <div className="yard-inspector-actions"><button className="yard-button" onClick={() => { setError(""); setModal({ type: "password" }); }}>Change password</button></div>}{admin && <div className="yard-inspector-actions"><button className="yard-button" onClick={() => setModal({ type: "edit" })}>Edit access</button><button className="yard-button quiet" disabled={busy} onClick={() => mutate(`/api/workspace/users/${user.id}`, "PATCH", { isActive: !user.isActive }).catch(() => {})}>{user.isActive ? "Pause access" : "Resume access"}</button></div>}</section>
      <section className="yard-panel yard-key-panel"><div className="yard-panel-heading"><h2>API keys</h2><button className="yard-icon-button" aria-label="Create API key" onClick={() => setModal({ type: "key" })}><YardIcon name="plus"/></button></div><p className="yard-help">All keys contribute to this person’s usage. Token budgets apply only when enabled by their profile.</p>{keys.length ? keys.map(k => <div className="yard-key-row" key={k.id}><YardIcon name="key"/><div><strong>{k.name}{!k.isActive && <small> · Revoked</small>}</strong><code>{k.prefix}</code></div>{k.isActive && <button className="yard-text-button" disabled={busy} onClick={() => { if (confirm(`Revoke key “${k.name}”? Existing clients using it will lose access.`)) mutate(`/api/workspace/keys/${k.id}`, "DELETE").catch(() => {}); }}>Revoke</button>}</div>) : <p className="yard-help">No keys yet. Create one to connect your client.</p>}<div className="yard-endpoint"><small>OPENAI-COMPATIBLE BASE URL</small><code>{origin}/v1</code></div></section></> : <section className="yard-panel yard-empty"><YardIcon name="profiles" size={30}/><h3>One person. One allowance.</h3><p>Select a person to manage their profile, daily and monthly limits, and API keys.</p></section>}</div>
    </div>}
    {view === "people" && user && <section className="yard-panel yard-recent"><div className="yard-panel-heading"><div><h2>{admin ? `${user.name.split(" ")[0]}’s recent activity` : "Your recent activity"}</h2><p>Provider-reported usage settles automatically. Unknown usage remains held.</p></div></div><RequestList requests={requests} reconcile={admin ? r => setModal({ type: "reconcile", request: r }) : null}/></section>}
    <footer className="yard-footer"><span>TokYard · Built for shared AI access.</span><Link href="/dashboard/support">Keep the yard growing <YardIcon name="support" size={13}/></Link></footer>
    {modal && <Dialog title={{ user: "Add a person", edit: "Edit access", profile: profile ? "Edit profile" : "New profile", key: "Create API key", reconcile: "Reconcile held request", password: "Change password" }[modal.type]} onClose={() => setModal(null)}><form onSubmit={submit} className="yard-form">
      {(modal.type === "user" || modal.type === "edit") && <><Field label="Full name"><input name="name" required maxLength={120} defaultValue={modal.type === "edit" ? user.name : ""} autoComplete="off" autoFocus/></Field>{modal.type === "user" && <Field label="Email"><input name="email" type="email" required maxLength={254} autoComplete="off"/></Field>}<Field label={modal.type === "edit" ? "New password (optional)" : "Temporary password"} hint="At least 12 characters, at most 72 UTF-8 bytes. Share securely."><input name="password" type="password" required={modal.type === "user"} minLength={12} autoComplete="new-password"/></Field><Field label="Access profile"><select name="profileId" defaultValue={modal.type === "edit" ? user.profileId : "standard"}>{data.profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.usageOnly ? "Usage only" : `${compact(p.tokenLimit)} / month`}</option>)}</select></Field>{modal.type === "edit" && !user.usageOnly && <Field label="Personal monthly allowance" hint="Leave empty to inherit the profile. Set 0 to stop new requests."><input name="tokenLimit" type="number" min="0" max="1000000000000" step="1" defaultValue={user.tokenLimitOverride ?? ""}/></Field>}{modal.type === "edit" && !user.usageOnly && <Field label="Personal daily allowance" hint="Leave empty to inherit the profile. Set 0 to stop new requests. Resets at 00:00 UTC."><input name="dailyTokenLimit" type="number" min="0" max="1000000000000" step="1" defaultValue={user.dailyTokenLimitOverride ?? ""}/></Field>}</>}
      {modal.type === "profile" && <><Field label="Profile name"><input name="name" required maxLength={60} defaultValue={profile?.name || ""} autoFocus/></Field><QuotaMode key={profile?.id || "new"} profile={profile}/><Field label="Concurrent requests"><input name="maxConcurrent" type="number" required min="1" max="20" step="1" defaultValue={profile?.maxConcurrent ?? 2}/></Field><AllowedModels key={profile?.id || "new"} initialModels={profile?.allowedModels}/></>}
      {modal.type === "key" && <><p>New key for <strong>{user.name}</strong>. Secret appears once. Store it securely.</p><Field label="Key name"><input name="name" placeholder="e.g. Work laptop" required maxLength={80} autoFocus/></Field></>}
      {modal.type === "password" && <><p>Changing your password signs you out on all devices. Your API keys keep working.</p><Field label="Current password"><input name="currentPassword" type="password" required autoComplete="current-password" autoFocus/></Field><Field label="New password" hint="At least 12 characters, at most 72 UTF-8 bytes."><input name="newPassword" type="password" required minLength={12} maxLength={72} autoComplete="new-password"/></Field><Field label="Confirm new password"><input name="confirmPassword" type="password" required minLength={12} maxLength={72} autoComplete="new-password"/></Field></>}
      {modal.type === "reconcile" && <><p>{modal.request.model} · {number(modal.request.reservedTokens)} tokens held.</p><Field label="Verified total tokens" hint="Input + output, including cache tokens. Use provider logs to verify."><input name="actualTokens" type="number" required min="0" max="1000000000000" step="1" autoFocus/></Field><Field label="Reason for reconciliation"><textarea name="reason" required minLength={3} maxLength={2000} rows={3}/></Field></>}
      {error && <p className="yard-error" role="alert">{error}</p>}<div className="yard-form-actions"><button type="button" className="yard-button" onClick={() => setModal(null)}>Cancel</button><button className="yard-button primary" disabled={busy}>{busy ? "Saving…" : modal.type === "user" ? "Add person" : modal.type === "key" ? "Create key" : modal.type === "password" ? "Change password" : "Save changes"}</button></div>
    </form></Dialog>}
    {secret && <Dialog title="Your new API key" onClose={() => setSecret(null)}><div className="yard-form"><p>Copy now. This secret will not be shown again.</p><Field label={secret.name}><textarea readOnly rows={3} value={secret.key} onFocus={e => e.target.select()}/></Field><button className="yard-button primary" onClick={async () => { try { await navigator.clipboard.writeText(secret.key); setCopied(true); } catch { setError("Clipboard unavailable. Select and copy the key above."); } }}>{copied ? "Copied" : "Copy key"}</button><button className="yard-button" onClick={() => setSecret(null)}>Done</button></div></Dialog>}
  </div>;
}
function RequestList({ requests, reconcile }) {
  if (!requests.length) return <div className="yard-activity-empty"><YardIcon name="activity"/><p>No requests yet. Usage will appear here after the first API call.</p></div>;
  return <div className="yard-table-scroll"><table className="yard-request-table"><thead><tr><th>Model / person</th><th>Time</th><th>Tokens</th><th>Status</th>{reconcile && <th><span className="sr-only">Actions</span></th>}</tr></thead><tbody>{requests.map(r => <tr key={r.id}><td><strong title={r.model}>{r.model}</strong>{r.userName && <small>{r.userName}</small>}<small title={r.id}>{r.id.slice(0, 8)}</small></td><td>{date(r.createdAt)}</td><td>{number(r.actualTokens ?? r.reservedTokens)}</td><td><span className={`yard-badge ${r.status === "uncertain" ? "warning" : ""}`} title={r.note || ""}>{r.status === "uncertain" ? "Held for review" : r.status === "reserved" ? "In flight" : "Settled"}</span></td>{reconcile && <td>{r.status === "uncertain" && <button className="yard-text-button" onClick={() => reconcile(r)}>Review</button>}</td>}</tr>)}</tbody></table></div>;
}
