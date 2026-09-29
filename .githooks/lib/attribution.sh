# Shared by the commit-msg and pre-push hooks: recognizes AI-tool identities
# and tool-attribution message lines. Sourced, not executed.
#
# Identities are matched exactly, by known tool name or address, so a person
# whose name merely contains a tool's name is never mistaken for one.

# tool_identity "Name <email>": succeeds when the identity is an AI tool's.
tool_identity() {
  ti_ident=$(printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]')
  ti_name=$(printf '%s\n' "$ti_ident" |
    sed -e 's/[[:space:]]*<.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  ti_email=$(printf '%s\n' "$ti_ident" | sed -n 's/^[^<]*<\([^>]*\)>.*$/\1/p')
  case $ti_name in
    claude | "cursor agent" | composer | copilot) return 0 ;;
  esac
  # Addresses are compared as local part and domain; the tree's public-safety
  # scan admits only reserved-domain addresses written out whole.
  case $ti_email in
    *@*) ;;
    *) return 1 ;;
  esac
  ti_local=${ti_email%@*}
  ti_domain=${ti_email##*@}
  case "$ti_domain $ti_local" in
    "anthropic.com noreply" | "cursor.com cursoragent") return 0 ;;
    "users.noreply.github.com "*+copilot) return 0 ;;
  esac
  return 1
}

# attribution_line LINE: succeeds when a message line is tool attribution: a
# Co-authored-by trailer naming a tool identity, a Claude-Session trailer, or
# a "Generated with/by Claude Code" footer.
attribution_line() {
  al_lower=$(printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]')
  case $al_lower in
    co-authored-by:*)
      tool_identity "${1#*:}"
      return
      ;;
    claude-session:*) return 0 ;;
  esac
  printf '%s\n' "$al_lower" | grep -Eq '^[^[:alnum:]]*generated (with|by) \[?claude code'
}

# ident_without_date "Name <email> 1700000000 +0000": drops git's timestamp.
ident_without_date() {
  printf '%s\n' "$1" | sed 's/ [0-9][0-9]* [-+][0-9][0-9]*$//'
}
