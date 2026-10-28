// ParkingController.h - hardware-independent movement and safety logic for
// the AutoPark rover (ESP32 brain + Arduino UNO motor driver).
//
// The sketch (autopark_esp32.ino) owns Wi-Fi, HTTP, sensors and the UART link
// to the UNO; this file owns every decision about when the motors may run. It
// has no Arduino dependencies, so it is compiled and unit-tested on a PC
// (firmware/test/test_controller.cpp).
//
// Hardware this logic is built on (from your sketches):
//   * ESP32 sends text commands over UART2 (TX 17 / RX 16, 9600 baud) to an
//     Arduino UNO with an Adafruit Motor Shield driving FOUR motors:
//       "F,<pwm>" forward, "B,<pwm>" reverse,
//       "L,<pwm>" / "R,<pwm>" rotate in place (left wheels one way, right
//       wheels the other), "S" stop, "H" heartbeat (UNO stops after 1 s without).
//   * There is no steering servo: turning = rotating in place.
//   * No wheel encoders: distance = calibrated speed (cm/s) x motor-on time,
//     rotation = calibrated ms per 90 degrees x motor-on time.
//
// States: IDLE, MANUAL, CALIBRATING, APPROACHING, TURNING, PARKING,
//         COMPLETED, OBSTACLE_STOP, ABORTED, ERROR.
// OBSTACLE_STOP / ABORTED / ERROR are latched: motors stay off and every
// motion command is refused until /reset.

