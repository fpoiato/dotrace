#!/usr/bin/env python3
"""Deterministic alarm / budget arithmetic for the AI cost-guard.

Do not do this math in the model — print it from this script.
"""

def main() -> None:
    # Healthy TURNS 1v1: human thinks ~8s, AI delay ~0.5s → one AI invoke per 8.5s.
    turns_period_s = 8.0 + 0.5
    turns_invokes_per_5min = 300.0 / turns_period_s

    # Healthy TIMED 1 AI: animation + delay ≈ one move every 3s.
    timed_period_s = 3.0
    timed_invokes_per_5min = 300.0 / timed_period_s

    # Alarm at 1.5× the busier healthy game (TIMED).
    invocations_alarm = round(timed_invokes_per_5min * 1.5)

    timeout_s = 30
    duration_p99_ms = int(timeout_s * 0.8 * 1000)

    # Immediate stop: 22 always-on 512 MB / 600s workers → reserved 2.
    incident_concurrent = 22
    reserved = 2
    duration_fraction = reserved / incident_concurrent

    print(f"turns_invokes_per_5min={turns_invokes_per_5min:.2f}")
    print(f"timed_invokes_per_5min={timed_invokes_per_5min:.2f}")
    print(f"invocations_alarm_per_5min={invocations_alarm}")
    print(f"duration_p99_ms={duration_p99_ms}")
    print(f"incident_to_reserved_duration_fraction={duration_fraction:.4f}")
    print(f"expected_alarm_constant=150 duration_p99_ms=24000")
    assert invocations_alarm == 150
    assert duration_p99_ms == 24_000


if __name__ == "__main__":
    main()
