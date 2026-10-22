//! A bound on the transport requests the supervisor serves at once: at most
//! the limit, each also bounded by the supervisor's request, command and
//! reply deadlines. A connection past the bound is closed unread.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Debug)]
pub struct Gate {
    active: Arc<AtomicUsize>,
    limit: usize,
}

/// Held while a request is served; dropping it frees the place.
#[derive(Debug)]
pub struct Pass(Arc<AtomicUsize>);

impl Drop for Pass {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Gate {
    pub fn new(limit: usize) -> Gate {
        Gate { active: Arc::new(AtomicUsize::new(0)), limit }
    }

    /// A pass, or None when `limit` requests are already in flight.
    pub fn enter(&self) -> Option<Pass> {
        if self.active.fetch_add(1, Ordering::SeqCst) >= self.limit {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Pass(Arc::clone(&self.active)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_up_to_the_limit_and_refuses_the_next() {
        let gate = Gate::new(2);
        let a = gate.enter();
        let b = gate.enter();
        assert!(a.is_some() && b.is_some());
        assert!(gate.enter().is_none());
    }

    #[test]
    fn frees_a_place_when_a_pass_is_dropped() {
        let gate = Gate::new(1);
        let pass = gate.enter();
        assert!(gate.enter().is_none());
        drop(pass);
        assert!(gate.enter().is_some());
    }

    #[test]
    fn a_refusal_takes_no_place() {
        let gate = Gate::new(1);
        let _pass = gate.enter();
        for _ in 0..10 {
            assert!(gate.enter().is_none());
        }
        drop(_pass);
        assert!(gate.enter().is_some());
    }
}
