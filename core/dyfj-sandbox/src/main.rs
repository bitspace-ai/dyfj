//! `dyfj-sandbox`: the trusted launcher of the isolated Linux machine.
//!
//!   dyfj-sandbox abi
//!   dyfj-sandbox apply-landlock <paths-json> -- <command>...
//!   dyfj-sandbox run --plan <file> [--cwd <dir>] -- <command>...
//!   dyfj-sandbox serve --runtime-plan <file> --executor-plan <file> --socket <path> -- <command>...
//!
//! `apply-landlock` runs inside a sandbox, as the role. `run` and `serve` run
//! as root, from plans the installer wrote (`linux-launch-plan.ts`).

// The launcher runs only on Linux; elsewhere only the pure parts are built
// and tested.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

mod landlock;
mod lease;
mod plan;
mod protocol;
#[cfg(target_os = "linux")]
mod supervisor;

use std::process::ExitCode;

type Flags = Vec<(String, String)>;

/// The flags before `--`, as (name, value) pairs, and the command after it.
fn split(args: &[String]) -> Result<(Flags, Vec<String>), String> {
    let at = args.iter().position(|a| a == "--").ok_or("missing -- before the command")?;
    let (flags, command) = (&args[..at], args[at + 1..].to_vec());
    if command.is_empty() {
        return Err("no command after --".into());
    }
    if flags.len() % 2 != 0 {
        return Err("every flag needs a value".into());
    }
    let pairs = flags.chunks(2).map(|p| (p[0].clone(), p[1].clone())).collect();
    Ok((pairs, command))
}

fn flag<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn known(pairs: &[(String, String)], names: &[&str]) -> Result<(), String> {
    match pairs.iter().find(|(k, _)| !names.contains(&k.as_str())) {
        Some((k, _)) => Err(format!("unknown flag {k}")),
        None => Ok(()),
    }
}

fn apply_landlock(args: &[String]) -> Result<i32, String> {
    let (spec, rest) = args.split_first().ok_or("apply-landlock needs a paths argument")?;
    if rest.first().map(String::as_str) != Some("--") || rest.len() < 2 {
        return Err("apply-landlock needs -- and a command".into());
    }
    let paths: plan::LandlockPaths =
        serde_json::from_str(spec).map_err(|e| format!("Landlock paths are malformed: {e}"))?;
    landlock::apply(&paths)?;
    use std::os::unix::process::CommandExt;
    let error = std::process::Command::new(&rest[1]).args(&rest[2..]).exec();
    Err(format!("{}: {error}", rest[1]))
}

#[cfg(target_os = "linux")]
fn launch(subcommand: &str, args: &[String]) -> Result<i32, String> {
    supervisor::require_root()?;
    let (pairs, command) = split(args)?;
    match subcommand {
        "run" => {
            known(&pairs, &["--plan", "--cwd"])?;
            let plan = supervisor::load_plan(flag(&pairs, "--plan").ok_or("run needs --plan")?)?;
            supervisor::run(&plan, flag(&pairs, "--cwd"), &command)
        }
        _ => {
            known(&pairs, &["--runtime-plan", "--executor-plan", "--socket"])?;
            let runtime = supervisor::load_plan(flag(&pairs, "--runtime-plan").ok_or("serve needs --runtime-plan")?)?;
            let executor = supervisor::load_plan(flag(&pairs, "--executor-plan").ok_or("serve needs --executor-plan")?)?;
            if runtime.role != plan::Role::Runtime || executor.role != plan::Role::Executor {
                return Err("serve needs a runtime plan and an executor plan".into());
            }
            let socket = flag(&pairs, "--socket").ok_or("serve needs --socket")?;
            supervisor::serve(runtime, executor, socket, &command)
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn launch(_subcommand: &str, args: &[String]) -> Result<i32, String> {
    split(args)?;
    Err("the launcher runs only on Linux".into())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("abi") => landlock::abi().map(|abi| {
            println!("{abi}");
            0
        }),
        Some("apply-landlock") => apply_landlock(&args[1..]),
        Some(sub @ ("run" | "serve")) => launch(sub, &args[1..]),
        _ => Err("usage: dyfj-sandbox abi | apply-landlock | run | serve".into()),
    };
    match result {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(message) => {
            eprintln!("dyfj-sandbox: {message}");
            ExitCode::from(125)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn splits_flags_from_the_command() {
        let (pairs, command) = split(&s(&["--plan", "/p", "--", "bash", "-c", "x"])).unwrap();
        assert_eq!(flag(&pairs, "--plan"), Some("/p"));
        assert_eq!(command, s(&["bash", "-c", "x"]));
    }

    #[test]
    fn refuses_a_flag_without_a_value_or_a_missing_command() {
        assert!(split(&s(&["--plan", "--", "x"])).is_err());
        assert!(split(&s(&["--plan", "/p", "--"])).is_err());
        assert!(split(&s(&["--plan", "/p"])).is_err());
    }

    #[test]
    fn refuses_unknown_flags() {
        let (pairs, _) = split(&s(&["--plna", "/p", "--", "x"])).unwrap();
        assert!(known(&pairs, &["--plan"]).is_err());
    }

    #[test]
    fn apply_landlock_needs_a_command() {
        assert!(apply_landlock(&s(&["{}"])).is_err());
        assert!(apply_landlock(&s(&["{}", "--"])).is_err());
    }
}
