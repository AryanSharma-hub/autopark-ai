// AutoPark rover - ESP32 "brain" (Wi-Fi, sensors, OLED, safety, parking runs).
//
// Based on your ESP32 sketch: same Wi-Fi AP (ESP32-Robot / Robot123), same
// sensor pins, OLED on I2C 14/15, and the same UART2 link (TX 17 / RX 16,
// 9600 baud) to the Arduino UNO that drives the four motors.
//
// UNO protocol (see firmware/uno_motor/uno_motor.ino):
//   "F,<pwm>" "B,<pwm>" forward / reverse      "L,<pwm>" "R,<pwm>" rotate in place
//   "S" stop                                  "H" heartbeat (UNO stops after 1 s without)
// The current command is re-sent every 200 ms, so a lost "S" cannot leave the
// motors running.
//
// Your endpoints still work: /  /cmd?m=F|B|L|R|S  /timed?m=..&seconds=..  /speed?v=N  /data
// Added for the app: /status /park /calib /abort /estop /reset /config /ping
// All movement and safety decisions are in ParkingController.h (unit-tested on a PC).
//
// Libraries: Adafruit SSD1306, Adafruit GFX (WiFi/WebServer/HardwareSerial come with the ESP32 core).
// Board: ESP32 Dev Module.

#include <WiFi.h>
#include <WebServer.h>
#include <HardwareSerial.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include "ParkingController.h"
#include "StatusJson.h"

using autopark::ParkRequest;
using autopark::Result;

const char* FW_VERSION = "autopark-uno-2.0";
const char* AP_SSID = "ESP32-Robot";
const char* AP_PASS = "Robot123";

WebServer server(80);
HardwareSerial motorSerial(2);
Adafruit_SSD1306 display(128, 64, &Wire, -1);
bool oledOk = false;

const int IR_FL_PIN = 32;
const int IR_FR_PIN = 33;
const int IR_RL_PIN = 34;
const int IR_RR_PIN = 35;
const bool IR_ACTIVE_LOW = true;

// Front, Rear, Left, Right (your pin map)
const int TRIG_PINS[4] = {26, 27, 4, 18};
const int ECHO_PINS[4] = {21, 22, 5, 23};
const unsigned long ECHO_TIMEOUT_US = 15000;  // ~2.5 m
const unsigned long US_SLOT_MS = 30;           // one ultrasonic reading per slot
const unsigned long UNO_REFRESH_MS = 200;      // heartbeat + command re-send
const unsigned long OLED_INTERVAL_MS = 250;

autopark::Controller ctl;
autopark::Sensors sens = {-1, -1, -1, -1, 0, 0, false, false, false, false};
unsigned long lastUsMs = 0, lastUnoMs = 0, lastOledMs = 0;
uint8_t usStep = 0;
char sentCmd[12] = "";
volatile bool stationLeft = false;

