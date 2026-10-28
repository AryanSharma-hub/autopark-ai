// StatusJson.h - JSON responses shared by the firmware and the host simulator
// (firmware/sim), so both speak byte-for-byte the same protocol.
#pragma once

#include <stdio.h>
#include <string.h>

#include "ParkingController.h"

namespace autopark {

inline int httpCodeFor(Result r) {
  switch (r) {
    case Result::OK: return 200;
    case Result::DUPLICATE: return 200;
    case Result::BUSY: return 409;
    case Result::BLOCKED: return 409;
    case Result::LOCKED: return 423;
    case Result::INVALID: return 400;
  }
  return 400;
}

// Copy `s` into `out` with JSON string escaping (quotes, backslashes, control chars dropped).
inline void jsonEscapeTo(const char* s, char* out, size_t len) {
  size_t j = 0;
  for (; s && *s && j + 2 < len; s++) {
    unsigned char c = (unsigned char)*s;
    if (c < 0x20) continue;
    if (c == '"' || c == '\\') out[j++] = '\\';
    out[j++] = (char)c;
  }
  out[j] = '\0';
}

inline void jsonDistanceTo(float v, char* out, size_t len) {
  if (v < 0) snprintf(out, len, "null");
  else snprintf(out, len, "%.1f", v);
}

inline int writeResultJson(char* buf, size_t len, Result r, const char* err, const Controller& c) {
  char e[100], rid[2 * RID_LEN];
  jsonEscapeTo(err, e, sizeof(e));
  jsonEscapeTo(c.lastRid, rid, sizeof(rid));
  bool ok = r == Result::OK || r == Result::DUPLICATE;
  return snprintf(buf, len, "{\"ok\":%s,\"result\":\"%s\",\"error\":\"%s\",\"state\":\"%s\",\"rid\":\"%s\"}",
                  ok ? "true" : "false", resultName(r), e, stateName(c.state), rid);
}

// Status for the app (/status). Sensor field names match the earlier /sensors
// response; the rest describes the controller state.
inline int writeStatusJson(char* buf, size_t len, const Controller& c, const Sensors& s, uint32_t now, const char* fw) {
  char f[16], r[16], l[16], rt[16], reason[200], rid[2 * RID_LEN], slot[8];
  jsonDistanceTo(s.front, f, sizeof(f));
  jsonDistanceTo(s.rear, r, sizeof(r));
  jsonDistanceTo(s.left, l, sizeof(l));
  jsonDistanceTo(s.right, rt, sizeof(rt));
  jsonEscapeTo(c.reason, reason, sizeof(reason));
  jsonEscapeTo(c.lastRid, rid, sizeof(rid));
  jsonEscapeTo(c.req.slot, slot, sizeof(slot));
  uint32_t lastAt = s.frontAt > s.rearAt ? s.frontAt : s.rearAt;
  int speed = c.runActive() ? c.out.pwm : c.manualPwm;
  bool auton = c.autonomous() && c.seg >= 0;
  char segMove = auton ? c.req.segs[c.seg].move : '-';
  char segPhase = auton ? c.req.segs[c.seg].phase : '-';
  return snprintf(
      buf, len,
      "{\"irFL\":%d,\"irFR\":%d,\"irRL\":%d,\"irRR\":%d,"
      "\"front\":%s,\"rear\":%s,\"left\":%s,\"right\":%s,"
      "\"speed\":%d,\"movement\":\"%c\","
      "\"fw\":\"%s\",\"uptime\":%lu,\"state\":\"%s\",\"reason\":\"%s\",\"estop\":%s,"
      "\"rid\":\"%s\",\"slot\":\"%s\",\"seg\":%d,\"segCount\":%d,\"segPhase\":\"%c\",\"segMove\":\"%c\","
      "\"settling\":%s,\"segMs\":%lu,\"segDurMs\":%lu,"
      "\"segDist\":%.2f,\"dist\":%.2f,\"total\":%.2f,\"elapsed\":%lu,\"cms\":%.2f,"
      "\"fwdMs\":%lu,\"revMs\":%lu,\"leftMs\":%lu,\"rightMs\":%lu,"
      "\"blocked\":\"%s\",\"calibMs\":%lu,\"calibMove\":\"%c\",\"sensorAge\":%lu}",
      (int)s.irFL, (int)s.irFR, (int)s.irRL, (int)s.irRR, f, r, l, rt, speed, c.out.motor, fw,
      (unsigned long)now, stateName(c.state), reason, c.estopLatched ? "true" : "false", rid, slot,
      auton ? c.seg : -1, c.req.segCount, segPhase, segMove, c.settling ? "true" : "false",
      (unsigned long)(auton && !c.settling ? c.segMovedMs : 0), (unsigned long)c.segDurationMs(),
      (double)c.segCm, (double)c.distCm(), (double)c.totalCm(), (unsigned long)c.elapsedMs(now), (double)c.req.cms,
      (unsigned long)c.fwdMs, (unsigned long)c.revMs, (unsigned long)c.leftMs, (unsigned long)c.rightMs,
      c.blocked, (unsigned long)c.calibMs, c.calibMove, (unsigned long)(now - lastAt));
}

// Your original /data response (used by the built-in web page), unchanged format.
inline int writeDataJson(char* buf, size_t len, const Controller& c, const Sensors& s) {
  const char* names[4] = {"Front", "Rear", "Left", "Right"};
  const char* irNames[4] = {"Front Left", "Front Right", "Rear Left", "Rear Right"};
  float d[4] = {s.front, s.rear, s.left, s.right};
  bool ir[4] = {s.irFL, s.irFR, s.irRL, s.irRR};
  int n = snprintf(buf, len, "{\"movement\":\"%c\",\"speed\":%d,\"distances\":[", c.out.motor, c.runActive() ? c.out.pwm : c.manualPwm);
  for (int i = 0; i < 4 && n > 0 && (size_t)n < len; i++)
    n += snprintf(buf + n, len - n, "%s{\"name\":\"%s\",\"cm\":%.1f}", i ? "," : "", names[i], (double)d[i]);
  if (n > 0 && (size_t)n < len) n += snprintf(buf + n, len - n, "],\"ir\":[");
  for (int i = 0; i < 4 && n > 0 && (size_t)n < len; i++)
    n += snprintf(buf + n, len - n, "%s{\"name\":\"%s\",\"detected\":%s}", i ? "," : "", irNames[i], ir[i] ? "true" : "false");
  if (n > 0 && (size_t)n < len) n += snprintf(buf + n, len - n, "],\"state\":\"%s\"}", stateName(c.state));
  return n;
}

}  // namespace autopark
