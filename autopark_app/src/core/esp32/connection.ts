/**
 * Connection / staleness tracking for the ESP32 telemetry poll. Pure reducer so
 * it can be unit-tested and so every screen shows the same notion of "live".
 */

import { RoverStatus } from './protocol';

export type LinkState = 'unknown' | 'connected' | 'stale' | 'disconnected';

export interface ConnectionState {
  link: LinkState;
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  status: RoverStatus | null; // last good telemetry (kept, but marked stale when old)
  /** Detects ESP32 reboots (uptime going backwards). */
  bootCount: number;
}

export const INITIAL_CONNECTION: ConnectionState = {
  link: 'unknown',
  lastOkAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
  lastError: null,
  status: null,
  bootCount: 0,
};

export const DISCONNECT_AFTER_FAILURES = 3;

export function onPollSuccess(s: ConnectionState, status: RoverStatus, now: number): ConnectionState {
  const rebooted = s.status !== null && status.uptimeMs + 1000 < s.status.uptimeMs;
  return {
    link: 'connected',
    lastOkAt: now,
    lastAttemptAt: now,
    consecutiveFailures: 0,
    lastError: null,
    status,
    bootCount: s.bootCount + (rebooted ? 1 : 0),
  };
}

export function onPollFailure(s: ConnectionState, error: string, now: number): ConnectionState {
  const failures = s.consecutiveFailures + 1;
  return {
    ...s,
    lastAttemptAt: now,
    consecutiveFailures: failures,
    lastError: error,
    link: failures >= DISCONNECT_AFTER_FAILURES ? 'disconnected' : s.link === 'unknown' ? 'unknown' : 'stale',
  };
}

/** Re-evaluate staleness on a clock tick (telemetry can age without a failed poll). */
export function evaluateLink(s: ConnectionState, now: number, staleAfterMs: number): ConnectionState {
  if (s.lastOkAt === null) return s;
  const age = now - s.lastOkAt;
  if (s.link === 'connected' && age > staleAfterMs) return { ...s, link: 'stale' };
  return s;
}

export function telemetryAgeMs(s: ConnectionState, now: number): number | null {
  return s.lastOkAt === null ? null : now - s.lastOkAt;
}

/** Telemetry may be displayed as live only when connected and fresh. */
export function isLive(s: ConnectionState, now: number, staleAfterMs: number): boolean {
  return s.link === 'connected' && s.lastOkAt !== null && now - s.lastOkAt <= staleAfterMs;
}
