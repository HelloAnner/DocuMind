"use client";

import { Check, Copy } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useDeferredValue,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Streamdown } from "streamdown";
import { copyToClipboard } from "@/lib/clipboard";

interface AnswerContentProps {
  content: string;
  isStreaming?: boolean;
  onCitationClick?: (index: number) => void;
  displayCitationIndex?: (index: number) => number;
}

interface MarkdownContentProps {
  content: string;
  className: string;
  isStreaming?: boolean;
  realtime?: boolean;
  onCitationClick?: (index: number) => void;
  displayCitationIndex?: (index: number) => number;
}


function CitationBadge({ index, onClick }: { index: number; onClick?: () => void }) {
  return (
    <button type="button" className="dm-citation-badge" onClick={onClick}>
      [{index}]
    </button>
  );
}

function renderCitationText(
  text: string,
  onCitationClick?: (index: number) => void,
  displayCitationIndex?: (index: number) => number
) {
  return text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g).map((part, index) => {
    if (!/^\[\d+(?:\s*,\s*\d+)*\]$/.test(part)) return part;
    return part
      .slice(1, -1)
      .split(",")
      .map((value) => Number(value.trim()))
      .map((citationIndex, markerIndex) => (
        <CitationBadge
          key={`${citationIndex}-${index}-${markerIndex}`}
          index={displayCitationIndex?.(citationIndex) ?? citationIndex}
          onClick={() => onCitationClick?.(citationIndex)}
        />
      ));
  });
}

function renderCitations(
  children: ReactNode,
  onCitationClick?: (index: number) => void,
  displayCitationIndex?: (index: number) => number
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return renderCitationText(child, onCitationClick, displayCitationIndex);
    }
    if (!isValidElement(child)) return child;

    const element = child as ReactElement<{ children?: ReactNode }>;
    if (!element.props.children || element.type === "code" || element.type === "pre") {
      return element;
    }

    return cloneElement(element, {
      children: renderCitations(element.props.children, onCitationClick, displayCitationIndex),
    });
  });
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (await copyToClipboard(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="dm-code-block">
      <div className="dm-code-block-head">
        <span>{lang || "code"}</span>
        <button type="button" onClick={handleCopy} aria-label="复制代码">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
  isStreaming = false,
  realtime = false,
  onCitationClick,
  displayCitationIndex,
}: MarkdownContentProps) {
  const deferredContent = useDeferredValue(content);
  const renderContent = realtime ? content : deferredContent;

  return (
    <div className={`${className} ${isStreaming ? "is-streaming" : ""}`}>
      <Streamdown
        animated={false}
        mode={isStreaming ? "streaming" : "static"}
        parseIncompleteMarkdown={isStreaming}
        components={{
          h1: ({ children }) => <h1>{renderCitations(children, onCitationClick, displayCitationIndex)}</h1>,
          h2: ({ children }) => <h2>{renderCitations(children, onCitationClick, displayCitationIndex)}</h2>,
          h3: ({ children }) => <h3>{renderCitations(children, onCitationClick, displayCitationIndex)}</h3>,
          h4: ({ children }) => <h4>{renderCitations(children, onCitationClick, displayCitationIndex)}</h4>,
          h5: ({ children }) => <h5>{renderCitations(children, onCitationClick, displayCitationIndex)}</h5>,
          h6: ({ children }) => <h6>{renderCitations(children, onCitationClick, displayCitationIndex)}</h6>,
          p: ({ children }) => <p>{renderCitations(children, onCitationClick, displayCitationIndex)}</p>,
          li: ({ children }) => <li>{renderCitations(children, onCitationClick, displayCitationIndex)}</li>,
          th: ({ children }) => <th>{renderCitations(children, onCitationClick, displayCitationIndex)}</th>,
          td: ({ children }) => <td>{renderCitations(children, onCitationClick, displayCitationIndex)}</td>,
          blockquote: ({ children }) => <blockquote>{renderCitations(children, onCitationClick, displayCitationIndex)}</blockquote>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {renderCitations(children, onCitationClick, displayCitationIndex)}
            </a>
          ),
          code: ({ children, className: codeClassName }) => {
            const match = /language-(\w+)/.exec(codeClassName ?? "");
            const code = String(children).replace(/\n$/, "");
            if (!code.includes("\n") && !match) return <code>{children}</code>;
            return <CodeBlock code={code} lang={match?.[1]} />;
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="dm-markdown-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {renderContent}
      </Streamdown>
    </div>
  );
});

export const AnswerContent = memo(function AnswerContent({
  content,
  isStreaming = false,
  onCitationClick,
  displayCitationIndex,
}: AnswerContentProps) {
  return (
    <MarkdownContent
      content={content}
      className="dm-answer-content dm-markdown-content"
      isStreaming={isStreaming}
      realtime={isStreaming}
      onCitationClick={onCitationClick}
      displayCitationIndex={displayCitationIndex}
    />
  );
});
