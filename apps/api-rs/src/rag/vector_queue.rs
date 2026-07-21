use std::time::Duration;

use anyhow::{Context, Result};
use futures::StreamExt;
use lapin::options::{
    BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicPublishOptions, BasicQosOptions,
    ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions,
};
use lapin::types::{AMQPValue, FieldTable, LongString};
use lapin::{BasicProperties, Connection, ConnectionProperties, ExchangeKind};
use sqlx::PgPool;
use tokio::sync::mpsc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::rag::vector_jobs;

const PENDING_QUEUE: &str = "documind.embedding.pending";
const DEAD_LETTER_EXCHANGE: &str = "documind.dlx";
const DEAD_LETTER_QUEUE: &str = "documind.embedding.dead";
const DEAD_LETTER_ROUTING_KEY: &str = "embedding";

pub fn start(rabbitmq_url: String, pool: PgPool, sender: mpsc::Sender<Uuid>) {
    tokio::spawn(async move {
        loop {
            match run_connection(&rabbitmq_url, &pool, &sender).await {
                Ok(()) => warn!("RabbitMQ vector queue connection closed; reconnecting"),
                Err(error) => {
                    warn!(error = %error, "RabbitMQ vector queue unavailable; database polling remains active")
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn run_connection(
    rabbitmq_url: &str,
    pool: &PgPool,
    sender: &mpsc::Sender<Uuid>,
) -> Result<()> {
    let connection = Connection::connect(rabbitmq_url, ConnectionProperties::default())
        .await
        .context("failed to connect RabbitMQ vector queue")?;
    let channel = connection.create_channel().await?;
    declare_topology(&channel).await?;
    channel.basic_qos(1, BasicQosOptions::default()).await?;
    let mut consumer = channel
        .basic_consume(
            PENDING_QUEUE,
            "documind-vector-worker",
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    let mut publish_tick = tokio::time::interval(Duration::from_secs(1));
    info!(queue = PENDING_QUEUE, "RabbitMQ vector queue connected");

    loop {
        tokio::select! {
            _ = publish_tick.tick() => {
                publish_pending(&channel, pool).await?;
            }
            delivery = consumer.next() => {
                let Some(delivery) = delivery else {
                    return Ok(());
                };
                let delivery = delivery?;
                match std::str::from_utf8(&delivery.data)
                    .ok()
                    .and_then(|value| Uuid::parse_str(value).ok())
                {
                    Some(job_id) => {
                        sender.send(job_id).await.context("vector queue receiver closed")?;
                        delivery.ack(BasicAckOptions::default()).await?;
                    }
                    None => {
                        delivery
                            .nack(BasicNackOptions { multiple: false, requeue: false })
                            .await?;
                    }
                }
            }
        }
    }
}

async fn declare_topology(channel: &lapin::Channel) -> Result<()> {
    channel
        .exchange_declare(
            DEAD_LETTER_EXCHANGE,
            ExchangeKind::Direct,
            ExchangeDeclareOptions {
                durable: true,
                ..ExchangeDeclareOptions::default()
            },
            FieldTable::default(),
        )
        .await?;
    channel
        .queue_declare(
            DEAD_LETTER_QUEUE,
            QueueDeclareOptions {
                durable: true,
                ..QueueDeclareOptions::default()
            },
            FieldTable::default(),
        )
        .await?;
    channel
        .queue_bind(
            DEAD_LETTER_QUEUE,
            DEAD_LETTER_EXCHANGE,
            DEAD_LETTER_ROUTING_KEY,
            QueueBindOptions::default(),
            FieldTable::default(),
        )
        .await?;
    let mut arguments = FieldTable::default();
    arguments.insert(
        "x-dead-letter-exchange".into(),
        AMQPValue::LongString(LongString::from(DEAD_LETTER_EXCHANGE)),
    );
    arguments.insert(
        "x-dead-letter-routing-key".into(),
        AMQPValue::LongString(LongString::from(DEAD_LETTER_ROUTING_KEY)),
    );
    channel
        .queue_declare(
            PENDING_QUEUE,
            QueueDeclareOptions {
                durable: true,
                ..QueueDeclareOptions::default()
            },
            arguments,
        )
        .await?;
    Ok(())
}

async fn publish_pending(channel: &lapin::Channel, pool: &PgPool) -> Result<()> {
    for job_id in vector_jobs::pending_for_publish(pool, 100).await? {
        let confirmation = channel
            .basic_publish(
                "",
                PENDING_QUEUE,
                BasicPublishOptions::default(),
                job_id.to_string().as_bytes(),
                BasicProperties::default()
                    .with_delivery_mode(2)
                    .with_content_type("text/plain".into()),
            )
            .await?
            .await?;
        if !confirmation.is_nack() {
            vector_jobs::mark_published(pool, job_id).await?;
        }
    }
    for job_id in vector_jobs::failed_for_dead_letter(pool, 100).await? {
        let confirmation = channel
            .basic_publish(
                DEAD_LETTER_EXCHANGE,
                DEAD_LETTER_ROUTING_KEY,
                BasicPublishOptions::default(),
                job_id.to_string().as_bytes(),
                BasicProperties::default()
                    .with_delivery_mode(2)
                    .with_content_type("text/plain".into()),
            )
            .await?
            .await?;
        if !confirmation.is_nack() {
            vector_jobs::mark_dead_lettered(pool, job_id).await?;
        }
    }
    Ok(())
}
