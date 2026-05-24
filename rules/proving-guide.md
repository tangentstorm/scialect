# Proving & Planning Guide for Workers

This document defines the standards and rules you **must** follow when working as an agent in the JacobianChallenge project.

---

## 1. Two Operational Modes

### A. Proving Mode (Coding a Task)
When you are assigned a code task in `task.md`, your status is `WORKING`. You must:
1.  Develop the exact proof/definition in the target Lean file.
2.  Follow the **scaffolding strategy** (no general math theory, narrow local stubs).
3.  Run the narrowest target build: `lake build Jacobian.Layer.File`.
4.  Run `lake build Jacobian.Solution` to verify no warnings except "uses sorry" were introduced.
5.  Commit your changes using your primary committer identity and appropriate `Co-authored-by` credits (see `/rules/commit-guide.md`).
6.  Once committed, set your status-line in `.sci/status-line` to `READY: [commit_description]` to alert the manager (`mgr`) for code review.

### B. Planning Mode (Proposing the Next Task)
When you are notified of an acceptance (`tell-worker accept`), your status is `WORKING: plan next step`. You must:
1.  Re-read `plan.md` and check off completed milestones.
2.  Formulate **exactly one** new commit-sized step representing the next logical milestone.
3.  Write this new step into `.sci/task.md` (unchecking all checkboxes).
4.  Once the task is drafted, set your status-line in `.sci/status-line` to `SUGGEST: [proposed_task]` to request task plan approval from the manager.

---

## 2. Verification Discipline
You must only claim a task is complete (marking it `READY:`) when:
*   `lake build Jacobian.Solution` succeeds with no disallowed linter/compiler warnings.
*   The relevant sorries have been substantively reduced (either proved or replaced by strictly narrower, named providers).

---

## 3. Status Reporting
You must update `.sci/status-line` (and the first line of `task.md`) using exactly one of the following formats:
*   `WORKING: [step]` — Actively proving the code task.
*   `WORKING: plan next step` — Actively drafting the next task plan in `task.md`.
*   `READY: [step]` — Completed coding the task, committed, ready for review.
*   `SUGGEST: [task]` — Completed drafting the task plan in `task.md`, ready for approval.
*   `BLOCKED: [reason]` — Stuck on a compiler error or cross-group gating. Append a Detailed Triage Report.

---

## 4. The Unblocking Protocol
If a prerequisite lemma, topological instance, or algebraic structure is missing from Mathlib, **you are NOT blocked**:
1.  **Build Local Infrastructure**: You must define and prove that missing infrastructure yourself as a local, sorry-free helper lemma in your assigned directory.
2.  **Exhaust Local Primitives**: Compose simpler Mathlib facts or basic metric topology properties.
3.  **Valid Block Criteria**: Only set `BLOCKED: Gated on Group X` or `BLOCKED: Lean Compiler Error`. You must append a **Detailed Blocker Triage Report** to the bottom of `task.md` explaining the blocker.
