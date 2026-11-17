"use client";

import { useState } from "react";
import { YardIcon } from "@/shared/components/TokYard";

const BITCOIN_ADDRESS = "bc1qtx7e0nkcx9y0m4a07u90n06m3fguasaxmmu5kl";

export default function SupportPage() {
  const [copyStatus, setCopyStatus] = useState("");
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(BITCOIN_ADDRESS);
      setCopyStatus("Bitcoin address copied.");
    } catch {
      setCopyStatus("Could not copy. Select the address above and copy it manually.");
    }
  };

  return <div className="yard-support">
    <div className="yard-eyebrow">COMMUNITY SUPPORTED</div>
    <div className="yard-page-heading"><div><h1>Keep the yard growing.</h1><p>Open tools get better when people build together.</p></div></div>
    <section className="yard-panel" aria-labelledby="bitcoin-donation-title">
      <div className="yard-donation-heading"><span className="yard-bitcoin-mark" aria-hidden="true">₿</span><div><h2 id="bitcoin-donation-title">Support TokYard with Bitcoin</h2><span className="yard-tag">BTC · Bitcoin mainnet</span></div></div>
      <p>TokYard is free and open source. Your support helps sustain development, fix bugs and improve shared AI access.</p>
      <div className="yard-donation-grid">
        <div className="yard-donation-qr"><img src="/images/donate-bitcoin.png" width="192" height="192" alt="QR code for the TokYard Bitcoin receiving address shown beside it"/></div>
        <div className="yard-donation-details">
          <span className="yard-eyebrow">BITCOIN RECEIVING ADDRESS</span>
          <code className="yard-donation-address" dir="ltr">{BITCOIN_ADDRESS}</code>
          <div className="yard-support-links"><button type="button" className="yard-button" onClick={copyAddress}>Copy address</button><a className="yard-button primary" href={`bitcoin:${BITCOIN_ADDRESS}`}>Open Bitcoin wallet<YardIcon name="arrow"/></a></div>
          <p className="yard-copy-status" role="status">{copyStatus}</p>
        </div>
      </div>
      <p className="yard-donation-note">Send only BTC on the Bitcoin network. Donations support development and do not add AI credits.</p>
    </section>
    <section className="yard-panel"><h2>There’s more than one way to help.</h2><p>Report a bug, improve the docs, share a feature idea or contribute code. Every useful contribution makes a difference.</p><div className="yard-support-links"><a className="yard-button" href="https://github.com/Operalith/tokyard" target="_blank" rel="noreferrer">Star on GitHub ↗</a><a className="yard-button" href="https://github.com/Operalith/tokyard/issues" target="_blank" rel="noreferrer">Report an issue ↗</a></div></section>
    <p style={{ marginTop: 24 }}>Built by Operalith, based on 9router. MIT licensed.</p>
  </div>;
}
