# Task Plan Approval Guide for Managers

This document defines the instructions you **must** follow when reviewing and approving a worker's proposed next task plan (`tell-worker approve-task`).

---

## 1. Approval Objectives
Your goal is to inspect the worker's proposed next commit-sized step in `task.md` and ensure it maintains the project's velocity and structural soundness:
1.  **Milestone Alignment**: Verify that the proposed step corresponds to the next unchecked milestone in the worker's `.sci/plan.md`.
2.  **Scope Tightness**: Ensure the step is scoped strictly to **exactly one commit's worth of work** (proving a single lemma, writing a single coordinate chart, or completing a single step of a topology constructor). Reject any steps that attempt to solve a whole group's goals at once.
3.  **No Cheat Stubs**: Ensure the task does not introduce broad, hacky stubs or trivializing definitions.

---

## 2. Step-by-Step Approval Procedure
1.  **Navigate & Read Task Proposal**: Change directory to the **worker's** project directory (provided in your prompt). Once there, every bare `.sci/...` path below refers to the **worker's** `.sci/`. Locate the proposed next step at the top of the worker's `.sci/task.md` (under the `SUGGEST: ...` status).
2.  **Check `plan.md`**: Re-read the worker's `.sci/plan.md` to confirm this is the correct next logical milestone.
3.  **Evaluate Scope**: Confirm that the target file and target proof are precisely scoped.

---

## 3. Decision & Status Reporting
Once your plan review is complete, write a brief comment (in the worker's `.sci/task.md` or in your chat response) and set **your own** status-line — i.e. the `status-line` file in **your own** manager `.sci/` directory, NOT the worker's `.sci/status-line` — to exactly one of the following. (Use an absolute path to your own `.sci/status-line` so the `cd` into the worker's directory does not redirect the write.)

*   **`REVIEWED: ACCEPT [worker]`**
    *   *When*: The plan is precise, correctly scoped, and aligns with `plan.md`.
    *   *Action*: Signals the orchestrator to approve the plan, notify the worker to start coding (`tell-worker assigned`), and reset you to `IDLE`.
*   **`REVIEWED: ADJUST [worker]`**
    *   *When*: The plan is too broad, skips intermediate stubs, or is misaligned with `plan.md`.
    *   *Action*: Signals the orchestrator to notify the worker to rewrite their task plan (`tell-worker adjust`) with your specific feedback, and reset you to `IDLE`.
