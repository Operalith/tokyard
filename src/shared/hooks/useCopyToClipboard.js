"use client";

import { useState, useCallback, useRef } from "react";

/**
 * Hook for copy to clipboard with feedback
 * @param {number} resetDelay - Time in ms before resetting copied state (default: 2000)
 * @returns {{ copied: string|null, copy: (text: string, id?: string) => Promise<boolean> }}
 */
export function useCopyToClipboard(resetDelay = 2000) {
  const [copied, setCopied] = useState(null);
  const timeoutRef = useRef(null);

  const copy = useCallback(async (text, id = "default") => {
    setCopied(null);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    try {
      let written = false;
      if (navigator?.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); written = true; } catch {}
      }
      if (!written) {
        const focused = document.activeElement;
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.readOnly = true;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        // Native dialogs make the rest of the document inert, including selection.
        (focused?.closest("dialog") || document.body).appendChild(textarea);
        try {
          textarea.select();
          textarea.setSelectionRange(0, text.length);
          written = document.execCommand("copy");
        } finally { textarea.remove(); focused?.focus({ preventScroll: true }); }
      }
      if (!written) return false;
      setCopied(id);
      timeoutRef.current = setTimeout(() => setCopied(null), resetDelay);
      return true;
    } catch { return false; }
  }, [resetDelay]);

  return { copied, copy };
}

