use std::{env, path::Path, process::ExitCode};

use memokeep_storage::{backup, initialize, StorageError};
use thiserror::Error;

#[derive(Debug, Error)]
enum CommandError {
    #[error("用法：memokeep-backup export <SQLite> <JSON>\n      memokeep-backup export-modules <SQLite> <目标目录>\n      memokeep-backup restore <JSON> <新 SQLite>\n      memokeep-backup replace <JSON> <已有 SQLite> <当前修订号> <恢复前 JSON>")]
    Usage,
    #[error("目标已变化，恢复已取消")]
    Stale,
    #[error("目标不存在或不可写：{0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Backup(#[from] backup::BackupError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn run() -> Result<(), CommandError> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let result = match args.as_slice() {
        [action, database, directory] if action == "export-modules" => {
            let output = backup::export_modules(Path::new(database), Path::new(directory))?;
            println!("{}", output.display());
            return Ok(());
        }
        [action, database, output] if action == "export" => {
            backup::export(Path::new(database), Path::new(output))?
        }
        [action, input, database] if action == "restore" => {
            let destination = Path::new(database);
            let parent = destination
                .parent()
                .filter(|dir| !dir.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let candidate = tempfile::NamedTempFile::new_in(parent)?;
            initialize(candidate.path())?;
            let result = backup::restore(candidate.path(), Path::new(input), 0)?;
            candidate
                .persist_noclobber(destination)
                .map_err(|error| error.error)?;
            result
        }
        [action, input, database, expected_revision, rollback] if action == "replace" => {
            let database = Path::new(database);
            let revision = expected_revision
                .to_str()
                .and_then(|value| value.parse::<i64>().ok())
                .filter(|revision| *revision > 0)
                .ok_or(CommandError::Usage)?;
            if backup::export(database, Path::new(rollback))?.revision != revision {
                return Err(CommandError::Stale);
            }
            backup::restore(database, Path::new(input), revision)?
        }
        _ => return Err(CommandError::Usage),
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
