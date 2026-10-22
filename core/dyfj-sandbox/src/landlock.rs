//! The Landlock floor: the plan's read, write and execute path sets, applied
//! to this process before it starts the role's command. Every filesystem
//! access the kernel's ABI can handle is handled, so a path not listed for a
//! right is denied it. ABI 3 (truncation) is the minimum: below it a file that
//! is only readable could still be truncated, and the floor is refused rather
//! than weakened.

use crate::plan::LandlockPaths;
use std::collections::BTreeMap;

pub const MIN_ABI: i32 = 3;

pub const EXECUTE: u64 = 1 << 0;
pub const WRITE_FILE: u64 = 1 << 1;
pub const READ_FILE: u64 = 1 << 2;
pub const READ_DIR: u64 = 1 << 3;
pub const REMOVE_DIR: u64 = 1 << 4;
pub const REMOVE_FILE: u64 = 1 << 5;
pub const MAKE_CHAR: u64 = 1 << 6;
pub const MAKE_DIR: u64 = 1 << 7;
pub const MAKE_REG: u64 = 1 << 8;
pub const MAKE_SOCK: u64 = 1 << 9;
pub const MAKE_FIFO: u64 = 1 << 10;
pub const MAKE_BLOCK: u64 = 1 << 11;
pub const MAKE_SYM: u64 = 1 << 12;
pub const REFER: u64 = 1 << 13;
pub const TRUNCATE: u64 = 1 << 14;
pub const IOCTL_DEV: u64 = 1 << 15;

/// The rights that apply to a file rather than a directory.
pub const FILE_RIGHTS: u64 = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV;

/// Every access the kernel at `abi` can handle.
pub fn handled(abi: i32) -> u64 {
    let mut mask = (MAKE_SYM << 1) - 1;
    if abi >= 2 {
        mask |= REFER;
    }
    if abi >= 3 {
        mask |= TRUNCATE;
    }
    if abi >= 5 {
        mask |= IOCTL_DEV;
    }
    mask
}

const READ: u64 = READ_FILE | READ_DIR;
const WRITE: u64 = WRITE_FILE
    | REMOVE_DIR
    | REMOVE_FILE
    | MAKE_CHAR
    | MAKE_DIR
    | MAKE_REG
    | MAKE_SOCK
    | MAKE_FIFO
    | MAKE_BLOCK
    | MAKE_SYM
    | REFER
    | TRUNCATE
    | IOCTL_DEV;

/// The access each listed path is granted at `abi`, merged across the three
/// sets, or a refusal.
pub fn path_rights(paths: &LandlockPaths, abi: i32) -> Result<BTreeMap<String, u64>, String> {
    if abi < MIN_ABI {
        return Err(format!("Landlock ABI {abi} is below the required {MIN_ABI}"));
    }
    let mask = handled(abi);
    let mut rights: BTreeMap<String, u64> = BTreeMap::new();
    for (set, grant) in [(&paths.read, READ), (&paths.write, WRITE), (&paths.execute, EXECUTE)] {
        for path in set {
            if !path.starts_with('/') {
                return Err("Landlock path is not absolute".into());
            }
            *rights.entry(path.clone()).or_default() |= grant & mask;
        }
    }
    Ok(rights)
}

