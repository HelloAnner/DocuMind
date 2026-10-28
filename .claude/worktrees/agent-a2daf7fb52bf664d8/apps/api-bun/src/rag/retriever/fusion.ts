// 移植自 apps/api-rs/src/rag/retriever.rs —— RRF 融合 / 去重（纯函数，与 ES 无关）
import type { RetrievedChunk } from '../../models/rag.ts';
import type { RetrievalSource } from '../../models/trace.ts';

export function successfulLists(
  results: PromiseSettledResult<RetrievedChunk[]>[],
  channel: string,
): { lists: RetrievedChunk[][]; failures: string[] } {
  const lists: RetrievedChunk[][] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      lists.push(result.value);
    } else {
      const reason = result.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      failures.push(`${channel} retrieval failed: ${message}`);
    }
  }
  return { lists, failures };
}

interface FusionState {
  chunk: RetrievedChunk;
  score: number;
  dense: boolean;
  bm25: boolean;
}

export function fuseRankedLists(
  denseLists: RetrievedChunk[][],
  bm25Lists: RetrievedChunk[][],
  topK: number,
): RetrievedChunk[] {
  const states = new Map<string, FusionState>();
  for (const [isDense, lists] of [[true, denseLists], [false, bm25Lists]] as const) {
    for (const list of lists) {
      const seenInList = new Set<string>();
      for (const [index, chunk] of list.entries()) {
        if (seenInList.has(chunk.chunk_id)) continue;
        seenInList.add(chunk.chunk_id);
        let state = states.get(chunk.chunk_id);
        if (state === undefined) {
          state = { chunk, score: 0, dense: false, bm25: false };
          states.set(chunk.chunk_id, state);
        }
        if (chunk.score > state.chunk.score) state.chunk = chunk;
        state.score += reciprocalRank(index + 1);
        state.dense ||= isDense;
        state.bm25 ||= !isDense;
      }
    }
  }
  const fused: RetrievedChunk[] = [];
  for (const state of states.values()) {
    const chunk: RetrievedChunk = { ...state.chunk, score: state.score };
    const source: RetrievalSource =
      state.dense && state.bm25 ? 'rrf'
      : state.dense ? 'dense'
      : state.bm25 ? 'bm25'
      : 'rrf';
    chunk.source = source;
    fused.push(chunk);
  }
  fused.sort((left, right) => compareDesc(left.score, right.score));
  const byId = new Map(fused.map((chunk) => [chunk.chunk_id, chunk]));
  const representatives = [...denseLists, ...bm25Lists]
    .map((list) => list[0])
    .filter((chunk): chunk is RetrievedChunk => chunk !== undefined)
    .map((chunk) => byId.get(chunk.chunk_id))
    .filter((chunk): chunk is RetrievedChunk => chunk !== undefined);
  return dedupeRetrievedChunks([...representatives, ...fused], Math.max(1, topK));
}

export function reciprocalRank(rank: number): number {
  return 1.0 / (60.0 + rank);
}

/** 与 Rust partial_cmp(...).unwrap_or(Equal) 语义一致：NaN 视为相等。 */
function compareDesc(left: number, right: number): number {
  if (Number.isNaN(left) || Number.isNaN(right)) return 0;
  if (right > left) return 1;
  if (right < left) return -1;
  return 0;
}

function dedupeRetrievedChunks(chunks: RetrievedChunk[], topK: number): RetrievedChunk[] {
  const seen = new Set<string>();
  const unique: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    const key = duplicateContentKey(chunk);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(chunk);
    if (unique.length >= topK) break;
  }
  return unique;
}

function duplicateContentKey(chunk: RetrievedChunk): string {
  const compactContent = Array.from(chunk.content)
    .filter((character) => !/\s/u.test(character))
    .slice(0, 256)
    .join('');
  return `${chunk.doc_title.trim()}::${compactContent}`;
}
