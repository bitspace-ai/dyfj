//! A role's launch plan, as `prototype/src/config/linux-launch-plan.ts` writes
//! it, and the one `bwrap` command line it yields. Parsing refuses anything
//! the launcher would have to guess at: unknown fields, a root id, a plan with
//! no single `--chdir`, or helper arguments that do not end the option list.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Runtime,
    Executor,
}

/// How the role's execute rights were drawn (`linux-launch-plan.ts`): exactly
/// its resolved executables and the loader, or its execute roots whole.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecuteScope {
    Files,
    Roots,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Bwrap {
    pub options: Vec<String>,
    pub inner: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LandlockPaths {
    pub read: Vec<String>,
    pub write: Vec<String>,
    pub execute: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchPlan {
    pub role: Role,
    pub policy_digest: String,
    pub execute_scope: ExecuteScope,
    pub uid: u32,
    pub gid: u32,
    pub bwrap: Bwrap,
    pub landlock: LandlockPaths,
    pub writable_targets: Vec<String>,
    pub nftables: String,
    pub environment: Vec<String>,
    pub max_processes: Option<u64>,
}

const BWRAP: &str = "/usr/bin/bwrap";

/// `path` is `root` or lies beneath it, both as plain absolute paths.
fn within(path: &str, root: &str) -> bool {
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

fn is_canonical(path: &str) -> bool {
    path.starts_with('/')
        && path != "/"
        && path[1..]
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains('\0'))
}

impl LaunchPlan {
    pub fn parse(json: &str) -> Result<LaunchPlan, String> {
        let plan: LaunchPlan =
            serde_json::from_str(json).map_err(|e| format!("launch plan is malformed: {e}"))?;
        if plan.uid == 0 || plan.gid == 0 {
            return Err("launch plan runs a role as root".into());
        }
        let chdirs = plan.bwrap.options.iter().filter(|o| *o == "--chdir").count();
        let last = plan.bwrap.options.iter().rposition(|o| o == "--chdir");
        if chdirs != 1 || last.is_none_or(|i| i + 1 >= plan.bwrap.options.len()) {
            return Err("launch plan needs exactly one --chdir with a value".into());
        }
        if plan.bwrap.inner.len() < 2 || plan.bwrap.inner.last().map(String::as_str) != Some("--")
        {
            return Err("launch plan's helper arguments must end with --".into());
        }
        if !plan.writable_targets.iter().all(|t| is_canonical(t)) {
            return Err("launch plan names a writable target that is not canonical".into());
        }
        Ok(plan)
    }

    /// The `bwrap` command line for `command`, started in `cwd` when given
    /// (it must lie in a writable mount), with only the `env` pairs whose names
    /// the plan lists, each once, in the plan's order.
    pub fn argv(
        &self,
        cwd: Option<&str>,
        env: &[(String, String)],
        command: &[String],
    ) -> Result<Vec<String>, String> {
        if command.is_empty() {
            return Err("no command to run".into());
        }
        let mut options = self.bwrap.options.clone();
        if let Some(cwd) = cwd {
            if !is_canonical(cwd) || !self.writable_targets.iter().any(|t| within(cwd, t)) {
                return Err("cwd outside the role's writable mounts".into());
            }
            let at = options.iter().position(|o| o == "--chdir").expect("checked by parse");
            options[at + 1] = cwd.to_string();
        }
        let mut argv = vec![BWRAP.to_string()];
        argv.extend(options);
        for name in &self.environment {
            if let Some((_, value)) = env.iter().find(|(key, _)| key == name) {
                argv.extend(["--setenv".to_string(), name.clone(), value.clone()]);
            }
        }
        argv.push("--".into());
        argv.extend(self.bwrap.inner.iter().cloned());
        argv.extend(command.iter().cloned());
        Ok(argv)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json() -> serde_json::Value {
        serde_json::json!({
            "role": "executor",
            "policyDigest": "sha256:00",
            "executeScope": "roots",
            "uid": 2002,
            "gid": 2002,
            "bwrap": {
                "options": ["--unshare-all", "--chdir", "/run/dyfj/workspace"],
                "inner": ["/usr/libexec/dyfj/dyfj-sandbox", "apply-landlock", "{}", "--"]
            },
            "landlock": { "read": ["/usr"], "write": ["/run/dyfj/workspace"], "execute": ["/usr"] },
            "writableTargets": ["/run/dyfj/workspace", "/run/dyfj/scratch"],
            "nftables": "table inet dyfj_executor\n",
            "environment": ["PATH", "HOME"],
            "maxProcesses": 64
        })
    }

    fn plan() -> LaunchPlan {
        LaunchPlan::parse(&json().to_string()).unwrap()
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn composes_the_command_line_in_order() {
        let env = vec![
            ("HOME".to_string(), "/var/empty/x".to_string()),
            ("SECRET".to_string(), "canary".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
        ];
        let argv = plan().argv(None, &env, &s(&["bash", "-c", "true"])).unwrap();
        assert_eq!(
            argv,
            s(&[
                "/usr/bin/bwrap",
                "--unshare-all",
                "--chdir",
                "/run/dyfj/workspace",
                "--setenv",
                "PATH",
                "/usr/bin",
                "--setenv",
                "HOME",
                "/var/empty/x",
                "--",
                "/usr/libexec/dyfj/dyfj-sandbox",
                "apply-landlock",
                "{}",
                "--",
                "bash",
                "-c",
                "true",
            ])
        );
    }

    #[test]
    fn drops_environment_names_the_plan_does_not_list() {
        let env = vec![("SECRET".to_string(), "canary".to_string())];
        let argv = plan().argv(None, &env, &s(&["true"])).unwrap();
        assert!(!argv.iter().any(|a| a == "SECRET" || a == "canary"));
    }

    #[test]
    fn starts_in_a_requested_directory_inside_a_writable_mount() {
        let argv = plan().argv(Some("/run/dyfj/workspace/sub"), &[], &s(&["true"])).unwrap();
        let at = argv.iter().position(|a| a == "--chdir").unwrap();
        assert_eq!(argv[at + 1], "/run/dyfj/workspace/sub");
    }

    #[test]
    fn refuses_a_directory_outside_the_writable_mounts() {
        for cwd in ["/etc", "/run/dyfj/workspacex", "/run/dyfj/workspace/../x", "relative", "/"] {
            assert_eq!(
                plan().argv(Some(cwd), &[], &s(&["true"])),
                Err("cwd outside the role's writable mounts".to_string()),
                "{cwd}"
            );
        }
    }

    #[test]
    fn refuses_an_empty_command() {
        assert!(plan().argv(None, &[], &[]).is_err());
    }

    #[test]
    fn refuses_a_root_role() {
        for field in ["uid", "gid"] {
            let mut value = json();
            value[field] = 0.into();
            assert_eq!(
                LaunchPlan::parse(&value.to_string()),
                Err("launch plan runs a role as root".to_string())
            );
        }
    }

    #[test]
    fn refuses_unknown_fields() {
        let mut value = json();
        value["extra"] = true.into();
        assert!(LaunchPlan::parse(&value.to_string()).is_err());
    }

    #[test]
    fn refuses_a_plan_without_exactly_one_chdir() {
        for options in [vec!["--unshare-all"], vec!["--chdir", "/a", "--chdir", "/b"], vec!["--chdir"]] {
            let mut value = json();
            value["bwrap"]["options"] = serde_json::json!(options);
            assert!(LaunchPlan::parse(&value.to_string()).is_err(), "{options:?}");
        }
    }

    #[test]
    fn refuses_helper_arguments_that_do_not_end_the_options() {
        let mut value = json();
        value["bwrap"]["inner"] = serde_json::json!(["/usr/libexec/dyfj/dyfj-sandbox"]);
        assert!(LaunchPlan::parse(&value.to_string()).is_err());
    }

    #[test]
    fn refuses_an_unknown_execute_scope() {
        let mut value = json();
        value["executeScope"] = "all".into();
        assert!(LaunchPlan::parse(&value.to_string()).is_err());
    }

    #[test]
    fn parses_the_typescript_plan_shape() {
        let plan = plan();
        assert_eq!(plan.execute_scope, ExecuteScope::Roots);
        assert_eq!(plan.role, Role::Executor);
        assert_eq!(plan.max_processes, Some(64));
        assert_eq!(plan.writable_targets.len(), 2);
    }
}
