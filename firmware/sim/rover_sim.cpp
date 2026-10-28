// rover_sim - runs the REAL firmware controller (ParkingController.h +
// StatusJson.h) behind the same HTTP endpoints as the ESP32, on a PC.
//
// Used by the app's integration tests and for trying the app without the
// rover:   ./rover_sim [port]      (default 8080)
//
// Hardware is simulated: motor outputs (and the UNO command text) are recorded, ultrasonic readings
// are refreshed every 30 ms with values set through /sim/*:
//   GET /sim/sensors?front=8&rear=-1&irFR=1   set sensor values (cm, -1 = no echo)
//   GET /sim/freeze?front=1                   stop refreshing the front sensor
//   GET /sim/disconnect                       simulate the last Wi-Fi client leaving
//   GET /sim/outputs                          motor/pwm/uno command as JSON
//
// Build: g++ -std=c++17 -O2 -I../autopark_esp32 rover_sim.cpp -o rover_sim
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>

#include "ParkingController.h"
#include "StatusJson.h"

using namespace autopark;

static Controller ctl;
static Sensors sens;
static bool freezeFront = false, freezeRear = false;
static auto t0 = std::chrono::steady_clock::now();

static uint32_t nowMs() {
  return (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count() + 1000;
}

static std::string urlDecode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '+') out += ' ';
    else if (s[i] == '%' && i + 2 < s.size()) {
      out += (char)strtol(s.substr(i + 1, 2).c_str(), nullptr, 16);
      i += 2;
    } else out += s[i];
  }
  return out;
}

static std::map<std::string, std::string> parseForm(const std::string& q) {
  std::map<std::string, std::string> m;
  size_t p = 0;
  while (p < q.size()) {
    size_t amp = q.find('&', p);
    std::string kv = q.substr(p, amp == std::string::npos ? std::string::npos : amp - p);
    size_t eq = kv.find('=');
    if (eq != std::string::npos) m[urlDecode(kv.substr(0, eq))] = urlDecode(kv.substr(eq + 1));
    else if (!kv.empty()) m[urlDecode(kv)] = "";
    if (amp == std::string::npos) break;
    p = amp + 1;
  }
  return m;
}

struct Response {
  int code = 200;
  std::string type = "application/json";
  std::string body;
};

static Response result(Result r, const char* err) {
  char buf[400];
  writeResultJson(buf, sizeof buf, r, err, ctl);
  return {httpCodeFor(r), "application/json", buf};
}

