"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
    if (typeof window !== "undefined") {
      (window as any).__lastComponentError = { message: error.message, stack: error.stack, info: errorInfo.componentStack };
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{ padding: 16, background: "#fff", color: "#c00", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 }}>
          <strong>渲染错误：</strong>
          {this.state.error.message}
          {"\n"}
          {this.state.error.stack}
        </div>
      );
    }
    return this.props.children;
  }
}
