import { clsx } from "clsx";

export const BRAND_ICON_URL = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/favicon.svg?v=2`;

// Grok 风格 blob，与 public/favicon.svg 同形同色；内联渲染以便 hero/busy 时 CSS 驱动眼睛与摆动动画。
const EYES =
  '<g transform="rotate(-24 30 24)"><g class="eyes"><rect x="21" y="15" width="6.5" height="12" rx="3.25" fill="#fff"/><rect x="32" y="12" width="5.5" height="9" rx="2.75" fill="#fff" opacity=".88"/></g></g>';

const BLOB_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" data-brand="documind">' +
  '<defs><linearGradient id="bg-dm" x1="10" y1="6" x2="54" y2="58" gradientUnits="userSpaceOnUse"><stop stop-color="#2FD39A"/><stop offset="1" stop-color="#0A9468"/></linearGradient></defs>' +
  '<path fill="url(#bg-dm)" d="M37 4c3 1 4 5 6 8 6 5 13 13 13 24 0 14-11 23-24 23C19 59 8 50 8 37 8 24 26 0 37 4Z"/>' +
  EYES +
  "</svg>";

export function BrandIcon({ size = 32, className, decorative = false, hero = false, busy = false }: { size?: number; className?: string; decorative?: boolean; hero?: boolean; busy?: boolean }) {
  return (
    <span
      className={clsx("dm-brand-icon", hero && "brand-hero", busy && "busy", className)}
      style={{ display: "block", flexShrink: 0, width: size, height: size }}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "DocuMind"}
      dangerouslySetInnerHTML={{ __html: BLOB_SVG }}
    />
  );
}

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={clsx("dm-brand-mark", compact && "compact", className)} aria-label="DocuMind">
      <BrandIcon size={compact ? 25 : 32} decorative />
      {!compact ? <span className="dm-brand-wordmark">DocuMind</span> : null}
    </span>
  );
}

export function AgentOrb({ size = "medium", className, hero = false, busy = false }: { size?: "small" | "medium" | "large"; className?: string; hero?: boolean; busy?: boolean }) {
  return <BrandIcon className={clsx("dm-agent-orb", `dm-agent-orb-${size}`, className)} hero={hero} busy={busy} decorative />;
}
