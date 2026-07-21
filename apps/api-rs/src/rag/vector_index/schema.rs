use serde_json::{json, Value};

pub(super) fn index_definition(dims: usize) -> Value {
    json!({
        "settings": {
            "number_of_shards": 1,
            "number_of_replicas": 0
        },
        "mappings": {
            "properties": {
                "chunk_id": { "type": "keyword" },
                "doc_id": { "type": "keyword" },
                "doc_title": {
                    "type": "text",
                    "analyzer": "cjk",
                    "search_analyzer": "cjk",
                    "fields": {
                        "keyword": { "type": "keyword", "ignore_above": 32766 }
                    }
                },
                "file_type": { "type": "keyword" },
                "kb_id": { "type": "keyword" },
                "tenant_id": { "type": "keyword" },
                "parse_job_id": { "type": "keyword" },
                "chunk_index": { "type": "integer" },
                "source_type": { "type": "keyword" },
                "content": {
                    "type": "text",
                    "analyzer": "cjk",
                    "search_analyzer": "cjk",
                    "fields": {
                        "standard": { "type": "text", "analyzer": "standard" },
                        "keyword": { "type": "keyword", "ignore_above": 32766 }
                    }
                },
                "heading_path": { "type": "keyword" },
                "heading_text": { "type": "text", "analyzer": "cjk", "search_analyzer": "cjk" },
                "page_range": { "type": "integer_range" },
                "slide_start": { "type": "integer" },
                "slide_end": { "type": "integer" },
                "token_count": { "type": "integer" },
                "block_ids": { "type": "keyword" },
                "table_ids": { "type": "keyword" },
                "anchor_ids": { "type": "keyword" },
                "primary_anchor_id": { "type": "keyword" },
                "anchor_quality": { "type": "keyword" },
                "anchor_format": { "type": "keyword" },
                "anchor_kind": { "type": "keyword" },
                "anchor_page": { "type": "integer" },
                "anchor_slide": { "type": "integer" },
                "anchor_char_range": { "type": "object" },
                "anchor_bbox": { "type": "object" },
                "anchor_text": { "type": "text", "index": false },
                "embedding_model": { "type": "keyword" },
                "embedding": {
                    "type": "dense_vector",
                    "dims": dims,
                    "index": true,
                    "similarity": "cosine",
                    "index_options": {
                        "type": "hnsw",
                        "m": 16,
                        "ef_construction": 200
                    }
                },
                "created_at": { "type": "date" },
                "embedded_at": { "type": "date" }
            }
        }
    })
}

pub fn physical_index_name(prefix: &str, model: &str, dims: usize, schema_version: u32) -> String {
    format!(
        "{}-v{}-{}-{}",
        sanitize_index_part(prefix),
        schema_version,
        sanitize_index_part(model),
        dims
    )
}

fn sanitize_index_part(value: &str) -> String {
    let mut sanitized = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while sanitized.contains("--") {
        sanitized = sanitized.replace("--", "-");
    }
    sanitized.trim_matches(['-', '_']).to_string()
}

#[cfg(test)]
mod tests {
    use super::physical_index_name;

    #[test]
    fn physical_index_name_is_stable_and_safe() {
        assert_eq!(
            physical_index_name("Chunks", "text/embedding v3", 1024, 2),
            "chunks-v2-text-embedding-v3-1024"
        );
    }
}
