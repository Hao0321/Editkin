//! Desktop facade over the shared native owned-process implementation.
//! Keep callers source-compatible; process containment has one canonical owner.
#[path = "../../native/shared/owned_process.rs"]
mod implementation;
pub use implementation::*;
