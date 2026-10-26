import { clsx } from "clsx";

export const BRAND_ICON_URL = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/favicon.svg?v=2`;

export function BrandIcon({ size = 32, className, decorative = false }: { size?: number; className?: string; decorative?: boolean }) {
  return <img src={BRAND_ICON_URL} alt={decorative ? "" : "DocuMind"} width={size} height={size} className={className} style={{ display: "block", flexShrink: 0, objectFit: "contain" }} />;
}

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={clsx("dm-brand-mark", compact && "compact", className)} aria-label="DocuMind">
      <BrandIcon size={compact ? 25 : 32} decorative />
      {!compact ? <span className="dm-brand-wordmark">DocuMind</span> : null}
    </span>
  );
}

export function AgentOrb({ size = "medium", className }: { size?: "small" | "medium" | "large"; className?: string }) {
  return <BrandIcon className={clsx("dm-agent-orb", `dm-agent-orb-${size}`, className)} />;
}
