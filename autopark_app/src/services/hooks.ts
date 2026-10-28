import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { isLive, telemetryAgeMs } from '../core/esp32/connection';

/**
 * Polls GET /status. The poll is also the heartbeat the ESP32 uses to abort an
 * autonomous run if the phone disappears, so it runs app-wide.
 */
export function useTelemetryPoller() {
  const host = useApp((s) => s.config.esp32.host);
  const interval = useApp((s) => s.config.esp32.pollIntervalMs);
  const hydrated = useApp((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) return; // don't poll the default host before saved settings are loaded
    let inFlight = false;
    let cancelled = false;
    const tick = async () => {
      const st = useApp.getState();
      st.tickLink(Date.now());
      if (inFlight) return;
      inFlight = true;
      try {
        const status = await st.client().status();
        if (!cancelled) useApp.getState().pollSucceeded(status, Date.now());
      } catch (e) {
        if (!cancelled) useApp.getState().pollFailed((e as Error).message, Date.now());
      } finally {
        inFlight = false;
      }
    };
    tick();
    const id = setInterval(tick, Math.max(150, interval));
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [host, interval, hydrated]);
}

/** Push manual-mode safety settings to the ESP32 whenever the link (re)connects or they change. */
export function useSafetySync() {
  const link = useApp((s) => s.connection.link);
  const bootCount = useApp((s) => s.connection.bootCount);
  const safety = useApp((s) => s.config.safety);
  useEffect(() => {
    if (link !== 'connected') return;
    useApp
      .getState()
      .client()
      .configure({
        obstacleCm: safety.obstacleStopCm,
        manualWatchdogMs: safety.manualWatchdogMs,
        manualObstacleStop: safety.manualObstacleStop,
        irStop: safety.irStopEnabled,
      })
      .catch(() => undefined);
  }, [link === 'connected', bootCount, safety.obstacleStopCm, safety.manualWatchdogMs, safety.manualObstacleStop, safety.irStopEnabled]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useNow(everyMs = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export function useLink() {
  const connection = useApp((s) => s.connection);
  const staleAfter = useApp((s) => s.config.esp32.staleAfterMs);
  const now = useNow(400);
  return {
    connection,
    status: connection.status,
    live: isLive(connection, now, staleAfter),
    ageMs: (() => {
      const a = telemetryAgeMs(connection, now);
      return a === null ? null : Math.max(0, a);
    })(),
  };
}

/**
 * Hold-to-drive: sends the move immediately and repeats it while held (the
 * ESP32 watchdog stops the motor if repeats stop arriving), then sends S.
 */
export function useHoldToDrive() {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const send = async (m: 'F' | 'B' | 'L' | 'R' | 'S') => {
    const r = await useApp.getState().client().move(m);
    setLastError(r.ok ? null : `${r.result}${r.message ? ': ' + r.message : ''}`);
    return r;
  };
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    void send('S');
  };
  const start = (m: 'F' | 'B' | 'L' | 'R') => {
    if (timer.current) clearInterval(timer.current);
    void send(m);
    const every = Math.max(150, Math.floor(useApp.getState().config.safety.manualWatchdogMs / 3));
    timer.current = setInterval(() => {
      void send(m).then((r) => {
        if (!r.ok && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
        }
      });
    }, every);
  };
  useEffect(() => () => {
    if (timer.current) {
      clearInterval(timer.current);
      void useApp.getState().client().move('S');
    }
  }, []);
  return { start, stop, lastError, send };
}
