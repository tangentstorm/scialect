# Swarm State Machine & Collaborative Protocol

This document defines the formal concurrent state machine and collaborative software engineering protocol used by the orchestrator and the multi-agent worker swarm.

---

## 1. Swarm State Diagram

The diagram below shows the parallel lifecycles of a Worker and the Coordinator, and highlights how the interactive `local-step` orchestrator coordinates tokens (state changes) between them:

```mermaid
stateDiagram-v2
    [*] --> Swarm
    state Swarm {
        state "Worker Lifecycle (Parallel Swarm)" as WorkerLifecycle {
            [*] --> IDLE : Initial State
            IDLE --> ASSIGNED : Goal/Task prepared
            ASSIGNED --> WORKING : Run local-step (Handoff assigned)
            
            WORKING --> READY : Code complete & committed (Proving Mode)
            WORKING --> SUGGEST : Next task plan drafted in task.md (Planning Mode)
            WORKING --> BLOCKED : Stuck on compiler or gating block
            
            READY --> AWAITING_REVIEW : Run local-step (worker -> AWAITING, coordinator -> REVIEWING)
            SUGGEST --> AWAITING_APPROVAL : Run local-step (worker -> AWAITING, coordinator -> REVIEWING)
            BLOCKED --> AWAITING_TRIAGE : Run local-step (worker -> AWAITING, coordinator -> REVIEWING)
            
            AWAITING_REVIEW --> WORKING_PLANNING : Coordinator accepts code (Run local-step / accept)
            AWAITING_APPROVAL --> WORKING : Coordinator approves task plan (Run local-step / accept)
            AWAITING_TRIAGE --> WORKING : Coordinator provides stubs / unblocks (Run local-step / accept)
            
            AWAITING_REVIEW --> WORKING : Coordinator rejects code (Reset to WORKING: starting task)
            AWAITING_APPROVAL --> WORKING_ADJUST : Coordinator requests adjustments (Run local-step / adjust)
            
            WORKING_PLANNING --> SUGGEST : Draft next step in task.md
            WORKING_ADJUST --> SUGGEST : Adjust plan in task.md
            
            WORKING --> COMPLETE : Entire goal.md module complete with 0 sorries
            COMPLETE --> [*]
        }
        --
        state "Coordinator Lifecycle (Sequential Gatekeeper)" as CoordinatorLifecycle {
            [*] --> IDLE : Ready for Review
            IDLE --> REVIEWING : Triggered by worker READY/SUGGEST/BLOCKED
            REVIEWING --> REVIEWED_DECISION : Coordinator writes ACCEPT/ADJUST/REJECT to status-line
            
            state "Reviewed Decision State" as REVIEWED_DECISION {
                REVIEWED_ACCEPT : REVIEWED: ACCEPT [worker]
                REVIEWED_ADJUST : REVIEWED: ADJUST [worker]
                REVIEWED_REJECT : REVIEWED: REJECT [worker]
            }
            
            REVIEWED_DECISION --> IDLE : Run local-step (Processes decision & triggers worker)
        }
    }
```

---

## 2. Worker Status Specification

A worker reports its current state by writing exactly one line to `.sci/status-line` (and keeping the first line of `task.md` in sync) using the format `[STATUS]: [detail]`:

1.  **`IDLE: [detail]`**
    *   *Meaning*: The worker has no active goal and is waiting for an assignment.
2.  **`ASSIGNED: [goal_detail]`**
    *   *Meaning*: The coordinator has prepared a new overall `goal.md` and initial `task.md`, and is about to trigger the worker.
3.  **`WORKING: [current_step]`**
    *   *Meaning*: The worker is actively developing and proving the current commit-sized step in `task.md`, or is actively planning/adjusting their next step.
4.  **`READY: [current_step]`**
    *   *Meaning*: The worker has completed the current `task.md` step, successfully run `lake build`, committed the changes, and is **ready for the coordinator to review the code**.
