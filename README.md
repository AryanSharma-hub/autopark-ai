# AutoPark AI: rover app, firmware and on-device classifier

One installable React Native (Expo SDK 58, TypeScript) app plus the ESP32 and Arduino UNO firmware for a four-motor rover that turns by rotating in place.

| Module | What it does | Where |
|---|---|---|
| **A. Manual control** | Hold-to-drive forward/reverse, **rotate left/right in place**, quick calibrated 90° turns, **speed (PWM) control**, live ultrasonic + IR, E-STOP. A separate mode: enabling it aborts any autonomous run. | `autopark_app/src/app/(tabs)/manual.tsx` |
| **B. Photo → slot → automatic parking** | Take or pick a photo. Your MobileNetV3 model labels S1–S5 on the phone. You pick an EMPTY slot and confirm. The ESP32 then drives to the slot centre, rotates 90° and drives into the bay. | `(tabs)/park.tsx`, `autopark.tsx` |
| **C. Live 2D map** | Lane 0–130 cm, five 26 cm bays, the planned path, the rotation point with its swept circle, and the estimated rover pose and heading. It uses the same config and plan the rover executes. | `(tabs)/map.tsx`, `src/components/LaneMap.tsx` |

Plus a Dashboard and Settings (calibration, **Appearance: System / Light / Dark**). No server or internet is needed at runtime.

```
autopark/
├── autopark_app/              Expo app
│   ├── assets/model/          slot_classifier.onnx + .json (your model, unchanged)
│   ├── src/core/vision/       decode, cv2 INTER_AREA port, ROI, classifier, onnxLite (ONNX interpreter)
│   ├── src/core/geometry/     lane/slots, kinematics (drive + rotate), route planner, map tracker
│   ├── src/core/esp32/        protocol + connection/staleness
│   ├── src/services/          ESP32 HTTP client, on-device classifier, polling hooks
│   ├── src/app/               screens (expo-router)
│   └── __tests__/             Jest: unit, Python parity, firmware integration, UI
├── firmware/
│   ├── autopark_esp32/        ESP32 sketch + ParkingController.h + StatusJson.h
│   ├── uno_motor/             Arduino UNO sketch (your code + "L,<pwm>"/"R,<pwm>")
│   ├── test/                  host tests: controller (152 checks), UNO command handling (13 checks)
│   ├── sim/rover_sim.cpp      the real controller behind the same HTTP API (PC simulator)
│   └── build/                 compiled ESP32 binaries (ESP32 Dev Module)
└── autopark_vision/           your classifier project
```

---

## 1. Hardware model (from your sketches)

- The **ESP32** handles Wi-Fi (`ESP32-Robot` / `Robot123`, 192.168.4.1), the four ultrasonics (trig 26/27/4/18, echo 21/22/5/23), four IR sensors (32–35) and the OLED (I2C 14/15). It sends motor commands over **UART2 (TX 17, RX 16, 9600 baud)** to the UNO.
- The **UNO** with the Adafruit Motor Shield drives **four motors**: `F,<pwm>`, `B,<pwm>`, `L,<pwm>` / `R,<pwm>` (rotate in place), `S`, and `H` (heartbeat; the UNO stops after 1 s without one).
- There is **no steering servo**. A turn is a timed **rotation in place** about the rover's centre.
- There are no wheel encoders. Distance = calibrated speed × motor time; rotation = motor time ÷ calibrated ms per 90°.
- Your values: slots **26 cm** × 5 = 130 cm; rover **22 × 22 cm**, so 22 + 4 cm margin = 26 cm and **2 cm per side**; speed **15.6 cm/s**, recorded at PWM 130, your firmware's default.

## 2. Parking route (deterministic)

The classifier decides **which** slot; the planner (`src/core/geometry/routePlanner.ts`) decides **how**:

