//! The executor lease: executors run only while their runtime does. When the
//! runtime exits the lease expires, every running executor is handed back to
//! be killed, and no new one is admitted.

use std::collections::BTreeSet;

#[derive(Debug, Default)]
pub struct Lease {
    expired: bool,
    executors: BTreeSet<i32>,
}

impl Lease {
    /// Records a started executor. False once the lease has expired, and the
    /// caller must kill the executor it just started.
    pub fn admit(&mut self, pid: i32) -> bool {
        if self.expired {
            return false;
        }
        self.executors.insert(pid);
        true
    }

    pub fn release(&mut self, pid: i32) {
        self.executors.remove(&pid);
    }

    pub fn is_live(&self) -> bool {
        !self.expired
    }

    /// Ends the lease and returns the executors still running.
    pub fn expire(&mut self) -> Vec<i32> {
        self.expired = true;
        std::mem::take(&mut self.executors).into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_returns_the_running_executors_once() {
        let mut lease = Lease::default();
        assert!(lease.admit(10));
        assert!(lease.admit(11));
        lease.release(10);
        assert_eq!(lease.expire(), vec![11]);
        assert_eq!(lease.expire(), Vec::<i32>::new());
    }

    #[test]
    fn admits_nothing_after_expiry() {
        let mut lease = Lease::default();
        assert!(lease.is_live());
        lease.expire();
        assert!(!lease.is_live());
        assert!(!lease.admit(12));
        assert_eq!(lease.expire(), Vec::<i32>::new());
    }
}
