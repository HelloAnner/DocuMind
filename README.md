# DocuMind

企业级文档智能问答系统 —— 基于 RAG（检索增强生成）架构，支持多格式文档解析、混合检索与流式生成。

## 技术栈

- **后端**: Rust + Axum + SQLx + Rig + ONNX Runtime
- **前端**: Next.js (静态导出，Rust 二进制内嵌)
- **数据库**: PostgreSQL (PGVector) + Redis + RabbitMQ
- **嵌入模型**: bge-large-zh-v1.5 (ONNX 本地推理)
- **部署**: 单二进制文件

## 快速开始

```bash
cp .env.example .env
# 编辑 .env 配置数据库连接等参数
cargo run
```

## 文档

- [产品定位与需求](docs/prd.md)
- [技术架构](docs/tech.md)
- [设计系统](DESIGN.md)
