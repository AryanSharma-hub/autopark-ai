/**
 * HTTP client for the rover. Plain fetch + timeouts so it runs unchanged in the
 * app (React Native) and in Node integration tests against firmware/sim.
 *
 * Every call reports real success or failure; nothing is simulated when the
 * ESP32 is unreachable.
 */

import { MotionCode, ParkRequest, RoverStatus, formEncode, parseStatus } from '../core/esp32/protocol';

export interface CommandResult {
  ok: boolean;
  httpStatus: number;
  /** firmware result code: OK, DUPLICATE, BUSY, LOCKED, BLOCKED, INVALID (or NETWORK) */
  result: string;
  message: string;
  state?: string;
}

export class Esp32Client {
  constructor(
    public baseUrl: string,
    public timeoutMs = 1500,
  ) {}

  static forHost(host: string, timeoutMs = 1500): Esp32Client {
    const h = host.trim().replace(/\/+$/, '');
    return new Esp32Client(/^https?:\/\//.test(h) ? h : `http://${h}`, timeoutMs);
  }

  private async request(path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        ...init,
        signal: controller.signal,
        // No custom headers on GETs: keeps requests "simple" (no CORS preflight when the
        // web build talks to firmware/sim). The firmware already sends Cache-Control: no-store.
        headers: init.headers,
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      const err = e as Error;
      throw new Error(err.name === 'AbortError' ? `timeout after ${this.timeoutMs} ms` : err.message || 'network error');
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<RoverStatus> {
    const r = await this.request('/status');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    let json: unknown;
    try {
      json = JSON.parse(r.text);
    } catch {
      throw new Error('status is not JSON (old firmware?)');
    }
    return parseStatus(json);
  }

  private async command(path: string, init?: RequestInit): Promise<CommandResult> {
    try {
      const r = await this.request(path, init);
      let parsed: { ok?: boolean; result?: string; error?: string; state?: string } | null = null;
      try {
        parsed = JSON.parse(r.text);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object') {
        return {
          ok: r.status === 200 && parsed.ok !== false,
          httpStatus: r.status,
          result: parsed.result ?? (r.status === 200 ? 'OK' : 'ERROR'),
          message: parsed.error ?? '',
          state: parsed.state,
        };
      }
      const [code, ...rest] = r.text.split(':');
      return {
        ok: r.status === 200,
        httpStatus: r.status,
        result: r.status === 200 ? 'OK' : code.trim() || `HTTP ${r.status}`,
        message: rest.join(':').trim(),
      };
    } catch (e) {
      return { ok: false, httpStatus: 0, result: 'NETWORK', message: (e as Error).message };
    }
  }

  /** Hold-to-drive: repeat while the button is held (the firmware stops a move that is not repeated). */
  move(m: MotionCode) {
    return this.command(`/cmd?m=${m}`);
  }
  /** Move for a fixed time, then the firmware stops by itself. */
  timed(m: Exclude<MotionCode, 'S'>, ms: number) {
    return this.command(`/timed?m=${m}&ms=${Math.round(ms)}`);
  }
  setSpeed(pwm: number) {
    return this.command(`/speed?v=${Math.round(pwm)}`);
  }
  ping() {
    return this.command('/ping');
  }
  abort() {
    return this.command('/abort');
  }
  estop() {
    return this.command('/estop');
  }
  reset() {
    return this.command('/reset');
  }
  configure(p: { obstacleCm: number; manualWatchdogMs: number; manualObstacleStop: boolean; irStop: boolean }) {
    return this.command(
      `/config?obst=${p.obstacleCm}&mwd=${p.manualWatchdogMs}&mobst=${p.manualObstacleStop ? 1 : 0}&ir=${p.irStop ? 1 : 0}`,
    );
  }
  park(req: ParkRequest) {
    return this.command('/park', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(req as unknown as Record<string, string | number>),
    });
  }
  /** Timed calibration move: F/B to measure speed (cm), L/R to find the time for exactly 90 degrees. */
  calibrate(move: Exclude<MotionCode, 'S'>, pwm: number, ms: number, obstacleCm: number) {
    return this.command('/calib', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({ m: move, pwm, ms, obst: obstacleCm }),
    });
  }
}
