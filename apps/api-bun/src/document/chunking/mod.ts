// 兼容入口：Rust 侧为 document/chunking.rs + document/chunking/*.rs，
// TS 实现放在 document/chunking.ts（本次移植指定路径），这里 re-export 供按 Rust 目录结构引用

export * from '../chunking.ts';