#pragma once

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace autopark {

enum class State : uint8_t {
  IDLE,
  MANUAL,
  CALIBRATING,
  APPROACHING,
  TURNING,
  PARKING,
  COMPLETED,
  OBSTACLE_STOP,
  ABORTED,
  ERROR
};

inline const char* stateName(State s) {
  switch (s) {
    case State::IDLE: return "IDLE";
    case State::MANUAL: return "MANUAL";
    case State::CALIBRATING: return "CALIBRATING";
    case State::APPROACHING: return "APPROACHING";
    case State::TURNING: return "TURNING";
    case State::PARKING: return "PARKING";
    case State::COMPLETED: return "COMPLETED";
    case State::OBSTACLE_STOP: return "OBSTACLE_STOP";
    case State::ABORTED: return "ABORTED";
    case State::ERROR: return "ERROR";
  }
  return "ERROR";
}

enum class Result : uint8_t { OK, DUPLICATE, BUSY, LOCKED, BLOCKED, INVALID };

inline const char* resultName(Result r) {
  switch (r) {
    case Result::OK: return "OK";
    case Result::DUPLICATE: return "DUPLICATE";
    case Result::BUSY: return "BUSY";
    case Result::LOCKED: return "LOCKED";
    case Result::BLOCKED: return "BLOCKED";
    case Result::INVALID: return "INVALID";
  }
  return "INVALID";
}

const int MAX_SEGMENTS = 6;
const int RID_LEN = 41;

inline bool isStraight(char m) { return m == 'F' || m == 'B'; }
inline bool isRotation(char m) { return m == 'L' || m == 'R'; }
inline bool isMotion(char m) { return isStraight(m) || isRotation(m); }

struct Segment {
  char phase;  // 'A' approach, 'T' turn (rotate in place), 'P' park (bay entry)
  char move;   // 'F' / 'B' (straight) or 'L' / 'R' (rotate)
  float cm;    // straight segments: distance; rotations: 0
  uint32_t durationMs;  // rotations: given; straight: cm / cms
};

struct ParkRequest {
  char rid[RID_LEN];
  char slot[4];
  int pwm;   // straight driving PWM
  int rpwm;  // rotation PWM (the PWM the 90-degree time was calibrated at)
  float cms; // calibrated straight speed at `pwm`
  Segment segs[MAX_SEGMENTS];
  int segCount;
  float obstacleCm;
  float bayCm;
  bool irStop;
  uint32_t hbMs;
  uint32_t settleMs;  // pause between segments (motors off) so the rover stops moving
};

struct Sensors {
  float front, rear, left, right;  // cm, < 0 means "no echo"
  uint32_t frontAt, rearAt;        // millis() of the last front / rear reading
  bool irFL, irFR, irRL, irRR;     // true = detection
};

struct Outputs {
  char motor;  // 'F', 'B', 'L', 'R' or 'S'
  int pwm;     // 0..255
};

struct Limits {
  uint32_t sensorMaxAgeMs = 600;    // a reading older than this during straight motion = sensor fault
  uint32_t manualWatchdogMs = 1000; // manual moves must be repeated within this time
  float manualObstacleCm = 12.0f;   // manual F/B stop at obstacles closer than this
  bool manualObstacleStop = true;
  bool irStopManual = true;
  uint32_t irDebounceMs = 40;
  int obstacleHitsToStop = 2;       // consecutive fresh ultrasonic readings
  uint32_t runMarginMs = 3000;      // autonomous run may exceed its plan by this much
  uint32_t calibSettleMs = 300;
  uint32_t maxTimedMs = 60000;      // /timed (from your web page): 1..60 s
};

inline bool isAutonomous(State s) {
  return s == State::APPROACHING || s == State::TURNING || s == State::PARKING;
}
inline bool isLatched(State s) {
  return s == State::OBSTACLE_STOP || s == State::ABORTED || s == State::ERROR;
}
inline State phaseState(char phase) {
  return phase == 'A' ? State::APPROACHING : phase == 'T' ? State::TURNING : State::PARKING;
}

// ---------------------------------------------------------------------------
// Request parsing / validation (shared by HTTP handler, simulator and tests)
// ---------------------------------------------------------------------------

// "A,F,58.75;T,L,1180;P,F,24.00"  (straight: cm, rotation: ms)
inline bool parseSegments(const char* text, Segment* out, int& count, char* err, size_t errLen) {
  count = 0;
  if (!text || !*text) {
    snprintf(err, errLen, "segs missing");
    return false;
  }
  const char* p = text;
  while (*p) {
    if (count >= MAX_SEGMENTS) {
      snprintf(err, errLen, "too many segments (max %d)", MAX_SEGMENTS);
      return false;
    }
    Segment s;
    s.phase = *p++;
    if (*p++ != ',') { snprintf(err, errLen, "segment %d: bad format", count); return false; }
    s.move = *p++;
    if (*p++ != ',') { snprintf(err, errLen, "segment %d: bad format", count); return false; }
    char* end = nullptr;
    float v = strtof(p, &end);
    if (end == p) { snprintf(err, errLen, "segment %d: bad value", count); return false; }
    p = end;
    if (*p == ';') p++;
    else if (*p != '\0') { snprintf(err, errLen, "segment %d: trailing data", count); return false; }
    if (isRotation(s.move)) {
      s.cm = 0;
      s.durationMs = (v >= 0 && v < 1e7f) ? (uint32_t)lroundf(v) : 0;
    } else {
      s.cm = v;
      s.durationMs = 0;
    }
    out[count++] = s;
  }
  return count > 0;
}

inline bool validRid(const char* rid) {
  size_t n = strlen(rid);
  if (n < 4 || n >= (size_t)RID_LEN) return false;
  for (size_t i = 0; i < n; i++) {
    char c = rid[i];
    bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-';
    if (!ok) return false;
  }
  return true;
}

// Checks every field and fills in straight durations (ms = cm / cms * 1000).
inline bool validateRequest(ParkRequest& r, char* err, size_t errLen) {
  if (!validRid(r.rid)) { snprintf(err, errLen, "invalid rid"); return false; }
  if (!(strlen(r.slot) == 2 && r.slot[0] == 'S' && r.slot[1] >= '1' && r.slot[1] <= '5')) {
    snprintf(err, errLen, "slot must be S1..S5");
    return false;
  }
  if (r.pwm < 1 || r.pwm > 255) { snprintf(err, errLen, "pwm must be 1..255"); return false; }
  if (r.rpwm < 1 || r.rpwm > 255) { snprintf(err, errLen, "rpwm must be 1..255"); return false; }
  if (!(r.cms > 0.5f && r.cms < 200.0f) || isnan(r.cms)) { snprintf(err, errLen, "cms must be 0.5..200"); return false; }
  if (r.segCount < 1 || r.segCount > MAX_SEGMENTS) { snprintf(err, errLen, "1..%d segments required", MAX_SEGMENTS); return false; }
  if (!(r.obstacleCm >= 2 && r.obstacleCm <= 100)) { snprintf(err, errLen, "obst must be 2..100 cm"); return false; }
  if (!(r.bayCm >= 2 && r.bayCm <= 100)) { snprintf(err, errLen, "bay must be 2..100 cm"); return false; }
  if (r.hbMs < 500 || r.hbMs > 10000) { snprintf(err, errLen, "hb must be 500..10000 ms"); return false; }
  if (r.settleMs > 3000) { snprintf(err, errLen, "settle must be 0..3000 ms"); return false; }
  float total = 0;
  for (int i = 0; i < r.segCount; i++) {
    Segment& s = r.segs[i];
    if (s.phase != 'A' && s.phase != 'T' && s.phase != 'P') { snprintf(err, errLen, "segment %d: phase must be A/T/P", i); return false; }
    if (s.phase == 'T') {
      if (!isRotation(s.move)) { snprintf(err, errLen, "segment %d: a turn must be L or R", i); return false; }
      if (s.durationMs < 50 || s.durationMs > 10000) { snprintf(err, errLen, "segment %d: rotation must be 50..10000 ms", i); return false; }
      continue;
    }
    if (!isStraight(s.move)) { snprintf(err, errLen, "segment %d: move must be F/B", i); return false; }
    if (!(s.cm > 0 && s.cm <= 200) || isnan(s.cm)) { snprintf(err, errLen, "segment %d: cm must be 0..200", i); return false; }
    float ms = s.cm / r.cms * 1000.0f;
    if (ms > 30000.0f) { snprintf(err, errLen, "segment %d: longer than 30 s", i); return false; }
    s.durationMs = (uint32_t)lroundf(ms);
    total += s.cm;
  }
  if (total > 400) { snprintf(err, errLen, "route longer than 400 cm"); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class Controller {
 public:
  Limits lim;
  Outputs out{'S', 130};
  State state = State::IDLE;
  bool estopLatched = false;
  char reason[96] = "";
  char blocked[8] = "";

  // Autonomous / calibration run
  ParkRequest req{};
  char activeRid[RID_LEN] = "";
  char lastRid[RID_LEN] = "";
  int seg = -1;
  bool settling = false;
  uint32_t settleStartMs = 0;
  uint32_t moveStartMs = 0;
  uint32_t runStartMs = 0;
  uint32_t runLimitMs = 0;
  uint32_t segMovedMs = 0;  // motor-on time inside the current segment
  float doneCm = 0;         // straight distance of completed segments
  float segCm = 0;          // straight distance inside the current segment
  char calibMove = 'F';     // motion of the last calibration run
  uint32_t calibPlannedMs = 0;
  uint32_t calibMs = 0;     // last calibration run, actually driven

  // Manual
  int manualPwm = 130;
  uint32_t lastManualCmdMs = 0;
  bool timed = false;       // /timed move (bounded by its own end time instead of the watchdog)
  uint32_t timedEndMs = 0;

  // Heartbeat / odometry (cumulative motor-on time since boot)
  uint32_t lastClientMs = 0;
  uint32_t fwdMs = 0, revMs = 0, leftMs = 0, rightMs = 0;
  uint32_t lastTickMs = 0;
  bool ticked = false;

  // Obstacle debounce
  uint32_t lastFrontAt = 0, lastRearAt = 0;
  int frontHits = 0, rearHits = 0;
  uint32_t irSince = 0;
  bool irActive = false;

  // --- queries -------------------------------------------------------------
  bool autonomous() const { return isAutonomous(state); }
  bool runActive() const { return isAutonomous(state) || state == State::CALIBRATING; }
  float distCm() const { return doneCm + segCm; }
  float totalCm() const {
    float t = 0;
    for (int i = 0; i < req.segCount; i++) t += req.segs[i].cm;
    return t;
  }
  uint32_t elapsedMs(uint32_t now) const { return runActive() ? now - runStartMs : 0; }
  uint32_t segDurationMs() const { return (autonomous() && seg >= 0) ? req.segs[seg].durationMs : 0; }

  // --- inputs --------------------------------------------------------------
  void noteClient(uint32_t now) { lastClientMs = now; }

  // m: F/B/L/R/S. Must be repeated within manualWatchdogMs (hold-to-drive).
  Result manualCommand(char m, uint32_t now, const Sensors& s) {
    if (m == 'S') {
      timed = false;
      if (runActive()) {
        abort("stop command", now);
      } else {
        stopMotor();
        if (state == State::MANUAL) setState(State::IDLE, "manual stop");
      }
      return Result::OK;
    }
    if (!isMotion(m)) return Result::INVALID;
    if (estopLatched) return Result::LOCKED;
    if (runActive()) return Result::BUSY;
    if (isLatched(state)) return Result::LOCKED;
    if (isStraight(m) && lim.manualObstacleStop && obstacleAhead(m, s, lim.manualObstacleCm, now, lim.irStopManual, true)) {
      stopMotor();
      snprintf(blocked, sizeof(blocked), "%s", m == 'F' ? "front" : "rear");
      setState(State::IDLE, m == 'F' ? "manual blocked: front obstacle" : "manual blocked: rear obstacle");
      return Result::BLOCKED;
    }
    blocked[0] = '\0';
    if (state != State::MANUAL) setState(State::MANUAL, "");
    timed = false;
    lastManualCmdMs = now;
    out.motor = m;
    out.pwm = manualPwm;
    return Result::OK;
  }

  // Your web page's "Timed" buttons: move for `ms`, then stop by itself.
  Result timedCommand(char m, uint32_t ms, uint32_t now, const Sensors& s) {
    if (!isMotion(m) || ms < 1 || ms > lim.maxTimedMs) return Result::INVALID;
    Result r = manualCommand(m, now, s);
    if (r != Result::OK) return r;
    timed = true;
    timedEndMs = now + ms;
    return Result::OK;
  }

  Result setSpeed(int pwm) {
    if (runActive()) return Result::BUSY;
    if (pwm < 0) pwm = 0;
    if (pwm > 255) pwm = 255;
    manualPwm = pwm;
    out.pwm = pwm;
    return Result::OK;
  }

  Result startPark(const ParkRequest& r, uint32_t now, char* err, size_t errLen) {
    if (runActive()) {
      if (strcmp(r.rid, activeRid) == 0) return Result::DUPLICATE;
      snprintf(err, errLen, "a run is already active (%s)", stateName(state));
      return Result::BUSY;
    }
    if (r.rid[0] && strcmp(r.rid, lastRid) == 0) {
      snprintf(err, errLen, "request %s was already executed", r.rid);
      return Result::DUPLICATE;
    }
    if (estopLatched) { snprintf(err, errLen, "emergency stop latched; /reset first"); return Result::LOCKED; }
    if (isLatched(state)) { snprintf(err, errLen, "%s latched; /reset first", stateName(state)); return Result::LOCKED; }
    if (state == State::MANUAL && out.motor != 'S') { snprintf(err, errLen, "manual move in progress"); return Result::BUSY; }
    ParkRequest copy = r;
    if (!validateRequest(copy, err, errLen)) return Result::INVALID;
    req = copy;
    snprintf(activeRid, sizeof(activeRid), "%s", req.rid);
    snprintf(lastRid, sizeof(lastRid), "%s", req.rid);
    doneCm = 0;
    segCm = 0;
    timed = false;
    runStartMs = now;
    lastClientMs = now;
    uint32_t planned = 0;
    for (int i = 0; i < req.segCount; i++) planned += req.segs[i].durationMs + req.settleMs;
    runLimitMs = planned + lim.runMarginMs;
    blocked[0] = '\0';
    resetDebounce();
    beginSegment(0, now);
    return Result::OK;
  }

  // Timed calibration drive: F/B (speed: measure the distance) or L/R
  // (rotation: adjust ms until the rover turns exactly 90 degrees).
  Result startCalibration(char move, int pwm, uint32_t ms, float obstacleCm, uint32_t now, char* err, size_t errLen) {
    if (runActive()) { snprintf(err, errLen, "a run is already active"); return Result::BUSY; }
    if (estopLatched || isLatched(state)) { snprintf(err, errLen, "stop latched; /reset first"); return Result::LOCKED; }
    if (state == State::MANUAL && out.motor != 'S') { snprintf(err, errLen, "manual move in progress"); return Result::BUSY; }
    if (!isMotion(move)) { snprintf(err, errLen, "m must be F, B, L or R"); return Result::INVALID; }
    if (pwm < 1 || pwm > 255) { snprintf(err, errLen, "pwm must be 1..255"); return Result::INVALID; }
    if (ms < 100 || ms > 10000) { snprintf(err, errLen, "ms must be 100..10000"); return Result::INVALID; }
    if (!(obstacleCm >= 2 && obstacleCm <= 100)) { snprintf(err, errLen, "obst must be 2..100"); return Result::INVALID; }
    memset(&req, 0, sizeof(req));
    req.pwm = pwm;
    req.rpwm = pwm;
    req.obstacleCm = obstacleCm;
    req.hbMs = 3000;
    req.settleMs = lim.calibSettleMs;
    req.segCount = 0;
    activeRid[0] = '\0';
    calibMove = move;
    calibPlannedMs = ms;
    calibMs = 0;
    doneCm = segCm = 0;
    timed = false;
    runStartMs = now;
    lastClientMs = now;
    runLimitMs = ms + lim.calibSettleMs + lim.runMarginMs;
    settling = true;
    settleStartMs = now;
    resetDebounce();
    out.motor = 'S';
    out.pwm = pwm;
    setState(State::CALIBRATING, "");
    return Result::OK;
  }

  void abort(const char* why, uint32_t now) {
    if (state == State::CALIBRATING && !settling) calibMs = now - moveStartMs;
    bool wasRun = runActive();
    stopMotor();
    timed = false;
    if (wasRun) {
      finishRun(State::ABORTED, why);
    } else if (state == State::MANUAL) {
      setState(State::IDLE, why);
    }
  }

  void estop(uint32_t now) {
    abort("emergency stop", now);
    stopMotor();
    estopLatched = true;
    setState(State::ABORTED, "emergency stop");
  }

  Result reset(uint32_t now) {
    (void)now;
    if (runActive()) return Result::BUSY;
    stopMotor();
    estopLatched = false;
    blocked[0] = '\0';
    activeRid[0] = '\0';
    seg = -1;
    settling = false;
    timed = false;
    doneCm = segCm = 0;
    segMovedMs = 0;
    setState(State::IDLE, "reset");
    return Result::OK;
  }

  // Wi-Fi: the last station left the soft-AP.
  void clientsGone(uint32_t now) {
    if (runActive()) {
      if (state == State::CALIBRATING && !settling) calibMs = now - moveStartMs;
      stopMotor();
      finishRun(State::ERROR, "wifi client disconnected");
    } else if (out.motor != 'S') {
      stopMotor();
      timed = false;
      setState(State::IDLE, "wifi client disconnected");
    }
  }

  // Called every loop() iteration.
  void tick(uint32_t now, const Sensors& s) {
    if (ticked) {
      uint32_t dt = now - lastTickMs;
      if (out.motor == 'F') fwdMs += dt;
      else if (out.motor == 'B') revMs += dt;
      else if (out.motor == 'L') leftMs += dt;
      else if (out.motor == 'R') rightMs += dt;
    }
    ticked = true;
    lastTickMs = now;

    if (state == State::MANUAL) {
      tickManual(now, s);
      return;
    }
    if (!runActive()) {
      if (out.motor != 'S') stopMotor();  // nothing else may run the motors
      return;
    }

    // ---- autonomous / calibration run ----
    if (now - lastClientMs > req.hbMs) {
      if (state == State::CALIBRATING && !settling) calibMs = now - moveStartMs;
      stopMotor();
      finishRun(State::ERROR, "heartbeat lost");
      return;
    }
    if (now - runStartMs > runLimitMs) {
      stopMotor();
      finishRun(State::ERROR, "run time limit exceeded");
      return;
    }
    if (state == State::CALIBRATING) {
      tickCalibration(now, s);
      return;
    }

    Segment& g = req.segs[seg];
    if (settling) {
      out.motor = 'S';
      if (now - settleStartMs >= req.settleMs) {
        settling = false;
        moveStartMs = now;
        out.motor = g.move;
        out.pwm = isRotation(g.move) ? req.rpwm : req.pwm;
      }
      return;
    }

    uint32_t moved = now - moveStartMs;
    segMovedMs = moved;
    if (isStraight(g.move)) {
      segCm = req.cms * (float)moved / 1000.0f;
      if (segCm > g.cm) segCm = g.cm;

      // Safety in the direction of travel.
      char fault[48];
      if (sensorStale(g.move, s, now, fault, sizeof(fault))) {
        stopMotor();
        finishRun(State::ERROR, fault);
        return;
      }
      float limitCm = (g.phase == 'P') ? req.bayCm : req.obstacleCm;
      if (obstacleAhead(g.move, s, limitCm, now, req.irStop)) {
        stopMotor();
        char why[48];
        float d = g.move == 'F' ? s.front : s.rear;
        if (irActive && irFor(g.move, s)) snprintf(why, sizeof(why), "%s IR detection", g.move == 'F' ? "front" : "rear");
        else snprintf(why, sizeof(why), "%s %.1fcm", g.move == 'F' ? "front" : "rear", d);
        if (g.phase == 'P') {
          char done[96];
          snprintf(done, sizeof(done), "bay end reached (%s)", why);
          doneCm += segCm;
          segCm = 0;
          finishRun(State::COMPLETED, done);
        } else {
          finishRun(State::OBSTACLE_STOP, why);
        }
        return;
      }
    }
    // Rotations in place have no direction of travel; they are short, timed,
    // and still covered by the heartbeat, run-time limit, /abort and /estop.

    if (moved >= g.durationMs) {
      doneCm += g.cm;
      segCm = 0;
      if (seg + 1 >= req.segCount) {
        stopMotor();
        finishRun(State::COMPLETED, "route finished");
      } else {
        beginSegment(seg + 1, now);
      }
    }
  }

 private:
  void setState(State s, const char* why) {
    state = s;
    snprintf(reason, sizeof(reason), "%s", why ? why : "");
  }

  void stopMotor() { out.motor = 'S'; }

  void finishRun(State terminal, const char* why) {
    stopMotor();
    settling = false;
    activeRid[0] = '\0';
    setState(terminal, why);
  }

  void beginSegment(int i, uint32_t now) {
    seg = i;
    settling = true;
    settleStartMs = now;
    segCm = 0;
    segMovedMs = 0;
    out.motor = 'S';
    out.pwm = isRotation(req.segs[i].move) ? req.rpwm : req.pwm;
    resetDebounce();
    setState(phaseState(req.segs[i].phase), "");
  }

  void tickCalibration(uint32_t now, const Sensors& s) {
    if (settling) {
      out.motor = 'S';
      if (now - settleStartMs >= req.settleMs) {
        settling = false;
        moveStartMs = now;
        out.motor = calibMove;
        out.pwm = req.pwm;
      }
      return;
    }
    if (isStraight(calibMove)) {
      char fault[48];
      if (sensorStale(calibMove, s, now, fault, sizeof(fault))) {
        calibMs = now - moveStartMs;
        stopMotor();
        finishRun(State::ERROR, fault);
        return;
      }
      if (obstacleAhead(calibMove, s, req.obstacleCm, now, true)) {
        calibMs = now - moveStartMs;
        stopMotor();
        char why[48];
        snprintf(why, sizeof(why), "calibration: %s %.1fcm", calibMove == 'F' ? "front" : "rear", calibMove == 'F' ? s.front : s.rear);
        finishRun(State::OBSTACLE_STOP, why);
        return;
      }
    }
    if (now - moveStartMs >= calibPlannedMs) {
      calibMs = now - moveStartMs;
      stopMotor();
      finishRun(State::IDLE, "calibration finished");
    }
  }

  void tickManual(uint32_t now, const Sensors& s) {
    if (out.motor == 'S') return;
    if (timed) {
      if ((int32_t)(now - timedEndMs) >= 0) {
        stopMotor();
        timed = false;
        setState(State::IDLE, "timed move finished");
        return;
      }
    } else if (now - lastManualCmdMs > lim.manualWatchdogMs) {
      stopMotor();
      setState(State::IDLE, "manual watchdog: no repeat command");
      return;
    }
    if (isStraight(out.motor) && lim.manualObstacleStop && obstacleAhead(out.motor, s, lim.manualObstacleCm, now, lim.irStopManual)) {
      snprintf(blocked, sizeof(blocked), "%s", out.motor == 'F' ? "front" : "rear");
      stopMotor();
      timed = false;
      setState(State::IDLE, out.motor == 'F' ? "manual blocked: front obstacle" : "manual blocked: rear obstacle");
    }
  }

  void resetDebounce() {
    frontHits = rearHits = 0;
    irActive = false;
    irSince = 0;
  }

  static bool irFor(char dir, const Sensors& s) { return dir == 'F' ? (s.irFL || s.irFR) : (s.irRL || s.irRR); }

  bool sensorStale(char dir, const Sensors& s, uint32_t now, char* why, size_t len) const {
    uint32_t at = dir == 'F' ? s.frontAt : s.rearAt;
    if (now - at > lim.sensorMaxAgeMs) {
      snprintf(why, len, "%s ultrasonic not updating", dir == 'F' ? "front" : "rear");
      return true;
    }
    return false;
  }

  // Debounced: an ultrasonic stop needs `obstacleHitsToStop` consecutive NEW
  // readings at or below the limit; an IR stop needs the IR to stay active for
  // irDebounceMs. "No echo" (< 0) counts as clear.
  bool obstacleAhead(char dir, const Sensors& s, float limitCm, uint32_t now, bool useIr, bool immediate = false) {
    float d = dir == 'F' ? s.front : s.rear;
    uint32_t at = dir == 'F' ? s.frontAt : s.rearAt;
    uint32_t& lastAt = dir == 'F' ? lastFrontAt : lastRearAt;
    int& hits = dir == 'F' ? frontHits : rearHits;
    bool close = d >= 0 && d <= limitCm;
    if (immediate) return close || (useIr && irFor(dir, s));
    if (at != lastAt) {
      lastAt = at;
      hits = close ? hits + 1 : 0;
    }
    if (hits >= lim.obstacleHitsToStop) return true;
    if (useIr && irFor(dir, s)) {
      if (!irActive) {
        irActive = true;
        irSince = now;
      }
      if (now - irSince >= lim.irDebounceMs) return true;
    } else {
      irActive = false;
    }
    return false;
  }
};

// Text command for the UNO motor driver for the current output.
inline void unoCommandFor(const Outputs& o, char* buf, size_t len) {
  int pwm = o.pwm > 255 ? 255 : o.pwm;
  if (!isMotion(o.motor) || pwm <= 0) snprintf(buf, len, "S");
  else snprintf(buf, len, "%c,%d", o.motor, pwm % 256);
}

}  // namespace autopark
