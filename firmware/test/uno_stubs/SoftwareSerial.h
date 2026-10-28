#pragma once
#include "Arduino.h"
#include <string>
struct SoftwareSerial {
  std::string in;
  SoftwareSerial(int, int) {}
  void begin(long) {}
  int available() { return (int)in.size(); }
  char read() { char c = in[0]; in.erase(0, 1); return c; }
};