const char PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 Rover</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#101114;color:#eee;font-family:Arial;padding:18px}
main{max-width:650px;margin:auto}
.card{background:#1b1d22;border:1px solid #30333a;border-radius:14px;padding:16px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
button{background:#30343c;color:white;border:0;border-radius:10px;padding:15px;font-size:16px;touch-action:none;user-select:none}
button:active{background:#4a4f5a}
.stop{background:#a52e37}
input{width:100%;accent-color:#eee}
.readings{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.reading{background:#262930;padding:12px;border-radius:9px}
small{color:#aaa}
</style>
</head>
<body>
<main>
<h2>Rover Control</h2>
<div class="card">
<small>Hold a button to move; release to stop.</small>
<div class="grid" style="margin-top:10px">
<button data-m="F">Forward</button>
<button data-m="B">Reverse</button>
<button data-m="L">Rotate Left</button>
<button data-m="R">Rotate Right</button>
<button class="stop" onclick="cmd('S')" style="grid-column:span 2">STOP</button>
</div>
</div>
<div class="card">
<label>Motor speed: <b id="speedText">130</b></label>
<input id="speed" type="range" min="0" max="255" value="130"
oninput="speedText.textContent=this.value" onchange="setSpeed(this.value)">
</div>
<div class="card">
<label>Timed duration: <b id="secondsText">3</b> seconds</label>
<input id="seconds" type="range" min="1" max="60" value="3"
oninput="secondsText.textContent=this.value">
<div class="grid" style="margin-top:12px">
<button onclick="timed('F')">Timed Forward</button>
<button onclick="timed('B')">Timed Reverse</button>
<button onclick="timed('L')">Timed Rotate Left</button>
<button onclick="timed('R')">Timed Rotate Right</button>
</div>
</div>
<div class="card">
<h3>Ultrasonic distances</h3>
<div class="readings" id="distances"></div>
</div>
<div class="card">
<h3>IR sensors</h3>
<div class="readings" id="irs"></div>
</div>
<div class="card">Status: <b id="status">Connecting...</b></div>
</main>
<script>
async function cmd(m){try{await fetch('/cmd?m='+m,{cache:'no-store'})}catch(e){}}
async function timed(m){try{await fetch('/timed?m='+m+'&seconds='+seconds.value)}catch(e){}}
async function setSpeed(v){try{await fetch('/speed?v='+v)}catch(e){}}
let holdTimer=null;
function hold(m){release(false);cmd(m);holdTimer=setInterval(()=>cmd(m),300)}
function release(send=true){if(holdTimer){clearInterval(holdTimer);holdTimer=null;if(send)cmd('S')}}
document.querySelectorAll('button[data-m]').forEach(b=>{
 b.addEventListener('pointerdown',e=>{e.preventDefault();hold(b.dataset.m)});
 ['pointerup','pointerleave','pointercancel'].forEach(t=>b.addEventListener(t,()=>release()));
});
async function update(){
 try{
  const r=await fetch('/data',{cache:'no-store'});
  const d=await r.json();
  status.textContent=d.movement+' | Speed '+d.speed+' | '+d.state;
  distances.innerHTML=d.distances.map(x=>
   '<div class="reading">'+x.name+'<br><b>'+(x.cm<0?'No echo':x.cm+' cm')+'</b></div>'
  ).join('');
  irs.innerHTML=d.ir.map(x=>
   '<div class="reading">'+x.name+'<br><b>'+(x.detected?'Detected':'Clear')+'</b></div>'
  ).join('');
 }catch(e){status.textContent='Connection lost'}
}
setInterval(update,500);
update();
</script>
</body>
</html>
)rawliteral";

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

bool irDetected(int pin) {
  int value = digitalRead(pin);
  return IR_ACTIVE_LOW ? value == LOW : value == HIGH;
}

float readDistance(int i) {
  digitalWrite(TRIG_PINS[i], LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PINS[i], HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PINS[i], LOW);
  unsigned long duration = pulseIn(ECHO_PINS[i], HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return -1;
  return duration * 0.0343f / 2.0f;
}

// One ultrasonic per 30 ms slot. Driving straight, the sensor facing the
// direction of travel is read every other slot (~60 ms); otherwise all four in turn.
void serviceUltrasonic(unsigned long now) {
  if (now - lastUsMs < US_SLOT_MS) return;
  lastUsMs = now;
  static const uint8_t idle[] = {0, 2, 3, 1};
  static const uint8_t fwd[] = {0, 2, 0, 3, 0, 1};
  static const uint8_t rev[] = {1, 2, 1, 3, 1, 0};
  uint8_t which;
  if (ctl.out.motor == 'F') which = fwd[usStep++ % sizeof(fwd)];
  else if (ctl.out.motor == 'B') which = rev[usStep++ % sizeof(rev)];
  else which = idle[usStep++ % sizeof(idle)];
  float d = readDistance(which);
  switch (which) {
    case 0: sens.front = d; sens.frontAt = millis(); break;
    case 1: sens.rear = d; sens.rearAt = millis(); break;
    case 2: sens.left = d; break;
    case 3: sens.right = d; break;
  }
}

void readIr() {
  sens.irFL = irDetected(IR_FL_PIN);
  sens.irFR = irDetected(IR_FR_PIN);
  sens.irRL = irDetected(IR_RL_PIN);
  sens.irRR = irDetected(IR_RR_PIN);
}

// ---------------------------------------------------------------------------
// Motors (via the UNO)
// ---------------------------------------------------------------------------

void applyOutputs() {
  char cmd[12];
  autopark::unoCommandFor(ctl.out, cmd, sizeof(cmd));
  if (strcmp(cmd, sentCmd) != 0) {  // send changes immediately
    motorSerial.println(cmd);
    strcpy(sentCmd, cmd);
  }
}

void refreshUno(unsigned long now) {
  if (now - lastUnoMs < UNO_REFRESH_MS) return;
  lastUnoMs = now;
  motorSerial.println("H");
  char cmd[12];
  autopark::unoCommandFor(ctl.out, cmd, sizeof(cmd));
  motorSerial.println(cmd);  // idempotent re-send
  strcpy(sentCmd, cmd);
}

// ---------------------------------------------------------------------------
// OLED
// ---------------------------------------------------------------------------

const char* moveName(char m) {
  switch (m) {
    case 'F': return "FORWARD";
    case 'B': return "REVERSE";
    case 'L': return "ROT LEFT";
    case 'R': return "ROT RIGHT";
  }
  return "STOP";
}

void printDistance(float d) {
  if (d < 0) display.print("--");
  else display.print(d, 0);
}

void updateOLED() {
  if (!oledOk) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(autopark::stateName(ctl.state));
  if (ctl.estopLatched) display.print(" ESTOP");
  display.setCursor(0, 10);
  if (ctl.autonomous()) {
    display.print(ctl.req.slot);
    display.print(" seg ");
    display.print(ctl.seg + 1);
    display.print("/");
    display.print(ctl.req.segCount);
  } else {
    display.print("Move: ");
    display.print(moveName(ctl.out.motor));
  }
  display.setCursor(0, 20);
  display.print("Speed: ");
  display.print(ctl.runActive() ? ctl.out.pwm : ctl.manualPwm);
  display.setCursor(0, 30);
  display.print("F:");
  printDistance(sens.front);
  display.print(" R:");
  printDistance(sens.rear);
  display.setCursor(0, 40);
  display.print("L:");
  printDistance(sens.left);
  display.print(" Rt:");
  printDistance(sens.right);
  display.setCursor(0, 50);
  display.print("IR:");
  display.print((int)sens.irFL);
  display.print((int)sens.irFR);
  display.print((int)sens.irRL);
  display.print((int)sens.irRR);
  display.print(" C:");
  display.print(WiFi.softAPgetStationNum());
  display.display();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

void sendJson(int code, const char* body) {
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(code, "application/json", body);
}

void sendResult(Result r, const char* err = "") {
  static char body[320];
  autopark::writeResultJson(body, sizeof(body), r, err, ctl);
  sendJson(autopark::httpCodeFor(r), body);
}

void sendStatus() {
  static char body[1100];
  autopark::writeStatusJson(body, sizeof(body), ctl, sens, millis(), FW_VERSION);
  sendJson(200, body);
}

// Every request counts as an app heartbeat.
void touch() { ctl.noteClient(millis()); }

void sendText(Result r) {
  if (r == Result::OK) server.send(200, "text/plain", "OK");
  else server.send(autopark::httpCodeFor(r), "text/plain", String(autopark::resultName(r)) + ": " + ctl.reason);
}

void handleCmd() {
  touch();
  String m = server.arg("m");
  Result r = Result::INVALID;
  if (m.length() == 1) r = ctl.manualCommand(m[0], millis(), sens);
  applyOutputs();
  sendText(r);
}

void handleTimed() {
  touch();
  String m = server.arg("m");
  long ms = server.hasArg("ms") ? server.arg("ms").toInt() : server.arg("seconds").toInt() * 1000L;
  Result r = Result::INVALID;
  if (m.length() == 1 && ms > 0) r = ctl.timedCommand(m[0], (uint32_t)ms, millis(), sens);
  applyOutputs();
  if (r == Result::OK) server.send(200, "text/plain", "Timed movement started");
  else sendText(r);
}

void handleSpeed() {
  touch();
  Result r = Result::INVALID;
  String v = server.hasArg("v") ? server.arg("v") : server.arg("value");
  if (v.length()) r = ctl.setSpeed(v.toInt());
  // a running manual move picks up the new speed
  if (r == Result::OK && ctl.state == autopark::State::MANUAL && ctl.out.motor != 'S') ctl.out.pwm = ctl.manualPwm;
  applyOutputs();
  sendText(r);
}

void handleData() {
  touch();
  static char body[700];
  autopark::writeDataJson(body, sizeof(body), ctl, sens);
  sendJson(200, body);
}

void handlePark() {
  touch();
  ParkRequest r;
  memset(&r, 0, sizeof(r));
  char err[96] = "";
  // Reject over-long fields instead of silently truncating them (e.g. "S12" -> "S1").
  if (server.arg("slot").length() != 2 || server.arg("rid").length() >= sizeof(r.rid)) {
    sendResult(Result::INVALID, "slot/rid malformed");
    return;
  }
  memcpy(r.rid, server.arg("rid").c_str(), server.arg("rid").length() + 1);
  memcpy(r.slot, server.arg("slot").c_str(), 3);
  r.pwm = server.arg("pwm").toInt();
  r.rpwm = server.hasArg("rpwm") ? server.arg("rpwm").toInt() : r.pwm;
  r.cms = server.arg("cms").toFloat();
  r.obstacleCm = server.arg("obst").toFloat();
  r.bayCm = server.arg("bay").toFloat();
  r.irStop = server.arg("ir") == "1";
  r.hbMs = (uint32_t)server.arg("hb").toInt();
  r.settleMs = (uint32_t)server.arg("settle").toInt();
  if (!autopark::parseSegments(server.arg("segs").c_str(), r.segs, r.segCount, err, sizeof(err))) {
    sendResult(Result::INVALID, err);
    return;
  }
  Result res = ctl.startPark(r, millis(), err, sizeof(err));
  applyOutputs();
  sendResult(res, err);
}

void handleCalib() {
  touch();
  char err[96] = "";
  String m = server.hasArg("m") ? server.arg("m") : String("F");
  float obst = server.hasArg("obst") ? server.arg("obst").toFloat() : ctl.lim.manualObstacleCm;
  Result res = Result::INVALID;
  if (m.length() == 1) {
    res = ctl.startCalibration(m[0], server.arg("pwm").toInt(), (uint32_t)server.arg("ms").toInt(), obst, millis(), err, sizeof(err));
  } else {
    snprintf(err, sizeof(err), "m must be F, B, L or R");
  }
  applyOutputs();
  sendResult(res, err);
}

void handleAbort() {
  touch();
  ctl.abort("abort command", millis());
  applyOutputs();
  sendResult(Result::OK);
}

void handleEstop() {
  touch();
  ctl.estop(millis());
  applyOutputs();
  sendResult(Result::OK);
}

void handleReset() {
  touch();
  Result r = ctl.reset(millis());
  applyOutputs();
  sendResult(r, r == Result::BUSY ? "abort the active run first" : "");
}

void handleConfig() {
  touch();
  if (server.hasArg("obst")) {
    float v = server.arg("obst").toFloat();
    if (v >= 2 && v <= 100) ctl.lim.manualObstacleCm = v;
  }
  if (server.hasArg("mwd")) {
    long v = server.arg("mwd").toInt();
    if (v >= 300 && v <= 5000) ctl.lim.manualWatchdogMs = (uint32_t)v;
  }
  if (server.hasArg("mobst")) ctl.lim.manualObstacleStop = server.arg("mobst") == "1";
  if (server.hasArg("ir")) ctl.lim.irStopManual = server.arg("ir") == "1";
  char j[96];
  snprintf(j, sizeof(j), "{\"obst\":%.1f,\"mwd\":%lu,\"mobst\":%d,\"ir\":%d}", ctl.lim.manualObstacleCm,
           (unsigned long)ctl.lim.manualWatchdogMs, ctl.lim.manualObstacleStop ? 1 : 0, ctl.lim.irStopManual ? 1 : 0);
  sendJson(200, j);
}

void onWiFiEvent(WiFiEvent_t event) {
  if (event == ARDUINO_EVENT_WIFI_AP_STADISCONNECTED) stationLeft = true;
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  motorSerial.begin(9600, SERIAL_8N1, 16, 17);
  motorSerial.println("S");

  for (int i = 0; i < 4; i++) {
    pinMode(TRIG_PINS[i], OUTPUT);
    pinMode(ECHO_PINS[i], INPUT);
    digitalWrite(TRIG_PINS[i], LOW);
  }
  pinMode(IR_FL_PIN, INPUT);
  pinMode(IR_FR_PIN, INPUT);
  pinMode(IR_RL_PIN, INPUT);
  pinMode(IR_RR_PIN, INPUT);

  Wire.begin(14, 15);
  Wire.setClock(400000);
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (oledOk) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("Starting rover...");
    display.display();
  } else {
    Serial.println("OLED not found. Check wiring/address.");
  }

  WiFi.mode(WIFI_AP);
  WiFi.onEvent(onWiFiEvent);
  WiFi.softAP(AP_SSID, AP_PASS);

  server.on("/", HTTP_GET, []() { server.send_P(200, "text/html", PAGE); });
  server.on("/cmd", HTTP_GET, handleCmd);
  server.on("/timed", HTTP_GET, handleTimed);
  server.on("/speed", HTTP_GET, handleSpeed);
  server.on("/data", HTTP_GET, handleData);
  server.on("/status", HTTP_GET, []() { touch(); sendStatus(); });
  server.on("/sensors", HTTP_GET, []() { touch(); sendStatus(); });
  server.on("/ping", HTTP_GET, []() { touch(); server.send(200, "text/plain", "OK"); });
  server.on("/park", HTTP_POST, handlePark);
  server.on("/calib", HTTP_POST, handleCalib);
  server.on("/abort", HTTP_GET, handleAbort);
  server.on("/estop", HTTP_GET, handleEstop);
  server.on("/reset", HTTP_GET, handleReset);
  server.on("/config", HTTP_GET, handleConfig);
  server.onNotFound([]() { server.send(404, "text/plain", "Not found"); });
  server.begin();

  Serial.println("Connect to Wi-Fi: ESP32-Robot");
  Serial.print("Open http://");
  Serial.println(WiFi.softAPIP());
}

void loop() {
  server.handleClient();

  unsigned long now = millis();
  if (stationLeft) {
    stationLeft = false;
    if (WiFi.softAPgetStationNum() == 0) ctl.clientsGone(now);
  }

  readIr();
  serviceUltrasonic(now);
  ctl.tick(millis(), sens);
  applyOutputs();
  refreshUno(millis());

  if (millis() - lastOledMs >= OLED_INTERVAL_MS) {
    lastOledMs = millis();
    updateOLED();
  }
}
