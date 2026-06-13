"use client";

import { Search } from "lucide-react";

export function SearchInput({
  placeholder,
  className,
  ...props
}: {
  placeholder?: string;
  className?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={className}>
      <div className="dm-search-input">
        <Search size={14} />
        <input placeholder={placeholder} {...props} />
      </div>
    </div>
  );
}
