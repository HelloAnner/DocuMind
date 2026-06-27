use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::{config::Region, Client, Config};
use tokio::fs::{metadata, File};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tracing::{info, warn};

use crate::config::AppConfig;

/// 统一的对象存储抽象。
#[async_trait]
pub trait ObjectStorage: Send + Sync {
    /// 将字节流写入指定 key。
    async fn put(&self, key: &str, bytes: &[u8]) -> Result<()>;

    /// 读取指定 key 的字节流。
    async fn get(&self, key: &str) -> Result<Vec<u8>>;

    /// 获取指定 key 的字节大小。
    async fn size(&self, key: &str) -> Result<u64>;

    /// 读取指定 key 的某个字节范围（含 start，不含 end）。
    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>>;

    /// 删除指定 key。失败不应阻塞调用方，由实现内部记录日志。
    async fn delete(&self, key: &str) -> Result<()>;
}

/// 根据配置构建存储后端。
///
/// 当 `OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_ACCESS_KEY`、`OBJECT_STORAGE_SECRET_KEY`
/// 同时存在且非空时使用 MinIO / S3；否则回退到本地文件系统。
pub fn build_storage(config: &AppConfig) -> Arc<dyn ObjectStorage> {
    let endpoint = config
        .object_storage_endpoint
        .as_deref()
        .filter(|s| !s.trim().is_empty());
    let access_key = config
        .object_storage_access_key
        .as_deref()
        .filter(|s| !s.trim().is_empty());
    let secret_key = config
        .object_storage_secret_key
        .as_deref()
        .filter(|s| !s.trim().is_empty());

    if let (Some(endpoint), Some(access_key), Some(secret_key)) = (endpoint, access_key, secret_key)
    {
        info!(
            endpoint = endpoint,
            bucket = %config.object_storage_bucket,
            "using S3/MinIO object storage"
        );
        Arc::new(S3Storage::new(
            endpoint,
            &config.object_storage_region,
            access_key,
            secret_key,
            &config.object_storage_bucket,
            config.object_storage_force_path_style,
        ))
    } else {
        info!(
            blob_dir = %config.blob_storage_dir,
            "object storage not fully configured, falling back to local file storage"
        );
        Arc::new(LocalStorage::new(PathBuf::from(&config.blob_storage_dir)))
    }
}

/// 基于 aws-sdk-s3 的对象存储实现，兼容 MinIO。
pub struct S3Storage {
    client: Client,
    bucket: String,
}

impl S3Storage {
    pub fn new(
        endpoint: &str,
        region: &str,
        access_key: &str,
        secret_key: &str,
        bucket: &str,
        force_path_style: bool,
    ) -> Self {
        let creds = Credentials::new(
            access_key.to_string(),
            secret_key.to_string(),
            None,
            None,
            "static",
        );
        let config = Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(creds)
            .region(Region::new(region.to_string()))
            .endpoint_url(endpoint)
            .force_path_style(force_path_style)
            .build();
        Self {
            client: Client::from_conf(config),
            bucket: bucket.to_string(),
        }
    }
}

#[async_trait]
impl ObjectStorage for S3Storage {
    async fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(bytes.to_vec()))
            .send()
            .await
            .with_context(|| format!("failed to put object s3://{}/{}", self.bucket, key))?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        let stream = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("failed to get object s3://{}/{}", self.bucket, key))?
            .body;

        let aggregated = stream
            .collect()
            .await
            .with_context(|| format!("failed to read object body s3://{}/{}", self.bucket, key))?;
        Ok(aggregated.into_bytes().to_vec())
    }

    async fn size(&self, key: &str) -> Result<u64> {
        let head = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("failed to head object s3://{}/{}", self.bucket, key))?;
        head.content_length
            .map(|len| len as u64)
            .context("missing content-length in head response")
    }

    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>> {
        // S3 range 是闭区间：bytes=start-end
        let stream = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .range(format!("bytes={}-{}" , start, end.saturating_sub(1)))
            .send()
            .await
            .with_context(|| format!("failed to get range s3://{}/{}", self.bucket, key))?
            .body;
        let aggregated = stream
            .collect()
            .await
            .with_context(|| format!("failed to read range body s3://{}/{}", self.bucket, key))?;
        Ok(aggregated.into_bytes().to_vec())
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("failed to delete object s3://{}/{}", self.bucket, key))?;
        Ok(())
    }
}

/// 本地文件系统存储实现，key 直接映射为 blob_storage_dir 下的相对路径。
pub struct LocalStorage {
    root: PathBuf,
}

impl LocalStorage {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn key_to_path(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }
}

#[async_trait]
impl ObjectStorage for LocalStorage {
    async fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let path = self.key_to_path(key);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create directory: {}", parent.display()))?;
        }
        tokio::fs::write(&path, bytes)
            .await
            .with_context(|| format!("failed to write local file: {}", path.display()))?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>> {
        let path = self.key_to_path(key);
        tokio::fs::read(&path)
            .await
            .with_context(|| format!("failed to read local file: {}", path.display()))
    }

    async fn size(&self, key: &str) -> Result<u64> {
        let path = self.key_to_path(key);
        let meta = metadata(&path)
            .await
            .with_context(|| format!("failed to stat local file: {}", path.display()))?;
        Ok(meta.len())
    }

    async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>> {
        let path = self.key_to_path(key);
        let mut file = File::open(&path)
            .await
            .with_context(|| format!("failed to open local file: {}", path.display()))?;
        file.seek(SeekFrom::Start(start))
            .await
            .with_context(|| format!("failed to seek local file: {}", path.display()))?;
        let len = (end - start) as usize;
        let mut buffer = vec![0_u8; len];
        let mut read = 0_usize;
        while read < len {
            let n = file.read(&mut buffer[read..])
                .await
                .with_context(|| format!("failed to read local file: {}", path.display()))?;
            if n == 0 {
                break;
            }
            read += n;
        }
        buffer.truncate(read);
        Ok(buffer)
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let path = self.key_to_path(key);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => {
                warn!(path = %path.display(), error = %e, "failed to delete local file");
                Err(e).with_context(|| format!("failed to delete local file: {}", path.display()))
            }
        }
    }
}
