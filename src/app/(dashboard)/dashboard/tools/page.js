import Link from "next/link";
import { YardIcon } from "@/shared/components/TokYard";

export const dynamic = "force-dynamic";

export default function ToolsPage() {
  const tools = [
    ["token-saver", "Token Saver", "Compress tool output and context, and tune response prompts.", "savings"],
    ["usage", "Usage", "Inspect provider traffic, token usage and costs.", "activity"],
    ["quota", "Provider quotas", "Check remaining limits on your connected AI accounts.", "profiles"],
    ["combos", "Combos & vision", "Configure fallback routes, model groups and vision adapters.", "connections"],
    ["cli-tools", "CLI tools", "Connect coding clients to your gateway.", "tools"],
    ["proxy-pools", "Proxy pools", "Manage outbound proxy connections.", "connections"],
    ["console-log", "Console log", "Inspect gateway events and troubleshoot requests.", "activity"],
    ...(["embedding", "image", "video", "tts", "stt", "systemone", "web"].map((kind, i) => [
      `media-providers/${kind}`,
      ["Embeddings", "Images", "Video", "Text to speech", "Speech to text", "System One", "Web fetch & search"][i],
      "Configure providers and routes for this capability.", "tools",
    ])),
    ...(process.env.ENABLE_TRANSLATOR === "true" ? [["translator", "Translator", "Inspect request and response format conversions.", "tools"]] : []),
  ];
  return <div>
    <div className="yard-page-heading"><div><div className="yard-eyebrow">GATEWAY TOOLS</div><h1>More ways to work.</h1><p>Provider tools and advanced routing, together in one place. Media and combo routes require owner API keys.</p></div></div>
    <div className="yard-profile-grid">{tools.map(([route, title, description, icon]) => <section className="yard-panel yard-profile" key={route}>
      <div className="yard-profile-symbol"><YardIcon name={icon} size={24}/></div><h2>{title}</h2><p>{description}</p>
      <Link className="yard-button" href={`/dashboard/${route}`}>Open {title}<YardIcon name="arrow"/></Link>
    </section>)}</div>
  </div>;
}