1. **APPROACHING:** drive straight until the rover's **centre** is at the slot centre (S1 13, S2 39, S3 65, S4 91, S5 117 cm). A per-slot measured correction can replace this.
2. **TURNING:** stop, then **rotate 90° in place** toward the bays, timed by your calibrated "ms per 90°" at the rotation PWM. Forward-in turns the nose to the bays; reverse-in turns the tail to the bays and reverses in.
3. **PARKING:** drive straight into the bay (default: to the bay centre = lane-to-bay offset + depth/2). It ends early if the bay-end ultrasonic reads ≤ the bay-stop distance.

The app sends the whole route in one request (`POST /park`, e.g. `segs=A,F,54.00;T,L,1200;P,F,38.00`), and the ESP32 executes it alone. The phone never streams motor commands.

**Geometry checks the planner does for a 22 × 22 cm rover:**
- **Corner sweep while rotating.** The corners trace a circle of radius √(11² + 11²) = 15.6 cm. Where that circle crosses the bay mouth, it stays within ±√(15.6² − offset²) of the slot centre. That is less than 13 cm for any offset over 11 cm, so rotating never touches a neighbouring bay. The swept body is checked numerically anyway, and a longer rover would be flagged.
- **Rotation accuracy.** With 2 cm per side, a heading error of θ shifts the rover sideways by about (entry + 11 cm) · tan θ. The plan shows the tolerance (about ±2.3° with the defaults), so calibrate the 90° rotation carefully.

## 3. Firmware: what the ESP32 enforces on its own

| Condition | Response |
|---|---|
| Ultrasonic in the direction of travel ≤ obstacle distance (2 fresh readings) or IR held 40 ms, when driving **straight** | **OBSTACLE_STOP**, latched |
| Bay-end ultrasonic ≤ bay-stop distance during PARKING | **COMPLETED** |
| `/abort`, `/cmd?m=S` during a run | **ABORTED**, latched |
| `/estop` | UNO gets `S`, **ABORTED + E-STOP latch** |
| App silent for the heartbeat time during a run (status polls count) | **ERROR "heartbeat lost"** |
| Wi-Fi client leaves | **ERROR** (run) / stop (manual) |
| Front/rear ultrasonic not updating for 600 ms while driving straight | **ERROR** |
| Run takes longer than planned + 3 s | **ERROR** |
| Manual move not repeated within 1 s (hold-to-drive watchdog) | stop |
| Manual, timed, speed commands during a run | **409 BUSY** |
| Any motion while latched | **423 LOCKED** until `/reset` |
| Same request id twice | executed once |
| The current UNO command | re-sent every 200 ms with `H`, so a lost `S` can't leave the motors running |

Rotations have no direction of travel, so they don't use the ultrasonics. They are short and timed, and still covered by the heartbeat, time limit, abort and E-STOP.

**Your endpoints still work:** `/`, `/cmd?m=F|B|L|R|S`, `/timed?m=..&seconds=..`, `/speed?v=N`, `/data` (same JSON). One deliberate change: `/cmd` moves now expire after 1 s unless repeated, so the built-in page uses **hold-to-drive**. The Timed buttons work as before.

**UNO change:** it accepts `L,<pwm>` / `R,<pwm>`, so the ESP32 sets the rotation speed explicitly. Plain `L` / `R` still work. **Flash both boards.** The old UNO sketch would treat `L,130` as unknown and stop.

## 4. Classifier on the phone

The app decodes the photo, crops S1–S5 with your ROI files and runs **your `slot_classifier.onnx`** with the same preprocessing as `src/local_classifier.py`:

- 96×96 INTER_AREA squash resize, BGR→RGB, ImageNet mean/std
- temperature **T = 0.5901** (from the JSON) and threshold 0.9875 → EMPTY / OCCUPIED / UNCERTAIN

