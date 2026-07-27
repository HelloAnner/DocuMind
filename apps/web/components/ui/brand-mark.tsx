import { clsx } from "clsx";

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={clsx("dm-brand-mark", compact && "compact", className)} aria-label="DocuMind">
      <span className="dm-brand-glyph" aria-hidden="true">
        <span />
      </span>
      {!compact ? <span className="dm-brand-wordmark">DocuMind</span> : null}
    </span>
  );
}

export function AgentOrb({ size = "medium", className }: { size?: "small" | "medium" | "large"; className?: string }) {
  return (
    <span className={clsx("dm-agent-orb", `dm-agent-orb-${size}`, className)} aria-hidden="true">
      <span className="dm-agent-orb-core" />
      <span className="dm-agent-orb-glint dm-agent-orb-glint-one" />
      <span className="dm-agent-orb-glint dm-agent-orb-glint-two" />
    </span>
  );
}
