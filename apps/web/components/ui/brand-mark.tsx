import { BookOpenText, Smile } from "lucide-react";
import { clsx } from "clsx";

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={clsx("dm-brand-mark", compact && "compact", className)} aria-label="DocuMind">
      <span className="dm-brand-glyph" aria-hidden="true">
        <BookOpenText size={compact ? 13 : 16} strokeWidth={2.2} />
      </span>
      {!compact ? <span className="dm-brand-wordmark">DocuMind</span> : null}
    </span>
  );
}

export function AgentOrb({ size = "medium", className }: { size?: "small" | "medium" | "large"; className?: string }) {
  return (
    <span className={clsx("dm-agent-orb", `dm-agent-orb-${size}`, className)} aria-label="油条">
      <Smile aria-hidden className="dm-agent-orb-face" />
    </span>
  );
}
