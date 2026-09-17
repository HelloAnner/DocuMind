// 移植自 apps/api-rs/src/rag/context.rs —— SimpleContextAssembler：按 max_context_chars 预算拼装证据上下文
import type { ContextInput, EvidencePack } from '../models/rag.ts';
import type { ContextAssembler } from './types.ts';

export class SimpleContextAssembler implements ContextAssembler {
  constructor() {}

  componentName(): string {
    return 'simple-context-assembler';
  }

  async assemble(input: ContextInput): Promise<EvidencePack> {
    const lines: string[] = [];
    const selected = [] as EvidencePack['chunks'];
    let usedChars = 0;
    for (const chunk of input.chunks) {
      const chunkChars = Array.from(chunk.chunk.content).length;
      if (selected.length > 0 && usedChars + chunkChars > Math.max(input.max_context_chars, 1)) {
        continue;
      }
      usedChars += chunkChars;
      selected.push(chunk);
    }
    for (const [i, chunk] of selected.entries()) {
      const index = i + 1;
      const heading =
        chunk.chunk.heading_path.length === 0
          ? ''
          : ` > ${chunk.chunk.heading_path.join(' > ')}`;
      const page =
        chunk.chunk.page_range.length === 0
          ? ''
          : `第${chunk.chunk.page_range.map((p) => p.toString()).join('-')}`;
      lines.push(
        `[${index}] 文档: ${chunk.chunk.doc_title} ${page}${heading}
${chunk.chunk.content}`,
      );
    }
    return { chunks: selected, context_text: lines.join('\n\n') };
  }
}
