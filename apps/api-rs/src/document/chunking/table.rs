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
    let parts = postprocess::split_table_text(&block.cleaned_text, cfg);
    if parts.len() <= 1 {
        return false;
    }
    for (part_index, content) in parts.into_iter().enumerate() {
        let mut part = block.clone();
        part.cleaned_text = content;
        let mut chunk = chunk_from_group(
            file_type,
            kb_id,
            parse_job_id,
            single_block_group(part),
            "table_rows",
        );
        if let Some(metadata) = chunk.metadata.as_object_mut() {
            metadata.insert("table_part_index".to_string(), json!(part_index));
        }
        chunks.push(chunk);
    }
    true
}
