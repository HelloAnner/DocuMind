"use client";

import { clsx } from "clsx";

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange?: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx("dm-segmented", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          className={clsx(value === option.value && "selected")}
          onClick={() => onChange?.(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
