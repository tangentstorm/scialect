# Code Review Guide for Managers

This document defines the standards and instructions you **must** follow when reviewing a worker's completed code task (`tell-worker review`).

---

## 1. Review Objectives
Your goal is to inspect the worker's changes and make a deterministic quality decision:
1.  **Mathematical Correctness**: Ensure the proof/definition is honest and mathematically sound. No trivializing axioms or cheat stubs.
2.  **Compilation**: Verify that the branch compiles cleanly without warnings (except the permitted `declaration uses 'sorry'` warnings).
3.  **Scoped Commits**: Confirm that the worker made exactly one commit representing this step, using normalized committer credentials and co-author credits (e.g. `Co-authored-by: Aristotle (Harmonic)`).

---

## 2. Step-by-Step Review Procedure
1.  **Navigate & Inspect Diff**: Change directory to the worker's project directory (provided in your prompt). Read `.sci/task.md` and `.sci/goal.md` to see what was assigned. Explicitly verify that a commit exists (e.g., via `git log`), and inspect the changes using `git diff main..HEAD` to audit the code changes.
2.  **Verify Build**: Confirm that the target builds cleanly by running `lake build` on the worker's narrow target.
3.  **Check Axioms**: Optionally run `#print axioms <lemma>` to ensure the worker hasn't sneaked in unauthorized stubs.

---

## 3. Decision & Status Reporting
Once your review is complete, you must write a brief review summary to `.sci/result.md` (or output it in your chat response) and set your **own** `.sci/status-line` to exactly one of the following:

*   **`REVIEWED: ACCEPT [worker]`**
    *   *When*: The code is correct, compiles cleanly, and is committed correctly.
    *   *Action*: Signals the orchestrator to merge the commits, notify the worker to enter planning mode (`tell-worker accept`), and reset you to `IDLE`.
*   **`REVIEWED: REJECT [worker]`**
    *   *When*: The code fails to compile, has unwanted stubs, lacks credits, or is incorrect.
    *   *Action*: Signals the orchestrator to roll back the branch, notify the worker of the rejection with feedback, and reset you to `IDLE`.
