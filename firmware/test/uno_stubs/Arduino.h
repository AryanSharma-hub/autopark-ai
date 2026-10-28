#pragma once
#include <cstdint>
#include <cstring>
#include <cstdio>
#define A0 14
#define A1 15
inline unsigned long& fakeMillis() { static unsigned long t = 0; return t; }
inline unsigned long millis() { return fakeMillis(); }
template <class T> T constrain(T v, T lo, T hi) { return v < lo ? lo : v > hi ? hi : v; }
