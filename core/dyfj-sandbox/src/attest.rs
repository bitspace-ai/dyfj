//! What the supervisor attests to its runtime (BIT-736): which executor
//! policy and plan it loaded, whether the files are still as loaded, whether
//! an operator grant names that policy, and what the enforcement probe saw.
//! The pure parts live here so they are tested on every platform.

use serde::Deserialize;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// The probe the supervisor runs in a fresh executor before it serves: a
/// connect to a TEST-NET-1 address and a write beneath `/usr`. It prints one
/// line of JSON with each attempt's error code.
pub const PROBE_SCRIPT: &str = r#"const net=require("net"),fs=require("fs");const r={};
try{fs.writeFileSync("/usr/.dyfj-l9-probe","x");r.write="written";try{fs.unlinkSync("/usr/.dyfj-l9-probe")}catch{}}catch(e){r.write=e.code||"error"}
const done=()=>{process.stdout.write(JSON.stringify(r));process.exit(0)};
const s=net.connect({host:"192.0.2.1",port:9});s.setTimeout(3000);
s.on("connect",()=>{r.connect="connected";s.destroy();done()});
s.on("timeout",()=>{r.connect="timeout";s.destroy();done()});
s.on("error",(e)=>{r.connect=e.code||"error";done()});"#;

/// Connect errors that show the executor has no route out.
const REFUSED_CONNECT: &[&str] = &["ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"];
/// Write errors that show the path is not writable to the executor.
const REFUSED_WRITE: &[&str] = &["EACCES", "EROFS", "EPERM"];

/// The probe's (passed, connect, write) from its stdout. Anything else than
/// a refusal of both, or output that is not the probe's line, fails.
pub fn probe_verdict(stdout: &str) -> (bool, String, String) {
    #[derive(Deserialize)]
    struct Line {
        connect: Option<String>,
        write: Option<String>,
    }
    let Ok(line) = serde_json::from_str::<Line>(stdout.trim()) else {
        return (false, "none".into(), "none".into());
    };
    let connect = line.connect.unwrap_or_else(|| "none".into());
    let write = line.write.unwrap_or_else(|| "none".into());
    let passed = REFUSED_CONNECT.contains(&connect.as_str()) && REFUSED_WRITE.contains(&write.as_str());
    (passed, connect, write)
}

/// A file only root can have written: owned by root and not group- or
/// world-writable, in a directory with the same property.
pub fn trusted_modes(uid: u32, mode: u32, dir_uid: u32, dir_mode: u32) -> Result<(), String> {
    if uid != 0 || mode & 0o022 != 0 {
        return Err("must be owned by root and not group- or world-writable".into());
    }
    if dir_uid != 0 || dir_mode & 0o022 != 0 {
        return Err("its directory must be owned by root and not group- or world-writable".into());
    }
    Ok(())
}

/// The bytes of `path`, when `trusted_modes` holds for it and its directory.
/// A symlink is refused rather than followed.
pub fn read_trusted(path: &str) -> Result<Vec<u8>, String> {
    let file = Path::new(path);
    let meta = std::fs::symlink_metadata(file).map_err(|e| format!("{path}: {e}"))?;
    if !meta.file_type().is_file() {
        return Err(format!("{path}: not a regular file"));
    }
    let dir = file.parent().ok_or_else(|| format!("{path}: no directory"))?;
    let dir_meta = std::fs::metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    trusted_modes(meta.uid(), meta.mode(), dir_meta.uid(), dir_meta.mode())
        .map_err(|reason| format!("{path}: {reason}"))?;
    std::fs::read(file).map_err(|e| format!("{path}: {e}"))
}

/// The operator's envelope grant file, written by the installer's `grant`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant {
    version: u32,
    executor_policy_digest: String,
}

/// The granted digest and, for a present grant that is not accepted, why.
/// An absent file is no grant and no refusal.
pub fn grant_status(path: Option<&str>, policy_digest: &str) -> (Option<String>, Option<String>) {
    let Some(path) = path else { return (None, None) };
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (None, None),
        _ => {}
    }
    let bytes = match read_trusted(path) {
        Ok(bytes) => bytes,
        Err(reason) => return (None, Some(reason)),
    };
    match serde_json::from_slice::<Grant>(&bytes) {
        Ok(grant) if grant.version != 1 => (None, Some("grant has an unknown version".into())),
        Ok(grant) if grant.executor_policy_digest != policy_digest => {
            (None, Some("grant names another executor policy".into()))
        }
        Ok(grant) => (Some(grant.executor_policy_digest), None),
        Err(_) => (None, Some("grant is malformed".into())),
    }
}

