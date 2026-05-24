# Task Adjustment Guide for Workers

This document defines the instructions you **must** follow when adjusting your proposed task plan (`tell-worker adjust`).

---

## 1. Adjustment Objectives
The manager has rejected your proposed next task plan in `task.md` with specific feedback (e.g. the step was scoped too broadly, skipped necessary stubs, or was misaligned with the milestones). Your objective is to rewrite `task.md` to address all of the manager's concerns.

---

## 2. Step-by-Step Adjustment Procedure
1.  **Read Manager Feedback**: Locate the manager's review comments (usually appended to `.sci/task.md` or found in recent review results).
2.  **Scope Down**: Scale down your task plan. Break the milestone into smaller, more granular stubs.
3.  **Rewrite task.md**: Overwrite `.sci/task.md` with the adjusted, tightly scoped step (leaving all checklists unchecked `[ ]`).

---

## 3. Status Reporting
Once the task is adjusted and saved, set your status-line in `.sci/status-line` to:

*   **`SUGGEST: [proposed_task]`**
    *   *Action*: Signals the orchestrator that you have resubmitted your task plan, and triggers the manager to review the adjustment (`tell-worker approve-task`).
