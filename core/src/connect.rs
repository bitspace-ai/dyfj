//! MySQL connect options for the Dolt store.
//!
//! sqlx 0.9 sends `SET NAMES utf8mb4` when no collation is configured, and
//! lets the server pick the collation. sqlx 0.8 sent
//! `SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci` for that same default
//! charset. [`connect_options`] restores that collation unless the URL
//! already names one, or names a different charset (whose sqlx 0.8 default
//! collation is not reimplemented here).

use sqlx::mysql::MySqlConnectOptions;

use crate::error::Result;

/// Collation sqlx 0.8 applied for charset `utf8mb4` when none was configured.
const SQLX_08_UTF8MB4_COLLATION: &str = "utf8mb4_unicode_ci";

/// Parse `database_url` and keep the session collation sqlx 0.8 used for the
/// default charset. MySQL treats charset names case-insensitively, so the
/// charset is compared that way.
pub fn connect_options(database_url: &str) -> Result<MySqlConnectOptions> {
    let options: MySqlConnectOptions = database_url.parse()?;
    if options.get_collation().is_none() && options.get_charset().eq_ignore_ascii_case("utf8mb4") {
        Ok(options.collation(SQLX_08_UTF8MB4_COLLATION))
    } else {
        Ok(options)
    }
}

#[cfg(test)]
mod tests {
    use super::connect_options;

    #[test]
    fn restores_the_previous_default_collation_for_utf8mb4() {
        let options =
            connect_options("mysql://root@127.0.0.1:3306/dolt").expect("example URL must parse");
        assert_eq!(options.get_charset(), "utf8mb4");
        assert_eq!(options.get_collation(), Some("utf8mb4_unicode_ci"));
    }

    #[test]
    fn treats_the_default_charset_name_case_insensitively() {
        let options = connect_options("mysql://root@127.0.0.1:3306/dolt?charset=UTF8MB4")
            .expect("example URL must parse");
        assert_eq!(options.get_collation(), Some("utf8mb4_unicode_ci"));
    }

    #[test]
    fn keeps_a_collation_the_url_already_sets() {
        let options = connect_options("mysql://root@127.0.0.1:3306/dolt?collation=utf8mb4_bin")
            .expect("example URL must parse");
        assert_eq!(options.get_collation(), Some("utf8mb4_bin"));
    }

    #[test]
    fn leaves_another_charset_without_inventing_a_collation() {
        let options = connect_options("mysql://root@127.0.0.1:3306/dolt?charset=latin1")
            .expect("example URL must parse");
        assert_eq!(options.get_charset(), "latin1");
        assert_eq!(options.get_collation(), None);
    }
}
