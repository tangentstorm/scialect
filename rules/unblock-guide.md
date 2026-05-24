# Blocker Triage Guide for Managers

This document defines the instructions you **must** follow when triaging a blocked worker (`tell-worker unblock`).

---

## 1. Triage Objectives
Your goal is to inspect the worker's blocker report and help them resume work by providing a local scaffolding solution or workaround.

---

## 2. Step-by-Step Triage Procedure
1.  **Read Blocker Triage Report**: Locate the triage report at the bottom of the worker's `.sci/task.md`. Understand the exact compiler error or cross-group gate.
2.  **Evaluate Block Validity**:
    *   *If Gated by Upstream*: Check if the target theorem is waiting for a lower-layer Group (e.g. Group 4 waiting for Group 1).
    *   *If Lean Compiler Error*: Verify if there is a universe level mismatch or typeclass elaboration panic.
3.  **Formulate Workaround**:
    *   If missing Mathlib features block them, **instruct them to build a local helper lemma** (local infrastructure) in their own directory.
    *   If gated by upstream, construct a narrow, mock, or intermediate helper stub to decouple them, or re-route the proof.

---

## 3. Decision & Status Reporting
Once you have formulated a resolution, write it as clear constructive feedback in their `task.md` (or output it in your response) and set your **own** `.sci/status-line` to:

*   **`REVIEWED: UNBLOCKED [worker]`**
    *   *Action*: Signals the orchestrator that the blocker is triaged, the worker is unblocked, and resets you to `IDLE`.
