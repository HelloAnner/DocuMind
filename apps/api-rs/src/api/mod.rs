pub mod admin;
pub mod auth;
pub mod conversations;
pub mod documents;
pub mod history;
pub mod knowledge;
pub mod system;

pub use admin::router as admin_router;
pub use auth::router as auth_router;
pub use conversations::router as conversations_router;
pub use documents::router as documents_router;
pub use history::router as history_router;
pub use knowledge::router as knowledge_router;
pub use system::router as system_router;
