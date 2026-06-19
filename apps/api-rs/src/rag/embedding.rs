pub const LOCAL_HASH_EMBEDDING_MODEL: &str = "local-hash-embedding-v1";
pub const LOCAL_HASH_EMBEDDING_DIM: usize = 64;

pub fn local_hash_embedding(text: &str) -> Vec<f64> {
    let mut vector = vec![0.0; LOCAL_HASH_EMBEDDING_DIM];
    let normalized = text.to_lowercase();
    let chars: Vec<char> = normalized.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.is_empty() {
        return vector;
    }

    for n in [1, 2, 3] {
        for window in chars.windows(n) {
            let gram = window.iter().collect::<String>();
            let index = stable_hash(&gram) as usize % LOCAL_HASH_EMBEDDING_DIM;
            vector[index] += 1.0 / n as f64;
        }
    }

    normalize(&mut vector);
    vector
}

pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let len = a.len().min(b.len());
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..len {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        (dot / norm_a.sqrt() / norm_b.sqrt()).clamp(0.0, 1.0)
    }
}

pub fn vector_from_json(value: &serde_json::Value) -> Option<Vec<f64>> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_f64()).collect())
}

fn normalize(vector: &mut [f64]) {
    let norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
    if norm > 0.0 {
        for value in vector {
            *value /= norm;
        }
    }
}

fn stable_hash(text: &str) -> u64 {
    // FNV-1a keeps this fallback deterministic across platforms and releases.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_is_normalized_and_deterministic() {
        let a = local_hash_embedding("付款节点");
        let b = local_hash_embedding("付款节点");

        assert_eq!(a, b);
        assert_eq!(a.len(), LOCAL_HASH_EMBEDDING_DIM);
        let norm = a.iter().map(|v| v * v).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 0.000001);
    }

    #[test]
    fn cosine_scores_related_text_higher() {
        let query = local_hash_embedding("付款节点");
        let related = local_hash_embedding("合同付款节点和验收付款比例");
        let unrelated = local_hash_embedding("员工差旅住宿标准");

        assert!(cosine_similarity(&query, &related) > cosine_similarity(&query, &unrelated));
    }
}
