"use client";

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="dm-stat-card">
      <span className="dm-stat-label">{label}</span>
      <strong className="dm-stat-value">{value}</strong>
      <small className="dm-stat-hint">{hint}</small>
    </div>
  );
}