#[cfg(target_os = "linux")]
mod sys {
    use std::ffi::CString;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }

    #[repr(C, packed)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    const CREATE_RULESET_VERSION: u32 = 1;
    const RULE_PATH_BENEATH: u32 = 1;

    pub fn abi() -> io::Result<i32> {
        // SAFETY: a version query passes no attribute and no file descriptor.
        let v = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<RulesetAttr>(),
                0usize,
                CREATE_RULESET_VERSION,
            )
        };
        if v < 0 { Err(io::Error::last_os_error()) } else { Ok(v as i32) }
    }

    pub fn restrict(handled: u64, rights: &[(String, u64)]) -> io::Result<()> {
        let attr = RulesetAttr { handled_access_fs: handled };
        // SAFETY: attr is a valid ruleset attribute of the size passed.
        let fd = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr as *const RulesetAttr,
                std::mem::size_of::<RulesetAttr>(),
                0u32,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the kernel returned a new descriptor that this owns.
        let ruleset = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        for (path, access) in rights {
            let c = CString::new(path.as_bytes())
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path has a NUL"))?;
            // SAFETY: c is a valid C string.
            let raw = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
            if raw < 0 {
                let error = io::Error::last_os_error();
                return Err(io::Error::new(error.kind(), format!("{path}: {error}")));
            }
            // SAFETY: open returned a new descriptor that this owns.
            let parent = unsafe { OwnedFd::from_raw_fd(raw) };
            // SAFETY: an all-zero stat is a valid out buffer for fstat.
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: parent is open and stat is a valid buffer.
            if unsafe { libc::fstat(parent.as_raw_fd(), &mut stat) } < 0 {
                return Err(io::Error::last_os_error());
            }
            let is_dir = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
            let allowed = if is_dir { *access } else { access & super::FILE_RIGHTS };
            let beneath = PathBeneathAttr { allowed_access: allowed, parent_fd: parent.as_raw_fd() };
            // SAFETY: beneath is a valid rule attribute; ruleset is open.
            let added = unsafe {
                libc::syscall(
                    libc::SYS_landlock_add_rule,
                    ruleset.as_raw_fd(),
                    RULE_PATH_BENEATH,
                    &beneath as *const PathBeneathAttr,
                    0u32,
                )
            };
            if added < 0 {
                let error = io::Error::last_os_error();
                return Err(io::Error::new(error.kind(), format!("{path}: {error}")));
            }
        }
        // SAFETY: plain prctl; restrict_self requires no_new_privs.
        if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: ruleset is open.
        if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset.as_raw_fd(), 0u32) } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Applies `paths` to this process and every process it later starts.
#[cfg(target_os = "linux")]
pub fn apply(paths: &LandlockPaths) -> Result<i32, String> {
    let abi = sys::abi().map_err(|e| format!("Landlock is unavailable: {e}"))?;
    let rights = path_rights(paths, abi)?;
    let rights: Vec<(String, u64)> = rights.into_iter().collect();
    sys::restrict(handled(abi), &rights).map_err(|e| format!("Landlock refused the ruleset: {e}"))?;
    Ok(abi)
}

#[cfg(target_os = "linux")]
pub fn abi() -> Result<i32, String> {
    sys::abi().map_err(|e| format!("Landlock is unavailable: {e}"))
}

#[cfg(not(target_os = "linux"))]
pub fn apply(_paths: &LandlockPaths) -> Result<i32, String> {
    Err("Landlock exists only on Linux".into())
}

#[cfg(not(target_os = "linux"))]
pub fn abi() -> Result<i32, String> {
    Err("Landlock exists only on Linux".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(read: &[&str], write: &[&str], execute: &[&str]) -> LandlockPaths {
        let v = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
        LandlockPaths { read: v(read), write: v(write), execute: v(execute) }
    }

    #[test]
    fn refuses_an_abi_without_truncation() {
        assert!(path_rights(&paths(&["/usr"], &[], &[]), 2).is_err());
    }

    #[test]
    fn merges_the_sets_per_path() {
        let rights =
            path_rights(&paths(&["/usr", "/w"], &["/w"], &["/usr"]), 10).unwrap();
        assert_eq!(rights["/usr"], READ_FILE | READ_DIR | EXECUTE);
        assert_eq!(rights["/w"] & (WRITE_FILE | TRUNCATE | READ_FILE), WRITE_FILE | TRUNCATE | READ_FILE);
        assert_eq!(rights["/w"] & EXECUTE, 0);
    }

    #[test]
    fn grants_only_what_the_abi_handles() {
        let rights = path_rights(&paths(&[], &["/w"], &[]), 3).unwrap();
        assert_eq!(rights["/w"] & IOCTL_DEV, 0);
        assert_ne!(rights["/w"] & TRUNCATE, 0);
    }

    #[test]
    fn handles_every_access_of_the_abi() {
        assert_eq!(handled(1), 0x1fff);
        assert_eq!(handled(3), 0x7fff);
        assert_eq!(handled(10), 0xffff);
    }

    #[test]
    fn refuses_a_relative_path() {
        assert!(path_rights(&paths(&["usr"], &[], &[]), 10).is_err());
    }
}
