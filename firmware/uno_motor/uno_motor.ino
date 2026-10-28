// AutoPark rover - Arduino UNO motor driver (Adafruit Motor Shield v1, AFMotor).
//
// Your sketch, with one addition: rotation commands may carry a speed,
// "L,<pwm>" / "R,<pwm>", so the ESP32 sets the rotation speed explicitly
// (the 90-degree rotation is calibrated at a known PWM). Plain "L" / "R"
// still work and use the last speed, as before.
//
// Commands from the ESP32 (SoftwareSerial A0 = RX, A1 = TX, 9600 baud, one per line):
//   H            heartbeat (motors stop if none for LINK_TIMEOUT ms)
//   F,<0-255>    forward          B,<0-255>   reverse
//   L[,<0-255>]  rotate left      R[,<0-255>] rotate right (in place)
//   S            stop             anything else -> stop
//
// Wiring note: ESP32 TX (GPIO17, 3.3 V) -> UNO A0 is fine. The UNO never
// transmits to the ESP32; if you ever connect UNO A1 -> ESP32 GPIO16, use a
// voltage divider (5 V -> 3.3 V).

#include <AFMotor.h>
#include <SoftwareSerial.h>
#include <string.h>
#include <stdio.h>

SoftwareSerial espLink(A0, A1);

AF_DCMotor motorFL(4, MOTOR34_1KHZ);
AF_DCMotor motorFR(3, MOTOR34_1KHZ);
AF_DCMotor motorRL(1, MOTOR12_1KHZ);
AF_DCMotor motorRR(2, MOTOR12_1KHZ);

const unsigned long LINK_TIMEOUT = 1000;
unsigned long lastHeartbeat = 0;
bool linkSeen = false;
int motorSpeed = 130;

void setAllSpeeds(int speedValue) {
  motorFL.setSpeed(speedValue);
  motorFR.setSpeed(speedValue);
  motorRL.setSpeed(speedValue);
  motorRR.setSpeed(speedValue);
}

void stopMotors() {
  motorFL.run(RELEASE);
  motorFR.run(RELEASE);
  motorRL.run(RELEASE);
  motorRR.run(RELEASE);
}

void driveMotors(char direction, int speedValue) {
  motorSpeed = constrain(speedValue, 0, 255);
  setAllSpeeds(motorSpeed);

  if (direction == 'F') {
    motorFL.run(FORWARD);
    motorFR.run(FORWARD);
    motorRL.run(FORWARD);
    motorRR.run(FORWARD);
  } else if (direction == 'B') {
    motorFL.run(BACKWARD);
    motorFR.run(BACKWARD);
    motorRL.run(BACKWARD);
    motorRR.run(BACKWARD);
  } else {
    stopMotors();
  }
}

void rotateRover(char direction) {
  setAllSpeeds(motorSpeed);

  if (direction == 'L') {
    motorFL.run(BACKWARD);
    motorRL.run(BACKWARD);
    motorFR.run(FORWARD);
    motorRR.run(FORWARD);
  } else {
    motorFL.run(FORWARD);
    motorRL.run(FORWARD);
    motorFR.run(BACKWARD);
    motorRR.run(BACKWARD);
  }
}

void processCommand(char* command) {
  if (strcmp(command, "H") == 0) {
    lastHeartbeat = millis();
    linkSeen = true;
    return;
  }

  if (!linkSeen) return;

  if (strcmp(command, "S") == 0) {
    stopMotors();
    return;
  }

  if (strcmp(command, "L") == 0 || strcmp(command, "R") == 0) {
    rotateRover(command[0]);
    return;
  }

  char direction;
  int speedValue;

  if (sscanf(command, "%c,%d", &direction, &speedValue) == 2 && speedValue >= 0 && speedValue <= 255) {
    if (direction == 'F' || direction == 'B') {
      driveMotors(direction, speedValue);
      return;
    }
    if (direction == 'L' || direction == 'R') {  // NEW: rotate at an explicit speed
      motorSpeed = speedValue;
      rotateRover(direction);
      return;
    }
  }
  stopMotors();
}

void setup() {
  espLink.begin(9600);
  stopMotors();
}

void loop() {
  static char buffer[32];
  static uint8_t index = 0;

  while (espLink.available()) {
    char c = espLink.read();

    if (c == '\n') {
      buffer[index] = '\0';
      processCommand(buffer);
      index = 0;
    } else if (c != '\r') {
      if (index < sizeof(buffer) - 1) {
        buffer[index++] = c;
      } else {
        index = 0;
        stopMotors();
      }
    }
  }

  if (linkSeen && millis() - lastHeartbeat > LINK_TIMEOUT) {
    stopMotors();
    linkSeen = false;
  }

  if (!linkSeen) stopMotors();
}