5.  **`SUGGEST: [proposed_task]`**
    *   *Meaning*: The worker has completed the planning phase, written the proposed next step into `task.md`, and is **ready for the coordinator to approve the new task plan**.
6.  **`BLOCKED: [reason]`**
    *   *Meaning*: The worker is genuinely blocked (cross-group gating or compiler/universe error) and has appended a triage report to the bottom of `task.md`.
7.  **`AWAITING: [detail]`**
    *   *Meaning*: The worker has submitted code or plans and is temporarily paused, waiting for the coordinator to complete the review or triage.
8.  **`COMPLETE: [goal_description]`**
    *   *Meaning*: The worker has successfully completed their **entire `goal.md` module**, verified that the entire target builds with zero `sorry`s, and is completely done with their overall phase.

---

## 3. Coordinator Status Specification

The coordinator is an active participant in the workflow. Its own `.sci/status-line` is polled by the server to coordinate handoffs:

1.  **`IDLE: [detail]`**
    *   *Meaning*: The coordinator is ready for a new review, adjustment, or triage assignment.
2.  **`REVIEWING: [worker]`**
    *   *Meaning*: The coordinator is actively conducting a review of the target worker's task (either code review or plan approval).
3.  **`REVIEWED: [DECISION] [worker]`**
    *   *Meaning*: The coordinator has completed the review. The deterministic orchestrator server reads this status to know the exact judgement and execute the required action, before resetting the coordinator's status back to `IDLE`.
    *   *Possible Decisions*:
        *   `REVIEWED: ACCEPT [worker]` — Accept the work / plan, merge commits (if code), and transition worker to `WORKING`.
        *   `REVIEWED: ADJUST [worker]` — Task plan needs adjustments (worker transitions to `WORKING: adjust plan`).
        *   `REVIEWED: REJECT [worker]` — Worker must roll back their changes completely and start over (with a fresh `task.md` and new session).

---

## 4. Handoff Coordination Commands (`local-step` & `tell-worker`)

The orchestrator script `local-step` drives all worker/coordinator handoffs, copying version-controlled guides from `rules/` to `.sci/` during execution:

*   **`assigned`** (`tell-worker -- <worker> assigned`):
    *   *Prompt Guide*: `proving-guide.md`
    *   *Action*: Initial handoff of the goal and the first task to the worker. Transitions worker to `WORKING`.
*   **`review`** (`tell-worker -- <coordinator> review <worker>`):
    *   *Prompt Guide*: `review-guide.md`
    *   *Action*: Assert coordinator is `IDLE`. Transitions coordinator to `REVIEWING: <worker>` and prompts the coordinator to review the worker's completed code.
*   **`accept`** (`tell-worker -- <worker> accept`):
    *   *Prompt Guide*: `proving-guide.md`
    *   *Action*: Prompts the accepted worker to enter planning mode, re-read `plan.md`, and write their next task plan to `task.md`. Transitions worker to `WORKING`.
*   **`approve-task`** (`tell-worker -- <coordinator> approve-task <worker>`):
    *   *Prompt Guide*: `approve-task-guide.md`
    *   *Action*: Assert coordinator is `IDLE`. Transitions coordinator to `REVIEWING: <worker>` and prompts the coordinator to review/approve the proposed task plan in the worker's `task.md`.
*   **`adjust`** (`tell-worker -- <worker> adjust`):
    *   *Prompt Guide*: `adjust-guide.md`
    *   *Action*: Prompts the worker to adjust their proposed task plan in `task.md` based on coordinator feedback. Transitions worker to `WORKING`.
*   **`unblock`** (`tell-worker -- <coordinator> unblock <worker>`):
    *   *Prompt Guide*: `unblock-guide.md`
    *   *Action*: Assert coordinator is `IDLE`. Transitions coordinator to `REVIEWING: <worker>` and prompts the coordinator to triage the blocker.
