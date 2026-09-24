# Lantern — Delivery Handbook

Lantern is the fictional service this handbook describes. Every workstream below is estimated in **points**, reviewed at a fixed cadence, and closed only when its *acceptance criteria* hold. The [rollout policy](https://example.com/policy "Policy") governs anything that reaches production [^1]. Its owner is [@ada](mention:u_ada).

This document exists to be parsed, projected, diffed and re-parsed — it is a test fixture, not a real plan. It deliberately contains every block and inline shape the editor supports, including the ones that are awkward to serialize.

## How to read this handbook

* Section numbers are stable; **never renumber them** in a patch.
* Estimates are in points, never in hours.
  * A point is a unit of uncertainty, not a unit of time.
  * Anything above 8 points is split before it is scheduled.
* Terms in `monospace` name files, commands or config keys.
* Links to `/doc/...` are internal; everything else is external.

> Read the glossary first. A reviewer who guesses at a term will estimate it wrong, and a wrong estimate in points is the most expensive mistake in this process.
>
> > Nested note: the glossary is normative, the prose around it is not.

## Glossary

| Term | Meaning | Owner | Notes |
| :-- | :-: | --: | --- |
| **Epic** | a body of work spanning sprints | planning | sized in points |
| `ADR` | architecture decision record | design | see [ADR index](/doc/adr) |
| ~~Task force~~ | *retired* in favour of workstreams | — |  |
| Escape hatch | a documented exception \| approved once | on-call | `C:\\path` style |

## Conventions

Each workstream states its scope, its estimate in points, and the evidence a reviewer checks. **Task&#32;**`Spent` = the evidence a reviewer reads first.

1. Write the scope before the estimate.
2. Estimate in points, as a team, in one pass.
3. Record the number; do not renegotiate it mid-sprint.

```ts
export type Estimate = { points: number; owner: string; sprint: number };

export const split = (e: Estimate): Estimate[] =>
  e.points <= 8 ? [e] : [{ ...e, points: 8 }, { ...e, points: e.points - 8 }];
```

---

## Workstream 01 — Intake

Intake work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/intake.yaml` and revisits it at checkpoint 1.

### Scope

* Confirm the intake owner is on rotation.
* Re-read the previous intake review before estimating.
  * Carry forward anything left open at checkpoint 1.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 01.

### Estimation

Sizing uses story points, not hours: a intake item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 01 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| intake intake | 2 | **duty lead** |
| intake review | 3 | `rotation` |
| intake rollout | 5 | [handbook](/doc/intake) |

### Evidence

The **plan in&#32;**`budget.yaml`**&#32;is the record** — nothing else counts.

```yaml
workstream: 01
slug: intake
estimate:
  points: 3
  reviewed_by: duty-lead
```

---

## Workstream 02 — Triage

Triage work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/triage.yaml` and revisits it at checkpoint 2.

### Scope

* Confirm the triage owner is on rotation.
* Re-read the previous triage review before estimating.
  * Carry forward anything left open at checkpoint 1.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 02.

### Estimation

Sizing uses story points, not hours: a triage item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 02 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| triage intake | 2 | **duty lead** |
| triage review | 3 | `rotation` |
| triage rollout | 5 | [handbook](/doc/triage) |

### Evidence

Run [`verify.sh`](https://example.com/verify "How to verify") before the handoff.

```ts
export const triageBudget = { points: 4, checkpoint: 2 };
```

---

## Workstream 03 — Design review

Design review work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/design-review.yaml` and revisits it at checkpoint 3.

### Scope

1. Confirm the design review owner is on rotation.
2. Re-read the previous design-review review before estimating.
3. Record the estimate in points against workstream 03.

### Estimation

Sizing uses story points, not hours: a design-review item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 03 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| design-review intake | 2 | **duty lead** |
| design-review review | 3 | `rotation` |
| design-review rollout | 5 | [handbook](/doc/design-review) |

### Evidence

A [checklist with `inline code` inside](https://example.com/list) covers the rest.

```md
# workstream 03 is not a heading here

* and this is not a list
```

---

## Workstream 04 — Implementation

Implementation work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/implementation.yaml` and revisits it at checkpoint 4.

### Scope

* Confirm the implementation owner is on rotation.
* Re-read the previous implementation review before estimating.
  * Carry forward anything left open at checkpoint 3.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 04.

### Estimation

Sizing uses story points, not hours: a implementation item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 04 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| implementation intake | 2 | **duty lead** |
| implementation review | 3 | `rotation` |
| implementation rollout | 5 | [handbook](/doc/implementation) |

### Evidence

*Draft&#32;*`notes.md`*&#32;then review* — in that order.

```
$ lantern estimate --workstream 04 --unit points
implementation: 8 points (split required)
```

---

## Workstream 05 — Verification

Verification work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/verification.yaml` and revisits it at checkpoint 5.

### Scope

* Confirm the verification owner is on rotation.
* Re-read the previous verification review before estimating.
  * Carry forward anything left open at checkpoint 4.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 05.

### Estimation

Sizing uses story points, not hours: a verification item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 05 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| verification intake | 2 | **duty lead** |
| verification review | 3 | `rotation` |
| verification rollout | 5 | [handbook](/doc/verification) |

### Evidence

~~Superseded&#32;~~`RFC-002` replaced it last quarter.

```yaml
workstream: 05
slug: verification
estimate:
  points: 7
  reviewed_by: duty-lead
```

> Checkpoint 5 is the last point at which the estimate can change. After it, a change in points is a new item, not a re-estimate.

---

## Workstream 06 — Rollout

Rollout work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/rollout.yaml` and revisits it at checkpoint 6.

### Scope

1. Confirm the rollout owner is on rotation.
2. Re-read the previous rollout review before estimating.
3. Record the estimate in points against workstream 06.

### Estimation

Sizing uses story points, not hours: a rollout item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 06 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| rollout intake | 2 | **duty lead** |
| rollout review | 3 | `rotation` |
| rollout rollout | 5 | [handbook](/doc/rollout) |

### Evidence

**Owner&#32;**`duty-lead`**&#32;signs off** on every exception.

```ts
export const rolloutBudget = { points: 8, checkpoint: 6 };
```

---

## Workstream 07 — Observability

Observability work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/observability.yaml` and revisits it at checkpoint 7.

### Scope

* Confirm the observability owner is on rotation.
* Re-read the previous observability review before estimating.
  * Carry forward anything left open at checkpoint 6.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 07.

### Estimation

Sizing uses story points, not hours: a observability item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 07 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| observability intake | 2 | **duty lead** |
| observability review | 3 | `rotation` |
| observability rollout | 5 | [handbook](/doc/observability) |

### Evidence

**Estimate&#32;**&#116;racking stays in the sprint board.

```md
# workstream 07 is not a heading here

* and this is not a list
```

## Acceptance criteria

* GIVEN a document with an open review
* WHEN the reviewer accepts a single hunk
* THEN the rest of the run stays pending

Closed when the reviewer signs off on workstream 07 and the estimate in points matches the recorded actual.

---

## Workstream 08 — On-call

On-call work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/on-call.yaml` and revisits it at checkpoint 8.

### Scope

* Confirm the on-call owner is on rotation.
* Re-read the previous on-call review before estimating.
  * Carry forward anything left open at checkpoint 7.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 08.

### Estimation

Sizing uses story points, not hours: a on-call item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 08 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| on-call intake | 2 | **duty lead** |
| on-call review | 3 | `rotation` |
| on-call rollout | 5 | [handbook](/doc/on-call) |

### Evidence

Recor&#100;**&#32;every deviation** in the log.

```
$ lantern estimate --workstream 08 --unit points
on-call: 8 points (split required)
```

---

## Workstream 09 — Data retention

Data retention work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/retention.yaml` and revisits it at checkpoint 9.

### Scope

1. Confirm the data retention owner is on rotation.
2. Re-read the previous retention review before estimating.
3. Record the estimate in points against workstream 09.

### Estimation

Sizing uses story points, not hours: a retention item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 09 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| retention intake | 2 | **duty lead** |
| retention review | 3 | `rotation` |
| retention rollout | 5 | [handbook](/doc/retention) |

### Evidence

> **Task&#32;**`Spent` = the evidence a reviewer reads first.

```yaml
workstream: 09
slug: retention
estimate:
  points: 4
  reviewed_by: duty-lead
```

---

## Workstream 10 — Access review

Access review work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/access-review.yaml` and revisits it at checkpoint 10.

### Scope

* Confirm the access review owner is on rotation.
* Re-read the previous access-review review before estimating.
  * Carry forward anything left open at checkpoint 9.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 10.

### Estimation

Sizing uses story points, not hours: a access-review item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 10 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| access-review intake | 2 | **duty lead** |
| access-review review | 3 | `rotation` |
| access-review rollout | 5 | [handbook](/doc/access-review) |

### Evidence

The **plan in&#32;**`budget.yaml`**&#32;is the record** — nothing else counts.

```ts
export const accessReviewBudget = { points: 5, checkpoint: 10 };
```

> Checkpoint 10 is the last point at which the estimate can change. After it, a change in points is a new item, not a re-estimate.

---

## Workstream 11 — Capacity

Capacity work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/capacity.yaml` and revisits it at checkpoint 11.

### Scope

* Confirm the capacity owner is on rotation.
* Re-read the previous capacity review before estimating.
  * Carry forward anything left open at checkpoint 10.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 11.

### Estimation

Sizing uses story points, not hours: a capacity item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 11 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| capacity intake | 2 | **duty lead** |
| capacity review | 3 | `rotation` |
| capacity rollout | 5 | [handbook](/doc/capacity) |

### Evidence

Run [`verify.sh`](https://example.com/verify "How to verify") before the handoff.

```md
# workstream 11 is not a heading here

* and this is not a list
```

---

## Workstream 12 — Cost review

Cost review work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/cost-review.yaml` and revisits it at checkpoint 12.

### Scope

1. Confirm the cost review owner is on rotation.
2. Re-read the previous cost-review review before estimating.
3. Record the estimate in points against workstream 12.

### Estimation

Sizing uses story points, not hours: a cost-review item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 12 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| cost-review intake | 2 | **duty lead** |
| cost-review review | 3 | `rotation` |
| cost-review rollout | 5 | [handbook](/doc/cost-review) |

### Evidence

A [checklist with `inline code` inside](https://example.com/list) covers the rest.

```
$ lantern estimate --workstream 12 --unit points
cost-review: 8 points (split required)
```

---

## Workstream 13 — Localization

Localization work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/localization.yaml` and revisits it at checkpoint 13.

### Scope

* Confirm the localization owner is on rotation.
* Re-read the previous localization review before estimating.
  * Carry forward anything left open at checkpoint 12.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 13.

### Estimation

Sizing uses story points, not hours: a localization item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 13 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| localization intake | 2 | **duty lead** |
| localization review | 3 | `rotation` |
| localization rollout | 5 | [handbook](/doc/localization) |

### Evidence

*Draft&#32;*`notes.md`*&#32;then review* — in that order.

```yaml
workstream: 13
slug: localization
estimate:
  points: 8
  reviewed_by: duty-lead
```

---

## Workstream 14 — Accessibility

Accessibility work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/accessibility.yaml` and revisits it at checkpoint 14.

### Scope

* Confirm the accessibility owner is on rotation.
* Re-read the previous accessibility review before estimating.
  * Carry forward anything left open at checkpoint 13.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 14.

### Estimation

Sizing uses story points, not hours: a accessibility item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 14 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| accessibility intake | 2 | **duty lead** |
| accessibility review | 3 | `rotation` |
| accessibility rollout | 5 | [handbook](/doc/accessibility) |

### Evidence

~~Superseded&#32;~~`RFC-002` replaced it last quarter.

```ts
export const accessibilityBudget = { points: 2, checkpoint: 14 };
```

---

## Workstream 15 — Documentation

Documentation work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/docs.yaml` and revisits it at checkpoint 15.

### Scope

1. Confirm the documentation owner is on rotation.
2. Re-read the previous docs review before estimating.
3. Record the estimate in points against workstream 15.

### Estimation

Sizing uses story points, not hours: a docs item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 15 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| docs intake | 2 | **duty lead** |
| docs review | 3 | `rotation` |
| docs rollout | 5 | [handbook](/doc/docs) |

### Evidence

**Owner&#32;**`duty-lead`**&#32;signs off** on every exception.

```md
# workstream 15 is not a heading here

* and this is not a list
```

> Checkpoint 15 is the last point at which the estimate can change. After it, a change in points is a new item, not a re-estimate.

---

## Workstream 16 — Training

Training work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/training.yaml` and revisits it at checkpoint 16.

### Scope

* Confirm the training owner is on rotation.
* Re-read the previous training review before estimating.
  * Carry forward anything left open at checkpoint 15.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 16.

### Estimation

Sizing uses story points, not hours: a training item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 16 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| training intake | 2 | **duty lead** |
| training review | 3 | `rotation` |
| training rollout | 5 | [handbook](/doc/training) |

### Evidence

**Estimate&#32;**&#116;racking stays in the sprint board.

```
$ lantern estimate --workstream 16 --unit points
training: 8 points (split required)
```

---

## Workstream 17 — Incident review

Incident review work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/incident-review.yaml` and revisits it at checkpoint 17.

### Scope

* Confirm the incident review owner is on rotation.
* Re-read the previous incident-review review before estimating.
  * Carry forward anything left open at checkpoint 16.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 17.

### Estimation

Sizing uses story points, not hours: a incident-review item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 17 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| incident-review intake | 2 | **duty lead** |
| incident-review review | 3 | `rotation` |
| incident-review rollout | 5 | [handbook](/doc/incident-review) |

### Evidence

Recor&#100;**&#32;every deviation** in the log.

```yaml
workstream: 17
slug: incident-review
estimate:
  points: 5
  reviewed_by: duty-lead
```

---

## Workstream 18 — Dependency upgrades

Dependency upgrades work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/dependencies.yaml` and revisits it at checkpoint 18.

### Scope

1. Confirm the dependency upgrades owner is on rotation.
2. Re-read the previous dependencies review before estimating.
3. Record the estimate in points against workstream 18.

### Estimation

Sizing uses story points, not hours: a dependencies item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 18 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| dependencies intake | 2 | **duty lead** |
| dependencies review | 3 | `rotation` |
| dependencies rollout | 5 | [handbook](/doc/dependencies) |

### Evidence

> **Task&#32;**`Spent` = the evidence a reviewer reads first.

```ts
export const dependenciesBudget = { points: 6, checkpoint: 18 };
```

---

## Workstream 19 — Schema migration

Schema migration work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/schema-migration.yaml` and revisits it at checkpoint 19.

### Scope

* Confirm the schema migration owner is on rotation.
* Re-read the previous schema-migration review before estimating.
  * Carry forward anything left open at checkpoint 18.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 19.

### Estimation

Sizing uses story points, not hours: a schema-migration item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 19 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| schema-migration intake | 2 | **duty lead** |
| schema-migration review | 3 | `rotation` |
| schema-migration rollout | 5 | [handbook](/doc/schema-migration) |

### Evidence

The **plan in&#32;**`budget.yaml`**&#32;is the record** — nothing else counts.

```md
# workstream 19 is not a heading here

* and this is not a list
```

## Acceptance criteria

* GIVEN a document with an open review
* WHEN the reviewer accepts a single hunk
* THEN the rest of the run stays pending

Closed when the reviewer signs off on workstream 19 and the estimate in points matches the recorded actual.

---

## Workstream 20 — Feature flag cleanup

Feature flag cleanup work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/flag-cleanup.yaml` and revisits it at checkpoint 20.

### Scope

* Confirm the feature flag cleanup owner is on rotation.
* Re-read the previous flag-cleanup review before estimating.
  * Carry forward anything left open at checkpoint 19.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 20.

### Estimation

Sizing uses story points, not hours: a flag-cleanup item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 20 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| flag-cleanup intake | 2 | **duty lead** |
| flag-cleanup review | 3 | `rotation` |
| flag-cleanup rollout | 5 | [handbook](/doc/flag-cleanup) |

### Evidence

Run [`verify.sh`](https://example.com/verify "How to verify") before the handoff.

```
$ lantern estimate --workstream 20 --unit points
flag-cleanup: 8 points (split required)
```

> Checkpoint 20 is the last point at which the estimate can change. After it, a change in points is a new item, not a re-estimate.

---

## Workstream 21 — Load testing

Load testing work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/load-testing.yaml` and revisits it at checkpoint 21.

### Scope

1. Confirm the load testing owner is on rotation.
2. Re-read the previous load-testing review before estimating.
3. Record the estimate in points against workstream 21.

### Estimation

Sizing uses story points, not hours: a load-testing item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 21 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| load-testing intake | 2 | **duty lead** |
| load-testing review | 3 | `rotation` |
| load-testing rollout | 5 | [handbook](/doc/load-testing) |

### Evidence

A [checklist with `inline code` inside](https://example.com/list) covers the rest.

```yaml
workstream: 21
slug: load-testing
estimate:
  points: 2
  reviewed_by: duty-lead
```

---

## Workstream 22 — Backup drill

Backup drill work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/backup-drill.yaml` and revisits it at checkpoint 22.

### Scope

* Confirm the backup drill owner is on rotation.
* Re-read the previous backup-drill review before estimating.
  * Carry forward anything left open at checkpoint 21.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 22.

### Estimation

Sizing uses story points, not hours: a backup-drill item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 22 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| backup-drill intake | 2 | **duty lead** |
| backup-drill review | 3 | `rotation` |
| backup-drill rollout | 5 | [handbook](/doc/backup-drill) |

### Evidence

*Draft&#32;*`notes.md`*&#32;then review* — in that order.

```ts
export const backupDrillBudget = { points: 3, checkpoint: 22 };
```

---

## Workstream 23 — Key rotation

Key rotation work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/key-rotation.yaml` and revisits it at checkpoint 23.

### Scope

* Confirm the key rotation owner is on rotation.
* Re-read the previous key-rotation review before estimating.
  * Carry forward anything left open at checkpoint 22.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 23.

### Estimation

Sizing uses story points, not hours: a key-rotation item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 23 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| key-rotation intake | 2 | **duty lead** |
| key-rotation review | 3 | `rotation` |
| key-rotation rollout | 5 | [handbook](/doc/key-rotation) |

### Evidence

~~Superseded&#32;~~`RFC-002` replaced it last quarter.

```md
# workstream 23 is not a heading here

* and this is not a list
```

---

## Workstream 24 — Vendor review

Vendor review work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/vendor-review.yaml` and revisits it at checkpoint 24.

### Scope

1. Confirm the vendor review owner is on rotation.
2. Re-read the previous vendor-review review before estimating.
3. Record the estimate in points against workstream 24.

### Estimation

Sizing uses story points, not hours: a vendor-review item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 24 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| vendor-review intake | 2 | **duty lead** |
| vendor-review review | 3 | `rotation` |
| vendor-review rollout | 5 | [handbook](/doc/vendor-review) |

### Evidence

**Owner&#32;**`duty-lead`**&#32;signs off** on every exception.

```
$ lantern estimate --workstream 24 --unit points
vendor-review: 8 points (split required)
```

---

## Workstream 25 — Privacy review

Privacy review work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/privacy-review.yaml` and revisits it at checkpoint 25.

### Scope

* Confirm the privacy review owner is on rotation.
* Re-read the previous privacy-review review before estimating.
  * Carry forward anything left open at checkpoint 24.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 25.

### Estimation

Sizing uses story points, not hours: a privacy-review item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 25 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| privacy-review intake | 2 | **duty lead** |
| privacy-review review | 3 | `rotation` |
| privacy-review rollout | 5 | [handbook](/doc/privacy-review) |

### Evidence

**Estimate&#32;**&#116;racking stays in the sprint board.

```yaml
workstream: 25
slug: privacy-review
estimate:
  points: 6
  reviewed_by: duty-lead
```

> Checkpoint 25 is the last point at which the estimate can change. After it, a change in points is a new item, not a re-estimate.

---

## Workstream 26 — Performance budget

Performance budget work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/perf-budget.yaml` and revisits it at checkpoint 26.

### Scope

* Confirm the performance budget owner is on rotation.
* Re-read the previous perf-budget review before estimating.
  * Carry forward anything left open at checkpoint 25.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 26.

### Estimation

Sizing uses story points, not hours: a perf-budget item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 26 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| perf-budget intake | 2 | **duty lead** |
| perf-budget review | 3 | `rotation` |
| perf-budget rollout | 5 | [handbook](/doc/perf-budget) |

### Evidence

Recor&#100;**&#32;every deviation** in the log.

```ts
export const perfBudgetBudget = { points: 7, checkpoint: 26 };
```

---

## Workstream 27 — Release notes

Release notes work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/release-notes.yaml` and revisits it at checkpoint 27.

### Scope

1. Confirm the release notes owner is on rotation.
2. Re-read the previous release-notes review before estimating.
3. Record the estimate in points against workstream 27.

### Estimation

Sizing uses story points, not hours: a release-notes item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 27 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| release-notes intake | 2 | **duty lead** |
| release-notes review | 3 | `rotation` |
| release-notes rollout | 5 | [handbook](/doc/release-notes) |

### Evidence

> **Task&#32;**`Spent` = the evidence a reviewer reads first.

```md
# workstream 27 is not a heading here

* and this is not a list
```

---

## Workstream 28 — Deprecation

Deprecation work enters the board as a **sized** item and is estimated in points before the sprint opens. The team keeps the record in `plan/deprecation.yaml` and revisits it at checkpoint 28.

### Scope

* Confirm the deprecation owner is on rotation.
* Re-read the previous deprecation review before estimating.
  * Carry forward anything left open at checkpoint 27.
  * Close anything the last review resolved.
* Record the estimate in points against workstream 28.

### Estimation

Sizing uses story points, not hours: a deprecation item worth 3 points is roughly one day of focused work for one engineer, and anything above 8 points is split before workstream 28 is scheduled.

| Step | Points | Owner |
| :-- | --: | :-- |
| deprecation intake | 2 | **duty lead** |
| deprecation review | 3 | `rotation` |
| deprecation rollout | 5 | [handbook](/doc/deprecation) |

### Evidence

The **plan in&#32;**`budget.yaml`**&#32;is the record** — nothing else counts.

```
$ lantern estimate --workstream 28 --unit points
deprecation: 8 points (split required)
```

---

## Appendix A — Inline edge cases

Every line below is here because it once serialized to something that re-parsed differently. They are load-bearing: do not "tidy" them.

> **Task&#32;**`Spent` = the evidence a reviewer reads first.

The **plan in&#32;**`budget.yaml`**&#32;is the record** — nothing else counts.

Run [`verify.sh`](https://example.com/verify "How to verify") before the handoff.

A [checklist with `inline code` inside](https://example.com/list) covers the rest.

*Draft&#32;*`notes.md`*&#32;then review* — in that order.

~~Superseded&#32;~~`RFC-002` replaced it last quarter.

**Owner&#32;**`duty-lead`**&#32;signs off** on every exception.

**Estimate&#32;**&#116;racking stays in the sprint board.

Recor&#100;**&#32;every deviation** in the log.

Literal \*stars\*, \_unders\_, \`ticks\`, \[brackets\] and a backslash \\ stay literal.

Ampersand \&amp; and \&#32; stay literal, and the string \<https://example.com> is not a link.

He said “the budget — all of it — is gone”, then ‘left’. Wait… for it.

a | b | c is not a table, and 3 points | 2 days is not one either.

first line\
second line, after a hard break

See [the docs](https://example.com/a_b), [a titled link](https://example.com "The Docs"), [parens](https://example.com/a\(b\)c), [a spaced path](<./report draft.md>) and [an internal doc](/doc/abc123).

![a diagram of the review loop](./review-loop.png "The review loop")

## Appendix B — Readiness checklist

* \[ \] Estimate recorded in points
* \[ \] Acceptance criteria written
* \[x\] Owner on rotation confirmed
* \[ \] Rollback rehearsed

## Acceptance criteria

* GIVEN a document with an open review
* WHEN the reviewer accepts a single hunk
* THEN the rest of the run stays pending

The appendix repeats the criteria on purpose: the same three lines appear in more than one section, which is what makes each hunk prove it can stand alone.

## Sources

[^1]: [Rollout policy — Section 4](/doc/policy) "the frozen excerpt"
