"use client";
import { useEffect, useState } from "react";
import { TokYardMark, YardIcon } from "@/shared/components/TokYard";
import ThemeToggle from "@/shared/components/ThemeToggle";
function Brand() { return <a href="/" className="yard-brand"><TokYardMark size={36}/><span>TokYard<span className="yard-brand-note">AI access, in balance.</span></span></a>; }
export default function Login() {
  const [mode, setMode] = useState("owner"), [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { fetch("/api/auth/status", { cache: "no-store" }).then(r => r.json()).then(data => { setStatus(data); if (data.authenticated) location.replace("/dashboard"); }).catch(() => setError("Could not connect to the server.")); }, []);
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sign in failed");
      location.assign("/dashboard");
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <main className="yard-login"><section className="yard-login-story"><Brand/><div className="yard-login-art"><div className="yard-eyebrow">ONE WORKSPACE. MORE POSSIBILITY.</div><h1>Give your people<br/><span>room to build.</span></h1><p>Your AI accounts, together. Personal profiles, fair token allowances, and a clear view of every request.</p><div className="yard-meter"><i style={{ width:"65%" }}/></div><p>Shared access.<br/>Individual limits.<br/>Open by design.</p></div><small>TokYard by Operalith · Open source under MIT</small></section><section className="yard-login-form-wrap"><Brand/><div className="yard-eyebrow">WELCOME TO YOUR WORKSPACE</div><h2>Come on in.</h2><p>Sign in to manage your AI access.</p><div className="yard-login-tabs" role="group" aria-label="Sign in type"><button type="button" aria-pressed={mode === "owner"} className={mode === "owner" ? "active" : ""} onClick={() => { setMode("owner"); setError(""); }}>Workspace owner</button><button type="button" aria-pressed={mode === "member"} className={mode === "member" ? "active" : ""} onClick={() => { setMode("member"); setError(""); }}>Member</button></div><form className="yard-form" onSubmit={submit} key={mode}>{mode === "member" && <label className="yard-field"><span>Email address</span><input name="email" type="email" required autoComplete="username" placeholder="you@example.com" autoFocus/></label>}<label className="yard-field"><span>Password</span><input name="password" type="password" required autoComplete="current-password" autoFocus={mode === "owner"}/></label>{error && <div className="yard-error" role="alert">{error}</div>}<button className="yard-button primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<YardIcon name="arrow"/></button>{mode === "owner" && status?.oidcConfigured && <a className="yard-button" href="/api/auth/oidc/start">{status.oidcLoginLabel}</a>}{mode === "owner" && status?.samlConfigured && <a className="yard-button" href="/api/auth/saml/start">{status.samlLoginLabel}</a>}<p className="yard-help">{mode === "member" ? "Need access or a password reset? Contact your workspace owner." : "First launch? Set INITIAL_PASSWORD on the server to at least 12 characters."}</p></form><div className="yard-login-foot"><a href="https://github.com/Operalith/tokyard" target="_blank" rel="noreferrer">Operalith / tokyard ↗</a><ThemeToggle/></div></section></main>;
}
