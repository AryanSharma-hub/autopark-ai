#pragma once
#include "Arduino.h"
#define MOTOR12_1KHZ 1
#define MOTOR34_1KHZ 1
enum { FORWARD = 1, BACKWARD = 2, RELEASE = 4 };
struct AF_DCMotor {
  int port, speed = 0, mode = RELEASE;
  AF_DCMotor(int p, int) : port(p) {}
  void setSpeed(int s) { speed = s; }
  void run(int m) { mode = m; }
};
