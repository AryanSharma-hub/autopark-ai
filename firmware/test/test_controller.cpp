// Host-side unit tests for ParkingController.h (no hardware).
//   g++ -std=c++17 -Wall -Wextra -I../autopark_esp32 test_controller.cpp -o test_controller && ./test_controller
#include "ParkingController.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

using namespace autopark;

static int failures = 0, checks = 0;
#define CHECK(cond)                                                              \
  do {                                                                           \
    checks++;                                                                    \
    if (!(cond)) {                                                               \
      failures++;                                                                \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);              \
    }                                                                            \
  } while (0)
#define CHECK_STATE(c, s) CHECK((c).state == (s))

struct Sim {
  Controller c;
  Sensors s{};
  uint32_t now = 1000;
  Sim() {
    s.front = 80;
    s.rear = 80;
    s.left = 30;
    s.right = 30;
    s.frontAt = s.rearAt = now;
  }
  // Advance time in 10 ms ticks; sensors refresh every 30 ms; the app polls every `pollMs` (0 = never).
  void run(uint32_t ms, uint32_t pollMs = 300) {
    for (uint32_t t = 0; t < ms; t += 10) {
      now += 10;
      if (now % 30 == 0) s.frontAt = s.rearAt = now;
      if (pollMs && now % pollMs == 0) c.noteClient(now);
      c.tick(now, s);
    }
  }
};

static ParkRequest makeReq(const char* rid = "rid-0001", const char* segs = "A,F,20.00;T,L,1200;P,F,3.00") {
  ParkRequest r{};
  std::snprintf(r.rid, sizeof(r.rid), "%s", rid);
  std::snprintf(r.slot, sizeof(r.slot), "S3");
  r.pwm = 130;
  r.rpwm = 150;
  r.cms = 20.0f;
  char err[64];
  parseSegments(segs, r.segs, r.segCount, err, sizeof(err));
  r.obstacleCm = 12;
  r.bayCm = 6;
  r.irStop = true;
  r.hbMs = 2000;
  r.settleMs = 400;
  return r;
}

static void test(const char* name, const std::function<void()>& fn) {
  int before = failures;
  fn();
  std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", name);
}

