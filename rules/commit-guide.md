# Git Commit and Crediting Guide

To acknowledge contributions from AI assistants and other automated workers, use `Co-authored-by:` trailers at the **very bottom of the commit message**, separated from the body by a blank line.

## Normalized Identity Mappings

The following exact spellings and email addresses must be used for agent credits:

| Agent / Persona | Normalized Co-authored-by Trailer |
| :--- | :--- |
| **Gemini** (Antigravity, Gemini CLI, etc.) | `Co-authored-by: Gemini <gemini@google.com>` |
| **Claude** (Claude Opus, sub-agents, etc.) | `Co-authored-by: Claude <claude@anthropic.com>` |
| **Codex** (OpenAI Codex, etc.) | `Co-authored-by: Codex <codex@openai.com>` |
| **GitHub** (noreply@github.com) | `Co-authored-by: GitHub <noreply@github.com>` |
| **Aristotle** (Aristotle Lean Worker, etc.) | `Co-authored-by: Aristotle (Harmonic) <aristotle-harmonic@harmonic.fun>` |
| **Grok** (Grok xAI, etc.) | `Co-authored-by: Grok <grok@x.ai>` |

## Rules for Co-Authorship

1.  **Formatting**: The trailer must be in the exact format: `Co-authored-by: Name <email>` (case-sensitive and no leading/trailing spaces around name and email).
2.  **Deterministic Ordering**: If a commit has multiple co-authors, they should be sorted alphabetically by name.
3.  **Separation**: Always leave exactly one blank line between the commit message body and the start of the `Co-authored-by:` trailer(s).

## Example Commit Message
```text
feat(ComplexTorus): prove quotientLieAddGroup_witness is sorry-free

State and prove quotientLieAddGroup_witness by showing that the translation 
action on the vector space preserves the lattice boundaries.

Co-authored-by: Aristotle (Harmonic) <aristotle-harmonic@harmonic.fun>
Co-authored-by: Gemini <gemini@google.com>
```
