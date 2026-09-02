# Scheduled jobs on the VPS

**The gap this closes (B-50).** The schedules live in `vercel.json` and the
Netlify `cron-*` functions. Production is a VPS running
`deploy/shikhon-web.service`, a plain `Type=simple` web process, and it has
neither — so **nothing on the production host has ever been scheduled**. The
SMS queue is not drained, partitions are not created, and the monitor that
would tell you so does not run either.

These units are the schedule for that host. Install all six files, or the
heartbeat alert (migration 071) will keep telling you a job has never run —
which is the correct answer until they exist.

```bash
sudo cp deploy/shikhon-*.service deploy/shikhon-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shikhon-sms.timer shikhon-maintenance.timer shikhon-monitor.timer
systemctl list-timers 'shikhon-*'
```

## What runs, and when

| Timer | Dhaka | UTC | Endpoint |
|---|---|---|---|
| `shikhon-sms` | 00:00 daily | 18:00 | `POST /api/v1/sms/dispatch` |
| `shikhon-maintenance` | 01:00 daily | 19:00 | `POST /api/v1/ops/maintenance` |
| `shikhon-monitor` | every 15 min | — | `POST /api/v1/ops/monitor` |

`OnCalendar` is written in UTC and the unit sets no `Timezone=`, deliberately:
a VPS whose clock is moved to Asia/Dhaka would otherwise shift both daily jobs
by six hours without anyone editing a file. The Dhaka column is what the school
experiences; the UTC column is what systemd is told. This is the same boundary
that produced B-79, where a fixture wrote UTC dates while the product read
Dhaka ones.

`Persistent=true` on the two daily timers means a host that was down at 18:00
runs the job when it comes back rather than skipping a day. The monitor is not
persistent — a fifteen-minute check that missed its slot has nothing to catch
up on, and the gap is exactly what the heartbeat is supposed to report.

## Why POST and not GET

`/ops/monitor` evaluates on both and **delivers only on POST**. A GET is an
operator asking "what would fire right now?"; it also does not record the
heartbeat, so looking at the monitor cannot be mistaken for the monitor
running.

## The credential

Each unit reads `/etc/shikhon/shikhon.env`, the same root-owned 0600 file the
web unit uses. `CRON_SECRET` must be set there. It is sent as a bearer token,
so it never appears in `ps` output or in the journal.

## Verifying, honestly

A timer that is enabled is not a job that ran. After installing:

```bash
systemctl list-timers 'shikhon-*'            # NEXT and LAST columns
journalctl -u shikhon-monitor.service -n 20  # what the last run actually did
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://sikhon.systems/api/v1/ops/monitor | jq '.signals.jobs'
```

That last command is the one that matters: it reports each job's own view of
when it last succeeded, read from `ops_job_runs`. A job showing
`minutesSinceSuccess: null` has never run on this deployment no matter what
`systemctl` says about the timer.

## What still is not covered

**Nothing here watches systemd itself.** If the host is off, or
`shikhon-monitor.timer` is disabled, no alert can originate from inside the
box — the monitor cannot report its own death. That needs an external check
(an uptime monitor hitting a public endpoint, or the host provider's own
alerting), and it is deliberately not simulated here. See §7 of the runbook.
