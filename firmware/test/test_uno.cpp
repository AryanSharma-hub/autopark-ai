// Host test of firmware/uno_motor/uno_motor.ino command handling (AFMotor/SoftwareSerial stubbed).
//   g++ -std=c++17 -Iuno_stubs -x c++ test_uno.cpp -o test_uno && ./test_uno
#include "Arduino.h"
#include "../uno_motor/uno_motor.ino"
#include <cstdio>
static int fails = 0, checks = 0;
#define CHECK(c) do { checks++; if (!(c)) { fails++; std::printf("FAIL line %d: %s\n", __LINE__, #c); } } while (0)
static void send(const char* s) { espLink.in += s; espLink.in += "\n"; loop(); }
static bool all(int mode) { return motorFL.mode == mode && motorFR.mode == mode && motorRL.mode == mode && motorRR.mode == mode; }
int main() {
  setup();
  send("F,150");                       // ignored before the first heartbeat
  CHECK(all(RELEASE));
  send("H");
  send("F,150");
  CHECK(all(FORWARD) && motorFL.speed == 150);
  send("B,90");
  CHECK(all(BACKWARD) && motorRR.speed == 90);
  send("L,170");                       // NEW: rotate left at an explicit speed
  CHECK(motorFL.mode == BACKWARD && motorRL.mode == BACKWARD && motorFR.mode == FORWARD && motorRR.mode == FORWARD);
  CHECK(motorFL.speed == 170 && motorFR.speed == 170);
  send("R,120");
  CHECK(motorFL.mode == FORWARD && motorRL.mode == FORWARD && motorFR.mode == BACKWARD && motorRR.mode == BACKWARD);
  CHECK(motorRR.speed == 120);
  send("L");                           // old form still works, last speed
  CHECK(motorFL.mode == BACKWARD && motorFL.speed == 120);
  send("S");
  CHECK(all(RELEASE));
  send("F,999");                       // out of range -> stop
  CHECK(all(RELEASE));
  send("X,10");                        // unknown -> stop
  CHECK(all(RELEASE));
  send("F,100");
  CHECK(all(FORWARD));
  fakeMillis() += 1001;                // heartbeat lost
  loop();
  CHECK(all(RELEASE));
  std::printf("%d checks, %d failures\n", checks, fails);
  return fails ? 1 : 0;
}
