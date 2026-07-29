mod inventory;
mod premise;
mod primary;
mod referee;

pub(super) const INVENTORY_SYSTEM: &str = inventory::SYSTEM;
pub(super) const PREMISE_SYSTEM: &str = premise::SYSTEM;
pub(super) const PRIMARY_SYSTEM: &str = primary::SYSTEM;
pub(super) const REFEREE_SYSTEM: &str = referee::SYSTEM;

#[cfg(test)]
mod tests {
    use super::{INVENTORY_SYSTEM, PREMISE_SYSTEM, PRIMARY_SYSTEM, REFEREE_SYSTEM};

    #[test]
    fn verification_prompts_preserve_untrusted_data_and_correction_boundaries() {
        assert!(PRIMARY_SYSTEM.contains("untrusted"));
        assert!(PRIMARY_SYSTEM.contains("corrected_answer"));
        assert!(INVENTORY_SYSTEM.contains("premise inventory"));
        assert!(PREMISE_SYSTEM.contains("proposition and quantifier"));
        assert!(REFEREE_SYSTEM.contains("general knowledge"));
    }
}
