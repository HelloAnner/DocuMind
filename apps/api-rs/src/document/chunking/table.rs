use super::*;
pub(super) fn split_table_group(
    file_type: FileType,
    kb_id: Uuid,
    parse_job_id: Uuid,
    group: &BlockGroup,
    cfg: &ChunkConfig,
    chunks: &mut Vec<ChunkDraft>,
) -> bool {
    let Some(block) = group.blocks.first() else {
        return false;
    };
    let lines = block.cleaned_text.lines().collect::<Vec<_>>();
    if lines.len() <= 2
        || (lines.len().saturating_sub(2) <= cfg.max_table_rows_per_chunk
            && group.tokens <= cfg.max_table_token_per_chunk)
    {
        return false;
    }

    let header = &lines[..2];
    let body = &lines[2..];
    let mut current_rows = Vec::new();
    for row in body {
        let mut candidate = header.to_vec();
        candidate.extend(current_rows.iter().copied());
        candidate.push(row);
        let exceeds_rows = current_rows.len() >= cfg.max_table_rows_per_chunk;
        let exceeds_tokens = estimate_tokens(&candidate.join("\n")) > cfg.max_table_token_per_chunk;
        if !current_rows.is_empty() && (exceeds_rows || exceeds_tokens) {
            push_table_chunk(
                file_type,
                kb_id,
                parse_job_id,
                block,
                header,
                &current_rows,
                chunks,
            );
            current_rows.clear();
        }
        current_rows.push(*row);
    }
    if !current_rows.is_empty() {
        push_table_chunk(
            file_type,
            kb_id,
            parse_job_id,
            block,
            header,
            &current_rows,
            chunks,
        );
    }
    true
}

fn push_table_chunk(
    file_type: FileType,
    kb_id: Uuid,
    parse_job_id: Uuid,
    block: &CleanedBlock,
    header: &[&str],
    rows: &[&str],
    chunks: &mut Vec<ChunkDraft>,
) {
    let mut part = block.clone();
    part.cleaned_text = header
        .iter()
        .chain(rows.iter())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    chunks.push(chunk_from_group(
        file_type,
        kb_id,
        parse_job_id,
        single_block_group(part),
        "table_rows",
    ));
}