/// The policy file's `identity.digest`, which must equal the plan's.
pub fn policy_digest(policy: &serde_json::Value) -> Option<&str> {
    policy.get("identity")?.get("digest")?.as_str()
}

/// A fresh instance id: 16 random bytes as hex.
pub fn new_instance() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("/dev/urandom: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// An exec request's binding is absent, or names this instance.
pub fn binding_matches(binding: Option<&str>, instance: &str) -> bool {
    binding.is_none_or(|b| b == instance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_passes_only_when_both_attempts_are_refused() {
        assert!(probe_verdict(r#"{"connect":"ENETUNREACH","write":"EROFS"}"#).0);
        assert!(probe_verdict(r#"{"connect":"EHOSTUNREACH","write":"EACCES"}"#).0);
        assert!(!probe_verdict(r#"{"connect":"connected","write":"EROFS"}"#).0);
        assert!(!probe_verdict(r#"{"connect":"timeout","write":"EROFS"}"#).0);
        assert!(!probe_verdict(r#"{"connect":"ENETUNREACH","write":"written"}"#).0);
        assert!(!probe_verdict(r#"{"connect":"ENETUNREACH","write":"ENOENT"}"#).0);
        assert!(!probe_verdict(r#"{"write":"EROFS"}"#).0);
        assert_eq!(probe_verdict("node: not found"), (false, "none".into(), "none".into()));
    }

    #[test]
    fn trusts_only_root_owned_files_in_root_owned_directories() {
        assert!(trusted_modes(0, 0o100644, 0, 0o40755).is_ok());
        assert!(trusted_modes(1001, 0o100644, 0, 0o40755).is_err(), "runtime-owned file");
        assert!(trusted_modes(0, 0o100664, 0, 0o40755).is_err(), "group-writable file");
        assert!(trusted_modes(0, 0o100646, 0, 0o40755).is_err(), "world-writable file");
        assert!(trusted_modes(0, 0o100644, 1001, 0o40755).is_err(), "runtime-owned directory");
        assert!(trusted_modes(0, 0o100644, 0, 0o40775).is_err(), "group-writable directory");
    }

    #[test]
    fn a_runtime_writable_grant_is_refused() {
        // A file this test user owns stands in for one the runtime could
        // write; the check is the same.
        let dir = std::env::temp_dir().join(format!("dyfj-grant-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("envelope-grant.json");
        std::fs::write(&path, r#"{"version":1,"executorPolicyDigest":"sha256:aa"}"#).unwrap();
        let (granted, refusal) = grant_status(path.to_str(), "sha256:aa");
        std::fs::remove_dir_all(&dir).unwrap();
        // Root owns nothing in the test's temporary directory, unless the
        // test itself runs as root.
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(granted, None);
            assert!(refusal.unwrap().contains("owned by root"));
        }
    }

    #[test]
    fn an_absent_grant_is_no_grant_and_no_refusal() {
        assert_eq!(grant_status(None, "sha256:aa"), (None, None));
        assert_eq!(grant_status(Some("/nonexistent/dyfj/grant.json"), "sha256:aa"), (None, None));
    }

    #[test]
    fn reads_the_policy_digest() {
        let policy = serde_json::json!({ "identity": { "digest": "sha256:ab" } });
        assert_eq!(policy_digest(&policy), Some("sha256:ab"));
        assert_eq!(policy_digest(&serde_json::json!({})), None);
    }

    #[test]
    fn makes_fresh_instances() {
        let (a, b) = (new_instance().unwrap(), new_instance().unwrap());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn a_binding_must_name_this_instance() {
        assert!(binding_matches(None, "abc"));
        assert!(binding_matches(Some("abc"), "abc"));
        assert!(!binding_matches(Some("abd"), "abc"));
    }
}
