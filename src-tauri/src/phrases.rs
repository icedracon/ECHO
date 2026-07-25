use rand::seq::SliceRandom;
use std::collections::HashMap;

// Compiled in so there is no runtime path to resolve, but still an editable
// file on disk. Swap the include path per character/level later.
const DANTE_LVL1: &str = include_str!("../phrases/dante_lvl1.json");

pub struct Phrases {
    pools: HashMap<String, Vec<String>>,
}

impl Phrases {
    pub fn load_default() -> Self {
        let pools: HashMap<String, Vec<String>> =
            serde_json::from_str(DANTE_LVL1).unwrap_or_default();
        Self { pools }
    }

    /// Random phrase for a state key ("thinking", "coding", ...), or None.
    pub fn pick(&self, key: &str) -> Option<String> {
        let pool = self.pools.get(key)?;
        pool.choose(&mut rand::thread_rng()).cloned()
    }
}