static Response route(const std::string& method, const std::string& path, std::map<std::string, std::string> a) {
  uint32_t now = nowMs();
  ctl.noteClient(now);
  auto arg = [&](const char* k) { return a.count(k) ? a[k] : std::string(); };
  char err[96] = "";
  if (path == "/status" || path == "/sensors") {
    char buf[1200];
    writeStatusJson(buf, sizeof buf, ctl, sens, now, "autopark-uno-2.0-sim");
    return {200, "application/json", buf};
  }
  if (path == "/ping") return {200, "text/plain", "OK"};
  if (path == "/cmd") {
    std::string m = arg("m");
    Result r = m.size() == 1 ? ctl.manualCommand(m[0], now, sens) : Result::INVALID;
    if (r == Result::OK) return {200, "text/plain", "OK"};
    return {httpCodeFor(r), "text/plain", std::string(resultName(r)) + ": " + ctl.reason};
  }
  if (path == "/timed") {
    std::string m = arg("m");
    long ms = a.count("ms") ? atol(arg("ms").c_str()) : atol(arg("seconds").c_str()) * 1000L;
    Result r = (m.size() == 1 && ms > 0) ? ctl.timedCommand(m[0], (uint32_t)ms, now, sens) : Result::INVALID;
    if (r == Result::OK) return {200, "text/plain", "Timed movement started"};
    return {httpCodeFor(r), "text/plain", std::string(resultName(r)) + ": " + ctl.reason};
  }
  if (path == "/speed") {
    std::string v = a.count("v") ? arg("v") : arg("value");
    Result r = v.empty() ? Result::INVALID : ctl.setSpeed(atoi(v.c_str()));
    if (r == Result::OK && ctl.state == State::MANUAL && ctl.out.motor != 'S') ctl.out.pwm = ctl.manualPwm;
    if (r == Result::OK) return {200, "text/plain", "OK"};
    return {httpCodeFor(r), "text/plain", std::string(resultName(r)) + ": " + ctl.reason};
  }
  if (path == "/data") {
    char buf[700];
    writeDataJson(buf, sizeof buf, ctl, sens);
    return {200, "application/json", buf};
  }
  if (path == "/park") {
    if (method != "POST") return {405, "text/plain", "POST required"};
    ParkRequest r;
    memset(&r, 0, sizeof r);
    if (arg("slot").size() != 2 || arg("rid").size() >= sizeof r.rid) return result(Result::INVALID, "slot/rid malformed");
    memcpy(r.rid, arg("rid").c_str(), arg("rid").size() + 1);
    memcpy(r.slot, arg("slot").c_str(), 3);
    r.pwm = atoi(arg("pwm").c_str());
    r.rpwm = a.count("rpwm") ? atoi(arg("rpwm").c_str()) : r.pwm;
    r.cms = strtof(arg("cms").c_str(), nullptr);
    r.obstacleCm = strtof(arg("obst").c_str(), nullptr);
    r.bayCm = strtof(arg("bay").c_str(), nullptr);
    r.irStop = arg("ir") == "1";
    r.hbMs = (uint32_t)atoi(arg("hb").c_str());
    r.settleMs = (uint32_t)atoi(arg("settle").c_str());
    if (!parseSegments(arg("segs").c_str(), r.segs, r.segCount, err, sizeof err)) return result(Result::INVALID, err);
    return result(ctl.startPark(r, now, err, sizeof err), err);
  }
  if (path == "/calib") {
    if (method != "POST") return {405, "text/plain", "POST required"};
    float obst = a.count("obst") ? strtof(arg("obst").c_str(), nullptr) : ctl.lim.manualObstacleCm;
    std::string m = a.count("m") ? arg("m") : std::string("F");
    if (m.size() != 1) return result(Result::INVALID, "m must be F, B, L or R");
    return result(ctl.startCalibration(m[0], atoi(arg("pwm").c_str()), (uint32_t)atoi(arg("ms").c_str()), obst, now, err, sizeof err), err);
  }
  if (path == "/abort") {
    ctl.abort("abort command", now);
    return result(Result::OK, "");
  }
  if (path == "/estop") {
    ctl.estop(now);
    return result(Result::OK, "");
  }
  if (path == "/reset") {
    Result r = ctl.reset(now);
    return result(r, r == Result::BUSY ? "abort the active run first" : "");
  }
  if (path == "/config") {
    if (a.count("obst")) { float v = strtof(arg("obst").c_str(), nullptr); if (v >= 2 && v <= 100) ctl.lim.manualObstacleCm = v; }
    if (a.count("mwd")) { long v = atol(arg("mwd").c_str()); if (v >= 300 && v <= 5000) ctl.lim.manualWatchdogMs = (uint32_t)v; }
    if (a.count("mobst")) ctl.lim.manualObstacleStop = arg("mobst") == "1";
    if (a.count("ir")) ctl.lim.irStopManual = arg("ir") == "1";
    char j[96];
    snprintf(j, sizeof j, "{\"obst\":%.1f,\"mwd\":%lu,\"mobst\":%d,\"ir\":%d}", ctl.lim.manualObstacleCm,
             (unsigned long)ctl.lim.manualWatchdogMs, ctl.lim.manualObstacleStop ? 1 : 0, ctl.lim.irStopManual ? 1 : 0);
    return {200, "application/json", j};
  }
  if (path == "/sim/sensors") {
    if (a.count("front")) sens.front = strtof(arg("front").c_str(), nullptr);
    if (a.count("rear")) sens.rear = strtof(arg("rear").c_str(), nullptr);
    if (a.count("left")) sens.left = strtof(arg("left").c_str(), nullptr);
    if (a.count("right")) sens.right = strtof(arg("right").c_str(), nullptr);
    if (a.count("irFL")) sens.irFL = arg("irFL") == "1";
    if (a.count("irFR")) sens.irFR = arg("irFR") == "1";
    if (a.count("irRL")) sens.irRL = arg("irRL") == "1";
    if (a.count("irRR")) sens.irRR = arg("irRR") == "1";
    return {200, "text/plain", "OK"};
  }
  if (path == "/sim/freeze") {
    freezeFront = arg("front") == "1";
    freezeRear = arg("rear") == "1";
    return {200, "text/plain", "OK"};
  }
  if (path == "/sim/disconnect") {
    ctl.clientsGone(now);
    return {200, "text/plain", "OK"};
  }
  if (path == "/sim/outputs") {
    char j[128], uno[16];
    unoCommandFor(ctl.out, uno, sizeof uno);
    snprintf(j, sizeof j, "{\"motor\":\"%c\",\"pwm\":%d,\"uno\":\"%s\"}", ctl.out.motor, ctl.out.pwm, uno);
    return {200, "application/json", j};
  }
  if (path == "/") return {200, "text/html", "<html><body>rover_sim: firmware controller simulator</body></html>"};
  return {404, "text/plain", "Not found"};
}