**The image-upload crash is fixed in two ways:**
1. **Memory.** Phone photos (12+ MP) were decoded at full resolution in JavaScript. They are now shrunk natively to at most 1280 px on the long side (expo-image-manipulator, lossless PNG, EXIF rotation and HEIC handled) before decoding.
2. **No native inference module.** `onnxruntime-react-native` was removed; its native initialisation was the unverified part on React Native 0.88. The model now runs in **onnxLite** (`src/core/vision/onnxLite.ts`), a small TypeScript interpreter that reads the same `.onnx` file. It covers exactly the operators MobileNetV3-Small uses (Conv, Relu, HardSwish, HardSigmoid, GlobalAveragePool, Mul, Add, Flatten, Gemm) and refuses anything else.

| Check | Result |
|---|---|
| onnxLite vs onnxruntime, random inputs (batches of 1 and 3) | logits equal within 1e-4 (observed ~1e-6) |
| Full pipeline vs the original Python code on 6 PNG + 3 JPEG samples × 2 ROI layouts, through **both** onnxruntime-node and onnxLite | same decisions; PNG probabilities equal to 1e-6 |

Speed: about 0.3 s for five slots on a desktop. On a phone it is slower, around a few seconds, and the UI stays responsive and shows progress.

## 5. Build the APK (EAS)

```powershell
cd autopark_app
npm ci                                   # never "npm install": it rewrites the lockfile
npx eas-cli@latest login
npx eas-cli@latest build -p android --profile preview
```

`app.json` already contains your EAS project (`owner: aryan-2006`, project id), and `eas.json` sets `ONNXRUNTIME_NODE_INSTALL=skip`, which the test-only package needs on EAS.

## 6. Flash the firmware

- **ESP32:** Arduino IDE → board **ESP32 Dev Module** → libraries **Adafruit SSD1306** and **Adafruit GFX** → open `firmware/autopark_esp32/autopark_esp32.ino` (keep the two `.h` files beside it) → Upload. Or flash `firmware/build/autopark_esp32.ino.merged.bin` at offset 0x0.
- **UNO:** board **Arduino Uno** → library **Adafruit Motor Shield library (AFMotor, v1)** → open `firmware/uno_motor/uno_motor.ino` → Upload.

## 7. Calibration (on the real lot, in order)

1. **Speed.** 15.6 cm/s at PWM 130 is preloaded. To drive at another speed, use Settings › Driving speed › *Run calibration drive* at that PWM and measure the distance. With two or more measured PWMs you can also type a target speed in cm/s.
2. **90° rotation.** Settings › *Calibrate 90° rotation*. Mark the rover's heading, rotate left for a trial time, and adjust ±20/100 ms until it turns exactly 90°, then save. Or enter the angle it actually turned and the app computes the 90° time. Repeat for right. Times are tied to the rotation PWM.
3. **Lot.** Which side the bays are on, the lane-to-bay offset (driving line to bay mouth, > 11 cm), bay depth, and the start mark. The default start is the rover centre at 11 cm, i.e. rear bumper on the 0 line.
4. **Try each slot slowly.** If the rover consistently ends off-centre, enter a measured rotation point for that slot.
5. **Safety thresholds** (obstacle 12 cm, bay end 6 cm) are unconfirmed defaults.

## 8. Tests and what has NOT been tested

| Level | Status |
|---|---|
| App unit + parity + UI tests (Jest) | **182 passing** |
| Firmware controller host tests (rotation segments, UNO command text, timed moves, rotation calibration, all safety paths) | **152 checks passing** |
| UNO sketch command handling (host build with stubbed AFMotor/SoftwareSerial) | **13 checks passing** |
| App ↔ firmware over HTTP against `rover_sim` | **passing** (part of the Jest run) |
| ESP32 firmware compile (ESP32 Dev Module) | **passing**, 75% flash, 15% RAM |
| UNO firmware compile with the real AVR toolchain | **not done here.** Arduino's download server is blocked from this environment. |
| Android JS bundle; clean `npm ci` as EAS runs it | **passing** |
| `autopark_vision` Python tests | 91 pass, 1 fails as before (`roi_config.json` `placeholder: false`) |
| **APK on a phone, onnxLite speed on the phone** | **not tested here** |
| **Physical rover** | **not tested.** Nothing here has driven the real car. |
