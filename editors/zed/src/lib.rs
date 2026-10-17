use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree};

/// The Staleproof version `npx` runs when no `staleproof` is on the PATH (set at each release).
const STALEPROOF_VERSION: &str = "0.6.0";

/// Starts `staleproof lsp`: a `staleproof` on the worktree's PATH (a global or project install
/// put there by the shell), else `npx -y staleproof@<version>`. The server reads the files,
/// git and a local cache only.
struct Staleproof;

impl zed::Extension for Staleproof {
    fn new() -> Self {
        Staleproof
    }

    fn language_server_command(&mut self, _id: &LanguageServerId, worktree: &Worktree) -> Result<zed::Command> {
        let env = worktree.shell_env();
        if let Some(path) = worktree.which("staleproof") {
            return Ok(zed::Command { command: path, args: vec!["lsp".into()], env });
        }
        let npx = worktree
            .which("npx")
            .ok_or_else(|| "Staleproof needs Node.js 20 or later (npx), or a staleproof on the PATH: npm i -g staleproof".to_string())?;
        Ok(zed::Command {
            command: npx,
            args: vec!["-y".into(), format!("staleproof@{STALEPROOF_VERSION}"), "lsp".into()],
            env,
        })
    }
}

zed::register_extension!(Staleproof);
