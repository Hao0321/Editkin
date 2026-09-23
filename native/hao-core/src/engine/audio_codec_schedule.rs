//! Sample-addressed catalog traversal. Catalog size is not decoder concurrency.
use std::collections::BTreeSet;

pub const MAX_CATALOG: usize = 4096;
pub const MAX_ACTIVE: usize = 16;
pub struct Segment {
    pub from: u64,
    pub to: u64,
    pub sources: Vec<usize>,
}
pub struct Schedule {
    ranges: Vec<(u64, u64)>,
    pending: Vec<usize>,
    next: usize,
    active: BTreeSet<usize>,
    position: u64,
    end: u64,
    pub peak_active: usize,
}
impl Schedule {
    pub fn new(ranges: Vec<(u64, u64)>, start: u64, end: u64) -> Result<Self, String> {
        if ranges.len() > MAX_CATALOG || start >= end || ranges.iter().any(|(a, b)| a >= b) {
            return Err("codec catalog ranges invalid".into());
        }
        let mut edges = ranges
            .iter()
            .flat_map(|&(a, b)| [(a, 1_i32), (b, -1)])
            .collect::<Vec<_>>();
        edges.sort_unstable(); // End before start at a shared boundary: half-open ranges.
        let mut count = 0;
        for (_, delta) in edges {
            count += delta;
            if count > MAX_ACTIVE as i32 {
                return Err("codec simultaneous source limit exceeded (16)".into());
            }
        }
        let mut pending = (0..ranges.len())
            .filter(|&i| ranges[i].0 < end && ranges[i].1 > start)
            .collect::<Vec<_>>();
        pending.sort_by_key(|&i| (ranges[i].0.max(start), i));
        Ok(Self {
            ranges,
            pending,
            next: 0,
            active: BTreeSet::new(),
            position: start,
            end,
            peak_active: 0,
        })
    }
    pub fn next_segment(&mut self, until: u64) -> Result<Option<Segment>, String> {
        if until < self.position || until > self.end {
            return Err("codec catalog traversal is not monotonic".into());
        }
        if until == self.position {
            return Ok(None);
        }
        self.active.retain(|&i| self.ranges[i].1 > self.position);
        while self.next < self.pending.len()
            && self.ranges[self.pending[self.next]].0 <= self.position
        {
            self.active.insert(self.pending[self.next]);
            self.next += 1;
        }
        if self.active.len() > MAX_ACTIVE {
            return Err("codec active set overflow".into());
        }
        self.peak_active = self.peak_active.max(self.active.len());
        let mut to = until;
        if self.next < self.pending.len() {
            to = to.min(self.ranges[self.pending[self.next]].0);
        }
        for &i in &self.active {
            to = to.min(self.ranges[i].1);
        }
        if to <= self.position {
            return Err("codec catalog made no progress".into());
        }
        let segment = Segment {
            from: self.position,
            to,
            sources: self.active.iter().copied().collect(),
        };
        self.position = to;
        Ok(Some(segment))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thousands_of_adjacent_clips_are_one_active_source() {
        let mut schedule =
            Schedule::new((0..4096).map(|n| (n * 2, n * 2 + 2)).collect(), 0, 8192).unwrap();
        let mut seen = Vec::new();
        for until in [2048, 4096, 6144, 8192] {
            while let Some(s) = schedule.next_segment(until).unwrap() {
                assert_eq!(s.to - s.from, 2);
                assert_eq!(s.sources.len(), 1);
                seen.push(s.sources[0]);
            }
        }
        assert_eq!(seen, (0..4096).collect::<Vec<_>>());
        assert_eq!(schedule.peak_active, 1);
    }
    #[test]
    fn overlap_bounds_empty_gaps_and_mid_clip_start() {
        assert!(Schedule::new(vec![(0, 100); 17], 0, 100).is_err());
        assert!(Schedule::new(vec![(0, 100); 16], 0, 100).is_ok());
        let mut schedule = Schedule::new(vec![(0, 10), (20, 30), (25, 40)], 5, 50).unwrap();
        let mut got = Vec::new();
        while let Some(s) = schedule.next_segment(50).unwrap() {
            got.push((s.from, s.to, s.sources));
        }
        assert_eq!(
            got,
            vec![
                (5, 10, vec![0]),
                (10, 20, vec![]),
                (20, 25, vec![1]),
                (25, 30, vec![1, 2]),
                (30, 40, vec![2]),
                (40, 50, vec![])
            ]
        );
        assert_eq!(schedule.peak_active, 2);
        assert!(schedule.next_segment(49).is_err());
        assert!(schedule.next_segment(51).is_err());
    }
}
