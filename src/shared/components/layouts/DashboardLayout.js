"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "../ThemeToggle";
import { TokYardMark, YardIcon } from "../TokYard";
import { useNotificationStore } from "@/store/notificationStore";

export default function DashboardLayout({ children }) {
  const pathname = usePathname();
  const [auth, setAuth] = useState(null);
  const [open, setOpen] = useState(false);
  const [hash, setHash] = useState("");
  const notifications = useNotificationStore(s => s.notifications);
  const remove = useNotificationStore(s => s.removeNotification);
  useEffect(() => {
    fetch("/api/auth/status", { cache: "no-store" }).then(r => r.json()).then(setAuth).catch(() => {});
    const update = () => { setHash(location.hash); setOpen(false); };
    update(); window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = e => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  const admin = auth?.role === "admin";
  const nav = [
    { href: "/dashboard", label: admin ? "People & quotas" : "My workspace", icon: "people" },
    ...(admin ? [
      { href: "/dashboard#profiles", label: "Profiles", icon: "profiles" },
      { href: "/dashboard#activity", label: "Activity", icon: "activity" },
      { href: "/dashboard/providers", label: "Connections", icon: "connections" },
      { href: "/dashboard/endpoint", label: "Gateway", icon: "key" },
      { href: "/dashboard/profile", label: "Settings", icon: "settings" },
    ] : []),
  ];
  const active = href => href.includes("#") ? pathname === "/dashboard" && hash === href.slice(href.indexOf("#")) : pathname === href && (href !== "/dashboard" || !hash);
  const current = nav.find(n => active(n.href))?.label || (pathname.includes("support") ? "Support TokYard" : "Gateway workspace");
  return <div className="yard-shell">
    <a className="yard-skip" href="#yard-main">Skip to content</a>
    {open && <button className="yard-backdrop" aria-label="Close navigation" onClick={() => setOpen(false)}/>}
    <aside className={`yard-sidebar ${open ? "is-open" : ""}`} aria-label="Workspace navigation">
      <Link href="/dashboard" className="yard-brand"><TokYardMark/><span>TokYard<span className="yard-brand-note">AI access, in balance.</span></span></Link>
      <div className="yard-workspace-tag"><span className="yard-dot"/><span>Personal workspace</span><span className="yard-tag">α</span></div>
      <div className="yard-nav-label">WORKSPACE</div>
      <nav>{nav.map(item => <Link key={item.href} href={item.href} className={`yard-nav-link ${active(item.href) ? "active" : ""}`} onClick={() => setOpen(false)} aria-current={active(item.href) ? "page" : undefined}><YardIcon name={item.icon}/>{item.label}</Link>)}</nav>
      <div className="yard-sidebar-bottom">
        <div className="yard-open-source"><span className="yard-dot"/>Open source. Shared possibility.</div>
        <Link href="/dashboard/support" className={`yard-nav-link ${pathname.includes("support") ? "active" : ""}`}><YardIcon name="support"/>Support TokYard</Link>
        <a href="https://github.com/Operalith/tokyard" target="_blank" rel="noreferrer" className="yard-repo-link">Operalith / tokyard <span>↗</span></a>
        <div className="yard-account"><span className="yard-avatar">{admin ? "O" : (auth?.displayName || "M").slice(0, 1).toUpperCase()}</span><div><strong>{admin ? "Workspace owner" : auth?.displayName || "Member"}</strong><small>{admin ? "Administrator" : "Member"}</small></div><button title="Sign out" aria-label="Sign out" onClick={async () => { const res = await fetch("/api/auth/logout", { method: "POST" }); if (res.ok) location.assign("/login"); }}>↪</button></div>
      </div>
    </aside>
    <div className="yard-main-column">
      <header className="yard-topbar"><button className="yard-mobile-menu" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen(v => !v)}><YardIcon name="menu"/></button><div className="yard-breadcrumb">Workspace <span>/</span><strong>{current}</strong></div><div className="yard-topbar-actions"><span className="yard-alpha">ALPHA 0.1</span><ThemeToggle/></div></header>
      <main id="yard-main" className="yard-main" tabIndex={-1}>{children}</main>
    </div>
    <div className="yard-toasts" aria-live="polite">{notifications.map(n => <div key={n.id} className="yard-notice"><div>{n.title && <strong>{n.title}</strong>}<p>{n.message}</p></div><button aria-label="Dismiss notification" onClick={() => remove(n.id)}>×</button></div>)}</div>
  </div>;
}