int main() {
  test("parse segments (straight = cm, rotation = ms)", [] {
    Segment s[MAX_SEGMENTS];
    int n = 0;
    char err[64];
    CHECK(parseSegments("A,F,30.50;T,R,1180;P,B,3.00", s, n, err, sizeof err));
    CHECK(n == 3);
    CHECK(s[0].phase == 'A' && s[0].move == 'F' && std::fabs(s[0].cm - 30.5f) < 1e-4);
    CHECK(s[1].phase == 'T' && s[1].move == 'R' && s[1].durationMs == 1180 && s[1].cm == 0);
    CHECK(s[2].move == 'B');
    CHECK(!parseSegments("", s, n, err, sizeof err));
    CHECK(!parseSegments("A,F", s, n, err, sizeof err));
    CHECK(!parseSegments("A,F,1;A,F,1;A,F,1;A,F,1;A,F,1;A,F,1;A,F,1", s, n, err, sizeof err));
    CHECK(!parseSegments("A,F,x", s, n, err, sizeof err));
  });

  test("validate request + durations", [] {
    char err[64];
    ParkRequest r = makeReq();
    CHECK(validateRequest(r, err, sizeof err));
    CHECK(r.segs[0].durationMs == 1000);  // 20 cm at 20 cm/s
    CHECK(r.segs[1].durationMs == 1200);  // rotation: as given
    CHECK(r.segs[2].durationMs == 150);   // 3 cm
    ParkRequest bad = makeReq("rid-0001", "T,F,1200");  // a turn must rotate
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq("rid-0001", "A,L,20");  // approach must be straight
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq("rid-0001", "T,L,20");  // implausibly short rotation
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq("rid-0001", "T,L,20000");
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq();
    bad.cms = 0;
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq();
    bad.rpwm = 0;
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq();
    std::snprintf(bad.slot, sizeof bad.slot, "S6");
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq("x y!");
    CHECK(!validateRequest(bad, err, sizeof err));
    bad = makeReq();
    bad.segs[0].phase = 'Z';
    CHECK(!validateRequest(bad, err, sizeof err));
  });

  test("UNO command text", [] {
    char b[12];
    unoCommandFor(Outputs{'F', 130}, b, sizeof b);
    CHECK(std::strcmp(b, "F,130") == 0);
    unoCommandFor(Outputs{'L', 150}, b, sizeof b);
    CHECK(std::strcmp(b, "L,150") == 0);
    unoCommandFor(Outputs{'S', 150}, b, sizeof b);
    CHECK(std::strcmp(b, "S") == 0);
    unoCommandFor(Outputs{'F', 0}, b, sizeof b);
    CHECK(std::strcmp(b, "S") == 0);
  });

  test("full parking run: APPROACHING -> TURNING (rotate) -> PARKING -> COMPLETED", [] {
    Sim m;
    char err[64] = "";
    CHECK(m.c.startPark(makeReq(), m.now, err, sizeof err) == Result::OK);
    CHECK_STATE(m.c, State::APPROACHING);
    CHECK(m.c.settling && m.c.out.motor == 'S');
    m.run(400);
    CHECK(m.c.out.motor == 'F' && m.c.out.pwm == 130);
    m.run(500);
    CHECK(m.c.distCm() > 9.0f && m.c.distCm() < 11.0f);  // ~0.5 s at 20 cm/s
    m.run(520);
    CHECK_STATE(m.c, State::TURNING);
    CHECK(m.c.out.motor == 'S' && m.c.settling);  // stop before rotating
    m.run(400);
    CHECK(m.c.out.motor == 'L' && m.c.out.pwm == 150);  // rotation PWM
    CHECK(m.c.segDurationMs() == 1200);
    m.run(1210);
    CHECK_STATE(m.c, State::PARKING);
    m.run(400 + 160);
    CHECK_STATE(m.c, State::COMPLETED);
    CHECK(m.c.out.motor == 'S');
    CHECK(std::fabs(m.c.distCm() - 23.0f) < 0.01f);  // rotations add no distance
    CHECK(std::strcmp(m.c.reason, "route finished") == 0);
  });

  test("rotation ignores the ultrasonics (no direction of travel)", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq("rid-0101", "T,R,1500"), m.now, err, sizeof err);
    m.run(500);
    CHECK(m.c.out.motor == 'R');
    m.s.front = 3;
    m.s.rear = 3;
    m.run(300);
    CHECK_STATE(m.c, State::TURNING);
    CHECK(m.c.out.motor == 'R');
  });

  test("duplicate request id is ignored while running and after completion", [] {
    Sim m;
    char err[64];
    CHECK(m.c.startPark(makeReq(), m.now, err, sizeof err) == Result::OK);
    CHECK(m.c.startPark(makeReq(), m.now, err, sizeof err) == Result::DUPLICATE);
    CHECK(m.c.startPark(makeReq("rid-0002"), m.now, err, sizeof err) == Result::BUSY);
    m.run(8000);
    CHECK_STATE(m.c, State::COMPLETED);
    CHECK(m.c.startPark(makeReq(), m.now, err, sizeof err) == Result::DUPLICATE);  // never re-run the same request
    CHECK(m.c.startPark(makeReq("rid-0003"), m.now, err, sizeof err) == Result::OK);
  });

  test("front obstacle during approach -> OBSTACLE_STOP (latched)", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(700);
    CHECK(m.c.out.motor == 'F');
    m.s.front = 9.0f;  // single reading below 12 cm: debounced, keep going
    m.now += 10; m.s.frontAt = m.now; m.c.noteClient(m.now); m.c.tick(m.now, m.s);
    CHECK(m.c.out.motor == 'F');
    m.now += 30; m.s.frontAt = m.now; m.c.tick(m.now, m.s);  // second fresh reading
    CHECK_STATE(m.c, State::OBSTACLE_STOP);
    CHECK(m.c.out.motor == 'S');
    CHECK(std::strncmp(m.c.reason, "front 9.0cm", 11) == 0);
    m.s.front = 80;
    CHECK(m.c.manualCommand('F', m.now, m.s) == Result::LOCKED);
    CHECK(m.c.manualCommand('L', m.now, m.s) == Result::LOCKED);
    char err2[64];
    CHECK(m.c.startPark(makeReq("rid-9999"), m.now, err2, sizeof err2) == Result::LOCKED);
    CHECK(m.c.reset(m.now) == Result::OK);
    CHECK_STATE(m.c, State::IDLE);
    CHECK(m.c.manualCommand('F', m.now, m.s) == Result::OK);
  });

  test("single noisy echo does not stop the run", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(700);
    m.s.front = 5;
    m.now += 30; m.s.frontAt = m.now; m.c.noteClient(m.now); m.c.tick(m.now, m.s);
    m.s.front = 80;
    m.now += 30; m.s.frontAt = m.now; m.c.tick(m.now, m.s);
    CHECK_STATE(m.c, State::APPROACHING);
    CHECK(m.c.out.motor == 'F');
  });

  test("'no echo' (-1) counts as clear", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.s.front = -1;
    m.run(1500);  // 400 ms settle + 1000 ms approach
    CHECK_STATE(m.c, State::TURNING);
  });

  test("IR detection stops forward travel after debounce", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(600);
    m.s.irFR = true;
    m.run(20);
    CHECK(m.c.out.motor == 'F');
    m.run(40);
    CHECK_STATE(m.c, State::OBSTACLE_STOP);
    CHECK(std::strstr(m.c.reason, "IR") != nullptr);
  });

  test("bay-end ultrasonic during PARKING completes the manoeuvre", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq("rid-0005", "A,F,10.00;P,F,20.00"), m.now, err, sizeof err);
    m.run(400 + 510 + 400 + 300);
    CHECK_STATE(m.c, State::PARKING);
    m.s.front = 5.5f;
    m.run(80);
    CHECK_STATE(m.c, State::COMPLETED);
    CHECK(std::strstr(m.c.reason, "bay end") != nullptr);
  });

  test("reverse segments watch the REAR sensor", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq("rid-0006", "P,B,30.00"), m.now, err, sizeof err);
    m.run(500);
    CHECK(m.c.out.motor == 'B');
    m.s.front = 3;  // front is irrelevant when reversing
    m.run(100);
    CHECK(m.c.out.motor == 'B');
    m.s.rear = 4;
    m.run(100);
    CHECK_STATE(m.c, State::COMPLETED);  // in the bay-entry phase the rear sensor ends the manoeuvre
    CHECK(std::strstr(m.c.reason, "rear") != nullptr);
  });

  test("heartbeat loss aborts autonomous run with ERROR (also while rotating)", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(1000, 0);  // app silent
    CHECK(m.c.out.motor == 'F');
    m.run(1100, 0);
    CHECK_STATE(m.c, State::ERROR);
    CHECK(std::strcmp(m.c.reason, "heartbeat lost") == 0);
    CHECK(m.c.out.motor == 'S');
    Sim k;
    k.c.startPark(makeReq("rid-0102", "T,L,5000"), k.now, err, sizeof err);
    k.run(600);
    CHECK(k.c.out.motor == 'L');
    k.run(2100, 0);
    CHECK_STATE(k.c, State::ERROR);
    CHECK(k.c.out.motor == 'S');
  });

  test("stale front sensor during straight motion -> ERROR", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(500);
    uint32_t frozen = m.s.frontAt;
    for (int i = 0; i < 80; i++) {
      m.now += 10;
      m.s.frontAt = frozen;
      m.s.rearAt = m.now;
      m.c.noteClient(m.now);
      m.c.tick(m.now, m.s);
    }
    CHECK_STATE(m.c, State::ERROR);
    CHECK(std::strstr(m.c.reason, "not updating") != nullptr);
  });

  test("Wi-Fi client disconnect stops everything", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(600);
    m.c.clientsGone(m.now);
    CHECK_STATE(m.c, State::ERROR);
    CHECK(m.c.out.motor == 'S');
    Sim k;
    k.c.manualCommand('R', k.now, k.s);
    k.c.clientsGone(k.now);
    CHECK(k.c.out.motor == 'S');
  });

  test("abort and /cmd?m=S during a run -> ABORTED", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(600);
    m.c.abort("user abort", m.now);
    CHECK_STATE(m.c, State::ABORTED);
    CHECK(m.c.out.motor == 'S');
    Sim k;
    k.c.startPark(makeReq(), k.now, err, sizeof err);
    k.run(600);
    CHECK(k.c.manualCommand('S', k.now, k.s) == Result::OK);
    CHECK_STATE(k.c, State::ABORTED);
  });

  test("emergency stop latches and needs /reset", [] {
    Sim m;
    m.c.manualCommand('F', m.now, m.s);
    m.c.estop(m.now);
    CHECK(m.c.out.motor == 'S' && m.c.estopLatched);
    CHECK_STATE(m.c, State::ABORTED);
    CHECK(m.c.manualCommand('F', m.now, m.s) == Result::LOCKED);
    CHECK(m.c.manualCommand('R', m.now, m.s) == Result::LOCKED);
    char err[64];
    CHECK(m.c.startPark(makeReq(), m.now, err, sizeof err) == Result::LOCKED);
    m.run(500);
    CHECK(m.c.out.motor == 'S');
    CHECK(m.c.reset(m.now) == Result::OK);
    CHECK(!m.c.estopLatched);
    CHECK(m.c.manualCommand('F', m.now, m.s) == Result::OK);
  });

  test("manual commands rejected during autonomous run (no conflicts)", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.run(500);
    CHECK(m.c.manualCommand('B', m.now, m.s) == Result::BUSY);
    CHECK(m.c.manualCommand('L', m.now, m.s) == Result::BUSY);
    CHECK(m.c.timedCommand('F', 2000, m.now, m.s) == Result::BUSY);
    CHECK(m.c.setSpeed(255) == Result::BUSY);
    CHECK(m.c.out.motor == 'F' && m.c.out.pwm == 130);
  });

  test("manual watchdog stops a move that is not repeated (F and rotate)", [] {
    Sim m;
    CHECK(m.c.manualCommand('F', m.now, m.s) == Result::OK);
    CHECK_STATE(m.c, State::MANUAL);
    m.run(900, 300);  // status polls do NOT keep a manual move alive
    CHECK(m.c.out.motor == 'F');
    m.run(200, 300);
    CHECK(m.c.out.motor == 'S');
    CHECK_STATE(m.c, State::IDLE);
    CHECK(m.c.manualCommand('L', m.now, m.s) == Result::OK);
    m.run(1100);
    CHECK(m.c.out.motor == 'S');
    // repeating the command keeps it going
    m.c.manualCommand('B', m.now, m.s);
    for (int i = 0; i < 10; i++) {
      m.run(300);
      m.c.manualCommand('B', m.now, m.s);
    }
    CHECK(m.c.out.motor == 'B');
  });

  test("timed moves (your web page) run for their duration, then stop", [] {
    Sim m;
    CHECK(m.c.timedCommand('R', 3000, m.now, m.s) == Result::OK);
    m.run(2900);  // no repeats needed
    CHECK(m.c.out.motor == 'R');
    m.run(200);
    CHECK(m.c.out.motor == 'S');
    CHECK_STATE(m.c, State::IDLE);
    CHECK(m.c.timedCommand('F', 0, m.now, m.s) == Result::INVALID);
    CHECK(m.c.timedCommand('F', 61000, m.now, m.s) == Result::INVALID);
    CHECK(m.c.timedCommand('F', 5000, m.now, m.s) == Result::OK);
    m.s.front = 6;  // obstacle still stops a timed forward move
    m.run(100);
    CHECK(m.c.out.motor == 'S');
    CHECK(m.c.timedCommand('F', 5000, m.now, m.s) == Result::BLOCKED);
    m.s.front = 80;
    CHECK(m.c.timedCommand('F', 5000, m.now, m.s) == Result::OK);
    m.c.manualCommand('S', m.now, m.s);  // STOP cancels it
    CHECK(m.c.out.motor == 'S');
  });

  test("manual obstacle protection refuses / stops straight moves (rotation allowed)", [] {
    Sim m;
    m.s.front = 8;
    CHECK(m.c.manualCommand('F', m.now, m.s) == Result::BLOCKED);
    CHECK(m.c.out.motor == 'S');
    CHECK(m.c.manualCommand('B', m.now, m.s) == Result::OK);  // can still back away
    CHECK(m.c.manualCommand('L', m.now, m.s) == Result::OK);  // or rotate away
    m.c.manualCommand('S', m.now, m.s);
    m.s.front = 80;
    m.c.manualCommand('F', m.now, m.s);
    m.s.front = 7;
    m.run(100);
    CHECK(m.c.out.motor == 'S');
    CHECK(std::strcmp(m.c.blocked, "front") == 0);
  });

  test("speed setting clamps and applies to manual moves", [] {
    Sim m;
    m.c.setSpeed(400);
    CHECK(m.c.manualPwm == 255);
    m.c.setSpeed(-3);
    CHECK(m.c.manualPwm == 0);
    m.c.setSpeed(170);
    m.c.manualCommand('F', m.now, m.s);
    CHECK(m.c.out.pwm == 170);
  });

  test("motor-time odometry counters (straight and rotation)", [] {
    Sim m;
    m.c.manualCommand('F', m.now, m.s);
    m.run(500);
    m.c.manualCommand('B', m.now, m.s);
    m.run(300);
    m.c.manualCommand('L', m.now, m.s);
    m.run(200);
    m.c.manualCommand('R', m.now, m.s);
    m.run(400);
    m.c.manualCommand('S', m.now, m.s);
    CHECK(m.c.fwdMs >= 490 && m.c.fwdMs <= 510);
    CHECK(m.c.revMs >= 290 && m.c.revMs <= 310);
    CHECK(m.c.leftMs >= 190 && m.c.leftMs <= 210);
    CHECK(m.c.rightMs >= 390 && m.c.rightMs <= 410);
  });

  test("speed calibration run drives straight for the requested time", [] {
    Sim m;
    char err[64];
    CHECK(m.c.startCalibration('F', 130, 3000, 12, m.now, err, sizeof err) == Result::OK);
    CHECK_STATE(m.c, State::CALIBRATING);
    m.run(300 + 3010);
    CHECK_STATE(m.c, State::IDLE);
    CHECK(m.c.calibMs >= 3000 && m.c.calibMs <= 3020);
    CHECK(m.c.out.motor == 'S');
  });

  test("rotation calibration rotates for the requested time at the requested PWM", [] {
    Sim m;
    char err[64];
    CHECK(m.c.startCalibration('L', 150, 1250, 12, m.now, err, sizeof err) == Result::OK);
    m.run(300 + 100);
    CHECK(m.c.out.motor == 'L' && m.c.out.pwm == 150);
    m.s.front = 3;  // rotation calibration ignores the front sensor
    m.run(1200);
    CHECK_STATE(m.c, State::IDLE);
    CHECK(m.c.calibMove == 'L');
    CHECK(m.c.calibMs >= 1250 && m.c.calibMs <= 1270);
    CHECK(m.c.out.motor == 'S');
    CHECK(m.c.startCalibration('X', 150, 1250, 12, m.now, err, sizeof err) == Result::INVALID);
    CHECK(m.c.startCalibration('R', 150, 50, 12, m.now, err, sizeof err) == Result::INVALID);
  });

  test("calibration stops at an obstacle and reports the real time driven", [] {
    Sim m;
    char err[64];
    m.c.startCalibration('F', 130, 3000, 12, m.now, err, sizeof err);
    m.run(1300);
    m.s.front = 10;
    m.run(100);
    CHECK_STATE(m.c, State::OBSTACLE_STOP);
    CHECK(m.c.calibMs > 900 && m.c.calibMs < 1200);
  });

  test("run time limit guard", [] {
    Sim m;
    char err[64];
    m.c.startPark(makeReq(), m.now, err, sizeof err);
    m.c.runLimitMs = 500;  // simulate a stuck plan
    m.run(600);
    CHECK_STATE(m.c, State::ERROR);
  });

  test("idle controller never runs the motors", [] {
    Sim m;
    m.c.out.motor = 'L';  // e.g. corrupted output
    m.run(20);
    CHECK(m.c.out.motor == 'S');
  });

  std::printf("\n%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
