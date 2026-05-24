# Swarm State Machine & Collaborative Protocol

This document defines the formal state machine and collaborative software engineering protocol used by the `scialect` orchestrator and the multi-agent worker swarm.

---

## 1. State Machine Diagram

```mermaid
stateDiagram-v2
    [*] --> IDLE : Initial State
    IDLE --> ASSIGNED : Orchestrator prepares goal & task
    ASSIGNED --> WORKING : Worker starts coding ('tell-worker assigned')
    WORKING --> READY : Worker completes code & commits
    
    state "Code Review Loop" as CodeReview {
        READY --> REVIEWING_CODE : Run 'tell-worker review'
        REVIEWING_CODE --> REVIEWED_DECISION : Mgr completes review
    }
    
    state "Decision Action" as DecisionBranch {
        REVIEWED_DECISION --> ACCEPTED : DECISION is ACCEPT
        REVIEWED_DECISION --> REJECTED : DECISION is REJECT
    }

    REJECTED --> WORKING : Worker restarts task (Rollback branch & reset task.md)
    
    state "Planning Loop" as PlanningLoop {
        ACCEPTED --> WORKING_PLAN : Run 'tell-worker accept' (Worker enters planning mode)
        WORKING_PLAN --> SUGGEST : Worker completes task plan in task.md
        SUGGEST --> REVIEWING_PLAN : Run 'tell-worker approve-task'
        REVIEWING_PLAN --> REVIEWED_PLAN_DECISION : Mgr completes task plan review
    }
    
    state "Plan Decision Action" as PlanDecisionBranch {
        REVIEWED_PLAN_DECISION --> APPROVED : DECISION is ACCEPT
        REVIEWED_PLAN_DECISION --> ADJUSTED : DECISION is ADJUST
    }

    APPROVED --> WORKING : Worker starts coding next task
    ADJUSTED --> ADJUSTING : Run 'tell-worker adjust' (Worker rewrites plan)
    ADJUSTING --> SUGGEST : Worker resubmits adjusted plan
    
    state "Blocker Triage" as BlockerTriage {
        WORKING --> BLOCKED : Worker hits compiler or gating block
        BLOCKED --> TRIAGING : Run 'tell-worker unblock'
        TRIAGING --> UNBLOCKED : Mgr provides workaround / local stubs
    }
    
    UNBLOCKED --> WORKING : Worker resumes coding with stubs
```

---

## 2. Worker Status Specification

A worker reports its current state by writing exactly one line to `.sci/status-line` (and keeping the first line of `task.md` in sync) using the format `[STATUS]: [detail]`:

1.  **`IDLE: [detail]`**
    *   *Meaning*: The worker has no active goal and is waiting for an assignment.
2.  **`ASSIGNED: [goal_detail]`**
    *   *Meaning*: The manager or orchestrator has prepared a new overall `goal.md` and initial `task.md`, and is about to trigger the worker.
3.  **`WORKING: [current_step]`**
    *   *Meaning*: The worker is actively developing and proving the current commit-sized step in `task.md`, or is actively planning their next step.
4.  **`READY: [current_step]`**
    *   *Meaning*: The worker has completed the current `task.md` step, successfully run `lake build`, committed the changes, and is **ready for the manager (`mgr`) to review the code**.
5.  **`SUGGEST: [proposed_task]`**
    *   *Meaning*: The worker has completed the planning phase, written the proposed next step into `task.md`, and is **ready for the manager (`mgr`) to approve the new task plan**.
6.  **`BLOCKED: [reason]`**
    *   *Meaning*: The worker is genuinely blocked (cross-group gating or compiler/universe error) and has appended a triage report to the bottom of `task.md`.
7.  **`COMPLETE: [goal_description]`**
    *   *Meaning*: The worker has successfully completed their **entire `goal.md` module**, verified that the entire target builds with zero `sorry`s, and is completely done with their overall phase.

---

## 3. Manager (Reviewer) Status Specification

The manager (`mgr`) is an active participant in the workflow. Its own `.sci/status-line` is polled by the server to coordinate handoffs:

1.  **`IDLE: [detail]`**
    *   *Meaning*: The manager is ready for a new review, adjustment, or triage assignment.
2.  **`REVIEWING: [worker]`**
    *   *Meaning*: The manager is actively conducting a review of the target worker's task (either code review or plan approval).
3.  **`REVIEWED: [DECISION] [worker]`**
    *   *Meaning*: The manager has completed the review. The deterministic orchestrator server reads this status to know the exact judgement and execute the required action, before resetting the manager's status back to `IDLE`.
    *   *Possible Decisions*:
        *   `REVIEWED: ACCEPT [worker]` — Accept the work / plan, merge commits (if code), and transition worker to `WORKING`.
        *   `REVIEWED: ADJUST [worker]` — Task plan needs adjustments (worker transitions to `WORKING: adjust plan`).
        *   `REVIEWED: REJECT [worker]` — Worker must roll back their changes completely and start over (with a fresh `task.md` and new session).

---

## 4. Handoff Commands (`tell-worker`)

The orchestrator script `tell-worker` drives all worker/manager handoffs, copying version-controlled guides from `rules/` to `.sci/` during execution:

*   **`assigned`** (`tell-worker -- <worker> assigned`):
    *   *Prompt Guide*: `proving-guide.md`
    *   *Action*: Initial handoff of the goal and the first task to the worker. Transitions worker to `WORKING`.
*   **`review`** (`tell-worker -- mgr review <worker>`):
    *   *Prompt Guide*: `review-guide.md`
    *   *Action*: Assert `mgr` is `IDLE`. Transitions `mgr` to `REVIEWING: <worker>` and prompts the manager to review the worker's completed code.
*   **`accept`** (`tell-worker -- <worker> accept`):
    *   *Prompt Guide*: `proving-guide.md`
    *   *Action*: Prompts the accepted worker to enter planning mode, re-read `plan.md`, and write their next task plan to `task.md`. Transitions worker to `WORKING`.
*   **`approve-task`** (`tell-worker -- mgr approve-task <worker>`):
    *   *Prompt Guide*: `approve-task-guide.md`
    *   *Action*: Assert `mgr` is `IDLE`. Transitions `mgr` to `REVIEWING: <worker>` and prompts the manager to review/approve the proposed task plan in the worker's `task.md`.
*   **`adjust`** (`tell-worker -- <worker> adjust`):
    *   *Prompt Guide*: `adjust-guide.md`
    *   *Action*: Prompts the worker to adjust their proposed task plan in `task.md` based on manager feedback. Transitions worker to `WORKING`.
*   **`unblock`** (`tell-worker -- mgr unblock <worker>`):
    *   *Prompt Guide*: `unblock-guide.md`
    *   *Action*: Assert `mgr` is `IDLE`. Transitions `mgr` to `REVIEWING: <worker>` and prompts the manager to triage the blocker.
