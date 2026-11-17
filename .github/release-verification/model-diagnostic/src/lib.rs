pub mod ai_cli {
    use std::path::{Path,PathBuf};
    #[derive(Clone,Copy,PartialEq,Eq)]
    pub enum CliKind {Codex,ClaudeCode}
    impl CliKind {pub fn label(self)->&'static str {match self {Self::Codex=>"Codex",Self::ClaudeCode=>"Claude Code"}}}
    #[derive(Debug)]
    pub struct CliError(pub String);
    impl std::fmt::Display for CliError {fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {self.0.fmt(f)}}
    impl std::error::Error for CliError {}
    pub fn resolve_program(_:CliKind,program:Option<&Path>)->Option<PathBuf>{program.map(Path::to_path_buf)}
    pub struct RequestDir(pub PathBuf);
    impl RequestDir {pub fn create()->Result<Self,CliError>{tempfile::tempdir().map(|dir|Self(dir.keep())).map_err(|e|CliError(e.to_string()))}}
    impl Drop for RequestDir {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
}
#[path="../../../../src-tauri/src/ai_models.rs"]
mod ai_models;
