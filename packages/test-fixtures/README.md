# Deterministic reference workloads

These hand-calculated golden results are inputs for the Week 2 scheduler tests. They contain no scheduling implementation. Clone fixtures with `structuredClone` before simulation; never mutate the shared exports.

All fixtures use one printer at 60 pages/minute, zero warmup, no jams, and a simulation epoch of `2026-09-21T00:00:00.000Z`. Each page takes 1,000 ms. Throughput and utilization use the interval from simulation time zero to the last completion, including the aging fixture's initial idle period. Wait and turnaround averages include completed jobs only. Cancelled and capability-blocked jobs are excluded.

| Fixture               | Expected dispatch order (ID suffix) | Average wait, ms | Average turnaround, ms |
| --------------------- | ----------------------------------- | ---------------: | ---------------------: |
| FCFS arrivals         | 1, 2, 3                             |       11,000 / 3 |             23,000 / 3 |
| SJF convoy            | 2, 3, 1                             |        8,000 / 3 |             20,000 / 3 |
| Priority order        | 2, 3, 1                             |        8,000 / 3 |             20,000 / 3 |
| Aging overtakes       | 1, 2                                |           14,000 |                 15,000 |
| Queued cancellation   | 1, 3; job 2 cancelled at 1,000 ms   |            1,500 |                  3,500 |
| Color compatibility   | 2; job 1 blocked                    |                0 |                  2,000 |
| Simultaneous arrivals | 1, 2, 3; input order 3, 1, 2        |            1,000 |                  2,000 |

For aging, dispatch is held until 26,000 ms: job 1 has `min(100, 20 + floor(26000 / 5000) × 3) = 35`; job 2 arrived at 25,000 ms with priority 34. The older job wins despite lower base priority. The tests independently check interval duration, non-overlap, compatibility, job accounting, and the displayed metrics. Scheduler selection itself remains a Week 2 test gate.