static void handle(int fd) {
  std::string req;
  char buf[4096];
  size_t headerEnd = std::string::npos;
  size_t contentLength = 0;
  for (int i = 0; i < 200; i++) {
    struct pollfd p{fd, POLLIN, 0};
    if (poll(&p, 1, 50) <= 0) continue;
    ssize_t n = recv(fd, buf, sizeof buf, 0);
    if (n <= 0) break;
    req.append(buf, (size_t)n);
    if (headerEnd == std::string::npos) {
      headerEnd = req.find("\r\n\r\n");
      if (headerEnd != std::string::npos) {
        std::string lower = req.substr(0, headerEnd);
        for (auto& ch : lower) ch = (char)tolower(ch);
        size_t cl = lower.find("content-length:");
        if (cl != std::string::npos) contentLength = (size_t)atol(lower.c_str() + cl + 15);
      }
    }
    if (headerEnd != std::string::npos && req.size() >= headerEnd + 4 + contentLength) break;
  }
  if (headerEnd == std::string::npos) {
    close(fd);
    return;
  }
  size_t sp1 = req.find(' ');
  size_t sp2 = req.find(' ', sp1 + 1);
  std::string method = req.substr(0, sp1);
  std::string target = req.substr(sp1 + 1, sp2 - sp1 - 1);
  std::string path = target, query;
  size_t qm = target.find('?');
  if (qm != std::string::npos) {
    path = target.substr(0, qm);
    query = target.substr(qm + 1);
  }
  auto args = parseForm(query);
  if (method == "POST") {
    auto body = parseForm(req.substr(headerEnd + 4, contentLength));
    args.insert(body.begin(), body.end());
  }
  Response r = route(method, path, args);
  char head[256];
  int hl = snprintf(head, sizeof head,
                    "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\n"
                    "Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
                    r.code, r.code == 200 ? "OK" : "ERR", r.type.c_str(), r.body.size());
  std::string out(head, (size_t)hl);
  out += r.body;
  send(fd, out.data(), out.size(), MSG_NOSIGNAL);
  close(fd);
}

int main(int argc, char** argv) {
  int port = argc > 1 ? atoi(argv[1]) : 8080;
  sens.front = sens.rear = 80;
  sens.left = sens.right = 30;
  int srv = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons((uint16_t)port);
  if (bind(srv, (sockaddr*)&addr, sizeof addr) != 0 || listen(srv, 16) != 0) {
    perror("bind/listen");
    return 1;
  }
  printf("rover_sim listening on %d\n", port);
  fflush(stdout);
  uint32_t lastUs = 0;
  for (;;) {
    struct pollfd p{srv, POLLIN, 0};
    if (poll(&p, 1, 5) > 0) {
      int fd = accept(srv, nullptr, nullptr);
      if (fd >= 0) handle(fd);
    }
    uint32_t now = nowMs();
    if (now - lastUs >= 30) {
      lastUs = now;
      if (!freezeFront) sens.frontAt = now;
      if (!freezeRear) sens.rearAt = now;
    }
    ctl.tick(now, sens);
  }
}
